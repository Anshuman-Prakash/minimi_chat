// HTTP layer: static UI, a small JSON API, and one SSE endpoint for chat.

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { runTurn } from "./agent";
import { isValidTz } from "./clock";
import { config, missingKeys } from "./config";
import * as store from "./db";

const app = new Hono();

const ChatBody = z.object({
  text: z.string().trim().min(1).max(8000),
  conversationId: z.number().int().positive().optional(),
  tz: z.string().optional(),
});

app.post("/api/chat", async (c) => {
  const body = ChatBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "Expected { text, conversationId?, tz? }" }, 400);
  const tz = body.data.tz && isValidTz(body.data.tz) ? body.data.tz : config.defaultTz;

  return streamSSE(c, async (stream) => {
    const abort = new AbortController();
    stream.onAbort(() => abort.abort()); // browser went away: stop model and search calls

    // Events are written in order; runTurn never throws.
    let queue = Promise.resolve();
    await runTurn({ ...body.data, tz }, (e) => {
      queue = queue.then(() => stream.writeSSE({ event: e.type, data: JSON.stringify(e) })).catch(() => {});
    }, abort.signal);
    await queue;
  });
});

app.get("/api/conversations", (c) => c.json(store.listConversations()));

app.get("/api/conversations/:id/messages", (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || !store.conversationExists(id)) return c.json({ error: "Not found" }, 404);
  const messages = store.getMessages(id).map(({ id, role, content, created_at }) => ({ id, role, content, created_at }));
  return c.json(messages);
});

app.use("/*", serveStatic({ root: "./public" }));

serve({ fetch: app.fetch, port: config.port }, ({ port }) => {
  console.log(`Chat is running at http://localhost:${port}`);
  const missing = missingKeys();
  if (missing.length) console.warn(`Warning: ${missing.join(", ")} not set. Copy .env.example to .env and fill it in.`);
  if (config.nowOverride) console.log(`NOW_OVERRIDE active: the app believes it is ${config.nowOverride}`);
});
