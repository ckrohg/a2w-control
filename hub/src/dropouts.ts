/**
 * @purpose Pi-link dropout episodes for the hub (#166, eval 2026-10-18 F1).
 *
 * The hub used to log `Pi connected` / `Pi disconnected` as isolated lines, so a three-hour
 * outage read as two lines two hours apart and nothing downstream (deploy gate, drift-check)
 * could see it. This module turns the connect/disconnect transitions into EPISODES — one
 * {start, end, minutes} per dropout — kept in memory only (the hub has no database by
 * design) and pruned to a rolling window.
 *
 * Pure: no timers, no sockets, no I/O. The clock is injected so the tests can drive time.
 * The caller (index.ts) decides what a transition is; this module only guarantees that
 *   - a disconnect while already disconnected is a no-op (the "missed pong — terminating"
 *     path fires `close` once, but belt and braces: it can never open two episodes), and
 *   - a connect while already connected is a no-op (a replacement socket arriving while the
 *     old one is still open is NOT a dropout — the Pi never lost the hub).
 *
 * Minutes are reported to one decimal so a 15-second flap (0.3 min) stays distinguishable
 * from a real 2–3 h dropout (130 min) — the two symptoms F1 asks us to tell apart.
 *
 * Counters reset on every hub boot; `tracking_since` says how much of the window the
 * numbers actually cover, so "0 dropouts" five minutes after a deploy is not misread as a
 * clean day.
 */

export interface Dropout {
  /** ISO-8601 (UTC) instant the hub lost the Pi. */
  start: string;
  /** ISO-8601 (UTC) instant the Pi came back. */
  end: string;
  /** Duration in minutes, one decimal. */
  minutes: number;
}

export interface DropoutStats {
  /** Episodes that ENDED within the last 24 h. Integer — drift-check compares it with -le. */
  pi_dropouts_24h: number;
  /** Episodes that ended within the last 7 d (cheap: the list is pruned to 7 d anyway). */
  pi_dropouts_7d: number;
  /** Longest closed episode in the 24 h window, minutes (0 when none). */
  longest_dropout_min: number;
  /** The most recent closed episode, or null if none in the 7 d window. */
  last_dropout: Dropout | null;
  /** Minutes since the Pi was lost, while disconnected; null while connected. */
  current_dropout_min: number | null;
  /** ISO-8601 instant this tracker started (hub boot) — the window's real lower bound. */
  tracking_since: string;
}

export interface DropoutTracker {
  /** The Pi link is up. Returns the episode this connect closed, or null if none was open. */
  connected(): Dropout | null;
  /** The Pi link is down. Returns true if this opened a new episode. */
  disconnected(): boolean;
  /** Point-in-time counters for /health. */
  snapshot(): DropoutStats;
}

export const WINDOW_24H_MS = 24 * 60 * 60 * 1000;
export const WINDOW_7D_MS = 7 * WINDOW_24H_MS;

/** Milliseconds → minutes, one decimal, never negative. */
export function toMinutes(ms: number): number {
  return Math.max(0, Math.round(ms / 6_000) / 10);
}

interface Episode {
  startMs: number;
  endMs: number;
}

/**
 * @param now  clock returning epoch milliseconds (defaults to Date.now).
 */
export function createDropoutTracker(now: () => number = Date.now): DropoutTracker {
  const trackingSinceMs = now();
  /** Closed episodes, oldest first, pruned to the 7 d window on every mutation/read. */
  let episodes: Episode[] = [];
  /** Start of the open episode, or null while connected (and before the first connect —
   *  the hub boots with no Pi, and that initial wait is not a dropout). */
  let openSinceMs: number | null = null;
  let linkUp = false;

  const prune = (t: number): void => {
    const cutoff = t - WINDOW_7D_MS;
    // Episodes are appended in end order, so the first one still inside the window bounds them all.
    let i = 0;
    while (i < episodes.length && episodes[i].endMs <= cutoff) i++;
    if (i > 0) episodes = episodes.slice(i);
  };

  const toDropout = (e: Episode): Dropout => ({
    start: new Date(e.startMs).toISOString(),
    end: new Date(e.endMs).toISOString(),
    minutes: toMinutes(e.endMs - e.startMs),
  });

  return {
    connected(): Dropout | null {
      if (linkUp) return null; // replacement socket: the Pi never left
      linkUp = true;
      if (openSinceMs === null) return null; // first connect after boot
      const t = now();
      const e: Episode = { startMs: openSinceMs, endMs: Math.max(openSinceMs, t) };
      openSinceMs = null;
      episodes.push(e);
      prune(t);
      return toDropout(e);
    },

    disconnected(): boolean {
      if (!linkUp) return false; // already down (or never up): never open a second episode
      linkUp = false;
      openSinceMs = now();
      return true;
    },

    snapshot(): DropoutStats {
      const t = now();
      prune(t);
      const cutoff24h = t - WINDOW_24H_MS;
      let n24 = 0;
      let longestMs = 0;
      for (const e of episodes) {
        if (e.endMs <= cutoff24h) continue; // "ended less than 24 h ago": the boundary itself is out
        n24++;
        const len = e.endMs - e.startMs;
        if (len > longestMs) longestMs = len;
      }
      const last = episodes.length ? episodes[episodes.length - 1] : null;
      return {
        pi_dropouts_24h: n24,
        pi_dropouts_7d: episodes.length,
        longest_dropout_min: toMinutes(longestMs),
        last_dropout: last ? toDropout(last) : null,
        current_dropout_min: openSinceMs === null ? null : toMinutes(t - openSinceMs),
        tracking_since: new Date(trackingSinceMs).toISOString(),
      };
    },
  };
}
