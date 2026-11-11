# Design

## The problem as I read it

The sample questions all have the shape "what did we discuss on *some date*, and is it still true?". The hard parts are remembering conversations with their dates, resolving "Monday" or "last Tuesday" correctly, and being honest when nothing is on record. Web search is how the last step gets verified.

## How it works

One Node process: Hono serves a small HTML/JS UI and an SSE chat endpoint; SQLite holds everything. Each message goes through five steps.

1. **Resolve dates, in code.** `chrono-node` finds date phrases; my own rules turn them into ranked candidate days in the user's timezone ("last Tuesday" said on a Wednesday is yesterday, or the Tuesday before).
2. **Recall, in code.** SQLite is queried by day window and topic words (FTS5). When a phrase has two readings, the day whose conversation best matches the topic wins, and the model is told which was used. It receives the past exchange with its timestamp, cited sources and stated facts, or an explicit `NO RECORD FOUND`.
3. **Plan.** A fast model (Haiku) returns structured output: search or not, the queries, and whether this is a "still true?" question.
4. **Search in parallel**, through a provider interface (Tavily; timeout, one retry, short cache). For "still true?" questions the pages the old answer cited are fetched again, so then and now are compared on the same source.
5. **Answer.** Sonnet streams the reply with numbered citations and may search again, at most two more rounds. Afterwards a background step records the entities and checkable facts in the reply.

## Why this way

- **Memory is not a tool.** The brief allows one tool. And recall in code always runs and cannot make things up: an empty lookup is stated, never skipped.
- **Dates are not left to the model.** A wrong date silently fetches the wrong conversation. Rules in code are testable: 28 tests cover the sample questions, timezones, daylight-saving days, and seeding on every weekday.
- **Code structures the comparison; the model judges it.** "$19/mo" and "$19 a month, billed annually" can't be compared as strings. Stored facts say what was claimed and where; code re-fetches those pages; the model decides Changed / Unchanged / Couldn't verify, and "Unchanged" needs a current source.
- **Speed comes from order and parallelism.** Recall is local. The planner saves a round trip of the larger model. Searches run concurrently. Fact extraction happens after the reply. The system prompt is static, so it caches; date, memory and results travel in the user turn.
- **Failure degrades.** Planner down: the answer model searches for itself. Search down: it answers from memory and says it couldn't check.

## Considered and rejected

| Option | Why not |
|---|---|
| Model-native web search | No control over parallelism, date filters, caching, or re-fetching specific pages. |
| Memory as a tool | Breaks the one-tool rule; the model can skip it or misreport it. |
| Vector database | Another key and moving part. Dates plus keywords cover these questions; the cost is paraphrase recall. |
| LangChain, agent frameworks | They hide the control flow, which is what is being reviewed. The whole turn is one 300-line file. |
| Multiple agents | Nothing here needs a second context; it adds latency and failure modes. |
| `better-sqlite3` | Native build risk on install. Node's built-in SQLite has FTS5 and nothing to compile. |

**Known limits:** deciding whether a date refers to a past conversation is a heuristic; keyword recall misses paraphrases; numeric dates are read day-first; single user.

## With another week

Embeddings alongside FTS for paraphrase recall. Scheduled re-verification of tracked facts, so "what changed?" is answered from a change log. Per-user accounts. A larger eval set with latency percentiles and a regression history. Source reliability scoring (vendor page over review site over forum).
