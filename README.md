# Minimi Chat

A chat agent with one tool, web search, and a memory of past conversations that understands dates. Ask it "What did I ask you on 3 November? Is your answer still correct today?" and it finds that conversation, re-checks the facts on the web, and tells you what changed.

Design rationale is in [DESIGN.md](DESIGN.md) (one page). The full decision log is in [DECISIONS.md](DECISIONS.md).

## Run it

Requires Node 22.13 or newer (it uses Node's built-in SQLite, so there is nothing to compile).

```bash
cp .env.example .env     # then add a model key and TAVILY_API_KEY (see below)
npm install
npm run dev              # http://localhost:3000
```

One process serves the API and the UI. The database is a file at `data/minimi.db`, created on first run.

### Keys

You need one model key and the search key.

| Key | What for | Cost |
|---|---|---|
| `GROQ_API_KEY` | The model, free option (open-weight models on Groq) | Free tier, no card: [console.groq.com/keys](https://console.groq.com/keys) |
| `ANTHROPIC_API_KEY` | The model, best quality (Claude Sonnet and Haiku) | Prepaid credit: [platform.claude.com](https://platform.claude.com/) |
| `TAVILY_API_KEY` | Web search and page extraction | Free tier: [app.tavily.com](https://app.tavily.com/) |

Set either model key and the app uses it; with both set it uses Claude (`LLM_PROVIDER=groq` overrides). The app was designed around Claude, and the then-versus-now comparisons are noticeably more careful there. Groq is the way to run everything at no cost. Free plans limit tokens per minute, so a long re-check can be refused; if that happens, wait a minute or set `SEARCH_MAX_RESULTS=3`.

## Try the sample questions

You can't have chatted with it last Monday, so load some history first:

```bash
npm run seed
```

This adds four past conversations, dated relative to today using the app's own date logic:

| When | Conversation |
|---|---|
| the most recent Monday | A CRM shortlist for a 20-person sales team (5 tools, with prices and sources) |
| the most recent Tuesday | Managed Postgres hosting for a small SaaS |
| 3 November | Vercel Pro pricing |
| one week ago today | Cloudflare Workers pricing |

Then ask:

- *On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?*
- *What did I ask you on 3 November? Is your answer still correct today?*
- *Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?*

And the edges:

- *What did I ask you on 1 January?* It has no record and should say so, not invent one.
- *On Monday we shortlisted 7 CRM tools. Which was the cheapest?* The record has five; it should point that out.
- *What happened on 3 November in the US election?* A date, but not about your conversations: no memory lookup.

Two things to know about the seed data:

- Prices were taken from the vendors' pricing pages on 11 November 2026, with one deliberate exception: the Postgres conversation quotes Neon's old "$19 a month" Launch minimum. That is there so the "has anything changed?" flow has a real change to find.
- Re-running `npm run seed` replaces the seeded conversations and leaves your own chats alone.

## Test the date logic

Set `NOW_OVERRIDE` to make the app believe it is another moment:

```bash
NOW_OVERRIDE=2026-11-18T10:00:00Z npm run seed
NOW_OVERRIDE=2026-11-18T10:00:00Z npm run dev
```

"Last Tuesday" now resolves a week later. This moves the app's clock only; web search still returns today's internet.

How date phrases are read ("Monday", "last Tuesday", "3 November", "last week") is listed at the top of [src/temporal.ts](src/temporal.ts) and covered by `npm test`.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Starts the server and UI, restarting on code changes |
| `npm run seed` | Loads the past conversations described above |
| `npm run eval` | Runs 10 cases (the sample questions plus edge cases) through the real pipeline on a fresh database and prints latency, pass/fail checks and the answers. Add `-- --judge` for an LLM-graded rubric, `-- --only <name>` for one case. Calls the real model and search APIs. |
| `npm test` | Unit tests for date resolution, recall and seeding. No API keys needed. |
| `npm run typecheck` | TypeScript check |

## How a message is handled

```
message ─▶ resolve dates (code) ─▶ recall from SQLite (code) ─▶ plan (fast model)
        ─▶ searches + re-fetch of previously cited pages, in parallel
        ─▶ answer (main model, streamed; may search again, at most 2 more rounds)
        ─▶ save ─▶ after the reply: record the facts it stated, update the summary
```

The UI shows each stage as it happens ("Checking my notes from Tuesday 3 November 2026…", "Searching: …"), then the streamed answer with clickable citations and the time to first token.

## Where things are

```
src/server.ts        HTTP routes, SSE stream, static UI
src/agent.ts         one turn, start to finish (the flow above)
src/temporal.ts      date phrases → day windows in the user's timezone
src/recall.ts        memory lookup → the "memory" block, or an explicit "no record"
src/planner.ts       should we search, and for what
src/search/          SearchProvider interface (timeout, retry, cache) and the Tavily implementation
src/llm/             LlmProvider interface, with Claude and OpenAI-compatible (Groq) implementations
src/facts.ts         after each answer: the named things and checkable facts it contained
src/context.ts       recent messages + rolling summary for long conversations
src/sources.ts       citation numbering
src/prompts.ts       system prompt and context blocks
src/db.ts            SQLite schema and queries
src/clock.ts         the only reader of the system clock (NOW_OVERRIDE)
public/              the chat UI (plain HTML, CSS, JS)
scripts/             seed and eval
test/                unit tests
```

## Configuration

All keys and settings are listed in [.env.example](.env.example). Required: `GROQ_API_KEY` or `ANTHROPIC_API_KEY`, and `TAVILY_API_KEY`. Optional: `LLM_PROVIDER`, `ANSWER_MODEL`, `FAST_MODEL`, `ANSWER_EFFORT`, `GROQ_BASE_URL`, `SEARCH_DEPTH`, `SEARCH_MAX_RESULTS`, `PORT`, `DB_PATH`, `DEFAULT_TZ`, `NOW_OVERRIDE`.

Without a Tavily key the app still answers, saying that it could not check the web. It is single-user: there is no login, and memory is shared across all conversations.
