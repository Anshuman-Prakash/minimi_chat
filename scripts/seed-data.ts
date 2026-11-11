// Past conversations for testing, dated relative to "now" with the app's own
// date resolver, so "on Monday", "last Tuesday" and "on 3 November" always
// land on a seeded conversation whenever this is run.
//
// Prices were read from the vendors' own pricing pages on 11 Nov 2026.
// One value is out of date ON PURPOSE: Neon's "$19/month" Launch minimum is
// its old pricing (the live page shows usage-only pricing), so the
// "has anything changed?" flow has a real change to find.

import { DateTime } from "luxon";
import * as store from "../src/db";
import { resolveTemporal } from "../src/temporal";

interface SeedConversation {
  /** A date phrase, resolved exactly as the app would resolve it in a user's message. */
  when: string;
  title: string;
  question: string;
  answer: string;
  sources: { n: number; url: string; title: string }[];
  entities: string[];
  claims: { entity: string; attribute: string; value: string; source: number }[];
}

const conversations = (todayName: string): SeedConversation[] => [
  {
    when: "on Monday",
    title: "CRM shortlist for a 20-person sales team",
    question: "We're a 20-person sales team choosing a CRM. Can you shortlist the 5 best options with per-seat pricing?",
    answer: `Here are five that fit a 20-person sales team, with list prices for the plan I'd look at first:

| CRM | Plan | Price |
|---|---|---|
| HubSpot Sales Hub | Professional | $90–$100 per seat a month depending on commitment, plus a one-time $1,500 onboarding fee [1] |
| Salesforce | Pro Suite | $100 per user a month, billed annually (Starter Suite is $25) [2] |
| Close | Growth | $99 per seat a month billed annually, $109 monthly [3] |
| Attio | Pro | $100 a month for the workspace including one user, then $79 per extra user, billed annually [4] |
| Freshsales | Pro | $39 per user a month, billed annually [5] |

For 20 reps who mostly need pipeline, calling and email in one place, I'd trial Close and Freshsales first: they are the quickest to roll out and the cheapest to run. HubSpot and Salesforce make sense if marketing or heavy customisation is on the roadmap.`,
    sources: [
      { n: 1, url: "https://www.hubspot.com/pricing/sales", title: "HubSpot Sales Hub pricing" },
      { n: 2, url: "https://www.salesforce.com/sales/pricing/", title: "Salesforce Sales pricing" },
      { n: 3, url: "https://www.close.com/pricing", title: "Close pricing" },
      { n: 4, url: "https://attio.com/pricing", title: "Attio pricing" },
      { n: 5, url: "https://www.freshworks.com/crm/pricing/", title: "Freshsales pricing" },
    ],
    entities: ["HubSpot Sales Hub", "Salesforce", "Close", "Attio", "Freshsales"],
    claims: [
      { entity: "HubSpot Sales Hub", attribute: "Professional price", value: "$90–$100 per seat/month, plus $1,500 one-time onboarding", source: 1 },
      { entity: "Salesforce", attribute: "Pro Suite price", value: "$100 per user/month, billed annually", source: 2 },
      { entity: "Salesforce", attribute: "Starter Suite price", value: "$25 per user/month", source: 2 },
      { entity: "Close", attribute: "Growth price", value: "$99 per seat/month billed annually, $109 monthly", source: 3 },
      { entity: "Attio", attribute: "Pro price", value: "$100/month per workspace incl. 1 user, $79 per additional user, billed annually", source: 4 },
      { entity: "Freshsales", attribute: "Pro price", value: "$39 per user/month, billed annually", source: 5 },
    ],
  },
  {
    when: "last Tuesday",
    title: "Managed Postgres hosting for a small SaaS",
    question: "What are good managed Postgres hosting options for a small SaaS, and what do they cost?",
    answer: `Two I'd start with:

- **Neon**: serverless Postgres that scales to zero, with database branching. There's a free plan; the paid Launch plan starts at $19 a month [1].
- **Supabase**: Postgres plus auth, storage and an API layer. The Free plan gives you a 500 MB database; Pro starts at $25 a month and includes $10 of compute credit [2].

If you only need a database and like the idea of a branch per pull request, pick Neon. If you'd also use the auth and storage, Supabase saves you wiring those up yourself.`,
    sources: [
      { n: 1, url: "https://neon.com/pricing", title: "Neon pricing" },
      { n: 2, url: "https://supabase.com/pricing", title: "Supabase pricing" },
    ],
    entities: ["Neon", "Supabase"],
    claims: [
      { entity: "Neon", attribute: "Launch plan price", value: "starts at $19/month", source: 1 },
      { entity: "Supabase", attribute: "Pro plan price", value: "from $25/month, includes $10 compute credit", source: 2 },
      { entity: "Supabase", attribute: "Free plan database size", value: "500 MB", source: 2 },
    ],
  },
  {
    when: "on 3 November",
    title: "Vercel Pro pricing",
    question: "How much does Vercel Pro cost, and is there a free tier?",
    answer: `Vercel Pro is $20 a month per developer seat, and that includes $20 of usage credit each month; viewer seats are free [1]. There is a free tier: the Hobby plan, meant for personal projects, with fixed usage caps you can't pay to extend [1].`,
    sources: [{ n: 1, url: "https://vercel.com/pricing", title: "Vercel pricing" }],
    entities: ["Vercel"],
    claims: [
      { entity: "Vercel", attribute: "Pro plan price", value: "$20/month per developer seat", source: 1 },
      { entity: "Vercel", attribute: "Pro included usage credit", value: "$20/month", source: 1 },
      { entity: "Vercel", attribute: "Hobby plan price", value: "free", source: 1 },
    ],
  },
  {
    // One week ago today: gives "on <today's weekday>" two readings (a week ago, or today).
    when: `on ${todayName}`,
    title: "Cloudflare Workers pricing",
    question: "What does Cloudflare Workers cost once you outgrow the free plan?",
    answer: `The Workers Paid plan has a $5 a month minimum per account. That covers 10 million requests and 30 million CPU-milliseconds a month; beyond that it's $0.30 per extra million requests and $0.02 per extra million CPU-milliseconds [1]. The free plan allows 100,000 requests a day [1].`,
    sources: [{ n: 1, url: "https://developers.cloudflare.com/workers/platform/pricing/", title: "Cloudflare Workers pricing" }],
    entities: ["Cloudflare Workers"],
    claims: [
      { entity: "Cloudflare Workers", attribute: "Paid plan minimum", value: "$5/month per account", source: 1 },
      { entity: "Cloudflare Workers", attribute: "Paid plan included requests", value: "10 million/month, then $0.30 per million", source: 1 },
      { entity: "Cloudflare Workers", attribute: "Free plan requests", value: "100,000/day", source: 1 },
    ],
  },
];

export interface Seeded {
  title: string;
  phrase: string;
  localDate: string; // "Monday 9 November 2026"
}

export function seed(now: Date, tz: string): Seeded[] {
  store.deleteSeeded();
  const todayName = DateTime.fromJSDate(now, { zone: tz }).toFormat("cccc");
  const out: Seeded[] = [];

  for (const c of conversations(todayName)) {
    const window = resolveTemporal(c.when, now, tz)[0]?.candidates[0];
    if (!window) throw new Error(`could not resolve "${c.when}"`);
    // Mid-morning on that day; if that would be in the future (seeding on the day itself), two hours ago.
    let asked = DateTime.fromISO(window.from, { zone: tz }).set({ hour: 10, minute: 30 }).toJSDate();
    if (asked >= now) asked = new Date(now.getTime() - 2 * 3600_000);
    const answered = new Date(asked.getTime() + 15_000);

    const conv = store.createConversation(c.title, asked);
    store.addMessage(conv, "user", c.question, asked, tz, { seed: true });
    const answerId = store.addMessage(conv, "assistant", c.answer, answered, tz, { seed: true });
    store.addSources(answerId, c.sources.map((s) => ({ ...s, publishedDate: null })));
    const urlOf = new Map(c.sources.map((s) => [s.n, s.url]));
    store.addFacts(
      answerId,
      answered.toISOString(),
      c.entities.map((name) => ({ name, kind: "product" })),
      c.claims.map((x) => ({ entity: x.entity, attribute: x.attribute, value: x.value, sourceUrl: urlOf.get(x.source) ?? null, sourcePublishedDate: null })),
    );
    out.push({ title: c.title, phrase: c.when, localDate: window.label });
  }
  return out;
}
