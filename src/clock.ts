// The only place the app reads the wall clock. Everything else takes `now`
// from here, so NOW_OVERRIDE can move the whole app to another date.

import { config } from "./config";

// With NOW_OVERRIDE the clock starts at that instant and keeps ticking, so
// messages written during a faked session still have increasing timestamps.
const offsetMs = (() => {
  if (!config.nowOverride) return 0;
  const t = Date.parse(config.nowOverride);
  if (Number.isNaN(t)) throw new Error(`NOW_OVERRIDE is not a valid date: ${config.nowOverride}`);
  return t - Date.now();
})();

export function now(): Date {
  return new Date(Date.now() + offsetMs);
}

export function isValidTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** "Wednesday, 11 November 2026, 14:05" in the given timezone. */
export function formatLocal(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}
