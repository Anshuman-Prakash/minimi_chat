// Citation numbering. Code, not the model, decides what [n] means.

import type { Source } from "./db";

/**
 * Hands out citation numbers for one turn. A URL always gets the same number,
 * and numbers continue from those already used in the conversation, so [7]
 * never means two different pages in one thread.
 */
export class SourceBook {
  private byUrl = new Map<string, Source>();
  private last = 0;

  /** `existing`: sources already cited earlier in this conversation. */
  constructor(existing: Source[] = []) {
    for (const s of existing) {
      this.byUrl.set(s.url, s);
      this.last = Math.max(this.last, s.n);
    }
  }

  number<T extends { url: string; title: string; publishedDate: string | null }>(items: T[]): (T & Source)[] {
    return items.map((item) => {
      let s = this.byUrl.get(item.url);
      if (!s) {
        s = { n: ++this.last, url: item.url, title: item.title, publishedDate: item.publishedDate };
        this.byUrl.set(item.url, s);
      }
      return { ...item, ...s };
    });
  }

  all(): Source[] {
    return [...this.byUrl.values()].sort((a, b) => a.n - b.n);
  }
}

const CITATION = /\[(\d+(?:\s*,\s*\d+)*)\]/g;

/** Every n that appears as [n] or [n, m] in the text. */
export function citedNumbers(text: string): Set<number> {
  const out = new Set<number>();
  for (const m of text.matchAll(CITATION)) for (const n of m[1]!.split(",")) out.add(Number(n));
  return out;
}

/** Rewrites citation numbers in old text (e.g. a recalled answer) to this turn's numbering. */
export function renumberCitations(text: string, map: Map<number, number>): string {
  return text.replace(CITATION, (whole, list: string) => {
    const mapped = list.split(",").map((n) => map.get(Number(n)));
    return mapped.every((n) => n !== undefined) ? mapped.map((n) => `[${n}]`).join("") : whole;
  });
}
