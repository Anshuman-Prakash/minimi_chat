// Tavily implementation of SearchProvider.
// API reference: https://docs.tavily.com/documentation/api-reference/endpoint/search
//                https://docs.tavily.com/documentation/api-reference/endpoint/extract

import { config } from "../config";
import { RetryableSearchError, type SearchProvider, type SearchResult } from "./provider";

const BASE = "https://api.tavily.com";

async function post<T>(path: string, body: object, signal: AbortSignal): Promise<T> {
  const key = process.env.TAVILY_API_KEY;
  if (!key) throw new Error("TAVILY_API_KEY is not set");

  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) throw err;
    throw new RetryableSearchError("network error reaching search provider");
  }
  if (res.status === 429 || res.status >= 500) throw new RetryableSearchError(`search provider returned ${res.status}`);
  if (!res.ok) throw new Error(`search provider returned ${res.status}`); // 4xx: retrying won't help
  return (await res.json()) as T;
}

const dateOnly = (s: string | null | undefined): string | null => {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
};

interface TavilySearchResponse {
  results: { url: string; title: string; content: string; published_date?: string | null }[];
}
interface TavilyExtractResponse {
  results: { url: string; raw_content: string }[];
  failed_results: { url: string; error: string }[];
}

export const tavily: SearchProvider = {
  async search({ query, since }, signal) {
    const data = await post<TavilySearchResponse>(
      "/search",
      {
        query,
        // "advanced" returns the passages of each page that match the query,
        // so one call gives page content, not just a one-line snippet.
        search_depth: config.searchDepth,
        chunks_per_source: 3,
        max_results: config.searchMaxResults,
        include_published_date: true,
        ...(since ? { start_date: since } : {}),
      },
      signal,
    );
    return data.results.map(
      (r): SearchResult => ({ url: r.url, title: r.title || r.url, content: r.content, publishedDate: dateOnly(r.published_date) }),
    );
  },

  async extract(urls, focus, signal) {
    // With `query`, Tavily returns only the chunks of each page relevant to it
    // (e.g. the pricing table) instead of the whole page.
    const data = await post<TavilyExtractResponse>("/extract", { urls, query: focus, chunks_per_source: 5, format: "markdown" }, signal);
    return data.results.map((r): SearchResult => ({ url: r.url, title: r.url, content: r.raw_content, publishedDate: null }));
  },
};
