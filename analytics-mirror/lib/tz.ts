// @purpose Eastern-time display formatting for SERVER-rendered timestamps. Vercel
// functions run in UTC, so bare toLocale* calls rendered UTC times as if local (a
// "last poll 05:50 PM" that was really 1:50 PM Eastern). Every server component
// formats through these; client components ("use client") already render in the
// viewer's browser timezone and don't need this. America/New_York auto-switches
// EST/EDT. Data stays stored in UTC — this is display-only.
export const DISPLAY_TZ = process.env.DISPLAY_TZ ?? "America/New_York";

const asDate = (d: Date | number) =>
  d instanceof Date ? d : new Date(d < 1e12 ? d * 1000 : d); // accepts epoch seconds or ms

/** "01:50 PM" */
export const fmtTime = (d: Date | number) =>
  asDate(d).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: DISPLAY_TZ });

/** "Jul 14" */
export const fmtDay = (d: Date | number) =>
  asDate(d).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: DISPLAY_TZ });

/** "Jul 14, 01:50 PM" */
export const fmtDateTime = (d: Date | number) =>
  asDate(d).toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: DISPLAY_TZ,
  });
