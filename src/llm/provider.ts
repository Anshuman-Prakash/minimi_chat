// The app's view of "a language model service". The agent, planner and
// background steps only use this interface, so the model vendor is a setting.
//
// Two implementations:
//   claude.ts             the Claude API (best quality; paid)
//   openai-compatible.ts  any OpenAI-style chat completions API; defaults to Groq (free tier)

import type { z } from "zod";
import { config } from "../config";
import { claude } from "./claude";
import { openAiCompatible } from "./openai-compatible";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** A tool the answer model may call. `parameters` is a JSON Schema object. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown; // parsed JSON; validated by the caller before use
}

export interface ToolResult {
  id: string; // the ToolCall it answers
  content: string;
  isError?: boolean;
}

/** One reply from the answer model: either the final text, or a request to call tools. */
export interface Round {
  text: string;
  toolCalls: ToolCall[];
  stop: "end" | "tool_use" | "refusal" | "length";
  inputTokens: number;
  outputTokens: number;
}

/**
 * One user turn's exchange with the answer model. The session owns the
 * provider-specific message list (including anything the provider needs to see
 * again unchanged, such as Claude's thinking blocks), so the agent never touches it.
 */
export interface AnswerSession {
  /** Streams the next reply; `onText` receives text as it is generated. */
  next(onText: (delta: string) => void): Promise<Round>;
  /** Supplies the results for the tool calls of the last round. */
  addToolResults(results: ToolResult[]): void;
}

export interface LlmProvider {
  startAnswer(
    args: {
      system: string;
      messages: ChatMessage[];
      tool: ToolSpec;
      /** Told when the provider has to pause, e.g. to wait out a rate limit. */
      onNotice?: (text: string) => void;
    },
    signal: AbortSignal,
  ): AnswerSession;

  /** One call that returns JSON matching the schema. Used for planning, fact extraction, summaries, judging. */
  json<S extends z.ZodType>(args: {
    schema: S;
    system: string;
    user: string;
    /** Which model: the small fast one (default) or the answer model. */
    tier?: "fast" | "answer";
    /** Off for latency-critical routing; on for background work. Providers that can't turn thinking off use their lowest setting. */
    think: boolean;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<z.infer<S>>;

  /** A short, user-safe description of a failure (never includes keys or request bodies). */
  describeError(err: unknown): string;
}

export function llm(): LlmProvider {
  return config.llmProvider === "claude" ? claude : openAiCompatible;
}
