// Memory lookup. Runs in code before any model call, on every turn.
// The model never searches memory itself: it is handed either what was found,
// with exact timestamps, or an explicit statement that nothing was found.

import { formatLocal } from "./clock";
import { config } from "./config";
import * as store from "./db";
import type { Turn } from "./db";
import { SourceBook, renumberCitations } from "./sources";
import { isToday, localDate, resolveTemporal, type DayWindow, type TemporalRef } from "./temporal";

export interface Recall {
  /** Text for the <memory> block, or null when the message doesn't refer to the past. */
  block: string | null;
  /** One-line status for the UI, e.g. "Checking my notes from Tuesday 3 November 2026…". */
  status: string | null;
  /** The exchanges that were recalled. */
  turns: Turn[];
  /** Pages the recalled answers cited: what to re-fetch when the user asks "is it still true?". */
  citedUrls: string[];
  /** What those answers claimed, as short phrases ("Neon Launch plan price"): what to look for on the re-fetched pages. */
  claimTopics: string[];
}

// A date only triggers a lookup when the message is about the user and the
// assistant ("what did I ask…", "we shortlisted…", "your answer"). This keeps
// "what happened on 3 November in the election?" out of memory entirely.
// ("us" is deliberately absent: it would match "the US election".)
const PERSONAL = /\b(i|we|you|me|my|our|your)\b/i;
// Explicit references to an earlier conversation, with or without a date.
const RECALL_CUE =
  /\b(last time|previously|earlier|remember|recall|(did|have|had|were|was) (i|we|you)|(i|we|you) (asked|said|told|mentioned|discussed|talked|shortlisted|compared|recommended|suggested|decided|picked|chose))\b/i;

const STOPWORDS = new Set(
  `a about after again all also am an and any are as ask asked asking at be because been before being but by can changed
   changes change correct could did do does doing done down each for from get got had has have having he her here him his how i if
   in into is it its just know last like made make many me more most much my no not now of on once one only or other our out over
   said same say she should since so some still such tell than that the their them then there these they thing things this those
   to today told too under until up us very was we were what when where which who whom why will with would yesterday you your
   answer answered question conversation discussed discuss talked talk mentioned earlier previously remember recall time`.split(/\s+/),
);

/** Topic words of a message: lower-cased, without stop-words or the date phrases themselves. */
export function keywords(text: string, refs: TemporalRef[] = []): string[] {
  let rest = text;
  for (const r of refs) rest = rest.replace(r.phrase, " ");
  const words = rest.toLowerCase().match(/[a-z0-9][a-z0-9+#.-]*[a-z0-9+#]|[a-z0-9]/g) ?? [];
  return [...new Set(words.filter((w) => w.length > 1 && !STOPWORDS.has(w) && !/^\d+$/.test(w)))].slice(0, 10);
}

export function recall(
  args: { text: string; now: Date; tz: string; conversationId: number; messageId: number },
  book: SourceBook,
): Recall {
  const todayIso = localDate(args.now, args.tz);
  const personal = PERSONAL.test(args.text);
  const cue = RECALL_CUE.test(args.text);
  const allRefs = resolveTemporal(args.text, args.now, args.tz);
  // "today" needs an explicit recall cue; otherwise "what should I wear today" would trigger a lookup.
  const refs = allRefs.filter((r) => (isToday(r, todayIso) ? cue : personal));
  const words = keywords(args.text, allRefs);

  const sections: string[] = [];
  const turns: Turn[] = [];
  const cited = new Set<string>();
  const topics = new Set<string>();
  const render = (t: Turn[]) => {
    turns.push(...t);
    return t.map((turn) => renderTurn(turn, args.tz, book, cited, topics)).join("\n\n");
  };
  const result = (status: string): Recall => ({ block: sections.join("\n\n"), status, turns, citedUrls: [...cited], claimTopics: [...topics] });

  if (refs.length) {
    const labels: string[] = [];
    for (const ref of refs) {
      const found = lookupByDate(ref, words, args.messageId);
      sections.push(describeDateLookup(ref, found, words, render));
      labels.push((found.window ?? ref.candidates[0]!).label); // the day actually used, not just the first guess
    }
    return result(`Checking my notes from ${labels.join(" and ")}…`);
  }

  if (cue) {
    // No date, but the user refers to an earlier conversation: look by topic, then by recency.
    const byTopic = store.searchTurns(words, args.messageId, config.recallMaxTurns);
    if (byTopic.length) {
      sections.push(`Lookup by topic (${words.join(", ")}), no date given. Best-matching past exchanges:\n\n${render(byTopic)}`);
    } else {
      const recent = store.recentTurnsElsewhere(args.conversationId, 3).reverse();
      sections.push(
        recent.length
          ? `Lookup by topic${words.length ? ` (${words.join(", ")})` : ""}: nothing matched. For orientation, the most recent exchanges from other conversations:\n\n${render(recent)}`
          : `NO RECORD FOUND: there are no earlier conversations stored${words.length ? ` matching: ${words.join(", ")}` : ""}.`,
      );
    }
    return result("Checking my notes…");
  }

  return { block: null, status: null, turns: [], citedUrls: [], claimTopics: [] };
}

interface DateLookup {
  window: DayWindow | null; // the candidate that was used
  turns: Turn[];
  matchedTopic: boolean; // turns were selected by keyword, not just by date
  totalThatDay: number;
  nearby: { window: DayWindow; turns: Turn[] } | null; // only when nothing was found on the date itself
}

function lookupByDate(ref: TemporalRef, words: string[], excludeMessageId: number): DateLookup {
  // Choose between candidate days using memory: the day whose best exchange
  // matches the most topic words wins; on a tie the more likely reading wins;
  // if no day matches the topic, the first day that has anything at all.
  let best: (DateLookup & { score: number }) | null = null;
  for (const window of ref.candidates) {
    const all = store.turnsBetween(window.startUtc, window.endUtc, excludeMessageId);
    if (!all.length) continue;
    const { turns: onTopic, score } = rankByTopic(all, words);
    if (best && score <= best.score) continue;
    best = score
      ? { window, turns: onTopic.slice(0, config.recallMaxTurns), matchedTopic: true, totalThatDay: all.length, nearby: null, score }
      : { window, turns: all.slice(0, config.recallMaxTurns), matchedTopic: false, totalThatDay: all.length, nearby: null, score: 0 };
  }
  if (best) return best;

  // Nothing on any candidate. For a single day, look one day either side: the
  // user may be a day off. This is reported as "nearby", never as the date asked for.
  const primary = ref.candidates[0]!;
  if (primary.from === primary.to) {
    const dayMs = 24 * 3600 * 1000;
    const start = new Date(Date.parse(primary.startUtc) - dayMs).toISOString();
    const end = new Date(Date.parse(primary.endUtc) + dayMs).toISOString();
    const around = store.turnsBetween(start, end, excludeMessageId);
    if (around.length) {
      const onTopic = rankByTopic(around, words).turns;
      return { window: null, turns: [], matchedTopic: false, totalThatDay: 0, nearby: { window: primary, turns: (onTopic.length ? onTopic : around).slice(0, config.recallMaxTurns) } };
    }
  }
  return { window: null, turns: [], matchedTopic: false, totalThatDay: 0, nearby: null };
}

/**
 * Ranks turns by how many distinct topic words appear in the question or answer.
 * Returns the turns that match at least half as many words as the best one
 * (so a passing mention of one word doesn't ride along), and the best count.
 */
function rankByTopic(turns: Turn[], words: string[]): { turns: Turn[]; score: number } {
  const owner = new Map<number, Turn>();
  for (const t of turns) {
    owner.set(t.question.id, t);
    if (t.answer) owner.set(t.answer.id, t);
  }
  const ids = [...owner.keys()];
  const hits = new Map<Turn, number>();
  for (const word of words) {
    const matched = new Set(store.matchMessages([word], ids).map((id) => owner.get(id)!));
    for (const t of matched) hits.set(t, (hits.get(t) ?? 0) + 1);
  }
  const score = Math.max(0, ...hits.values());
  const ranked = [...hits.entries()].filter(([, n]) => n >= score / 2).sort((a, b) => b[1] - a[1]).map(([t]) => t);
  return { turns: ranked, score };
}

function describeDateLookup(ref: TemporalRef, found: DateLookup, words: string[], render: (t: Turn[]) => string): string {
  const [primary, ...others] = ref.candidates;
  const topic = words.length ? ` matching the topic words (${words.join(", ")})` : "";

  if (!found.window) {
    const tried = ref.candidates.map((c) => `${c.label} (${c.reading})`).join("; or ");
    const head = `Lookup: "${ref.phrase}" was read as ${tried}.\nNO RECORD FOUND: no conversation is stored for that date.`;
    const rule =
      "If the user is asking about a past conversation, say plainly that you have no record of one on that date. Do not reconstruct or guess what was said. If the date is not about a past conversation, ignore this lookup.";
    if (!found.nearby) return `${head}\n${rule}`;
    return `${head}\n${rule}\nNearby, NOT on the date asked (one day either side), in case the user is a day off:\n\n${render(found.nearby.turns)}`;
  }

  let head = `Lookup: "${ref.phrase}" was read as ${found.window.label} (${found.window.reading}).`;
  if (found.window !== primary) {
    head += ` The first reading, ${primary!.label} (${primary!.reading}), has no conversation${topic}, so this one was used. Tell the user which date you took it to mean.`;
  } else if (others.length) {
    head += ` Another possible reading is ${others.map((c) => c.label).join(" or ")}; mention the date you used.`;
  }
  const scope = found.matchedTopic
    ? `Showing ${found.turns.length} exchange(s)${topic}, out of ${found.totalThatDay} in that window.`
    : `${words.length ? `Nothing in that window matches the topic words (${words.join(", ")}). ` : ""}Showing ${found.turns.length} of ${found.totalThatDay} exchange(s) from that window.`;
  return `${head}\n${scope}\n\n${render(found.turns)}`;
}

function renderTurn(turn: Turn, tz: string, book: SourceBook, cited: Set<string>, topics: Set<string>): string {
  const when = formatLocal(new Date(turn.question.created_at), tz);
  const lines = [`--- Past exchange · ${when} (${tz}) · conversation "${turn.title}"`, `User asked: ${clip(turn.question.content)}`];
  if (!turn.answer) {
    lines.push("Assistant: (no answer was recorded for this question)");
  } else {
    // Old citation numbers are remapped to this turn's numbering, so a [n] taken
    // from a recalled answer still points at the right page.
    const old = store.sourcesFor([turn.answer.id]).get(turn.answer.id) ?? [];
    const renumbered = book.number(old);
    const map = new Map(old.map((s, i) => [s.n, renumbered[i]!.n]));
    lines.push(`Assistant answered: ${clip(renumberCitations(turn.answer.content, map))}`);
    if (renumbered.length) {
      lines.push("Sources cited in that answer:");
      for (const s of renumbered) lines.push(`[${s.n}] ${s.title} - ${s.url}${s.publishedDate ? ` (published ${s.publishedDate})` : ""}`);
    }

    // The index built after that answer was sent (see facts.ts). The count matters:
    // it is what lets the model notice "you said five, I have four".
    const facts = store.factsFor(turn.answer.id);
    if (facts.entities.length) lines.push(`Named in this exchange (${facts.entities.length}): ${facts.entities.map((e) => e.name).join(", ")}`);
    if (facts.claims.length) {
      const numberOf = new Map(renumbered.map((s) => [s.url, s.n]));
      lines.push("Facts stated in that answer (as of that date):");
      for (const c of facts.claims) {
        const n = c.sourceUrl ? numberOf.get(c.sourceUrl) : undefined;
        lines.push(`- ${c.entity} | ${c.attribute}: ${c.value}${n ? ` [${n}]` : " (no source recorded)"}`);
      }
    }
    // Pages behind recorded facts first, then the rest of what the answer cited.
    for (const c of facts.claims) topics.add(`${c.entity} ${c.attribute}`);
    for (const c of facts.claims) if (c.sourceUrl) cited.add(c.sourceUrl);
    for (const s of renumbered) cited.add(s.url);
  }
  lines.push("---");
  return lines.join("\n");
}

function clip(text: string): string {
  const max = config.recallMaxChars;
  return text.length > max ? `${text.slice(0, max)}\n[…cut here: the stored text is longer than shown]` : text;
}
