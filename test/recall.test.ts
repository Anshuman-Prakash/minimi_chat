import assert from "node:assert/strict";
import { test } from "node:test";

process.env.DB_PATH = ":memory:"; // must be set before the store is imported
const store = await import("../src/db");
const { recall, keywords } = await import("../src/recall");
const { SourceBook } = await import("../src/sources");

const IST = "Asia/Kolkata";
const NOW = new Date("2026-11-11T08:35:00Z"); // Wednesday 11 Nov 2026, 14:05 in Kolkata

function exchange(title: string, whenUtc: string, question: string, answer: string) {
  const at = new Date(whenUtc);
  const conv = store.createConversation(title, at);
  store.addMessage(conv, "user", question, at, IST);
  return store.addMessage(conv, "assistant", answer, new Date(at.getTime() + 20_000), IST);
}

// Tuesday 3 Nov, 10:00 IST
const pg = exchange("Postgres hosting", "2026-11-03T04:30:00Z", "Compare Postgres hosting for a small SaaS: Neon, Supabase, RDS", "Neon's Launch plan is $19 a month [1]. Supabase Pro is $25 a month [2].");
store.addSources(pg, [
  { n: 1, url: "https://neon.com/pricing", title: "Neon Pricing", publishedDate: null },
  { n: 2, url: "https://supabase.com/pricing", title: "Supabase Pricing", publishedDate: null },
]);
// Monday 9 Nov
exchange("CRM shortlist", "2026-11-09T05:00:00Z", "Shortlist CRM tools for a 20-person sales team", "Four fit well: HubSpot, Pipedrive, Salesforce and Zoho.");
// Tuesday 10 Nov: mentions pricing, but is not about Postgres
exchange("Landing page", "2026-11-10T06:00:00Z", "How should I lay out a pricing page?", "Three tiers, the middle one highlighted.");

// The conversation the user is typing in now.
const current = store.createConversation("New chat", NOW);
function ask(text: string, book = new SourceBook()) {
  const messageId = store.addMessage(current, "user", text, NOW, IST);
  return recall({ text, now: NOW, tz: IST, conversationId: current, messageId }, book);
}

test("explicit date: finds what was asked that day, with its timestamp", () => {
  const r = ask("What did I ask you on 3 November? Is your answer still correct today?");
  assert.equal(r.turns.length, 1);
  assert.match(r.block!, /was read as Tuesday 3 November 2026/);
  assert.match(r.block!, /Tuesday, 3 November 2026 at 10:00 \(Asia\/Kolkata\)/);
  assert.match(r.block!, /User asked: Compare Postgres hosting/);
  assert.match(r.status!, /Checking my notes from Tuesday 3 November 2026/);
});

test('"last Tuesday" is settled by memory: yesterday has no Postgres conversation, the week before does', () => {
  const r = ask("Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?");
  assert.equal(r.turns.length, 1);
  assert.equal(r.turns[0]!.title, "Postgres hosting");
  assert.match(r.block!, /was read as Tuesday 3 November 2026 \(the Tuesday of the week before\)/);
  assert.match(r.block!, /The first reading, Tuesday 10 November 2026 .* has no conversation about: postgres, hosting, pricing/);
  assert.doesNotMatch(r.block!, /pricing page/); // the unrelated chat from 10 Nov is not dragged in
});

test("weekday: Monday's shortlist, and the record (four tools) is there to contradict the user's five", () => {
  const r = ask("On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?");
  assert.equal(r.turns[0]!.title, "CRM shortlist");
  assert.match(r.block!, /Monday 9 November 2026/);
  assert.match(r.block!, /Four fit well: HubSpot, Pipedrive, Salesforce and Zoho/);
});

test("no conversation on that date: an explicit NO RECORD, nothing invented", () => {
  const r = ask("What did I ask you on 1 January?");
  assert.equal(r.turns.length, 0);
  assert.match(r.block!, /NO RECORD FOUND/);
  assert.doesNotMatch(r.block!, /Nearby/);
});

test("a day off: still NO RECORD for the date asked, neighbours offered as nearby", () => {
  const r = ask("What did I ask you on 4 November?");
  assert.match(r.block!, /NO RECORD FOUND/);
  assert.match(r.block!, /Nearby, NOT on the date asked/);
  assert.equal(r.turns[0]!.title, "Postgres hosting");
});

test("a date that is not about us triggers no lookup", () => {
  assert.equal(ask("What happened on 3 November in the US election?").block, null);
  assert.equal(ask("What is the capital of France?").block, null);
  assert.equal(ask("What's the weather like today?").block, null);
});

test("no date, but a reference to an earlier conversation: lookup by topic", () => {
  const r = ask("What did you tell me about Supabase last time?");
  assert.equal(r.turns[0]!.title, "Postgres hosting");
  assert.match(r.block!, /Lookup by topic \(supabase\)/);
});

test("reference to the past with no matching topic: recent conversations, labelled as such", () => {
  const r = ask("Do you remember what I asked about Kubernetes?");
  assert.match(r.block!, /nothing matched/);
  assert.equal(r.turns.length, 3);
});

test("recalled citations are renumbered into the current conversation's numbering", () => {
  // The current conversation has already used [1] and [2] for other pages.
  const book = new SourceBook([
    { n: 1, url: "https://example.com/a", title: "A", publishedDate: null },
    { n: 2, url: "https://example.com/b", title: "B", publishedDate: null },
  ]);
  const r = ask("What did I ask you on 3 November?", book);
  assert.match(r.block!, /Launch plan is \$19 a month \[3\]\. Supabase Pro is \$25 a month \[4\]/);
  assert.match(r.block!, /\[3\] Neon Pricing - https:\/\/neon\.com\/pricing/);
  assert.deepEqual(book.all().map((s) => s.n), [1, 2, 3, 4]);
});

test("keywords drop stop-words, numbers and the date phrase", () => {
  assert.deepEqual(keywords("What did I ask you about Postgres hosting?"), ["postgres", "hosting"]);
});
