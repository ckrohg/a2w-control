# @purpose: Simulated MAHRW030ZA heat pumps for Phase 0 development. Each pump is a
# pymodbus RTU-over-TCP server (imitating a USR-W610 in transparent mode) with toy
# thermal physics, plus one shared HTTP control API for fault injection:
#   uv run python sim/fake_pump.py                 # 2 pumps on :15020/:15021, control :8090
#   curl -X POST localhost:8090/pumps/1/fault/P01  # inject water-flow fault on pump 1
#   curl -X POST 'localhost:8090/pumps/1/fault/P01?on=false'   # clear it
#   curl -X POST 'localhost:8090/pumps/1/register/2052?value=65516'  # ambient = -20degC
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
from pymodbus.server import ModbusTcpServer
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

    def __init__(self, index: int, port: int, device_id: int = 1):
        self.index = index
        self.port = port
        self.device_id = device_id
        # thermal state (degC)
        self.ambient = 5.0
        self.tank = 38.0          # buffer water temp; inlet reads slightly below outlet
        self.heating = False
        self._t = random.uniform(0, 1000)  # phase offset so pumps don't move in lockstep
        self.server: ModbusTcpServer | None = None

    async def start(self) -> None:
        space = [SimData(address=2000, count=130, values=0, datatype=DataType.REGISTERS)]
        device = SimDevice(id=self.device_id, simdata=space)
        self.server = ModbusTcpServer(device, framer=FramerType.RTU,
                                      address=("127.0.0.1", self.port))
        asyncio.create_task(self.server.serve_forever(), name=f"modbus-{self.index}")
        await asyncio.sleep(0.2)
        await self.set_reg(R.REG_ON_OFF, 1)
        await self.set_reg(R.REG_MODE, 1)  # floor heating
        await self.set_reg(R.REG_SETPOINT_HEATING, 45)
        await self.set_reg(R.REG_MAX_WATER_TEMP, 55)
        await self.set_reg(R.REG_SWITCH_STATUS, (1 << 4) | (1 << 5))  # AC online + water flow OK
        log.info("pump %d: modbus RTU-over-TCP on :%d (device_id=%d)",
                 self.index, self.port, self.device_id)

    async def get_reg(self, addr: int) -> int:
        vals = await self.server.context.async_getValues(self.device_id, 3, addr, 1)
        return vals[0]

    async def set_reg(self, addr: int, value: int) -> None:
        await self.server.context.async_setValues(self.device_id, 3, addr, [value & 0xFFFF])

    async def tick(self) -> None:
        """Advance toy physics one step and write telemetry registers."""
        self._t += PHYSICS_TICK_S
        setpoint = await self.get_reg(R.REG_SETPOINT_HEATING)
        on = await self.get_reg(R.REG_ON_OFF)

        # ambient wanders slowly around 5degC with +/-6degC daily-ish swing
        self.ambient = 5.0 + 6.0 * math.sin(self._t / 600) + random.uniform(-0.3, 0.3)

        # thermostat with 2degC hysteresis, like the real control
        if on and not self.heating and self.tank < setpoint - 2:
            self.heating = True
        elif self.heating and (not on or self.tank >= setpoint + 1):
            self.heating = False

        if self.heating:
            self.tank += 0.12 * PHYSICS_TICK_S  # heat-up rate
        else:
            self.tank -= 0.008 * PHYSICS_TICK_S * max(0.2, (self.tank - self.ambient) / 30)

        outlet = self.tank + (4.5 if self.heating else 0.3) + random.uniform(-0.2, 0.2)
        inlet = self.tank - (0.5 if self.heating else 0.1) + random.uniform(-0.2, 0.2)

        # power: two stages; stage 2 (high-temp R134a) joins above 45degC outlet
        if self.heating:
            p1 = 2600 + random.uniform(-150, 150)
            p2 = (1900 + random.uniform(-120, 120)) if outlet > 45 else 0.0
        else:
            p1 = p2 = 0.0

        status = 0
        if on:
            status |= 1  # wall controller on
            status |= 1 << 6  # circulating pump
        if self.heating:
            status |= 1 << 1                      # compressor 1
            status |= (1 << 2) if p2 else 0       # compressor 2
            status |= 1 << 3                      # fan high

        await self.set_reg(R.REG_INLET_TEMP, encode(inlet))
        await self.set_reg(R.REG_OUTLET_TEMP, encode(outlet))
        await self.set_reg(R.REG_AMBIENT_TEMP, encode(self.ambient))
        await self.set_reg(R.REG_SYS1_POWER, encode(p1))
        await self.set_reg(R.REG_SYS2_POWER, encode(p2))
        await self.set_reg(R.REG_SYS1_CURRENT, encode(p1 / 240))
        await self.set_reg(R.REG_SYS2_CURRENT, encode(p2 / 240))
        await self.set_reg(R.REG_SYS1_FREQ, 65 if self.heating else 0)
        await self.set_reg(R.REG_SYS2_FREQ, 60 if p2 else 0)
        await self.set_reg(R.REG_AC_VOLTAGE, 232)
        await self.set_reg(R.REG_STATUS, status)

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
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
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
