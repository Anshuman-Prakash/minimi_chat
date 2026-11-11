// All tunables in one place. Read once at startup.

try {
  process.loadEnvFile(); // Node built-in; does not override variables already set
} catch {
  // no .env file: rely on the real environment
}

const env = process.env;

// Which model service to use. Set LLM_PROVIDER to force one; otherwise it
// follows whichever key is present, preferring Claude when both are.
const llmProvider: "claude" | "groq" =
  env.LLM_PROVIDER === "claude" || env.LLM_PROVIDER === "groq" ? env.LLM_PROVIDER : !env.ANTHROPIC_API_KEY && env.GROQ_API_KEY ? "groq" : "claude";

const defaultModels = {
  claude: { answer: "claude-sonnet-5-5", fast: "claude-haiku-5-5" },
  groq: { answer: "openai/gpt-oss-120b", fast: "openai/gpt-oss-20b" },
}[llmProvider];

// Sizes that depend on the model service. Groq's free plan allows 8,000 tokens
// per minute per model, so a whole request (system prompt + history + memory +
// search results) has to stay well under that; Claude has no such squeeze.
const limits = {
  claude: { answerMaxTokens: 16_000, contextBudgetChars: 400_000, searchMaxResults: 5, resultMaxChars: 4000, maxToolRounds: 2, rateLimitWaitMs: 0 },
  groq: { answerMaxTokens: 2_000, contextBudgetChars: 12_000, searchMaxResults: 3, resultMaxChars: 1200, maxToolRounds: 1, rateLimitWaitMs: 65_000 },
}[llmProvider];

export const config = {
  port: Number(env.PORT ?? 3000),
  dbPath: env.DB_PATH ?? "data/minimi.db",

  llmProvider,
  llmKeyName: llmProvider === "claude" ? "ANTHROPIC_API_KEY" : "GROQ_API_KEY",
  answerModel: env.ANSWER_MODEL ?? defaultModels.answer, // writes the answers
  fastModel: env.FAST_MODEL ?? defaultModels.fast, // planning, fact extraction, summaries
  // "low" is the recommended chat setting for Sonnet 5.5: it skips thinking on
  // simple turns, which is what keeps time-to-first-token short.
  answerEffort: (env.ANSWER_EFFORT ?? "low") as "low" | "medium" | "high",
  answerMaxTokens: limits.answerMaxTokens,
  // Characters of history + recalled memory + search results sent with one message (about 4 characters per token).
  contextBudgetChars: limits.contextBudgetChars,
  // On a rate-limit response that says when to retry, wait up to this long and retry instead of failing. 0 = don't.
  rateLimitWaitMs: limits.rateLimitWaitMs,
  // The "groq" provider works with any OpenAI-compatible service: point this elsewhere and set the model names.
  openAiBaseUrl: (env.GROQ_BASE_URL ?? "https://api.groq.com/openai/v1").replace(/\/$/, ""),

  defaultTz: env.DEFAULT_TZ ?? "UTC",
  nowOverride: env.NOW_OVERRIDE,

  // How many past messages of the current conversation go to the model verbatim.
  // Older ones are folded into a rolling summary, `summarizeEvery` messages at a time.
  historyMessages: 20,
  summarizeEvery: 10,

  // Re-verification: how many pages cited by a recalled answer are re-fetched.
  maxRefetchUrls: 8,
  // Per search result shown to the model; longer page text is cut with a visible marker.
  resultMaxChars: limits.resultMaxChars,

  // Recall: how much of the past is put in front of the model for one lookup.
  recallMaxTurns: 6,
  recallMaxChars: 6000, // per stored message; longer text is cut with a visible marker

  llmTimeoutMs: 60_000,
  plannerTimeoutMs: 8_000,

  // Search
  searchDepth: (env.SEARCH_DEPTH ?? "advanced") as "fast" | "basic" | "advanced",
  searchMaxResults: Number(env.SEARCH_MAX_RESULTS ?? limits.searchMaxResults),
  searchTimeoutMs: 8_000,
  searchCacheTtlMs: 10 * 60_000,
  maxPlannedQueries: 5,
  // Extra rounds of web_search the answer model may ask for after the planned searches.
  maxToolRounds: limits.maxToolRounds,
};

/** Keys the app cannot answer without. */
export function missingKeys(): string[] {
  return process.env[config.llmKeyName] ? [] : ["ANTHROPIC_API_KEY or GROQ_API_KEY"];
}

/** Keys worth warning about at startup. Without Tavily the app still answers, but cannot search. */
export function unsetKeys(): string[] {
  return [...missingKeys(), ...(process.env.TAVILY_API_KEY ? [] : ["TAVILY_API_KEY"])];
}
