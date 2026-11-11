// npm run eval [-- --judge] [-- --only <name>]
// Runs the sample questions and edge cases through the real pipeline against a
// fresh, seeded database, and prints latency, cheap deterministic checks, and
// the answers. With --judge, the answer model also grades each answer.

import { rmSync } from "node:fs";
import { DateTime } from "luxon";
import { z } from "zod";

process.env.DB_PATH = "data/eval.db"; // must be set before the store is imported
for (const suffix of ["", "-wal", "-shm"]) rmSync(`data/eval.db${suffix}`, { force: true });

const { runTurn } = await import("../src/agent");
const { now } = await import("../src/clock");
const { config, unsetKeys } = await import("../src/config");
const { anthropic } = await import("../src/llm");
const { citedNumbers } = await import("../src/sources");
const { seed } = await import("./seed-data");
type Timings = import("../src/agent").Timings;

if (unsetKeys().length) {
  console.error(`Missing ${unsetKeys().join(", ")}. The eval calls the real APIs; add the keys to .env first.`);
  process.exit(1);
}

const tz = process.env.DEFAULT_TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
const today = DateTime.fromJSDate(now(), { zone: tz });
const weekAgo = today.minus({ days: 7 });
seed(now(), tz);

interface Result {
  answer: string;
  error: string | null;
  timings: Timings | null;
  firstStatusMs: number;
  conversationId: number;
}
interface Case {
  name: string;
  /** One or more messages sent in the same conversation; the last one is the one graded. */
  messages: string[];
  /** What a good answer does, for the reader and for the judge. */
  expect: string;
  checks: (r: Result) => [string, boolean][];
}

const mentions = (text: string, names: string[]) => names.filter((n) => text.toLowerCase().includes(n.toLowerCase())).length;
const cites = (r: Result) => citedNumbers(r.answer).size > 0;
const NO_RECORD = /no record|don'?t have|do not have|couldn'?t find|could not find|nothing (stored|recorded|on record)|no conversation/i;
const CRMS = ["HubSpot", "Salesforce", "Close", "Attio", "Freshsales"];

const cases: Case[] = [
  {
    name: "sample-1-crm-monday",
    messages: ["On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?"],
    expect: "Recalls Monday's shortlist of five named CRMs, checks each against current sources, and reports per tool: changed / unchanged / couldn't verify, with citations. States the date it took 'Monday' to mean.",
    checks: (r) => [
      ["recalled the conversation", (r.timings?.recalled ?? 0) >= 1],
      ["ran as re-verification", r.timings?.mode === "reverify"],
      ["names at least 4 of the 5 CRMs", mentions(r.answer, CRMS) >= 4],
      ["has citations", cites(r)],
    ],
  },
  {
    name: "sample-2-3-november",
    messages: ["What did I ask you on 3 November? Is your answer still correct today?"],
    expect: "Says what was asked on 3 November (Vercel Pro pricing) and what was answered, then verifies it against today's sources and says whether it still holds, with citations.",
    checks: (r) => [
      ["recalled the conversation", (r.timings?.recalled ?? 0) >= 1],
      ["mentions Vercel", mentions(r.answer, ["Vercel"]) === 1],
      ["searched or re-fetched", r.timings?.mode !== "direct"],
      ["has citations", cites(r)],
    ],
  },
  {
    name: "sample-3-postgres-last-tuesday",
    messages: ["Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"],
    expect: "Recalls the Postgres hosting conversation (Neon, Supabase), re-checks the prices, and flags that Neon's Launch pricing is no longer a $19/month minimum. Says which Tuesday it used.",
    checks: (r) => [
      ["recalled the conversation", (r.timings?.recalled ?? 0) >= 1],
      ["ran as re-verification", r.timings?.mode === "reverify"],
      ["mentions Neon and Supabase", mentions(r.answer, ["Neon", "Supabase"]) === 2],
      ["has citations", cites(r)],
    ],
  },
  {
    name: "no-memory-for-date",
    messages: ["What did I ask you on 1 January?"],
    expect: "Says plainly that there is no record of a conversation on 1 January. Invents nothing. Does not search.",
    checks: (r) => [
      ["says there is no record", NO_RECORD.test(r.answer)],
      ["did not search", r.timings?.searches === 0],
      ["recalled nothing", r.timings?.recalled === 0],
    ],
  },
  {
    name: "ambiguous-weekday",
    messages: [`On ${today.toFormat("cccc")} I asked you about Cloudflare Workers pricing. What did you tell me?`],
    expect: `'${today.toFormat("cccc")}' could mean today or a week ago. The record is from ${weekAgo.toFormat("d LLLL")}; the answer reports that conversation and states the date it used.`,
    checks: (r) => [
      ["recalled the conversation", (r.timings?.recalled ?? 0) >= 1],
      ["mentions the $5 minimum", r.answer.includes("$5")],
      ["states the date used", r.answer.includes(String(weekAgo.day)) && r.answer.includes(weekAgo.toFormat("LLL"))],
    ],
  },
  {
    name: "count-mismatch",
    messages: ["On Monday we shortlisted 7 CRM tools. Which one was the cheapest?"],
    expect: "Points out that the record shows five tools, not seven, lists or uses those five, and answers from the record (Freshsales Pro at $39 was the cheapest listed).",
    checks: (r) => [
      ["corrects the count to five", /\bfive\b|\b5\b/i.test(r.answer)],
      ["names Freshsales", mentions(r.answer, ["Freshsales"]) === 1],
    ],
  },
  {
    name: "follow-up-them",
    messages: [
      "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Which ones were they?",
      "Which of them has a free plan?",
    ],
    expect: "Understands 'them' as the five shortlisted CRMs from the previous turn and answers per tool, citing sources for anything it looked up.",
    checks: (r) => [["names at least 2 of the CRMs", mentions(r.answer, CRMS) >= 2]],
  },
  {
    name: "plain-factual",
    messages: ["What is the capital of Australia?"],
    expect: "Canberra, in a sentence. No search, no memory lookup.",
    checks: (r) => [
      ["says Canberra", r.answer.includes("Canberra")],
      ["did not search", r.timings?.searches === 0],
      ["short answer", r.answer.length < 400],
    ],
  },
  {
    name: "chit-chat",
    messages: ["hey, how's it going?"],
    expect: "A short, friendly reply. No search, no memory lookup.",
    checks: (r) => [
      ["did not search", r.timings?.searches === 0],
      ["recalled nothing", r.timings?.recalled === 0],
      ["short answer", r.answer.length < 400],
    ],
  },
  {
    name: "fresh-search",
    messages: ["What's the latest stable release of Node.js, and when did it come out?"],
    expect: "Searches, gives the current version and its release date, and cites a primary source (nodejs.org).",
    checks: (r) => [
      ["searched", (r.timings?.searches ?? 0) >= 1],
      ["has citations", cites(r)],
    ],
  },
];

async function ask(text: string, conversationId?: number): Promise<Result> {
  const started = performance.now();
  const r: Result = { answer: "", error: null, timings: null, firstStatusMs: -1, conversationId: conversationId ?? 0 };
  const { background } = await runTurn(
    { text, tz, conversationId },
    (e) => {
      if (e.type === "status" && r.firstStatusMs < 0) r.firstStatusMs = Math.round(performance.now() - started);
      if (e.type === "delta") r.answer += e.text;
      if (e.type === "reset") r.answer = "";
      if (e.type === "done") { r.timings = e.timings; r.conversationId = e.conversationId; }
      if (e.type === "error") { r.error = e.message; r.conversationId = e.conversationId; }
    },
    new AbortController().signal,
  );
  await background; // so a follow-up message can rely on stored facts
  return r;
}

const JudgeSchema = z.object({
  correct_behavior: z.number().describe("1-5: does the answer do what the expected behavior describes?"),
  honesty: z.number().describe("1-5: no invented recollections or facts; uncertainty stated"),
  directness: z.number().describe("1-5: leads with the answer, no padding"),
  notes: z.string().describe("One or two sentences on the biggest problem, or 'none'"),
});

async function judge(c: Case, r: Result) {
  const res = await anthropic().messages.parse({
    model: config.answerModel,
    max_tokens: 2000,
    output_config: { effort: "low", format: (await import("@anthropic-ai/sdk/helpers/zod")).zodOutputFormat(JudgeSchema) },
    system: "You grade answers from a chat assistant that has web search and a memory of past conversations. Grade strictly against the expected behavior. You cannot check live facts; grade behavior, not whether a price is right.",
    messages: [{ role: "user", content: `<question>\n${c.messages.at(-1)}\n</question>\n\n<expected_behavior>\n${c.expect}\n</expected_behavior>\n\n<answer>\n${r.answer}\n</answer>` }],
  });
  return res.parsed_output;
}

const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
const useJudge = args.includes("--judge");
const selected = cases.filter((c) => !only || c.name.includes(only));

console.log(`Eval: ${selected.length} cases · now = ${today.toFormat("cccc d LLLL yyyy, HH:mm")} (${tz}) · answer model ${config.answerModel} · fast model ${config.fastModel}\n`);

const rows: Record<string, string | number>[] = [];
let failures = 0;
for (const c of selected) {
  let r: Result | undefined;
  for (const text of c.messages) r = await ask(text, r?.conversationId || undefined);
  const result = r!;
  const checks = result.error ? [["no error", false] as [string, boolean]] : c.checks(result);
  const failed = checks.filter(([, ok]) => !ok);
  failures += failed.length;
  const grade = useJudge && !result.error ? await judge(c, result).catch(() => null) : null;

  console.log(`━━ ${c.name}`);
  console.log(`Q: ${c.messages.join("\n   then: ")}`);
  console.log(`Expected: ${c.expect}`);
  for (const [label, ok] of checks) console.log(`  ${ok ? "✓" : "✗"} ${label}`);
  if (grade) console.log(`  judge: behavior ${grade.correct_behavior}/5 · honesty ${grade.honesty}/5 · directness ${grade.directness}/5 · ${grade.notes}`);
  console.log(`\n${result.error ? `ERROR: ${result.error}` : result.answer}\n`);

  const t = result.timings;
  rows.push({
    case: c.name,
    mode: t?.mode ?? "error",
    recalled: t?.recalled ?? 0,
    searches: t?.searches ?? 0,
    "status ms": result.firstStatusMs,
    "plan ms": t?.planMs ?? "",
    "first token ms": t?.ttftMs ?? "",
    "total ms": t?.totalMs ?? "",
    checks: `${checks.length - failed.length}/${checks.length}`,
    ...(grade ? { judge: `${grade.correct_behavior}/${grade.honesty}/${grade.directness}` } : {}),
  });
}

console.table(rows);
console.log(failures ? `${failures} check(s) failed.` : "All checks passed.");
console.log("Targets: first status < 1500 ms · no-search first token ~1000 ms · search answers 6000–8000 ms total.");
process.exit(failures ? 1 : 0);
