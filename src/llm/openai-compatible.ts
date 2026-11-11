// LlmProvider for any service that speaks the OpenAI chat completions format.
// Defaults to Groq, which has a free tier. Plain fetch, no SDK.
// Reference: https://console.groq.com/docs/api-reference#chat-create
//            https://console.groq.com/docs/tool-use
//            https://console.groq.com/docs/structured-outputs

import { z } from "zod";
import { config } from "../config";
import type { AnswerSession, LlmProvider, Round, ToolCall } from "./provider";

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`model API returned ${status}`);
  }
}

async function post(body: object, signal: AbortSignal | undefined, timeoutMs: number, onWait?: (seconds: number) => void): Promise<Response> {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new HttpError(401);
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${config.openAiBaseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) return res;

    // Free plans meter tokens per minute. The service says how long until there
    // is room again; waiting that long beats failing the whole turn.
    const waitMs = Number(res.headers.get("retry-after")) * 1000;
    if (res.status === 429 && attempt < 3 && waitMs > 0 && waitMs <= config.rateLimitWaitMs) {
      onWait?.(Math.ceil(waitMs / 1000));
      await new Promise((resolve) => setTimeout(resolve, waitMs + 500));
      if (signal?.aborted) throw new HttpError(429);
      continue;
    }
    throw new HttpError(res.status);
  }
}

// Groq's gpt-oss models always reason; "low" is their shortest setting. Other
// models reject the parameter, so it is only sent where it is documented.
const reasoning = (model: string) => (model.startsWith("openai/gpt-oss") ? { reasoning_effort: config.answerEffort } : {});

interface WireToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
type WireMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: WireToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export const openAiCompatible: LlmProvider = {
  startAnswer({ system, messages: history, tool, onNotice }, signal): AnswerSession {
    const messages: WireMessage[] = [{ role: "system", content: system }, ...history.map((m): WireMessage => ({ role: m.role, content: m.content }))];

    return {
      async next(onText): Promise<Round> {
        const res = await post(
          {
            model: config.answerModel,
            messages,
            tools: [{ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } }],
            max_completion_tokens: config.answerMaxTokens,
            stream: true,
            ...reasoning(config.answerModel),
          },
          signal,
          config.llmTimeoutMs,
          (seconds) => onNotice?.(`The free model plan is at its per-minute limit. Continuing in ${seconds} s…`),
        );

        let text = "";
        const emit = citationNormalizer((clean) => {
          text += clean;
          onText(clean);
        });
        let finish = "stop";
        let usage: { prompt_tokens?: number; completion_tokens?: number } = {};
        const calls: WireToolCall[] = [];

        // Server-sent events: one "data: {json}" line per chunk, ending with "data: [DONE]".
        const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          const lines = buffer.split("\n");
          buffer = lines.pop()!;
          for (const line of lines) {
            if (!line.startsWith("data: ") || line.startsWith("data: [DONE]")) continue;
            const chunk = JSON.parse(line.slice(6));
            usage = chunk.usage ?? chunk.x_groq?.usage ?? usage;
            const choice = chunk.choices?.[0];
            if (!choice) continue;
            if (choice.finish_reason) finish = choice.finish_reason;
            if (choice.delta?.content) emit.push(choice.delta.content);
            // Tool calls may arrive whole or in fragments (id and name first, then pieces of the arguments).
            for (const [position, part] of (choice.delta?.tool_calls ?? []).entries()) {
              const call = (calls[part.index ?? position] ??= { id: "", type: "function", function: { name: "", arguments: "" } });
              if (part.id) call.id = part.id;
              if (part.function?.name) call.function.name = part.function.name;
              if (part.function?.arguments) call.function.arguments += part.function.arguments;
            }
          }
        }

        emit.flush();
        const made = calls.filter(Boolean);
        if (made.length) messages.push({ role: "assistant", content: text || null, tool_calls: made });
        return {
          text,
          toolCalls: made.map((c): ToolCall => ({ id: c.id, name: c.function.name, input: parseJson(c.function.arguments) })),
          stop: made.length ? "tool_use" : finish === "length" ? "length" : "end",
          inputTokens: usage.prompt_tokens ?? 0,
          outputTokens: usage.completion_tokens ?? 0,
        };
      },

      addToolResults(results) {
        for (const r of results) messages.push({ role: "tool", tool_call_id: r.id, content: r.isError ? `Error: ${r.content}` : r.content });
      },
    };
  },

  async json({ schema, system, user, tier = "fast", timeoutMs, signal }) {
    const model = tier === "fast" ? config.fastModel : config.answerModel;
    const jsonSchema = strictSchema(z.toJSONSchema(schema));
    const request = (response_format: object, systemText: string) =>
      post(
        { model, messages: [{ role: "system", content: systemText }, { role: "user", content: user }], response_format, max_completion_tokens: 4096, ...reasoning(model) },
        signal,
        timeoutMs,
      );

    let res: Response;
    try {
      // Preferred: the service constrains the reply to the schema.
      res = await request({ type: "json_schema", json_schema: { name: "output", strict: true, schema: jsonSchema } }, system);
    } catch (err) {
      if (!(err instanceof HttpError) || err.status !== 400) throw err;
      // Models without schema support: plain JSON mode with the schema in the prompt. Validated below either way.
      res = await request({ type: "json_object" }, `${system}\n\nReply with one JSON object that matches this JSON Schema:\n${JSON.stringify(jsonSchema)}`);
    }
    const data = (await res.json()) as { choices: { message: { content: string | null } }[] };
    return schema.parse(JSON.parse(data.choices[0]?.message.content ?? "null")) as z.infer<typeof schema>;
  },

  describeError(err) {
    if (err instanceof HttpError) {
      if (err.status === 401) return "The model API key is missing or invalid. Check GROQ_API_KEY in .env.";
      if (err.status === 429) return "The model service's rate limit was reached (free plans allow a fixed number of tokens per minute and requests per day). Wait a minute and try again.";
      if (err.status === 413) return "This request was too large for the model service's plan. Try SEARCH_MAX_RESULTS=3 in .env, or a shorter conversation.";
      return `The model API returned an error (${err.status}).`;
    }
    if (err instanceof Error && err.name === "TimeoutError") return "The model took too long to respond. Try again.";
    if (err instanceof TypeError) return "Couldn't reach the model API. Check your network connection.";
    return "Something went wrong while answering.";
  },
};

/**
 * Some open-weight models (gpt-oss) cite in their training format, 【3†L1-L4】,
 * whatever the prompt says. This rewrites those to the app's [3] as text streams
 * through, holding back a marker that is still open at the end of a chunk.
 */
function citationNormalizer(out: (text: string) => void) {
  let held = "";
  const clean = (s: string) => s.replace(/【(\d+)[^】]*】/g, "[$1]");
  return {
    push(delta: string) {
      const all = held + delta;
      const open = all.lastIndexOf("【");
      const unfinished = open !== -1 && !all.includes("】", open) && all.length - open < 40;
      held = unfinished ? all.slice(open) : "";
      const ready = clean(unfinished ? all.slice(0, open) : all);
      if (ready) out(ready);
    },
    flush() {
      if (held) out(clean(held));
      held = "";
    },
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text || "{}");
  } catch {
    return undefined; // the caller's validation turns this into an error result the model can correct
  }
}

/** Strict mode requires every property to be listed as required, and no "$schema" key. */
function strictSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictSchema);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) if (k !== "$schema") out[k] = strictSchema(v);
  if (out.type === "object" && out.properties) {
    out.required = Object.keys(out.properties as object);
    out.additionalProperties = false;
  }
  return out;
}
