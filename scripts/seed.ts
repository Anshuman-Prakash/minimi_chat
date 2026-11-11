// npm run seed: loads past conversations dated relative to today (or NOW_OVERRIDE).
// Safe to re-run: it replaces what it created before and leaves your own chats alone.

import { now } from "../src/clock";
import { config } from "../src/config";
import { seed } from "./seed-data";

const tz = process.env.DEFAULT_TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
const seeded = seed(now(), tz);

console.log(`Seeded ${seeded.length} past conversations into ${config.dbPath} (timezone ${tz}):\n`);
for (const s of seeded) console.log(`  ${s.localDate.padEnd(28)} ${s.title}`);
console.log(`
Start the app (npm run dev) and try:
  • On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?
  • What did I ask you on 3 November? Is your answer still correct today?
  • Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?
  • What did I ask you on 1 January?            (nothing stored: it should say so)
`);
