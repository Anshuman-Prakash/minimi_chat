// The app's view of "a search engine". Anything that can implement
// SearchProvider can replace Tavily without touching the agent.

import { config } from "../config";

export interface SearchQuery {
  query: string;
  /** YYYY-MM-DD. Only results published on or after this date. Use for "what's new", never for evergreen pages. */
  since?: string;
}

export interface SearchResult {
  url: string;
  title: string;
  /** Text from the page that is relevant to the query. */
  content: string;
  /** YYYY-MM-DD if the provider could tell, else null. */
  publishedDate: string | null;
}

export interface SearchProvider {
  search(q: SearchQuery, signal: AbortSignal): Promise<SearchResult[]>;
  /** Fetch specific pages and return the parts relevant to `focus`. */
  extract(urls: string[], focus: string, signal: AbortSignal): Promise<SearchResult[]>;
}

/** Thrown by providers for failures that are worth one retry (network, 429, 5xx). */
export class RetryableSearchError extends Error {}

/**
 * Wraps a provider with the policies every external call gets:
 * a timeout, one retry on transient failure, and a short-lived cache.
 */
export function withPolicies(provider: SearchProvider): SearchProvider {
  // Caches the promise, so two identical lookups in flight share one request.
  const cache = new Map<string, { expires: number; value: Promise<SearchResult[]> }>();

  function cached(key: string, run: () => Promise<SearchResult[]>): Promise<SearchResult[]> {
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;
    const value = run();
    cache.set(key, { expires: Date.now() + config.searchCacheTtlMs, value });
    value.catch(() => cache.delete(key)); // never cache a failure
    return value;
  }

  async function attempt<T>(signal: AbortSignal, call: (s: AbortSignal) => Promise<T>): Promise<T> {
    const once = () => call(AbortSignal.any([signal, AbortSignal.timeout(config.searchTimeoutMs)]));
    try {
      return await once();
    } catch (err) {
      const transient = err instanceof RetryableSearchError || (err instanceof Error && err.name === "TimeoutError");
      if (!transient || signal.aborted) throw err;
      return once();
    }
  }

  return {
    search: (q, signal) => cached(`s|${q.query}|${q.since ?? ""}`, () => attempt(signal, (s) => provider.search(q, s))),
    extract: (urls, focus, signal) =>
      cached(`x|${[...urls].sort().join(",")}|${focus}`, () => attempt(signal, (s) => provider.extract(urls, focus, s))),
  };
}
