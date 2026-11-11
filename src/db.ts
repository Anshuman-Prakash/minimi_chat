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

/** The last `limit` messages of a conversation, oldest first. */
export function recentMessages(conversationId: number, limit: number): MessageRow[] {
  const rows = db
    .prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?")
    .all(conversationId, limit) as unknown as MessageRow[];
  return rows.reverse();
}
