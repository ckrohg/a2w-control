# @purpose: Simulated MAHRW030ZA heat pumps for Phase 0 development. Each pump is a
# pymodbus RTU server (imitating a USR-W610 in transparent mode) with toy thermal physics,
# plus one shared HTTP control API for fault injection:
#   uv run python sim/fake_pump.py                 # 2 pumps on :15020/:15021, control :8090
#   curl -X POST localhost:8090/pumps/1/fault/P01  # inject water-flow fault on pump 1
#   curl -X POST 'localhost:8090/pumps/1/fault/P01?on=false'   # clear it
#   curl -X POST 'localhost:8090/pumps/1/register/2052?value=65516'  # ambient = -20degC
# BENCH mode — serve ONE pump over a real USB-RS485 dongle (through a W610), same RTU framing
# the W610 puts on the wire, to prove the gateway + framing on real hardware before a pump:
#   uv run python sim/fake_pump.py --serial /dev/tty.usbserial-XXXX   # see deploy/w610-setup.md
from __future__ import annotations

import argparse
import asyncio
import logging
import math
import random
import sys
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException
from pymodbus import FramerType
from pymodbus.server import ModbusSerialServer, ModbusTcpServer
from pymodbus.simulator import SimData, SimDevice, DataType

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from bridge import registers as R                      # noqa: E402
from bridge.faults import CODE_TO_BITS, FAULTS         # noqa: E402

log = logging.getLogger("fake_pump")

PHYSICS_TICK_S = 2.0


def encode(value: float) -> int:
    v = int(round(value))
    return v + 0x10000 if v < 0 else v


class FakePump:
    """One simulated pump: Modbus server + toy thermal model."""

    def __init__(self, index: int, port: int, device_id: int = 1,
                 serial_port: str | None = None, baudrate: int = 2400):
        self.index = index
        self.port = port
        self.device_id = device_id
        # Bench mode: when serial_port is set the pump answers over a real USB-RS485 dongle
        # (through a W610) instead of localhost TCP. Same RTU framing either way.
        self.serial_port = serial_port
        self.baudrate = baudrate
        # thermal state (degC)
        self.ambient = 5.0
        self.tank = 38.0          # buffer water temp; inlet reads slightly below outlet
        self.heating = False
        self._t = random.uniform(0, 1000)  # phase offset so pumps don't move in lockstep
        self.server: ModbusTcpServer | ModbusSerialServer | None = None

    async def start(self) -> None:
        space = [SimData(address=2000, count=130, values=0, datatype=DataType.REGISTERS)]
        device = SimDevice(id=self.device_id, simdata=space)
        if self.serial_port:
            self.server = ModbusSerialServer(
                device, framer=FramerType.RTU, port=self.serial_port,
                baudrate=self.baudrate, bytesize=8, parity="N", stopbits=1)
        else:
            self.server = ModbusTcpServer(device, framer=FramerType.RTU,
                                          address=("127.0.0.1", self.port))
        asyncio.create_task(self.server.serve_forever(), name=f"modbus-{self.index}")
        await asyncio.sleep(0.2)
        await self.set_reg(R.REG_ON_OFF, 1)
        await self.set_reg(R.REG_MODE, 1)  # floor heating
        await self.set_reg(R.REG_SETPOINT_COOLING, 16)
        await self.set_reg(R.REG_SETPOINT_HEATING, 45)
        await self.set_reg(R.REG_SETPOINT_HOT_WATER, 50)
        # wire-controller parameters at factory defaults from the protocol doc —
        # except param 17 (max water temp), raised to 90 here so the full setpoint
        # range is exercisable in dev; real units ship at 55 (Phase 1 reads the truth)
        factory = {2010: 5, 2011: 5, 2012: 2, 2013: 5, 2014: 45, 2015: encode(-3),
                   2016: 8, 2017: 13, 2018: encode(-10), 2019: 45, 2020: 10,
                   2021: encode(-35), 2022: 5, 2023: 30, 2024: 5, 2025: 1, 2026: 400,
                   2027: 90, 2028: 12, 2029: 1, 2030: encode(-20), 2031: 30, 2032: 15,
                   2033: 0, 2034: 5, 2035: 0, 2036: 20, 2037: 0, 2038: encode(-10),
                   2039: 0}
        for addr, val in factory.items():
            await self.set_reg(addr, val)
        # AC online + water flow OK + remote linkage contact closed (HBX calling)
        await self.set_reg(R.REG_SWITCH_STATUS, (1 << 4) | (1 << 5) | (1 << 6))
        if self.serial_port:
            log.info("pump %d: modbus RTU on serial %s @ %d 8N1 (device_id=%d)",
                     self.index, self.serial_port, self.baudrate, self.device_id)
        else:
            log.info("pump %d: modbus RTU-over-TCP on :%d (device_id=%d)",
                     self.index, self.port, self.device_id)

    async def get_reg(self, addr: int) -> int:
        vals = await self.server.context.async_getValues(self.device_id, 3, addr, 1)
        return vals[0]

    async def set_reg(self, addr: int, value: int) -> None:
        await self.server.context.async_setValues(self.device_id, 3, addr, [value & 0xFFFF])

    async def tick(self) -> None:
        """Advance toy physics one step and write telemetry registers. Mode-aware:
        follows reg 2001 (0 = cooling chases reg 2002, heating chases reg 2003)."""
        self._t += PHYSICS_TICK_S
        on = await self.get_reg(R.REG_ON_OFF)
        mode = await self.get_reg(R.REG_MODE)
        cooling = mode == 0
        setpoint = await self.get_reg(R.REG_SETPOINT_COOLING if cooling
                                      else R.REG_SETPOINT_HEATING)

        # ambient wanders slowly around 5degC with +/-6degC daily-ish swing
        self.ambient = 5.0 + 6.0 * math.sin(self._t / 600) + random.uniform(-0.3, 0.3)

        # thermostat with 2degC hysteresis on either side, like the real control
        if cooling:
            if on and not self.heating and self.tank > setpoint + 2:
                self.heating = True   # "heating" = compressors running
            elif self.heating and (not on or self.tank <= setpoint - 1):
                self.heating = False
        else:
            if on and not self.heating and self.tank < setpoint - 2:
                self.heating = True
            elif self.heating and (not on or self.tank >= setpoint + 1):
                self.heating = False

        drift = 0.008 * PHYSICS_TICK_S * max(0.2, abs(self.tank - self.ambient) / 30)
        if self.heating:
            self.tank += (-0.10 if cooling else 0.12) * PHYSICS_TICK_S
        else:
            self.tank += drift if cooling and self.tank < 30 else -drift

        delta = 4.5 if self.heating else 0.3
        outlet = self.tank + (-delta if cooling else delta) + random.uniform(-0.2, 0.2)
        inlet = self.tank + (0.5 if cooling else -0.5) * (1 if self.heating else 0.2) \
            + random.uniform(-0.2, 0.2)

        # power: two stages; in heating, stage 2 (R134a) joins above 45degC outlet
        if self.heating:
            p1 = 2600 + random.uniform(-150, 150)
            p2 = (1900 + random.uniform(-120, 120)) if (not cooling and outlet > 45) else 0.0
        else:
            p1 = p2 = 0.0

        # occasional defrost cycle: in heating, cold ambient, while running
        defrost = (not cooling and self.heating and self.ambient < 3
                   and (self._t % 900) < 60)

        status = 0
        if on:
            status |= 1  # wall controller on
            status |= 1 << 6  # circulating pump
        if self.heating:
            status |= 1 << 1                      # compressor 1
            status |= (1 << 2) if p2 else 0       # compressor 2
            status |= 1 << 3                      # fan high
        if cooling or defrost:
            status |= 1 << 7                      # four-way valve 1
            if p2 or cooling:
                status |= 1 << 8                  # four-way valve 2
        if not cooling and self.ambient < -15:
            status |= 1 << 11                     # electric heating assists when frigid

        await self.set_reg(R.REG_INLET_TEMP, encode(inlet))
        await self.set_reg(R.REG_OUTLET_TEMP, encode(outlet))
        await self.set_reg(R.REG_AMBIENT_TEMP, encode(self.ambient))
        await self.set_reg(R.REG_SYS1_POWER, encode(p1))
        await self.set_reg(R.REG_SYS2_POWER, encode(p2))
        await self.set_reg(R.REG_SYS1_CURRENT, encode(p1 / 240))
        await self.set_reg(R.REG_SYS2_CURRENT, encode(p2 / 240))
        await self.set_reg(R.REG_SYS1_FREQ, 65 if self.heating else 0)
        await self.set_reg(R.REG_SYS2_FREQ, 60 if p2 else 0)
        await self.set_reg(R.REG_STATUS, status)

        # per-stage refrigerant-side detail (what the wall controller shows)
        run1 = self.heating
        run2 = bool(p2)
        await self.set_reg(2055, encode(78 + random.uniform(-3, 3) if run1 else self.tank))
        await self.set_reg(2056, encode(self.ambient - (6 if run1 else 0)))
        await self.set_reg(2057, encode(self.ambient - (2 if run1 else 0)))
        await self.set_reg(2059, 210 if run1 else 0)   # EEV, actual = x2
        await self.set_reg(2053, 180 if run1 else 0)   # aux EEV (raw 0-500)
        await self.set_reg(2054, 165 if run2 else 0)
        await self.set_reg(2060, encode(self.tank))
        await self.set_reg(2061, 38)                   # bus V, actual = x10
        await self.set_reg(2062, encode(52 if run1 else self.ambient + 5))
        await self.set_reg(2064, 850 if run1 else 0)   # fan rpm
        await self.set_reg(2065, 26 if run1 else 14)   # high pressure (raw)
        await self.set_reg(2066, 5 if run1 else 14)    # low pressure (raw)
        await self.set_reg(2067, 231)
        await self.set_reg(2080, encode(84 + random.uniform(-3, 3) if run2 else self.tank))
        await self.set_reg(2081, encode(self.tank + (3 if run2 else 0)))
        await self.set_reg(2082, encode(self.tank - (4 if run2 else 0)))
        await self.set_reg(2084, 195 if run2 else 0)
        await self.set_reg(2085, encode(self.tank))
        await self.set_reg(2086, 37)
        await self.set_reg(2087, encode(48 if run2 else self.ambient + 5))
        await self.set_reg(2089, 0)                    # stage 2 shares the fan
        await self.set_reg(2090, 28 if run2 else 15)
        await self.set_reg(2091, 6 if run2 else 15)
        # fixed-speed compressors idle in this sim: plausible resting temps, no draw
        for base in (2071, 2096):
            await self.set_reg(base, encode(self.tank))          # discharge
            await self.set_reg(base + 1, encode(self.ambient))   # coil
            await self.set_reg(base + 2, encode(self.ambient))   # suction
            await self.set_reg(base + 3, 0)                      # current
            await self.set_reg(base + 4, 0)                      # EEV
        await self.set_reg(2076, 0)
        await self.set_reg(R.REG_AC_VOLTAGE, 232)

    async def inject_fault(self, code: str, on: bool, bit_index: int = 0) -> dict:
        """Set/clear the bit(s) for a fault code. Codes mapping to multiple bits
        (e.g. P17) use bit_index to pick which; default first."""
        locations = CODE_TO_BITS.get(code.upper()) or CODE_TO_BITS.get(code)
        if not locations:
            raise KeyError(f"unknown fault code: {code}")
        register, bit = locations[min(bit_index, len(locations) - 1)]
        # 32-bit field: bits >=16 of the 2114 group live in 2115
        if register == R.REG_PROT_FIXED_LO and bit >= 16:
            register, bit = R.REG_PROT_FIXED_HI, bit - 16
        current = await self.get_reg(register)
        new = current | (1 << bit) if on else current & ~(1 << bit)
        await self.set_reg(register, new)
        fdef = FAULTS[locations[min(bit_index, len(locations) - 1)]]
        return {"pump": self.index, "code": fdef.code, "register": register, "bit": bit,
                "on": on, "message": fdef.message}


def build_control_api(pumps: dict[int, FakePump]) -> FastAPI:
    api = FastAPI(title="fake-pump-control")

    @api.get("/")
    async def state():
        out = {}
        for i, p in pumps.items():
            out[i] = {
                "modbus_port": p.port,
                "heating": p.heating,
                "tank_c": round(p.tank, 1),
                "ambient_c": round(p.ambient, 1),
                "setpoint_c": await p.get_reg(R.REG_SETPOINT_HEATING),
            }
        return out

    @api.post("/pumps/{pump}/fault/{code}")
    async def fault(pump: int, code: str, on: bool = True, bit_index: int = 0):
        if pump not in pumps:
            raise HTTPException(404, f"no pump {pump}")
        try:
            return await pumps[pump].inject_fault(code, on, bit_index)
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc

    @api.post("/pumps/{pump}/register/{address}")
    async def poke(pump: int, address: int, value: int):
        if pump not in pumps:
            raise HTTPException(404, f"no pump {pump}")
        await pumps[pump].set_reg(address, value)
        return {"pump": pump, "register": address, "value": value}

    return api


async def main() -> None:
    parser = argparse.ArgumentParser(description="Simulated MAHRW030ZA heat pumps")
    parser.add_argument("--pumps", type=int, default=2)
    parser.add_argument("--base-port", type=int, default=15020)
    parser.add_argument("--control-port", type=int, default=8090)
    parser.add_argument("--serial", metavar="DEVICE",
                        help="bench mode: serve ONE pump over a real serial port "
                             "(USB-RS485 dongle), e.g. /dev/tty.usbserial-XXXX")
    parser.add_argument("--baud", type=int, default=2400)
    parser.add_argument("--device-id", type=int, default=1)
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    if args.serial:
        # Real bench topology is one W610 <-> one pump <-> one dongle, so serve a single
        # pump on the serial port. Physics + the fault-injection control API still run.
        pumps = {1: FakePump(1, args.base_port, device_id=args.device_id,
                             serial_port=args.serial, baudrate=args.baud)}
    else:
        pumps = {i + 1: FakePump(i + 1, args.base_port + i) for i in range(args.pumps)}
    for p in pumps.values():
        await p.start()

    async def physics():
        while True:
            for p in pumps.values():
                await p.tick()
            await asyncio.sleep(PHYSICS_TICK_S)

    asyncio.create_task(physics(), name="physics")
    config = uvicorn.Config(build_control_api(pumps), host="127.0.0.1",
                            port=args.control_port, log_level="warning")
    log.info("control API on :%d — POST /pumps/1/fault/P01 to inject", args.control_port)
    await uvicorn.Server(config).serve()


if __name__ == "__main__":
    asyncio.run(main())
