# Decision log

Running notes, newest phase last. Each entry: what was decided, why, and what was rejected. DESIGN.md is condensed from this at the end.

## Framing

The three sample questions are all "what did we discuss on <date>, and is it still true?". So the system under test is: durable timestamped memory, deterministic date resolution, honest re-verification. Web search is the instrument for the last step, not the whole product.

## Decisions made up front (plan stage)

**D1. SQLite through Node's built-in `node:sqlite`. Requires Node ≥ 22.13.**
Why: nothing to compile or download, so `npm install` cannot fail on it on any OS. Checked on Node 24: FTS5 and bm25 work, no flag needed.
Rejected: `better-sqlite3` (native addon; when no prebuilt binary matches the Node version it falls back to node-gyp, which is the "native build pain" the rules ban). `sql.js` (loads the whole DB into memory, manual flush to disk, FTS5 not in the default build). JSON files (no full-text search, no date-range queries).
Cost: Node 20 users must upgrade. Node 20 went end-of-life in April 2026, and the app prints a clear message on old versions.

**D2. Memory is harness infrastructure, not a tool.**
Why: the rule says one tool. It is also more reliable: recall runs on every turn in code, so the model cannot forget to look, and cannot invent a result, because an empty lookup is injected as an explicit "no record".
Rejected: a `recall` tool; Anthropic's memory tool.

**D3. Our own `web_search` tool backed by Tavily, not the model's built-in server-side search.**
Why: we run the first batch of searches in parallel before the answer model starts; we choose per query whether to apply a published-date filter; we can re-fetch the exact pages an old answer relied on; we cache; we can swap providers.
Rejected: built-in search. It is good and needs no second key, but searches happen one model step at a time inside the model's turn and we can't cache or direct page fetches. Exa is comparable; Tavily's `/extract` (page content reranked against a query) suits pricing pages, and the API is two plain HTTP calls so no SDK is needed.

**D4. Order of work per turn: resolve dates → recall → plan → search → answer.**
Why: the planner can only write a query like "Pipedrive pricing change" if it has already seen the recalled list of CRM names. So recall cannot depend on the planner; its keywords come straight from the user's message.

**D5. Weekday ambiguity is resolved against memory.**
"Last Tuesday" said on a Wednesday can mean yesterday or eight days ago. The resolver returns ranked candidate days and recall uses the first one that has records, then tells the model which reading it took. Widening by ±1 day is kept only as a labeled "nearby, not exact" fallback for explicit dates.

**D6. Code structures the then-vs-now comparison; the model judges it.**
"$19/mo" vs "$19 per month billed annually" can't be compared as strings. Stored claims give a precise list of what was said and from which URL; code guarantees those URLs are re-fetched; the model decides changed / unchanged / couldn't verify.

**D7. Published-date filters only on "what's new" queries.**
Vendor pricing pages carry no publish date, so a date filter would drop the page we most need.

**D8. No embeddings in v1.** FTS5 keyword search plus date windows. One fewer API key and no vector store. Cost: a paraphrased question ("database hosting" vs "Postgres hosting") can miss. First item for week two.

**D9. Small planner model first, then parallel search, then the answer model.**
Why: saves a full round trip of the larger model in the common case and skips search when it isn't needed.
Rejected: letting the answer model drive every search (slower first round); multi-agent setups; agent frameworks such as LangChain (they hide the control flow a reviewer wants to read).

## Phase 1: server, streaming chat, UI

**D10. Hono + static HTML/JS, run with `tsx watch`.** One process, no build step. Rejected Vite/React: a second toolchain for a UI that isn't being judged.

**D11. Chat is a POST that returns an SSE stream, read with `fetch`.** `EventSource` only does GET, and the message belongs in a request body. Event types: `status`, `delta`, `done`, `error`.

**D12. `runTurn()` knows nothing about HTTP.** It takes an input and an `emit` callback. The server forwards events; the eval script will call the same function directly.

**D13. Per-turn context goes in the user message; the system prompt never changes.** The current date is wrapped around the latest user message as a `<context>` block. A static system prompt can be cached by the API; a date inside it would invalidate the cache every minute.

**D14. History is rebuilt from the database as plain text on every request.** The DB is the single source of truth, so restarts lose nothing. Only the newest message gets the `<context>` wrapper.

**D15. Answer model settings: `claude-sonnet-5-5`, adaptive thinking, effort `low`.** On this model thinking can't be switched off; at `low` it skips thinking on simple turns, which is Anthropic's recommended setting for chat and what keeps time-to-first-token down. Configurable with `ANSWER_EFFORT`.

**D16. Server-side refusal fallback is on (`fallbacks: "default"`).** If a safety classifier declines a request, the API retries it on a fallback model within the same call. It costs one beta header, which is why the answer call uses `client.beta.messages`.

**D17. One clock.** `clock.ts` is the only reader of the system time. `NOW_OVERRIDE` shifts it by a fixed offset, so a faked session still ticks forward and message order holds.

**D18. Logging: one JSON line per turn with timings and token counts.** No message content, no keys.

**D19. Markdown rendering: `marked` + `DOMPurify` from cdnjs.** Model output is sanitized before it touches the DOM. A CDN is acceptable because the app needs the internet anyway.

## Phase 2: web search and citations

**D20. `SearchProvider` is a two-method interface: `search(query, since?)` and `extract(urls, focus)`.** Tavily implements it in ~60 lines of plain `fetch`. `withPolicies()` wraps any provider with the rules every external call gets: 8 s timeout, one retry on network errors / 429 / 5xx (never on 4xx, where a retry can't help), and a 10-minute in-memory cache keyed by query + date filter. The cache stores the promise, so two identical lookups in flight share one request, and failures are never cached.

**D21. Tavily `search_depth: "advanced"` with 3 chunks per source.** One call returns the passages of each page that match the query, so we get page content without a second "fetch the page" hop. Costs 2 credits instead of 1 and is slower than `basic`; `SEARCH_DEPTH` makes it switchable once measured. `extract` is reserved for re-fetching known URLs (Phase 4).

**D22. The planner returns `{ mode: direct | search, queries[] }` via structured output.** The fast model runs with thinking off and a strict JSON schema, so there is nothing to parse by hand. It only sees today's date, the last four messages (clipped) and the new message.
If the planner fails or times out we do not fail the turn and do not guess a query: we skip the pre-search. The answer model still has the tool and will search by itself, one round later. Slower, never wrong.

**D23. "direct" means "no pre-search", not "search forbidden".** The answer model always has `web_search`. The planner is an optimisation for latency; the answer model is the safety net for the planner's mistakes.

**D24. Bounded tool loop: at most 2 extra rounds, enforced in the tool result, plus a hard stop.** The tool list must stay identical across requests inside a turn (changing it invalidates the model's replayed thinking blocks), so the budget can't be enforced by removing the tool. Instead an over-budget call gets an error result telling the model to answer with what it has. If it still asks again, the loop stops and the user gets a plain "ran out of search attempts" message. Found by testing against a fake model that never stops asking.

**D25. Citation numbers are issued by code and are unique per conversation.** `SourceBook` gives each URL one number, continuing from the highest number already used in the conversation, so `[7]` never means two different pages in one thread. Only sources the answer actually cites are stored. The UI links only numbers that exist; an unknown number stays plain text and is counted in the turn log (`unknownCitations`) as a quality signal.

**D26. Preamble is discarded with a `reset` event.** If the model streams "Let me check…" and then calls the tool, the UI clears that text and shows the search status again. The stored answer is the text of the final round only.

**D27. Pre-fetched results go into the user turn as a `<search_results>` block**, not as a faked tool call. Fabricating assistant tool-use turns the model never made is fragile; a labeled block is simple and the prompt explains it.

**D28. Search results are treated as untrusted.** The system prompt says web content is not instructions. Model output is sanitized before rendering.

**D29. Not using `strict` tools or eager input streaming.** The tool input is a one-line query; we validate it with zod before running anything, and an invalid call gets an error result the model can correct.

**D30. A missing Tavily key degrades, a missing Anthropic key stops.** Without search the app says it could not check the web and answers with that caveat.

Tested offline by faking both APIs at the `fetch` level: planned + model-requested searches, a follow-up turn, provider outage (one retry, then degrade), runaway tool loop. Not yet tested against the real APIs (no keys on the build machine).

## Phase 3: memory, date resolution, recall

**D31. Dates are resolved by code, in the user's timezone, as ranked candidate day windows.** `temporal.ts` is a pure function of (text, now, timezone). `chrono-node` finds the phrases and reports which parts the user actually stated; `luxon` does the calendar arithmetic so a "day" is a real local day (23 or 25 hours on daylight-saving days) converted to a UTC range for the query. The rules for ambiguous phrases are ours and are written at the top of the file:

| Phrase | Reading(s), most likely first |
|---|---|
| "3 November" (no year) | the most recent 3 November that is not in the future |
| "Monday", "on Monday" | the most recent Monday before today; if today is Monday, today is the second candidate |
| "last Tuesday" | the most recent Tuesday before today; if that falls in the current week, also the Tuesday a week earlier |
| "last week" | previous Monday–Sunday; second candidate: the past 7 days |
| "in October" | the most recent October that has started |
| "two weeks ago" | that exact day; second candidate: the week around it |
| "3/11" | 3 November (day first, matching how the brief writes dates). Known limit: US-style month-first input is misread. |

Why not let the model do it: models are unreliable at weekday arithmetic, and a wrong date here silently retrieves the wrong conversation. Rules in code can be unit-tested (19 tests, including timezone and DST cases).

**D32. Candidates are settled against memory.** For each candidate window, recall counts how many distinct topic words the best exchange in that window matches. Highest count wins; a tie goes to the more likely reading; if nothing matches the topic, the first window that has anything. The block tells the model which reading was used and that another existed, and the system prompt tells it to say so ("I took 'last Tuesday' to mean 3 November").
First version was "first candidate with any keyword hit". Rejected before it shipped: "pricing" alone would have matched an unrelated chat on the wrong day.

**D33. Chrono's false positives are guarded.** It reads "sat" and "sun" as weekdays and "last week" as a single day. Abbreviated weekdays count only after "on/last/this"; week and month ranges are handled before chrono runs; "next Friday" and anything in the future are dropped, because a memory cannot be in the future.

**D34. When does a date trigger a memory lookup?** Only when the message is about the user and the assistant: it contains I / we / you / my / our / your. "What happened on 3 November in the election?" triggers nothing. A reference to *today* needs an explicit recall cue ("what did I ask earlier today"), otherwise "what should I wear today" would pull in the day's chats. When an earlier date is named, a trailing "today" ("is it still correct today?") is the comparison point, not a second lookup.
This is a heuristic and is the weakest link in recall; a miss costs a memory lookup, a false hit costs some irrelevant context that the prompt tells the model to ignore. A unit test caught "US election" matching the pronoun "us".

**D35. Three lookup paths, all deterministic.** (1) By date, as above. (2) No date but a recall cue ("last time", "did I ask", "you said"): keyword search across all history. (3) Cue but no keyword match: the three most recent exchanges from other conversations, labeled as orientation only. No cue and no date: no memory block at all.

**D36. FTS5 with porter stemming, external-content table, kept in sync by triggers.** Topic words are the message minus stop-words, numbers and the date phrase. Each word is quoted in the MATCH query, so user text can't be interpreted as query syntax.

**D37. An empty lookup is stated, not omitted.** The block says `NO RECORD FOUND` plus the instruction not to reconstruct. If there is something one day either side, it is shown under "Nearby, NOT on the date asked". Never silently substituted.

**D38. The unit of recall is an exchange: the user's question plus the answer that followed, with the question's timestamp** shown in the user's current timezone, the conversation title, and the sources that answer cited. Long stored text is cut at 6,000 characters with a visible marker, never silently.

**D39. Recalled citations are renumbered.** An old answer's `[1]` would collide with this conversation's `[1]`. `SourceBook` is seeded with the conversation's existing sources, recalled sources get the next free numbers, and the recalled text is rewritten to match. So the model can cite the page an old answer relied on, and the link is right.

**D40. Recall is synchronous SQLite and runs before the planner** (a few milliseconds). The planner sees the memory block, which is what lets it write "Pipedrive pricing" instead of "them pricing".
