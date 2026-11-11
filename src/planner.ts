// Decides, with one fast model call, whether this turn needs the web and
// which searches to run first. Running these in parallel before the answer
// model starts saves a full round trip of the larger model.

import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { formatLocal } from "./clock";
import { config } from "./config";
import type { MessageRow } from "./db";
import { anthropic } from "./llm";
import type { SearchQuery } from "./search/provider";

const PlanSchema = z.object({
  mode: z.enum(["direct", "search"]).describe("direct = answer without searching first; search = run the queries first"),
  queries: z.array(
    z.object({
      query: z.string().describe("A focused web search query, the way an expert would type it"),
      since: z.string().nullable().describe("YYYY-MM-DD, or null. Set only when looking for news or changes after a date."),
    }),
  ),
});

export interface Plan {
  mode: "direct" | "search";
  queries: SearchQuery[];
}

const PLANNER_SYSTEM = `You route messages for a chat assistant that has a web search tool. Decide whether to search before answering, and write the searches.

Choose "search" when a good answer depends on something that can change or that happened recently: prices, plans, product features and releases, versions, news, people in roles, schedules, scores, laws, "latest" or "current" anything, or when the user asks for sources or to check something.
Choose "direct" for greetings and small talk, questions about the conversation itself, writing or coding help, reasoning, maths, and facts that do not change.

Writing queries (only for "search"):
- One query per distinct thing to look up; at most ${config.maxPlannedQueries}. A question about five products usually needs one query per product.
- Short and specific: names, the attribute wanted, and the year when recency matters. No full sentences.
- Aim at primary sources: for pricing use "<product> pricing", for releases use "<product> changelog" or "<product> release notes".
- "since" is a date filter on publication date. Set it only for queries that look for news or announcements after a date. Leave it null for pricing pages, documentation, and other evergreen pages, which have no publication date and would be filtered out.`;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export async function plan(args: { text: string; history: MessageRow[]; now: Date; tz: string }, signal: AbortSignal): Promise<Plan> {
  // The planner only needs the gist of recent turns to resolve references like "and the other one?".
  const recent = args.history
    .slice(-4)
    .map((m) => `${m.role}: ${clip(m.content, 600)}`)
    .join("\n");

  const res = await anthropic().messages.parse(
    {
      model: config.fastModel,
      max_tokens: 1024,
      thinking: { type: "disabled" }, // routing is simple; skip thinking for speed
      output_config: { effort: "low", format: zodOutputFormat(PlanSchema) },
      system: PLANNER_SYSTEM,
      messages: [
        {
          role: "user",
          content: `Today is ${formatLocal(args.now, args.tz)} (${args.tz}).

<recent_conversation>
${recent || "(none)"}
</recent_conversation>

<message>
${args.text}
</message>`,
        },
      ],
    },
    { signal, timeout: config.plannerTimeoutMs, maxRetries: 0 },
  );

  const parsed = res.parsed_output;
  if (!parsed) throw new Error("planner returned no parsable plan");

  const queries = parsed.queries
    .filter((q) => q.query.trim())
    .slice(0, config.maxPlannedQueries)
    .map((q): SearchQuery => ({ query: q.query.trim(), ...(isIsoDate(q.since) ? { since: q.since } : {}) }));
  return { mode: parsed.mode === "search" && queries.length ? "search" : "direct", queries };
}

export function isIsoDate(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}
