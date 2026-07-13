#!/usr/bin/env python3
# @purpose: Definitive pump-side diagnostic — FTDI dongle wired DIRECTLY to the pump's
# CN22 (pin2=GND, pin3=A, pin4=B), zero intermediaries (no W610, no wire run). Sweeps the
# full dialect space locally: every serial config (2400/9600/4800 x N/E/O parity) x slave
# address 1-16 x CRC variant (std Modbus + CCITT family, both byte orders) x FC03/FC04.
# Serial reopens are instant, so the whole matrix takes ~10-15 min. READ-ONLY (FC03/04).
#
#   .venv/bin/python deploy/cn22-direct-probe.py /dev/tty.usbserial-BG03FZ46
#
# Interpretation:
#   ANY reply  -> the pump speaks; the printed (serial, addr, crc, fc) IS its dialect.
#                 Fault was the run/gateway; configure everything to the found dialect.
#   All silent -> the pump's BMS port itself isn't answering: board-revision/enable
#                 question for Winnie (send series number MAHRW030ZA/BEH2), or a dead port.
import itertools
import sys
import time

try:
    import serial
except ImportError:
    sys.exit("pyserial missing — run via the project venv: .venv/bin/python deploy/cn22-direct-probe.py <dev>")


def crc_reflected(data: bytes, poly: int, init: int, xorout: int) -> int:
    c = init
    for b in data:
        c ^= b
        for _ in range(8):
            c = (c >> 1) ^ poly if c & 1 else c >> 1
    return c ^ xorout


def crc_nonreflected(data: bytes, poly: int, init: int) -> int:
    c = init
    for b in data:
        c ^= b << 8
        for _ in range(8):
            c = ((c << 1) ^ poly if c & 0x8000 else c << 1) & 0xFFFF
    return c


def variants(body: bytes):
    std = crc_reflected(body, 0xA001, 0xFFFF, 0)
    x25 = crc_reflected(body, 0x8408, 0xFFFF, 0xFFFF)
    kermit = crc_reflected(body, 0x8408, 0x0000, 0)
    cfalse = crc_nonreflected(body, 0x1021, 0xFFFF)
    xmodem = crc_nonreflected(body, 0x1021, 0x0000)
    return [("std-LE", std, "little"), ("x25-LE", x25, "little"), ("x25-BE", x25, "big"),
            ("ccittF-BE", cfalse, "big"), ("ccittF-LE", cfalse, "little"),
            ("xmodem-BE", xmodem, "big"), ("xmodem-LE", xmodem, "little"),
            ("kermit-LE", kermit, "little"), ("kermit-BE", kermit, "big")]


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit("usage: cn22-direct-probe.py /dev/tty.usbserial-XXXX")
    dev = sys.argv[1]
    # (baud, parity) in likelihood order; doc says 2400-N. Each takes ~45-90s to sweep.
    serial_configs = [(2400, "N"), (2400, "E"), (9600, "N"), (9600, "E"),
                      (4800, "N"), (2400, "O"), (19200, "N")]
    hits = []
    for baud, par in serial_configs:
        print(f"\n=== {baud} 8{par}1 ===", flush=True)
        with serial.Serial(dev, baud, bytesize=8, parity=par, stopbits=1, timeout=0.9) as s:
            s.reset_input_buffer()
            # passive listen first: an active (wrong) bus chatters
            time.sleep(1.2)
            noise = s.read(64)
            if noise:
                print(f"  [listen] bus chatter at this rate: {noise.hex(' ')}", flush=True)
            for addr, fc in itertools.product(range(1, 17), (0x03, 0x04)):
                body = bytes([addr, fc]) + (2050).to_bytes(2, "big") + (1).to_bytes(2, "big")
                for name, crc, order in variants(body):
                    s.reset_input_buffer()
                    s.write(body + crc.to_bytes(2, order))
                    s.flush()
                    reply = s.read(16)
                    if reply:
                        print(f"  *** REPLY *** addr={addr} fc={fc:#04x} crc={name} "
                              f"@ {baud}8{par}1: {reply.hex(' ')}", flush=True)
                        hits.append((baud, par, addr, fc, name, reply.hex(" ")))
                if fc == 0x04 and addr % 4 == 0:
                    print(f"  addr <= {addr}: silent so far", flush=True)
        if hits:
            break
    print("\n=== VERDICT ===", flush=True)
    if hits:
        b, p, a, f, c, r = hits[0]
        print(f"PUMP SPEAKS: {b} 8{p}1, address {a}, fc {f:#04x}, CRC {c}")
        print(f"first reply: {r}")
        print("-> The pump + protocol are fine. The fault is the wire run or the W610.")
        if (b, p, a, c) != (2400, "N", 1, "std-LE"):
            print("-> NOTE: dialect differs from our assumptions — bridge/W610 need matching config!")
    else:
        print("Pump silent even DIRECT at CN22 across the full matrix.")
        print("-> Pump-side issue: board revision / BMS enable / dead port.")
        print("-> Next: email Winnie with series number MAHRW030ZA/BEH2 + this evidence.")


if __name__ == "__main__":
    main()
