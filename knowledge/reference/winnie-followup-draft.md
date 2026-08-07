# Draft: follow-up to Winnie (Guangdong Macon) — owed items + winter questions

Status: DRAFT for the owner to review/send (2026-08-06). Winnie's last reply
(`winnie-bms-port-reply.md`, 2026-07-07) answered the BMS port questions; we still owe her
the serial number and the forced-defrost question, and HP2's July fault adds one more.

---

Hi Winnie,

Thank you again for the BMS port details — the CN22 connection is working well and we have
both units on Modbus monitoring now.

Following up on the items you asked about, plus two questions before the heating season:

1. **Serial numbers** (you asked for these): our two units are model MAHRW030ZA/BEH2,
   serial numbers: [OWNER: read from the nameplates — unit 1: ______, unit 2: ______].

2. **Forced defrost**: is there a Modbus register (or button sequence) to manually trigger
   a defrost cycle? We'd like the ability to test defrost behavior before winter, and to
   clear ice in an emergency without power-cycling.

3. **Fault E21**: unit 2 reported fault code E21 continuously from about July 23 to
   August 6, then cleared. The unit now runs normally. Could you tell us:
   - What does E21 mean on this model, and what conditions trigger it?
   - Does it derate or lock out the compressor while active?
   - Is it expected to self-clear, and should we service anything given it persisted for
     two weeks? (We want to rule out a winter failure-to-start risk.)

4. **Low-ambient operation**: at what outdoor temperature does the unit stop producing
   its rated 55 °C leaving-water temp, and is there a published capacity/COP derate table
   for -15 °C to +5 °C ambient we could use in our control planning?

Thanks!

---

Notes for the owner (not part of the email):
- Item 4 is opportunistic — a real derate table would replace the Carnot-extrapolated COP
  model in the winter DP (`winterdp.ts` copAt) with manufacturer data.
- E21 context: zero fault events since Aug 6; comm flapping since Aug 5 is OUR side (#76),
  unrelated — don't conflate them in the email.
