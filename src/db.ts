// Persistent store: SQLite via Node's built-in driver (no native install step).
// Timestamps are UTC ISO strings; ISO strings sort and range-compare correctly.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config";

const sqlite = await import("node:sqlite").catch(() => {
  console.error(`This app needs Node 22.13 or newer (built-in SQLite). You are on ${process.version}.`);
  process.exit(1);
});

if (config.dbPath !== ":memory:") mkdirSync(dirname(config.dbPath), { recursive: true });
export const db = new sqlite.DatabaseSync(config.dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS conversations (
    id         INTEGER PRIMARY KEY,
    title      TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id              INTEGER PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content         TEXT NOT NULL,
    created_at      TEXT NOT NULL,   -- UTC ISO-8601
    tz              TEXT NOT NULL,   -- user's IANA timezone when it was written
    meta            TEXT             -- JSON: timings, mode
  );
  CREATE INDEX IF NOT EXISTS messages_by_time ON messages(created_at);
  CREATE INDEX IF NOT EXISTS messages_by_conversation ON messages(conversation_id, id);

  -- The web sources an assistant message cited. n is the [n] used in the text
  -- and is unique within a conversation, so a citation is never ambiguous.
  CREATE TABLE IF NOT EXISTS sources (
    id             INTEGER PRIMARY KEY,
    message_id     INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    n              INTEGER NOT NULL,
    url            TEXT NOT NULL,
    title          TEXT NOT NULL,
    published_date TEXT              -- YYYY-MM-DD or NULL
  );
  CREATE INDEX IF NOT EXISTS sources_by_message ON sources(message_id);

  -- Keyword index over message text. "External content": the text lives in
  -- messages; triggers keep the index in step. Porter stemming lets
  -- "hosting" match "hosted" and "prices" match "price".
  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    content, content='messages', content_rowid='id', tokenize='porter unicode61'
  );
  CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
  END;
  CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
  END;
  -- Cheap at this scale, and guarantees the index covers rows written before it existed.
  INSERT INTO messages_fts(messages_fts) VALUES ('rebuild');
`);

export type Role = "user" | "assistant";

export interface ConversationRow {
  id: number;
  title: string;
  created_at: string;
}

export interface MessageRow {
  id: number;
  conversation_id: number;
  role: Role;
  content: string;
  created_at: string;
  tz: string;
  meta: string | null;
}

export function createConversation(title: string, at: Date): number {
  const r = db.prepare("INSERT INTO conversations (title, created_at) VALUES (?, ?)").run(title, at.toISOString());
  return Number(r.lastInsertRowid);
}

export function conversationExists(id: number): boolean {
  return db.prepare("SELECT 1 FROM conversations WHERE id = ?").get(id) !== undefined;
}

export function listConversations(): ConversationRow[] {
  return db.prepare("SELECT id, title, created_at FROM conversations ORDER BY id DESC LIMIT 100").all() as unknown as ConversationRow[];
}

export function addMessage(conversationId: number, role: Role, content: string, at: Date, tz: string, meta?: object): number {
  const r = db
    .prepare("INSERT INTO messages (conversation_id, role, content, created_at, tz, meta) VALUES (?, ?, ?, ?, ?, ?)")
    .run(conversationId, role, content, at.toISOString(), tz, meta ? JSON.stringify(meta) : null);
  return Number(r.lastInsertRowid);
}

export function getMessages(conversationId: number): MessageRow[] {
  return db.prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY id").all(conversationId) as unknown as MessageRow[];
}

export interface Source {
  n: number;
  url: string;
  title: string;
  publishedDate: string | null;
}

export function addSources(messageId: number, sources: Source[]): void {
  const insert = db.prepare("INSERT INTO sources (message_id, n, url, title, published_date) VALUES (?, ?, ?, ?, ?)");
  for (const s of sources) insert.run(messageId, s.n, s.url, s.title, s.publishedDate);
}

/** Sources for a set of messages, grouped by message id. */
export function sourcesFor(messageIds: number[]): Map<number, Source[]> {
  const out = new Map<number, Source[]>();
  if (!messageIds.length) return out;
  const rows = db
    .prepare(`SELECT message_id, n, url, title, published_date FROM sources WHERE message_id IN (${messageIds.map(() => "?").join(",")}) ORDER BY n`)
    .all(...messageIds) as unknown as { message_id: number; n: number; url: string; title: string; published_date: string | null }[];
  for (const r of rows) {
    const list = out.get(r.message_id) ?? [];
    list.push({ n: r.n, url: r.url, title: r.title, publishedDate: r.published_date });
    out.set(r.message_id, list);
  }
  return out;
}

/** Every source cited so far in a conversation, one row per citation number. */
export function conversationSources(conversationId: number): Source[] {
  const rows = db
    .prepare(
      `SELECT s.n, s.url, s.title, s.published_date FROM sources s JOIN messages m ON m.id = s.message_id
       WHERE m.conversation_id = ? GROUP BY s.n ORDER BY s.n`,
    )
    .all(conversationId) as unknown as { n: number; url: string; title: string; published_date: string | null }[];
  return rows.map((r) => ({ n: r.n, url: r.url, title: r.title, publishedDate: r.published_date }));
}

// ---- Recall queries ----

/** A past exchange: what the user asked and what the assistant answered. */
export interface Turn {
  title: string; // conversation title
  question: MessageRow;
  answer: MessageRow | null;
}

function toTurns(questions: (MessageRow & { title: string })[]): Turn[] {
  const next = db.prepare("SELECT * FROM messages WHERE conversation_id = ? AND id > ? ORDER BY id LIMIT 1");
  return questions.map(({ title, ...question }) => {
    const following = next.get(question.conversation_id, question.id) as unknown as MessageRow | undefined;
    return { title, question, answer: following?.role === "assistant" ? following : null };
  });
}

/** Turns whose question was asked in [startUtc, endUtc), oldest first. */
export function turnsBetween(startUtc: string, endUtc: string, excludeMessageId: number): Turn[] {
  const rows = db
    .prepare(
      `SELECT m.*, c.title FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE m.role = 'user' AND m.created_at >= ? AND m.created_at < ? AND m.id != ? ORDER BY m.created_at, m.id`,
    )
    .all(startUtc, endUtc, excludeMessageId) as unknown as (MessageRow & { title: string })[];
  return toTurns(rows);
}

/** The most recent turns from conversations other than the given one, newest first. */
export function recentTurnsElsewhere(conversationId: number, limit: number): Turn[] {
  const rows = db
    .prepare(
      `SELECT m.*, c.title FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE m.role = 'user' AND m.conversation_id != ? ORDER BY m.id DESC LIMIT ?`,
    )
    .all(conversationId, limit) as unknown as (MessageRow & { title: string })[];
  return toTurns(rows);
}

/** Turns matching the keywords anywhere in memory, best match first. */
export function searchTurns(keywords: string[], excludeMessageId: number, limit: number): Turn[] {
  const hits = matchMessages(keywords);
  if (!hits.length) return [];
  // A hit on an answer counts for the question it answered.
  const questionOf = db.prepare(
    `SELECT m.*, c.title FROM messages m JOIN conversations c ON c.id = m.conversation_id
     WHERE m.conversation_id = (SELECT conversation_id FROM messages WHERE id = ?) AND m.role = 'user' AND m.id <= ? ORDER BY m.id DESC LIMIT 1`,
  );
  const seen = new Set<number>();
  const questions: (MessageRow & { title: string })[] = [];
  for (const id of hits) {
    const q = questionOf.get(id, id) as unknown as (MessageRow & { title: string }) | undefined;
    if (!q || q.id === excludeMessageId || seen.has(q.id)) continue;
    seen.add(q.id);
    questions.push(q);
    if (questions.length === limit) break;
  }
  return toTurns(questions);
}

/** Ids of messages matching any keyword, best (bm25) first. Optionally restricted to a set of ids. */
export function matchMessages(keywords: string[], among?: number[]): number[] {
  if (!keywords.length || among?.length === 0) return [];
  // Each keyword is quoted so user text can never be read as FTS5 query syntax.
  const query = keywords.map((k) => `"${k.replaceAll('"', '""')}"`).join(" OR ");
  const restrict = among ? `AND rowid IN (${among.map(Number).join(",")})` : "";
  const rows = db
    .prepare(`SELECT rowid AS id FROM messages_fts WHERE messages_fts MATCH ? ${restrict} ORDER BY bm25(messages_fts) LIMIT 50`)
    .all(query) as unknown as { id: number }[];
  return rows.map((r) => r.id);
}

/** The last `limit` messages of a conversation, oldest first. */
export function recentMessages(conversationId: number, limit: number): MessageRow[] {
  const rows = db
    .prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?")
    .all(conversationId, limit) as unknown as MessageRow[];
  return rows.reverse();
}
