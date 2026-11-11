// After an answer has been sent, index it: which named things it was about,
// and which checkable facts it stated. Runs off the hot path with the fast
// model; the user never waits for it. If it fails, recall still works from
// the stored text; the facts are an index, not the record.

import { z } from "zod";
import * as store from "./db";
import type { Source } from "./db";
import { llm } from "./llm/provider";

const FactsSchema = z.object({
  entities: z.array(
    z.object({
      name: z.string(),
      kind: z.string().describe("product, company, person, place, or topic"),
    }),
  ),
  claims: z.array(
    z.object({
      entity: z.string().describe("The thing the fact is about, as named in the answer"),
      attribute: z.string().describe("Short and specific, e.g. 'Launch plan price'"),
      value: z.string().describe("As stated, with units and conditions, e.g. '$19/month, billed annually'"),
      source: z.number().nullable().describe("The citation number [n] given for it in the answer, or null"),
    }),
  ),
});

const FACTS_SYSTEM = `You index one exchange from a chat assistant so it can be found and re-checked later.

entities: the specific named things the exchange is about: products, companies, people, places. Include every item of any list or shortlist in the answer. No generic nouns ("pricing", "database").

claims: facts the assistant stated that can go out of date and could be re-checked on the web: prices and plan names, limits and quotas, versions, feature availability, release dates, who holds a role, rankings. One fact per claim. Copy the value as stated, with units and conditions. Give the citation number the answer attached to it, if any.
Leave out opinions, recommendations, definitions, and anything that cannot change. Leave out facts the answer itself marked as unverified. If the answer states no such facts, return an empty list.`;

export async function recordFacts(args: { messageId: number; question: string; answer: string; observedAt: string; sources: Source[] }): Promise<void> {
  if (args.answer.length < 80) return; // greetings and one-liners have nothing to index

  const facts = await llm().json({
    schema: FactsSchema,
    system: FACTS_SYSTEM,
    user: `<question>\n${args.question}\n</question>\n\n<answer>\n${args.answer}\n</answer>`,
    think: true,
    timeoutMs: 30_000,
  });

  const byNumber = new Map(args.sources.map((s) => [s.n, s]));
  store.addFacts(
    args.messageId,
    args.observedAt,
    facts.entities.slice(0, 20),
    facts.claims.slice(0, 30).map((c) => {
      const source = c.source === null ? undefined : byNumber.get(c.source);
      return { entity: c.entity, attribute: c.attribute, value: c.value, sourceUrl: source?.url ?? null, sourcePublishedDate: source?.publishedDate ?? null };
    }),
  );
}
