// Thin wrapper around the Anthropic SDK: one client, one place for model settings.

import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config";

let client: Anthropic | undefined;

export function anthropic(): Anthropic {
  // Created lazily so the server can start (and explain the problem) without a key.
  client ??= new Anthropic({ timeout: config.llmTimeoutMs, maxRetries: 1 });
  return client;
}

export type AnswerMessage = Anthropic.Beta.BetaMessageParam;
export type AnswerTool = Anthropic.Beta.BetaTool;

/**
 * Starts a streaming answer from the main model.
 *
 * - Adaptive thinking at low effort: the model skips thinking on easy turns.
 * - `fallbacks: "default"`: if a safety classifier declines the request, the API
 *   re-runs it on a fallback model inside the same call instead of dead-ending.
 *   This is the only reason the beta namespace is used.
 */
export function streamAnswer(args: { system: string; messages: AnswerMessage[]; tools: AnswerTool[] }, signal: AbortSignal) {
  return anthropic().beta.messages.stream(
    {
      model: config.answerModel,
      max_tokens: config.answerMaxTokens,
      system: [{ type: "text", text: args.system, cache_control: { type: "ephemeral" } }],
      messages: args.messages,
      tools: args.tools,
      thinking: { type: "adaptive" },
      output_config: { effort: config.answerEffort },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    },
    { signal },
  );
}

/** A short, user-safe description of an API failure (never includes keys or bodies). */
export function describeError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return "The Anthropic API key is missing or invalid. Check ANTHROPIC_API_KEY in .env.";
  if (err instanceof Anthropic.RateLimitError) return "The model is rate-limited right now. Try again in a moment.";
  if (err instanceof Anthropic.APIConnectionError) return "Couldn't reach the model API. Check your network connection.";
  if (err instanceof Anthropic.APIError) return `The model API returned an error (${err.status ?? "unknown"}).`;
  return "Something went wrong while answering.";
}
