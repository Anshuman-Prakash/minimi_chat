// What the model sees of the current conversation: the recent messages
// verbatim, and a rolling summary standing in for everything older.

import { z } from "zod";
import { config } from "./config";
import * as store from "./db";
import type { MessageRow } from "./db";
import { llm } from "./llm/provider";

export interface ConversationContext {
  summary: string | null;
  history: MessageRow[]; // oldest first; always starts with a user message
}

export function loadContext(conversationId: number): ConversationContext {
  const summary = store.getSummary(conversationId);
  const history = store
    .messagesAfter(conversationId, summary?.upto_message_id ?? 0)
    // Safety cap in case summarising has fallen behind (e.g. the fast model was unavailable).
    .slice(-(config.historyMessages + config.summarizeEvery));
  while (history[0]?.role === "assistant") history.shift(); // the API requires the first message to be the user's
  return { summary: summary?.text ?? null, history };
}

const SummarySchema = z.object({ summary: z.string() });

const SUMMARY_SYSTEM = `You keep running notes on a long conversation between a user and an assistant, for the assistant's own later reference. Merge the existing notes with the new messages into one updated set of notes, at most 250 words.
Keep: what the user is trying to do, decisions made, names, numbers and dates exactly as stated, the user's stated preferences, and questions still open. Drop pleasantries and anything superseded later in the conversation.`;

/**
 * Called after each turn, off the hot path. Once the verbatim window has grown
 * `summarizeEvery` messages past its target size, folds the oldest ones into the summary.
 */
export async function updateSummary(conversationId: number): Promise<void> {
  const existing = store.getSummary(conversationId);
  const messages = store.messagesAfter(conversationId, existing?.upto_message_id ?? 0);
  if (messages.length < config.historyMessages + config.summarizeEvery) return;

  const older = messages.slice(0, messages.length - config.historyMessages);
  const { summary } = await llm().json({
    schema: SummarySchema,
    system: SUMMARY_SYSTEM,
    user: `<existing_notes>\n${existing?.text ?? "(none yet)"}\n</existing_notes>\n\n<new_messages>\n${older.map((m) => `${m.role}: ${m.content}`).join("\n\n")}\n</new_messages>`,
    think: true,
    timeoutMs: 30_000,
  });
  store.saveSummary(conversationId, summary, older.at(-1)!.id);
}
