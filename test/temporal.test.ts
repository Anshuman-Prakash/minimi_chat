import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveTemporal } from "../src/temporal";

const IST = "Asia/Kolkata";
const WED = new Date("2026-11-11T08:35:00Z"); // Wednesday 11 Nov 2026, 14:05 in Kolkata
const MON = new Date("2026-11-09T08:35:00Z"); // Monday 9 Nov 2026
const SUN = new Date("2026-11-15T08:35:00Z"); // Sunday 15 Nov 2026

/** "phrase: date[/date...]" per reference, e.g. ["last Tuesday: 2026-11-10/2026-11-03"]. */
const days = (text: string, now = WED, tz = IST) =>
  resolveTemporal(text, now, tz).map((r) => `${r.phrase}: ${r.candidates.map((c) => (c.from === c.to ? c.from : `${c.from}..${c.to}`)).join("/")}`);

test("the three sample questions", () => {
  assert.deepEqual(days("On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?"), [
    "On Monday: 2026-11-09",
  ]);
  // "today" is the comparison point here, not a second lookup.
  assert.deepEqual(days("What did I ask you on 3 November? Is your answer still correct today?"), ["on 3 November: 2026-11-03"]);
  // Yesterday was a Tuesday, so "last Tuesday" has two readings; recall picks using memory.
  assert.deepEqual(days("Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"), ["Last Tuesday: 2026-11-10/2026-11-03"]);
});

test("bare weekday: most recent one before today; today is the alternate when it matches", () => {
  assert.deepEqual(days("what did we decide on Friday"), ["on Friday: 2026-11-06"]);
  assert.deepEqual(days("on Monday we shortlisted tools", MON), ["on Monday: 2026-11-02/2026-11-09"]);
  assert.deepEqual(days("this Wednesday I asked about X"), ["this Wednesday: 2026-11-11"]);
});

test('"last <weekday>": alternate only when the most recent one falls in the current week', () => {
  assert.deepEqual(days("last Tuesday", MON), ["last Tuesday: 2026-11-03"]); // 6 days ago, already last week
  assert.deepEqual(days("last Friday", WED), ["last Friday: 2026-11-06"]);
  assert.deepEqual(days("last Tuesday", SUN), ["last Tuesday: 2026-11-10/2026-11-03"]);
});

test("explicit dates", () => {
  assert.deepEqual(days("what happened on 25 December"), ["on 25 December: 2025-12-25"]); // not yet reached this year
  assert.deepEqual(days("on Nov 3rd 2025 you said"), ["Nov 3rd 2025: 2025-11-03"]);
  assert.deepEqual(days("on 3/11 I asked"), ["3/11: 2026-11-03"]); // day first
  assert.deepEqual(days("on 11 November I asked"), ["on 11 November: 2026-11-11"]); // today counts as "not in the future"
});

test("relative expressions and ranges", () => {
  assert.deepEqual(days("what did we talk about yesterday"), ["yesterday: 2026-11-10"]);
  assert.deepEqual(days("two weeks ago you said X"), ["two weeks ago: 2026-10-28/2026-10-26..2026-11-01"]);
  assert.deepEqual(days("last week we compared CRMs"), ["last week: 2026-11-02..2026-11-08/2026-11-04..2026-11-11"]);
  assert.deepEqual(days("in October you told me"), ["October: 2026-10-01..2026-10-31"]);
  assert.deepEqual(days("last month we spoke"), ["last month: 2026-10-01..2026-10-31/2026-10-12..2026-11-11"]);
});

test("things that are not date references", () => {
  assert.deepEqual(days("I sat down in the sun and may ask something"), []);
  assert.deepEqual(days("remind me next Friday"), []);
  assert.deepEqual(days("at 5pm we met"), []);
  assert.deepEqual(days("shortlist 5 CRM tools for a 20-person team"), []);
});

test('"today" alone is kept; the caller decides whether it is a memory question', () => {
  assert.deepEqual(days("what did I ask you earlier today"), ["today: 2026-11-11"]);
});

test("the same instant is a different local day in different timezones", () => {
  const instant = new Date("2026-11-11T20:00:00Z"); // 12 Nov 01:30 in Kolkata, 11 Nov 12:00 in Los Angeles
  assert.deepEqual(days("yesterday", instant, IST), ["yesterday: 2026-11-11"]);
  assert.deepEqual(days("yesterday", instant, "America/Los_Angeles"), ["yesterday: 2026-11-10"]);
  assert.deepEqual(days("on Monday", instant, IST), ["on Monday: 2026-11-09"]);
});

test("windows are local days expressed in UTC, including DST days", () => {
  const [ist] = resolveTemporal("on 3 November", WED, IST);
  assert.equal(ist!.candidates[0]!.startUtc, "2026-11-02T18:30:00.000Z");
  assert.equal(ist!.candidates[0]!.endUtc, "2026-11-03T18:30:00.000Z");
  assert.equal(ist!.candidates[0]!.label, "Tuesday 3 November 2026");

  // 1 Nov 2026 is the day US clocks go back: that local day is 25 hours long.
  const [ny] = resolveTemporal("on 1 November", WED, "America/New_York");
  assert.equal(ny!.candidates[0]!.startUtc, "2026-11-01T04:00:00.000Z");
  assert.equal(ny!.candidates[0]!.endUtc, "2026-11-02T05:00:00.000Z");
});
