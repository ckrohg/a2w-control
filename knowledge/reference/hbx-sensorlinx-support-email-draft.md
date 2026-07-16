# Draft email to HBX / SensorLinx support — remote config-write + post-reboot target

**Draft 2026-07-16. Do not send credentials; the questions below are safe to send as-is.**

---

**Subject:** ECO-0600 (SensorLinx WiFi): cloud config writes don't apply to operation, + target drops to 110°F after power cycle

Hello,

I have an HBX **ECO-0600** with the **SensorLinx WiFi module** (device sync code **AECO-2036**, controller firmware **2.08**). I'm building a monitoring/optimization integration against the SensorLinx cloud API (`api.sensorlinx.co`) and I've hit two behaviors I can't explain. I'd appreciate your guidance.

**1. Cloud config writes are accepted but never take effect on the device.**
When I change the hot-tank reset curve — `Max Tank Temp (dbt)` / `Min Tank Temp (mbt)` — either through the SensorLinx **iOS app** or via a `PATCH` to `/buildings/{id}/devices/AECO-2036`, the write is accepted and echoed back (the config value persists in the cloud), but the **operative target** (`temps.temp1.target`) never changes to match. I've confirmed it stays put:
- across many minutes,
- through a full heat-call cycle,
- and even after a complete power cycle of the controller.

Is remote configuration write supported on this device/firmware, or is the cloud connection read/telemetry-only? If writes are supposed to apply, is there a device setting or firmware update required to enable cloud changes to reach the controller's operating logic?

**2. After a power cycle, the operative target drops to 110°F and stays there.**
Before the power cycle, `temp1.target` read ~154°F (matching the reset curve at the current outdoor temp). After power-cycling the controller, it settles to **110°F** and holds, even though the tank is ~155°F and the curve is set to 165/145. Is 110°F an expected idle/resting value that will recompute to the curve target on the next heat call, or does a power cycle reset something in the controller? What determines `temp1.target` when no heat call is active?

Context / goal: I want to remotely lower the buffer target for efficiency (produce cooler water at higher COP). I need to understand the **supported path** to change the operative hot-tank target/curve remotely on this unit.

Thank you,
Christian

---

## Notes for us (not for the email)
- Firmware: `firmVer 2.08`, WiFi module `wVer: null`, built 2024-03-15. No update staged (`firmwareUrl: null`, `fieldFirmwareCheck: false`).
- Evidence file: `hbx-target-write-noop-diagnosis.md`. Memory: `hbx-remote-target-uncontrollable`.
- If they confirm cloud-write is unsupported → the interim-savings tank-lowering lever and the future TempIQ auto-pilot both need a different control route.
