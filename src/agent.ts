// One user turn, start to finish:
//   recall (code) → plan (fast model) → planned searches in parallel →
//   answer (main model, which may ask for more searches in a bounded loop) → save.
// The HTTP layer only forwards events; scripts can call runTurn directly.

import { z } from "zod";
import { now } from "./clock";
import { config, missingKeys } from "./config";
import { loadContext, updateSummary } from "./context";
import * as store from "./db";
import type { Source } from "./db";
import { recordFacts } from "./facts";
import { llm, type ChatMessage, type Round, type ToolResult, type ToolSpec } from "./llm/provider";
import { isIsoDate, plan, type Plan } from "./planner";
import { SYSTEM_PROMPT, clip, pastAnswer, renderResults, userTurn } from "./prompts";
import { recall } from "./recall";
import { withPolicies, type SearchQuery, type SearchResult } from "./search/provider";
import { tavily } from "./search/tavily";
import { SourceBook, citedNumbers } from "./sources";

export type TurnEvent =
  | { type: "status"; text: string }
  | { type: "sources"; sources: Source[] }
  | { type: "delta"; text: string }
  | { type: "reset" } // discard streamed text: the model decided to search before answering
  | { type: "done"; conversationId: number; messageId: number; timings: Timings }
  | { type: "error"; message: string; conversationId: number };

export interface Timings {
  mode: "direct" | "search" | "reverify";
  recalled: number; // past exchanges put in front of the model
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
const WEB_SEARCH_TOOL: ToolSpec = {
  name: "web_search",
  description:
    "Search the web and get back numbered sources with the relevant text from each page. " +
    "Call it several times in one step for independent lookups; they run in parallel.",
  parameters: {
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

/**
 * Resolves when the answer has been sent and saved. `background` resolves when
 * the after-work (fact extraction, summary) is done; the server ignores it,
 * scripts await it so that what they do next can rely on it.
 */
export async function runTurn(input: TurnInput, emit: (e: TurnEvent) => void, signal: AbortSignal): Promise<{ background: Promise<void> }> {
  const idle = { background: Promise.resolve() };
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const at = now();

  const conversationId =
    input.conversationId && store.conversationExists(input.conversationId)
      ? input.conversationId
      : store.createConversation(titleFrom(input.text), at);

  // Read history before saving the new message so it isn't included twice.
  const { summary, history } = loadContext(conversationId);
  const userMessageId = store.addMessage(conversationId, "user", input.text, at, input.tz);
  emit({ type: "status", text: "Thinking…" });

  try {
    const missing = missingKeys();
    if (missing.length) throw new ConfigError(`Missing ${missing.join(", ")}. Add it to .env and restart.`);

    // 1. Recall. Deterministic and local (a few ms), so it always runs first:
    //    the planner needs the recalled names to write useful queries.
    const book = new SourceBook(store.conversationSources(conversationId));
    const memory = recall({ text: input.text, now: at, tz: input.tz, conversationId, messageId: userMessageId }, book);
    if (memory.status) emit({ type: "status", text: memory.status });

    // Everything sent with this message has to fit the provider's context budget
    // (small on a free plan, generous on Claude): up to 40% for recalled memory,
    // 20% for earlier messages of this conversation, the rest for search results.
    const budget = config.contextBudgetChars;
    const memoryBlock = memory.block && clip(memory.block, budget * 0.4, "the stored record is longer than shown");
    const pastSources = store.sourcesFor(history.map((m) => m.id));
    const past = fitHistory(
      history.map((m): ChatMessage => ({ role: m.role, content: m.role === "assistant" ? pastAnswer(m.content, pastSources.get(m.id) ?? []) : m.content })),
      budget * 0.2,
    );
    const roomForResults = budget - (memoryBlock?.length ?? 0) - past.reduce((n, m) => n + m.content.length, 0);

    // 2. Plan. If the planner fails we skip the pre-search; the answer model
    //    still has the tool and can search on its own, just one round later.
    const thePlan = await plan({ text: input.text, history, memoryBlock, now: at, tz: input.tz }, signal).catch((err): Plan => {
      if (signal.aborted) throw err;
      return { mode: "direct", reverify: false, queries: [] };
    });
    const planMs = elapsed();

    // 3. Planned work, all at once: the searches, and (when re-verifying) a fresh
    //    copy of the very pages the recalled answer cited, so then and now are
    //    compared on the same source.
    let searches = 0;
    let searchBlock: string | undefined;
    if (thePlan.mode === "search") {
      const refetch = thePlan.reverify ? memory.citedUrls.slice(0, config.maxRefetchUrls) : [];
      const doing = [
        ...(refetch.length ? [`Re-checking ${refetch.length} page${refetch.length > 1 ? "s" : ""} I cited then`] : []),
        ...(thePlan.queries.length ? [`Searching: ${thePlan.queries.map((q) => q.query).join(" · ")}`] : []),
      ];
      emit({ type: "status", text: doing.join(" · ") || "Checking…" });
      searches += thePlan.queries.length;

      const [refetched, ...settled] = await Promise.allSettled([
        // Ask each page for the passages about what was claimed then ("Pro Suite price"), falling back to the user's words.
        refetch.length ? search.extract(refetch, memory.claimTopics.join(", ").slice(0, 380) || input.text, signal) : Promise.resolve([]),
        ...thePlan.queries.map((q) => search.search(q, signal)),
      ]);
      if (signal.aborted) return idle;

      const ok = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
      const failed = settled.length - ok.length;
      // Fit what came back into the room left: re-fetched pages first, then the
      // top result of every query before anyone's second result, each cut to an equal share.
      const pages = refetched.status === "fulfilled" ? refetched.value : [];
      // A result needs enough text to contain the fact (a price and its conditions), so
      // when room is short we keep fewer results rather than thinner ones.
      const kept = [...pages, ...mergeByUrl(interleave(ok))].slice(0, Math.max(1, Math.floor(roomForResults / 900)));
      const share = Math.min(config.resultMaxChars, Math.max(700, Math.floor(roomForResults / kept.length) - 150));
      const keptPages = kept.slice(0, pages.length);
      const keptFound = kept.slice(pages.length);

      const parts: string[] = [];
      if (refetch.length) {
        parts.push(
          keptPages.length
            ? `Fetched again just now: pages the earlier answer cited.\n\n${renderResults(book.number(keptPages), share)}`
            : "The pages the earlier answer cited could not be fetched again just now.",
        );
      }
      if (keptFound.length) {
        parts.push(`Search results.\n\n${renderResults(book.number(keptFound), share)}`);
        if (failed) parts.push(`(${failed} of ${settled.length} searches failed and are missing above.)`);
      } else if (settled.length && !ok.length) {
        parts.push("Web search is unavailable right now, so nothing new could be searched for this message.");
      }
      searchBlock = parts.join("\n\n");
    }
    // Everything citable this turn: earlier sources of this conversation, sources of recalled answers, new results.
    emit({ type: "sources", sources: book.all() });
    const searchMs = elapsed() - planMs;

    // 4. Answer, with a bounded tool loop.
    const messages: ChatMessage[] = [...past, { role: "user", content: userTurn({ text: input.text, now: at, tz: input.tz, summary, memoryBlock, searchBlock }) }];

    let ttftMs: number | null = null;
    let rounds = 0;
    let final: Round;
    const session = llm().startAnswer(
      { system: SYSTEM_PROMPT, messages, tool: WEB_SEARCH_TOOL, onNotice: (text) => emit({ type: "status", text }) },
      signal,
    );
    for (;;) {
      final = await session.next((delta) => {
        ttftMs ??= elapsed();
        emit({ type: "delta", text: delta });
      });

      const calls = final.toolCalls;
      if (final.stop !== "tool_use" || !calls.length) break;
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
        requests.map(async ({ id, query }): Promise<ToolResult> => {
          if (!query) return { id, isError: true, content: 'Invalid call. The only tool is web_search with input { "query": string, "since"?: "YYYY-MM-DD" }.' };
          // The tool list must not change mid-turn, so the budget is enforced here.
          if (!allowed) return { id, isError: true, content: "Search budget for this message is used up. Answer with what you have and say what you could not check." };
          try {
            return { id, content: renderResults(book.number(await search.search(query, signal))) };
          } catch {
            return { id, isError: true, content: "Search failed (provider unavailable). Tell the user what you could not check." };
          }
        }),
      );
      if (signal.aborted) return idle;
      emit({ type: "sources", sources: book.all() });
      session.addToolResults(results);
    }

    let answer = final.text;
    if (final.stop === "tool_use" || final.stop === "refusal" || !answer.trim()) {
      // Nothing usable was streamed: say so rather than leaving an empty or half-finished bubble.
      answer =
        final.stop === "tool_use"
          ? "I ran out of search attempts before I could put an answer together. Could you ask again, a bit more specifically?"
          : "I can't help with that request.";
      emit({ type: "reset" });
      emit({ type: "delta", text: answer });
    }

    // 5. Save the answer and the sources it actually cited.
    const cited = citedNumbers(answer);
    const known = book.all();
    const mode = thePlan.reverify ? "reverify" : thePlan.mode;
    const timings: Timings = { mode, recalled: memory.turns.length, planMs, searchMs, searches, ttftMs, totalMs: elapsed() };
    const answeredAt = now();
    const messageId = store.addMessage(conversationId, "assistant", answer, answeredAt, input.tz, { timings });
    const citedSources = known.filter((s) => cited.has(s.n));
    store.addSources(messageId, citedSources);
    emit({ type: "done", conversationId, messageId, timings });

    // 6. After the user has their answer: index it for later recall, and keep
    //    the conversation summary up to date. Failures here are logged, never surfaced.
    const background = Promise.allSettled([
      recordFacts({ messageId, question: input.text, answer, observedAt: answeredAt.toISOString(), sources: citedSources }),
      updateSummary(conversationId),
    ]).then((results) => {
      const failed = results.filter((r) => r.status === "rejected").length;
      if (failed) log({ conversationId, messageId, backgroundFailures: failed });
    });
    log({
      conversationId,
      ...timings,
      rounds,
      // Citations pointing at a number we never issued: should be 0; worth watching.
      unknownCitations: [...cited].filter((n) => !known.some((s) => s.n === n)).length,
      provider: config.llmProvider,
      inputTokens: final.inputTokens,
      outputTokens: final.outputTokens,
    });
    return { background };
  } catch (err) {
    if (signal.aborted) return idle; // user closed the tab; nothing to report
    const message = err instanceof ConfigError ? err.message : llm().describeError(err);
    emit({ type: "error", message, conversationId });
    log({ conversationId, totalMs: elapsed(), error: err instanceof Error ? err.name : "unknown" });
    return idle;
  }
}

class ConfigError extends Error {}

/** Keeps the most recent messages that fit in `maxChars`; the list still starts with a user message. */
function fitHistory(messages: ChatMessage[], maxChars: number): ChatMessage[] {
  const kept: ChatMessage[] = [];
  let used = 0;
  for (const m of messages.toReversed()) {
    if (kept.length >= 2 && used + m.content.length > maxChars) break;
    // The latest exchange is always kept, cut down if it alone is too long.
    const content = clip(m.content, maxChars / 2, "message cut here");
    kept.unshift({ role: m.role, content });
    used += content.length;
  }
  while (kept[0]?.role === "assistant") kept.shift();
  return kept;
}

/** [[a1, a2], [b1, b2]] → [a1, b1, a2, b2]: every query's best result before any query's second. */
function interleave<T>(lists: T[][]): T[] {
  const out: T[] = [];
  for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) if (i < l.length) out.push(l[i]!);
  return out;
}

/** Several queries often return the same page. Show it once, with the distinct passages each query found. */
function mergeByUrl(results: SearchResult[]): SearchResult[] {
  const byUrl = new Map<string, SearchResult>();
  for (const r of results) {
    const seen = byUrl.get(r.url);
    if (!seen) byUrl.set(r.url, { ...r });
    else if (!seen.content.includes(r.content)) seen.content += `\n[…]\n${r.content}`;
  }
  return [...byUrl.values()];
}

function titleFrom(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 60 ? `${oneLine.slice(0, 57)}…` : oneLine;
}

/** One JSON line per turn: timings and token counts only, never content or keys. */
function log(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event: "turn", ...fields }));
}
