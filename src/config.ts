// All tunables in one place. Read once at startup.

try {
  process.loadEnvFile(); // Node built-in; does not override variables already set
} catch {
  // no .env file: rely on the real environment
}

const env = process.env;

export const config = {
  port: Number(env.PORT ?? 3000),
  dbPath: env.DB_PATH ?? "data/minimi.db",

  answerModel: env.ANSWER_MODEL ?? "claude-sonnet-5-5",
  fastModel: env.FAST_MODEL ?? "claude-haiku-5-5",
  // "low" is the recommended chat setting for Sonnet 5.5: it skips thinking on
  // simple turns, which is what keeps time-to-first-token short.
  answerEffort: (env.ANSWER_EFFORT ?? "low") as "low" | "medium" | "high",
  answerMaxTokens: 16_000,

  defaultTz: env.DEFAULT_TZ ?? "UTC",
  nowOverride: env.NOW_OVERRIDE,

  // How many past messages of the current conversation go to the model verbatim.
  historyMessages: 20,

  // Recall: how much of the past is put in front of the model for one lookup.
  recallMaxTurns: 6,
  recallMaxChars: 6000, // per stored message; longer text is cut with a visible marker

  llmTimeoutMs: 60_000,
  plannerTimeoutMs: 8_000,

  // Search
  searchDepth: (env.SEARCH_DEPTH ?? "advanced") as "fast" | "basic" | "advanced",
  searchMaxResults: 5,
  searchTimeoutMs: 8_000,
  searchCacheTtlMs: 10 * 60_000,
  maxPlannedQueries: 5,
  // Extra rounds of web_search the answer model may ask for after the planned searches.
  maxToolRounds: 2,
};

/** Keys the app cannot answer without. */
export function missingKeys(): string[] {
  return ["ANTHROPIC_API_KEY"].filter((k) => !process.env[k]);
}

/** Keys worth warning about at startup. Without Tavily the app still answers, but cannot search. */
export function unsetKeys(): string[] {
  return ["ANTHROPIC_API_KEY", "TAVILY_API_KEY"].filter((k) => !process.env[k]);
}
