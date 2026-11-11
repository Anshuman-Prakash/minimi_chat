// One user turn, start to finish. The HTTP layer only forwards events;
// scripts (eval) can call runTurn directly with their own event collector.

import { now } from "./clock";
import { config, missingKeys } from "./config";
import * as store from "./db";
import { describeError, streamAnswer, type AnswerMessage } from "./llm";
import { SYSTEM_PROMPT, userTurn } from "./prompts";

export type TurnEvent =
  | { type: "status"; text: string }
  | { type: "delta"; text: string }
  | { type: "done"; conversationId: number; messageId: number; timings: Timings }
  | { type: "error"; message: string; conversationId: number };

export interface Timings {
  ttftMs: number | null; // request start → first answer token
  totalMs: number;
}

export interface TurnInput {
  conversationId?: number;
  text: string;
  tz: string;
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

    const messages: AnswerMessage[] = [
      ...history.map((m): AnswerMessage => ({ role: m.role, content: m.content })),
      { role: "user", content: userTurn(input.text, at, input.tz) },
    ];

    let ttftMs: number | null = null;
    const stream = streamAnswer({ system: SYSTEM_PROMPT, messages }, signal);
    stream.on("text", (delta) => {
      ttftMs ??= elapsed();
      emit({ type: "delta", text: delta });
    });
    const final = await stream.finalMessage();

    let answer = final.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    if (final.stop_reason === "refusal" || !answer.trim()) {
      // Nothing usable was streamed: say so rather than leaving an empty bubble.
      answer = "I can't help with that request.";
      emit({ type: "delta", text: answer });
    }

    const timings: Timings = { ttftMs, totalMs: elapsed() };
    const messageId = store.addMessage(conversationId, "assistant", answer, now(), input.tz, { timings });
    emit({ type: "done", conversationId, messageId, timings });
    log({ conversationId, ...timings, inputTokens: final.usage.input_tokens, outputTokens: final.usage.output_tokens });
  } catch (err) {
    if (signal.aborted) return; // user closed the tab; nothing to report
    const message = err instanceof ConfigError ? err.message : describeError(err);
    emit({ type: "error", message, conversationId });
    log({ conversationId, totalMs: elapsed(), error: err instanceof Error ? err.name : "unknown" });
  }
}

class ConfigError extends Error {}

function titleFrom(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 60 ? `${oneLine.slice(0, 57)}…` : oneLine;
}

/** One JSON line per turn: timings and token counts only, never content or keys. */
function log(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event: "turn", ...fields }));
}
