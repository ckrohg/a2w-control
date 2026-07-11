#!/usr/bin/env python3
# @purpose: Bench diagnostic for the register map's CRC doubt. Macon's protocol doc claims
# CRC-16/X25 (CCITT poly), which is almost certainly a doc error for standard Modbus CRC-16 —
# but if the doc were RIGHT, the bridge's symptom would be pure timeouts, identical to swapped
# A/B, wrong baud, or a wrong slave address. This script splits that diagnosis in one shot:
# it sends the same FC03 read (regs 2050-2052, device 1) through the W610 twice, once with
# each CRC, and reports which one the pump answers.
#
#   python3 crc-probe.py <w610-ip> [port=8899] [device_id=1]
#
# Interpretation:
#   standard answers          -> all good, the doc was wrong (expected outcome)
#   X25 answers               -> firmware really uses X25: STOP, report back — the bridge's
#                                framer needs a custom CRC before anything will work
#   NEITHER answers           -> not a CRC problem: check RS-485-vs-232 mode on the W610,
#                                repeater baud, A/B swap, slave address, CN22 seating
#   both answer               -> pump ignores CRC entirely (also fine — standard wins)
# Zero dependencies (raw TCP socket) — runs on the Pi or any laptop on the LAN.
import socket
import sys


def crc16_modbus(data: bytes) -> bytes:
    """Standard Modbus CRC-16 (poly 0xA001 reflected), little-endian on the wire."""
    crc = 0xFFFF
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return crc.to_bytes(2, "little")


def crc16_x25(data: bytes) -> bytes:
    """CRC-16/X25 (CCITT poly 0x8408 reflected, init 0xFFFF, xorout 0xFFFF) — what the
    protocol doc literally describes. Byte order chosen little-endian to mirror Modbus."""
    crc = 0xFFFF
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = (crc >> 1) ^ 0x8408 if crc & 1 else crc >> 1
    return (crc ^ 0xFFFF).to_bytes(2, "little")


def probe(host: str, port: int, frame: bytes, label: str) -> bool:
    print(f"\n--> {label}: {frame.hex(' ')}")
    try:
        with socket.create_connection((host, port), timeout=5) as s:
            s.settimeout(6)  # 2400 baud: response trickles in over ~0.2s; wait generously
            s.sendall(frame)
            chunks = []
            try:
                while True:
                    chunk = s.recv(256)
                    if not chunk:
                        break
                    chunks.append(chunk)
                    s.settimeout(1.0)  # got first bytes; short-wait for the tail
            except socket.timeout:
                pass
            reply = b"".join(chunks)
    except OSError as exc:
        print(f"    connect/send failed: {exc} (wrong IP/port, W610 off WiFi, or its "
              f"single client slot is taken — stop the bridge first!)")
        return False
    if reply:
        print(f"<-- {len(reply)} bytes: {reply.hex(' ')}   << PUMP ANSWERED")
        return True
    print("<-- silence (no reply within timeout)")
    return False


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit(__doc__ or "usage: crc-probe.py <w610-ip> [port] [device_id]")
    host = sys.argv[1]
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 8899
    dev = int(sys.argv[3]) if len(sys.argv) > 3 else 1
    # FC03 read holding registers 2050 count 3 (inlet/outlet/ambient)
    body = bytes([dev, 0x03]) + (2050).to_bytes(2, "big") + (3).to_bytes(2, "big")
    print(f"probing {host}:{port} device {dev} — FC03 read 2050 x3, both CRC flavors")
    print("NOTE: stop the bridge first (sudo systemctl stop heatpump-bridge) — the W610's")
    print("      single client slot must be free for this script to connect.")
    std = probe(host, port, body + crc16_modbus(body), "standard Modbus CRC-16")
    x25 = probe(host, port, body + crc16_x25(body), "CRC-16/X25 (doc's claim)")
    print("\n=== verdict ===")
    if std and not x25:
        print("standard CRC answered -> doc was wrong as suspected; the bridge will work as-is.")
    elif x25 and not std:
        print("X25 answered, standard did not -> the doc was RIGHT. STOP: the bridge needs a")
        print("custom CRC in its framer before anything will work. Report this finding.")
    elif std and x25:
        print("both answered -> pump tolerates either CRC; the bridge (standard) will work.")
    else:
        print("NEITHER answered -> not a CRC issue. Triage: RS-485 (not 232) selected on the")
        print("W610? repeater supports 2400 baud? A/B swapped? slave address? CN22 seated?")


if __name__ == "__main__":
    main()
