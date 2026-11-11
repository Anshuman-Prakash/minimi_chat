// One user turn, start to finish:
//   plan (fast model) → planned searches in parallel → answer (main model,
//   which may ask for more searches in a bounded loop) → save.
// The HTTP layer only forwards events; scripts can call runTurn directly.

import { z } from "zod";
import { now } from "./clock";
import { config, missingKeys } from "./config";
import * as store from "./db";
import type { Source } from "./db";
import { describeError, streamAnswer, type AnswerMessage, type AnswerTool } from "./llm";
import { isIsoDate, plan, type Plan } from "./planner";
import { SYSTEM_PROMPT, pastAnswer, renderResults, userTurn } from "./prompts";
import { withPolicies, type SearchQuery, type SearchResult } from "./search/provider";
import { tavily } from "./search/tavily";

export type TurnEvent =
  | { type: "status"; text: string }
  | { type: "sources"; sources: Source[] }
  | { type: "delta"; text: string }
  | { type: "reset" } // discard streamed text: the model decided to search before answering
  | { type: "done"; conversationId: number; messageId: number; timings: Timings }
  | { type: "error"; message: string; conversationId: number };

export interface Timings {
  mode: Plan["mode"];
  planMs: number;
  searchMs: number; // planned searches only
  searches: number; // all searches this turn, planned and model-requested
  ttftMs: number | null; // request start → first token of the final answer
  totalMs: number;
}

export interface TurnInput {
  conversationId?: number;
  text: string;
  tz: string;
}

const search = withPolicies(tavily);

// The one tool. No `strict`/eager streaming: the input is a one-line query,
// and we validate it ourselves before running anything.
const WEB_SEARCH_TOOL: AnswerTool = {
  name: "web_search",
  description:
    "Search the web and get back numbered sources with the relevant text from each page. " +
    "Call it several times in one step for independent lookups; they run in parallel.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Focused search query" },
      since: {
        type: "string",
        description: "Optional YYYY-MM-DD. Only results published on or after this date. Use for news or changes after a date; omit for pricing pages and docs.",
      },
    },
    required: ["query"],
  },
};
const WebSearchInput = z.object({ query: z.string().trim().min(1), since: z.string().optional() });

/** Assigns citation numbers. The same URL always keeps the same number within a turn. */
class SourceBook {
  private byUrl = new Map<string, Source>();
  constructor(private last: number) {}

  number(results: SearchResult[]) {
    return results.map((r) => {
      let s = this.byUrl.get(r.url);
      if (!s) {
        s = { n: ++this.last, url: r.url, title: r.title, publishedDate: r.publishedDate };
        this.byUrl.set(r.url, s);
      }
      return { ...s, content: r.content };
    });
  }
  all(): Source[] {
    return [...this.byUrl.values()];
  }
}

export async function runTurn(input: TurnInput, emit: (e: TurnEvent) => void, signal: AbortSignal): Promise<void> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const at = now();

  const conversationId =
    input.conversationId && store.conversationExists(input.conversationId)
      ? input.conversationId
      : store.createConversation(titleFrom(input.text), at);

  // Read history before saving the new message so it isn't included twice.
  const history = store.recentMessages(conversationId, config.historyMessages);
  store.addMessage(conversationId, "user", input.text, at, input.tz);
  emit({ type: "status", text: "Thinking…" });

  try {
    const missing = missingKeys();
    if (missing.length) throw new ConfigError(`Missing ${missing.join(", ")}. Add it to .env and restart.`);

    // 1. Plan. If the planner fails we skip the pre-search; the answer model
    //    still has the tool and can search on its own, just one round later.
    const thePlan = await plan({ text: input.text, history, now: at, tz: input.tz }, signal).catch((err): Plan => {
      if (signal.aborted) throw err;
      return { mode: "direct", queries: [] };
    });
    const planMs = elapsed();

    // 2. Planned searches, all at once.
    const book = new SourceBook(store.lastSourceNumber(conversationId));
    let searches = 0;
    let searchBlock: string | undefined;
    if (thePlan.mode === "search") {
      emit({ type: "status", text: `Searching: ${thePlan.queries.map((q) => q.query).join(" · ")}` });
      searches += thePlan.queries.length;
      const settled = await Promise.allSettled(thePlan.queries.map((q) => search.search(q, signal)));
      if (signal.aborted) return;
      const ok = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
      const failed = settled.length - ok.length;
      if (!ok.length) {
        searchBlock = "Web search is unavailable right now, so nothing could be checked for this message.";
      } else {
        searchBlock = renderResults(book.number(ok.flat()));
        if (failed) searchBlock += `\n\n(${failed} of ${settled.length} searches failed and are missing above.)`;
      }
      emit({ type: "sources", sources: book.all() });
    }
    const searchMs = elapsed() - planMs;

    // 3. Answer, with a bounded tool loop.
    const pastSources = store.sourcesFor(history.map((m) => m.id));
    const messages: AnswerMessage[] = [
      ...history.map((m): AnswerMessage => ({
        role: m.role,
        content: m.role === "assistant" ? pastAnswer(m.content, pastSources.get(m.id) ?? []) : m.content,
      })),
      { role: "user", content: userTurn({ text: input.text, now: at, tz: input.tz, searchBlock }) },
    ];

    let ttftMs: number | null = null;
    let rounds = 0;
    let final;
    for (;;) {
      const stream = streamAnswer({ system: SYSTEM_PROMPT, messages, tools: [WEB_SEARCH_TOOL] }, signal);
      stream.on("text", (delta) => {
        ttftMs ??= elapsed();
        emit({ type: "delta", text: delta });
      });
      final = await stream.finalMessage();

      const calls = final.content.filter((b) => b.type === "tool_use");
      if (final.stop_reason !== "tool_use" || !calls.length) break;
      // Hard stop: the model was already told the budget is used up and asked again anyway.
      if (rounds > config.maxToolRounds) break;

      // The model wants more searches. Anything it streamed so far was preamble.
      emit({ type: "reset" });
      ttftMs = null;
      rounds++;
      const allowed = rounds <= config.maxToolRounds;

      // Validate every call first, so the status line can name the searches before they run.
      const requests = calls.map((call) => {
        const parsed = WebSearchInput.safeParse(call.input);
        const query: SearchQuery | null =
          call.name === "web_search" && parsed.success
            ? { query: parsed.data.query, ...(isIsoDate(parsed.data.since) ? { since: parsed.data.since } : {}) }
            : null;
        return { id: call.id, query };
      });
      const toRun = allowed ? requests.flatMap((r) => (r.query ? [r.query] : [])) : [];
      if (toRun.length) emit({ type: "status", text: `Searching: ${toRun.map((q) => q.query).join(" · ")}` });
      searches += toRun.length;

      const results = await Promise.all(
        requests.map(async ({ id, query }) => {
          const base = { type: "tool_result" as const, tool_use_id: id };
          if (!query) return { ...base, is_error: true, content: 'Invalid call. The only tool is web_search with input { "query": string, "since"?: "YYYY-MM-DD" }.' };
          // The tool list must not change mid-turn, so the budget is enforced here.
          if (!allowed) return { ...base, is_error: true, content: "Search budget for this message is used up. Answer with what you have and say what you could not check." };
          try {
            return { ...base, content: renderResults(book.number(await search.search(query, signal))) };
          } catch {
            return { ...base, is_error: true, content: "Search failed (provider unavailable). Tell the user what you could not check." };
          }
        }),
      );
      if (signal.aborted) return;
      emit({ type: "sources", sources: book.all() });
      // Assistant content goes back unchanged (it may contain thinking blocks the API expects to see again).
      messages.push({ role: "assistant", content: final.content }, { role: "user", content: results });
    }

    let answer = final.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    if (final.stop_reason === "tool_use" || final.stop_reason === "refusal" || !answer.trim()) {
      // Nothing usable was streamed: say so rather than leaving an empty or half-finished bubble.
      answer =
        final.stop_reason === "tool_use"
          ? "I ran out of search attempts before I could put an answer together. Could you ask again, a bit more specifically?"
          : "I can't help with that request.";
      emit({ type: "reset" });
      emit({ type: "delta", text: answer });
    }

    // 4. Save the answer and the sources it actually cited.
    const cited = citedNumbers(answer);
    const known = book.all();
    const timings: Timings = { mode: thePlan.mode, planMs, searchMs, searches, ttftMs, totalMs: elapsed() };
    const messageId = store.addMessage(conversationId, "assistant", answer, now(), input.tz, { timings });
    store.addSources(messageId, known.filter((s) => cited.has(s.n)));
    emit({ type: "done", conversationId, messageId, timings });
    log({
      conversationId,
      ...timings,
      rounds,
      // Citations pointing at a number we never issued: should be 0; worth watching.
      unknownCitations: [...cited].filter((n) => !known.some((s) => s.n === n)).length,
      inputTokens: final.usage.input_tokens,
      outputTokens: final.usage.output_tokens,
    });
  } catch (err) {
    if (signal.aborted) return; // user closed the tab; nothing to report
    const message = err instanceof ConfigError ? err.message : describeError(err);
    emit({ type: "error", message, conversationId });
    log({ conversationId, totalMs: elapsed(), error: err instanceof Error ? err.name : "unknown" });
  }
}

class ConfigError extends Error {}

/** Every n that appears as [n] or [n, m] in the text. */
export function citedNumbers(text: string): Set<number> {
  const out = new Set<number>();
  for (const m of text.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)) {
    for (const n of m[1]!.split(",")) out.add(Number(n));
  }
  return out;
}

function titleFrom(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 60 ? `${oneLine.slice(0, 57)}…` : oneLine;
}

/** One JSON line per turn: timings and token counts only, never content or keys. */
function log(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event: "turn", ...fields }));
}
