// Thin wrapper around the Anthropic SDK: one client, one place for model settings.

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
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

/**
 * One structured-output call to the fast model. The API constrains the reply
 * to the schema, so there is no JSON to repair by hand.
 */
export async function fastJson<S extends z.ZodType>(args: {
  schema: S;
  system: string;
  user: string;
  /** Off for latency-critical routing; on (adaptive, low effort) for background work. */
  think: boolean;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<z.infer<S>> {
  const res = await anthropic().messages.parse(
    {
      model: config.fastModel,
      max_tokens: 4096,
      thinking: args.think ? { type: "adaptive" } : { type: "disabled" },
      output_config: { effort: "low", format: zodOutputFormat(args.schema) },
      system: args.system,
      messages: [{ role: "user", content: args.user }],
    },
    { signal: args.signal, timeout: args.timeoutMs, maxRetries: 0 },
  );
  if (res.parsed_output == null) throw new Error(`fast model returned no parsable output (stop_reason: ${res.stop_reason})`);
  return res.parsed_output as z.infer<S>;
}

/** A short, user-safe description of an API failure (never includes keys or bodies). */
export function describeError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return "The Anthropic API key is missing or invalid. Check ANTHROPIC_API_KEY in .env.";
  if (err instanceof Anthropic.RateLimitError) return "The model is rate-limited right now. Try again in a moment.";
  if (err instanceof Anthropic.APIConnectionError) return "Couldn't reach the model API. Check your network connection.";
  if (err instanceof Anthropic.APIError) return `The model API returned an error (${err.status ?? "unknown"}).`;
  return "Something went wrong while answering.";
}
