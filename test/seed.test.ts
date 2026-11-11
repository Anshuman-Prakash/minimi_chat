import assert from "node:assert/strict";
import { test } from "node:test";

process.env.DB_PATH = ":memory:"; // must be set before the store is imported
const store = await import("../src/db");
const { recall } = await import("../src/recall");
const { SourceBook } = await import("../src/sources");
const { seed } = await import("../scripts/seed-data");

const TZ = "Asia/Kolkata";

function ask(text: string, now: Date) {
  const conv = store.createConversation("New chat", now);
  const messageId = store.addMessage(conv, "user", text, now, TZ);
  return recall({ text, now, tz: TZ, conversationId: conv, messageId }, new SourceBook());
}

// Whatever day a reviewer runs `npm run seed`, the sample questions must find their conversation.
for (let offset = 0; offset < 7; offset++) {
  const now = new Date(Date.parse("2026-11-11T08:35:00Z") + offset * 24 * 3600_000);
  const dayName = now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short", timeZone: TZ });

  test(`seeded on ${dayName}: the three sample questions each recall the right conversation`, () => {
    store.db.exec("DELETE FROM conversations"); // each simulated day starts from an empty memory
    seed(now, TZ);
    const titles = (text: string) => ask(text, now).turns.map((t) => t.title);

    assert.deepEqual(titles("On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?"), [
      "CRM shortlist for a 20-person sales team",
    ]);
    assert.ok(titles("What did I ask you on 3 November? Is your answer still correct today?").includes("Vercel Pro pricing"));
    assert.deepEqual(titles("Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"), ["Managed Postgres hosting for a small SaaS"]);
    assert.deepEqual(titles("What did I ask you on 1 January?"), []);
  });
}

test("re-seeding replaces the seeded conversations and leaves the user's own alone", () => {
  const now = new Date("2026-11-11T08:35:00Z");
  store.db.exec("DELETE FROM conversations");
  const mine = store.createConversation("My own chat", now);
  store.addMessage(mine, "user", "hello", now, TZ);
  seed(now, TZ);
  seed(now, TZ);
  const titles = store.listConversations().map((c) => c.title);
  assert.equal(titles.length, 5); // 4 seeded (not 8) + mine
  assert.ok(titles.includes("My own chat"));
});
