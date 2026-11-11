// Turns date phrases in a message ("Monday", "last Tuesday", "3 November")
// into concrete day windows in the user's timezone. Pure and deterministic:
// same text + same `now` + same timezone always gives the same answer.
//
// chrono-node finds the phrases and tells us which parts the user actually
// stated (weekday? day? month? year?). The rules for the ambiguous cases are
// ours, written out below, because they must be explainable:
//
//   "3 November" (no year)  → the most recent 3 November that is not in the future
//   "Monday" / "on Monday"  → the most recent Monday before today
//                             (if today is Monday, today is a second candidate)
//   "last Tuesday"          → the most recent Tuesday before today; if that day is
//                             in the current week, the Tuesday a week earlier is a
//                             second candidate ("last" can mean "of last week")
//   "last week"             → previous Monday–Sunday; second candidate: the past 7 days
//   "in October"            → the most recent October that has started
//   "two weeks ago"         → that exact day; second candidate: the week around it
//
// When there is more than one candidate, the caller (recall.ts) checks memory
// and uses the first candidate that has matching records.

import * as chrono from "chrono-node";
import { DateTime } from "luxon";

export interface DayWindow {
  from: string; // first local day, YYYY-MM-DD
  to: string; // last local day, YYYY-MM-DD (same as `from` for a single day)
  startUtc: string; // inclusive
  endUtc: string; // exclusive
  label: string; // "Tuesday 3 November 2026" or "Mon 2 Nov – Sun 8 Nov 2026"
  reading: string; // how the phrase was read, e.g. "the most recent Tuesday before today"
}

export interface TemporalRef {
  phrase: string; // as the user typed it
  index: number; // position in the message
  candidates: DayWindow[]; // most likely first
}

function windowOf(first: DateTime, last: DateTime, reading: string): DayWindow {
  const start = first.startOf("day");
  const end = last.startOf("day").plus({ days: 1 }); // luxon handles DST: a local day can be 23 or 25 hours
  const single = start.hasSame(last, "day");
  return {
    from: start.toISODate()!,
    to: last.toISODate()!,
    startUtc: start.toUTC().toISO()!,
    endUtc: end.toUTC().toISO()!,
    label: single ? start.toFormat("cccc d LLLL yyyy") : `${start.toFormat("ccc d LLL")} – ${last.toFormat("ccc d LLL yyyy")}`,
    reading,
  };
}
const day = (d: DateTime, reading: string) => windowOf(d, d, reading);

const FULL_WEEKDAY = /\b(mon|tues|wednes|thurs|fri|satur|sun)day\b/i;
const WEEKDAY_NAMES = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export function resolveTemporal(text: string, now: Date, tz: string): TemporalRef[] {
  const nowLocal = DateTime.fromJSDate(now, { zone: tz });
  const today = nowLocal.startOf("day");
  const refs: TemporalRef[] = [];

  // 1. Ranges, which chrono would collapse to a single day.
  for (const m of text.matchAll(/\b(last|previous|past|this)\s+(week|month)\b/gi)) {
    const [phrase, which, unit] = [m[0], m[1]!.toLowerCase(), m[2]!.toLowerCase() as "week" | "month"];
    const candidates: DayWindow[] = [];
    const span = unit === "week" ? { days: 7 } : { days: 30 };
    if (which === "this") {
      candidates.push(windowOf(today.startOf(unit), today, `this ${unit} so far`));
    } else if (which === "past") {
      candidates.push(windowOf(today.minus(span), today, `the past ${span.days} days`));
    } else {
      const prev = today.startOf(unit).minus({ [`${unit}s`]: 1 });
      candidates.push(windowOf(prev, prev.endOf(unit), `the previous calendar ${unit}`));
      candidates.push(windowOf(today.minus(span), today, `the past ${span.days} days`));
    }
    refs.push({ phrase, index: m.index, candidates });
  }
  const overlapsRange = (i: number, len: number) => refs.some((r) => i < r.index + r.phrase.length && r.index < i + len);

  // 2. Everything else, found by chrono. en.GB reads 3/11 as 3 November (day first).
  const parsed = chrono.en.GB.parse(text, { instant: now, timezone: nowLocal.offset }, { forwardDate: false });
  for (const r of parsed) {
    if (overlapsRange(r.index, r.text.length)) continue;
    const s = r.start;
    const candidates: DayWindow[] = [];

    if (s.isCertain("weekday") && !s.isCertain("day")) {
      // A weekday name. Guard against chrono reading "sat" or "sun" in ordinary sentences.
      if (!FULL_WEEKDAY.test(r.text) && !/^(on|last|this|past|previous)\s/i.test(r.text)) continue;
      if (/\bnext\b/i.test(r.text)) continue; // the future is never a memory
      const target = s.get("weekday") === 0 ? 7 : s.get("weekday")!; // chrono: 0 = Sunday; luxon: 7 = Sunday
      const name = WEEKDAY_NAMES[target]!;
      const daysBack = (today.weekday - target + 7) % 7 || 7;
      const mostRecent = today.minus({ days: daysBack });

      if (/\b(last|previous|past)\b/i.test(r.text)) {
        candidates.push(day(mostRecent, `the most recent ${name} before today`));
        if (mostRecent >= today.startOf("week")) candidates.push(day(mostRecent.minus({ days: 7 }), `the ${name} of the week before`));
      } else if (/\bthis\b/i.test(r.text) && today.weekday === target) {
        candidates.push(day(today, "today"));
      } else {
        candidates.push(day(mostRecent, `the most recent ${name} before today`));
        if (today.weekday === target) candidates.push(day(today, `today, which is a ${name}`));
      }
    } else if (s.isCertain("day") && s.isCertain("month")) {
      // A calendar date, or a relative expression chrono resolved fully ("yesterday", "3 days ago").
      let d = DateTime.fromObject({ year: s.get("year")!, month: s.get("month")!, day: s.get("day")! }, { zone: tz });
      if (!d.isValid) continue;
      let reading = "the date as written";
      if (!s.isCertain("year")) {
        d = d.set({ year: today.year });
        if (d > today) d = d.minus({ years: 1 });
        reading = `the most recent ${d.toFormat("d LLLL")}`;
      }
      candidates.push(day(d, reading));
      if (/\bweeks?\s+ago\b/i.test(r.text)) candidates.push(windowOf(d.startOf("week"), d.endOf("week"), "the week around that day"));
      if (/\bmonths?\s+ago\b/i.test(r.text)) candidates.push(windowOf(d.startOf("month"), d.endOf("month"), "that calendar month"));
    } else if (s.isCertain("month")) {
      // A month name on its own ("in October").
      let d = DateTime.fromObject({ year: s.get("year")!, month: s.get("month")!, day: 1 }, { zone: tz });
      if (!s.isCertain("year")) {
        d = d.set({ year: today.year });
        if (d > today) d = d.minus({ years: 1 });
      }
      candidates.push(windowOf(d, d.endOf("month"), `the most recent ${d.toFormat("LLLL")}`));
    } else {
      continue; // time of day only ("at 5pm"): not a date reference
    }

    refs.push({ phrase: r.text, index: r.index, candidates });
  }

  // 3. A memory cannot be in the future.
  const todayIso = today.toISODate()!;
  let out = refs
    .map((r) => ({ ...r, candidates: r.candidates.filter((c) => c.from <= todayIso) }))
    .filter((r) => r.candidates.length)
    .sort((a, b) => a.index - b.index);

  // 4. "What did I ask on 3 November? Is it still correct today?" - when an earlier
  //    date is named, "today" is the comparison point, not a second thing to look up.
  if (out.length > 1) {
    const notToday = out.filter((r) => !isToday(r, todayIso));
    if (notToday.length) out = notToday;
  }
  return out.slice(0, 3);
}

export function isToday(ref: TemporalRef, todayIso: string): boolean {
  return ref.candidates.every((c) => c.from === todayIso && c.to === todayIso);
}

export function localDate(now: Date, tz: string): string {
  return DateTime.fromJSDate(now, { zone: tz }).toISODate()!;
}
