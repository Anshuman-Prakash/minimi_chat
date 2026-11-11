// LlmProvider backed by the Claude API (official SDK, @anthropic-ai/sdk).

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { config } from "../config";
import type { AnswerSession, LlmProvider, Round } from "./provider";

let client: Anthropic | undefined;
// Created lazily so the server can start (and explain the problem) without a key.
const api = () => (client ??= new Anthropic({ timeout: config.llmTimeoutMs, maxRetries: 1 }));

type Message = Anthropic.Beta.BetaMessageParam;

export const claude: LlmProvider = {
  startAnswer({ system, messages: history, tool }, signal): AnswerSession {
    const messages: Message[] = history.map((m) => ({ role: m.role, content: m.content }));
    let lastAssistant: Anthropic.Beta.BetaContentBlock[] = [];

    return {
      async next(onText): Promise<Round> {
        // - Adaptive thinking at low effort: the model skips thinking on easy turns.
        // - `fallbacks: "default"`: if a safety classifier declines the request, the API
        //   re-runs it on a fallback model inside the same call instead of dead-ending.
        //   This is the only reason the beta namespace is used.
        const stream = api().beta.messages.stream(
          {
            model: config.answerModel,
            max_tokens: config.answerMaxTokens,
            // The system prompt never changes, so it is marked cacheable.
            system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
            messages,
            tools: [{ name: tool.name, description: tool.description, input_schema: tool.parameters as Anthropic.Beta.BetaTool["input_schema"] }],
            thinking: { type: "adaptive" },
            output_config: { effort: config.answerEffort },
            betas: ["server-side-fallback-2026-07-01"],
            fallbacks: "default",
          },
          { signal },
        );
        stream.on("text", onText);
        const final = await stream.finalMessage();
        lastAssistant = final.content;

        return {
          text: final.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(""),
          toolCalls: final.content.flatMap((b) => (b.type === "tool_use" ? [{ id: b.id, name: b.name, input: b.input }] : [])),
          stop: final.stop_reason === "tool_use" ? "tool_use" : final.stop_reason === "refusal" ? "refusal" : final.stop_reason === "max_tokens" ? "length" : "end",
          inputTokens: final.usage.input_tokens,
          outputTokens: final.usage.output_tokens,
        };
      },

      addToolResults(results) {
        messages.push(
          // The assistant turn goes back unchanged: it may hold thinking blocks the API expects to see again.
          { role: "assistant", content: lastAssistant },
          { role: "user", content: results.map((r) => ({ type: "tool_result" as const, tool_use_id: r.id, content: r.content, is_error: r.isError })) },
        );
      },
    };
  },

  async json({ schema, system, user, tier = "fast", think, timeoutMs, signal }) {
    // The API constrains the reply to the schema, so there is no JSON to repair by hand.
    const res = await api().messages.parse(
      {
        model: tier === "fast" ? config.fastModel : config.answerModel,
        max_tokens: 4096,
        thinking: think ? { type: "adaptive" } : { type: "disabled" },
        output_config: { effort: "low", format: zodOutputFormat(schema) },
        system,
        messages: [{ role: "user", content: user }],
      },
      { signal, timeout: timeoutMs, maxRetries: 0 },
    );
    if (res.parsed_output == null) throw new Error(`model returned no parsable output (stop_reason: ${res.stop_reason})`);
    return res.parsed_output as z.infer<typeof schema>;
  },

  describeError(err) {
    if (err instanceof Anthropic.AuthenticationError) return "The Claude API key is missing or invalid. Check ANTHROPIC_API_KEY in .env.";
    if (err instanceof Anthropic.RateLimitError) return "The model is rate-limited right now. Try again in a moment.";
    if (err instanceof Anthropic.APIConnectionError) return "Couldn't reach the Claude API. Check your network connection.";
    if (err instanceof Anthropic.APIError) return `The Claude API returned an error (${err.status ?? "unknown"}).`;
    return "Something went wrong while answering.";
  },
};
