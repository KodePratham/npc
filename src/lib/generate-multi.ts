import { randomUUID } from "node:crypto";
import { z } from "zod";
import { fetchDocs, type DocResult } from "./docs";
import {
  PASS1_MAX_TOKENS,
  PASS2_MAX_TOKENS,
  RULES,
  SUB_CONCURRENCY,
  assemble,
  describeInput,
  docsToBlock,
  embedIntents,
  mapLimit,
  pass2System,
} from "./generate";
import { errorMessage } from "./errors";
import { generateStructured } from "./openai";
import { Pass1Schema, Pass2Schema, TemplateSchema, type Pass1 } from "./schema";
import { getBot, saveBot, saveVectors, updateBot } from "./store";
import type { Bot, BotInput, Intent } from "./types";

/**
 * Multi-domain generation for large bots (500+ intents). The single-pass generator in generate.ts
 * asks for 25-40 top-level intents, which is too few for a big business. This pipeline splits the
 * business into areas (domains), writes top-level intents per area, then reuses the same pass-2
 * expansion and assembly as generate.ts.
 */

export const BriefSchema = z.object({
  name: z.string().trim().min(1),
  businessDescription: z.string().trim().min(1),
  pricing: z.string().default(""),
  docsLinks: z.array(z.string().url()).default([]),
  faqs: z.string().default(""),
  goals: z.string().default(""),
  tone: z.string().default("friendly and concise"),
  dataToCollect: z.string().default(""),
  domains: z.array(z.object({ name: z.string().trim().min(1), description: z.string().trim().min(1) })).min(1),
});
export type Brief = z.infer<typeof BriefSchema>;

/** Stages, facts, greeting and fallback, shared by every domain. */
const PlanSchema = z.object({
  facts: Pass1Schema.shape.facts,
  stages: Pass1Schema.shape.stages,
  greeting: TemplateSchema,
  fallback: TemplateSchema,
});
type Plan = z.infer<typeof PlanSchema>;

const DomainSchema = z.object({ intents: Pass1Schema.shape.intents });
type DomainIntent = Pass1["intents"][number];

const DOMAIN_CONCURRENCY = 4;
const PLAN_MAX_TOKENS = 30_000;

export function briefToInput(brief: Brief): BotInput {
  return {
    name: brief.name,
    businessDescription: brief.businessDescription,
    pricing: brief.pricing,
    docsLinks: [...new Set(brief.docsLinks)],
    faqs: brief.faqs,
    goals: brief.goals,
    tone: brief.tone,
    dataToCollect: brief.dataToCollect,
  };
}

/** Create the bot record in "generating" state. Call generateMultiBot with its id next. */
export async function createMultiBot(brief: Brief): Promise<Bot> {
  const now = new Date().toISOString();
  const bot: Bot = {
    id: randomUUID(),
    name: brief.name,
    status: "generating",
    progress: "Queued",
    error: null,
    createdAt: now,
    updatedAt: now,
    input: briefToInput(brief),
    facts: {},
    stages: [],
    intents: [],
    greeting: { text: "", quickReplies: [] },
    fallback: { text: "", quickReplies: [] },
    docNotes: [],
  };
  await saveBot(bot);
  return bot;
}

export interface MultiOptions {
  brief: Brief;
  /** Top-level intents to aim for per domain. */
  perDomain: number;
  /** Only use the first N areas of the brief (smoke tests). Applies to topup too. */
  domainLimit?: number;
  /** Fill thin domains and retry top-level intents that have no sub-intents (failed expansions). */
  topup?: boolean;
  log?: (msg: string) => void;
}

export interface GenStats {
  botId: string;
  total: number;
  byDepth: Record<"1" | "2" | "3", number>;
  byDomain: { name: string; top: number; total: number }[];
  /** Top-level intents with no sub-intents, which usually means a failed expansion. */
  topWithoutChildren: string[];
  notes: string[];
}

interface Ctx {
  botId: string;
  input: BotInput;
  docsBlock: string;
  stageNames: string[];
  log: (msg: string) => void;
}

// ---------- helpers ----------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retry a structured call with backoff. Throws a labeled error after the last attempt. */
async function withRetry<T>(fn: () => Promise<T>, label: string, attempts = 3): Promise<T> {
  let lastErr: unknown = null;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts) await sleep(2000 * i * i);
    }
  }
  throw new Error(`${label}: ${errorMessage(lastErr)}`);
}

async function setProgress(botId: string, progress: string) {
  await updateBot(botId, (b) => {
    b.progress = progress;
  });
}

function planSystem(docsBlock: string): string {
  return `${RULES}

TASK: Produce the shared plan for a large business that is written in several business areas. Each area is generated separately, so this plan is used by all of them.
- "facts": 3 to 12 reusable facts extracted from the business info and docs (for example support hours, main product names, website, refund policy). Keys are snake_case. Values are short plain text.
- "stages": 3 to 6 customer-journey stages in order, for example "Discovery", "Evaluation", "Purchase", "Support".
- "greeting": the first message the bot sends. "fallback": used when no intent matches. The fallback must not ask for a name or phone number; it may offer to pass the question to a team member.

BUSINESS DOCUMENTATION (fetched from the links the business provided):
${docsBlock}`;
}

function domainSystem(
  ctx: Ctx,
  area: { name: string; description: string },
  otherAreas: string[],
  count: number,
  avoid: string[],
): string {
  return `${RULES}

TASK: Write the top-level intents for ONE business area of a large business. Other areas are written separately, so stay inside this area.
- Write exactly ${count} top-level intents. Each has 12 to 20 varied example utterances, a short description, the stage NAME it belongs to (must exactly match one of: ${ctx.stageNames.join(", ")}), and a reply template.
- Cover what customers in this area actually ask: FAQs, pricing and plans, product details, orders or bookings, support and troubleshooting, complaints, and changes or cancellations where relevant.
- Intent names must be specific to this area. Other areas of the business: ${otherAreas.join(", ")}.${
    avoid.length
      ? `\n- These intent names already exist in the bot. Do not reuse or paraphrase them: ${avoid.join("; ")}`
      : ""
  }

BUSINESS AREA: ${area.name}. ${area.description}

BUSINESS DOCUMENTATION (fetched from the links the business provided):
${ctx.docsBlock}`;
}

/** Top-level intents for one area. Names are checked against `used` by the caller. */
async function generateArea(
  ctx: Ctx,
  area: { name: string; description: string },
  otherAreas: string[],
  count: number,
  avoid: string[],
): Promise<DomainIntent[]> {
  const res = await withRetry(
    () =>
      generateStructured({
        name: "area_intents",
        schema: DomainSchema,
        instructions: domainSystem(ctx, area, otherAreas, count, avoid),
        input: describeInput(ctx.input),
        maxOutputTokens: PASS1_MAX_TOKENS,
      }),
    `area "${area.name}"`,
  );
  return res.intents;
}

async function expandIntent(ctx: Ctx, top: { name: string; description: string; stage: string }, siblings: string[]) {
  return withRetry(
    () =>
      generateStructured({
        name: "intent_expansion",
        schema: Pass2Schema,
        instructions: pass2System(ctx.docsBlock),
        input: JSON.stringify({
          businessName: ctx.input.name,
          stages: ctx.stageNames,
          parentIntent: top,
          siblingIntentNames: siblings.filter((n) => n !== top.name),
        }),
        maxOutputTokens: PASS2_MAX_TOKENS,
      }),
    `expand "${top.name}"`,
  );
}

/** Stable depth order (all top-level, then children, then grandchildren), like generate.ts. */
function sortByDepth(intents: Intent[]): Intent[] {
  return [...intents].sort((a, b) => a.depth - b.depth);
}

/** Give every descendant its top-level ancestor's domain. Expects parents before children. */
function propagateDomains(intents: Intent[]) {
  const domainById = new Map<string, string | undefined>();
  for (const intent of sortByDepth(intents)) {
    if (intent.depth === 1) domainById.set(intent.id, intent.domain);
    else intent.domain = domainById.get(intent.parentId ?? "") ?? intent.domain;
    domainById.set(intent.id, intent.domain);
  }
}

// ---------- main pipeline ----------

export async function generateMultiBot(botId: string, opts: MultiOptions): Promise<GenStats> {
  const log = opts.log ?? (() => undefined);
  const bot = await getBot(botId);
  if (!bot) throw new Error(`Bot ${botId} not found`);
  const { brief, perDomain } = opts;
  const topup = !!opts.topup;
  const input = bot.input;
  const notes: string[] = [];

  try {
    await updateBot(botId, (b) => {
      b.status = "generating";
      b.error = null;
    });

    await setProgress(botId, "Reading documentation links");
    const docs: DocResult[] = await fetchDocs(input.docsLinks);
    notes.push(...docs.filter((d) => d.error).map((d) => `${d.url}: ${d.error}`));
    const docsBlock = docsToBlock(docs);

    // Plan: stages, facts, greeting, fallback. Topup reuses the stored plan.
    let plan: Plan;
    if (topup) {
      plan = {
        facts: Object.entries(bot.facts).map(([key, value]) => ({ key, value })),
        stages: bot.stages.map((s) => ({ name: s.name, description: s.description })),
        greeting: bot.greeting,
        fallback: bot.fallback,
      };
    } else {
      await setProgress(botId, "Planning stages, facts, greeting and fallback");
      plan = await withRetry(
        () =>
          generateStructured({
            name: "bot_plan",
            schema: PlanSchema,
            instructions: planSystem(docsBlock),
            input: describeInput(input),
            maxOutputTokens: PLAN_MAX_TOKENS,
          }),
        "plan",
      );
    }
    const ctx: Ctx = { botId, input, docsBlock, stageNames: plan.stages.map((s) => s.name), log };

    // Existing state (empty on a fresh run).
    const existing = topup ? bot.intents : [];
    const existingTop = existing.filter((i) => i.depth === 1);
    const usedNames = new Set(existingTop.map((i) => i.name.toLowerCase()));
    const allAreaNames = brief.domains.map((d) => d.name);

    // Which areas need new top-level intents.
    const areas = brief.domains
      .slice(0, opts.domainLimit)
      .map((d) => ({
        area: d,
        count: topup ? Math.max(0, perDomain - existingTop.filter((i) => i.domain === d.name).length) : perDomain,
      }))
      .filter((a) => a.count > 0);
    const avoidNames = existingTop.map((i) => i.name);

    await setProgress(botId, `Writing top-level intents for ${areas.length} areas`);
    const areaResults = await mapLimit(areas, DOMAIN_CONCURRENCY, async ({ area, count }, idx) => {
      try {
        const items = await generateArea(
          ctx,
          area,
          allAreaNames.filter((n) => n !== area.name),
          count,
          avoidNames,
        );
        log(`area ${idx + 1}/${areas.length} ${area.name}: ${items.length} top-level intents`);
        return { area, items };
      } catch (err) {
        notes.push(`Area "${area.name}" failed: ${errorMessage(err)}`);
        return { area, items: [] as DomainIntent[] };
      }
    });

    // Name collisions across areas are renamed with the area suffix so every name stays unique.
    const newTop: { item: DomainIntent; domain: string }[] = [];
    for (const { area, items } of areaResults) {
      for (const item of items) {
        let name = item.name.trim();
        if (usedNames.has(name.toLowerCase())) name = `${name} (${area.name})`;
        usedNames.add(name.toLowerCase());
        newTop.push({ item: { ...item, name }, domain: area.name });
      }
    }

    // Sub-intents and follow-ups for new top-level intents, plus retries for existing childless ones.
    const siblingNames = [...existingTop, ...newTop.map((t) => ({ name: t.item.name }))].map((t) => t.name);
    const hasChildren = new Set(existing.filter((i) => i.depth === 2).map((i) => i.parentId));
    const orphans = existingTop.filter((i) => !hasChildren.has(i.id));

    await setProgress(botId, `Expanding sub-intents (0/${newTop.length + orphans.length})`);
    let expanded = 0;
    const total = newTop.length + orphans.length;
    const expandOne = async (top: { name: string; description: string; stage: string }) => {
      try {
        return await expandIntent(ctx, top, siblingNames);
      } catch (err) {
        notes.push(`Could not expand "${top.name}": ${errorMessage(err)}`);
        return null;
      } finally {
        expanded++;
        if (expanded % 5 === 0 || expanded === total) {
          await setProgress(botId, `Expanding sub-intents (${expanded}/${total})`);
        }
      }
    };
    const stageNameOf = (stageId: string) => plan.stages.find((_, i) => `stage-${i + 1}` === stageId)?.name ?? plan.stages[0]?.name ?? "";

    const expansions = await mapLimit(newTop, SUB_CONCURRENCY, ({ item }) =>
      expandOne({ name: item.name, description: item.description, stage: item.stage }),
    );
    const orphanExpansions = await mapLimit(orphans, SUB_CONCURRENCY, (o) =>
      expandOne({ name: o.name, description: o.description, stage: stageNameOf(o.stageId) }),
    );

    // Assemble new top-level intents with the existing pass-2 assembly.
    const assembled = assemble(input, { ...plan, intents: newTop.map((t) => t.item) }, expansions);
    const newTopIntents = assembled.intents.filter((i) => i.depth === 1);
    newTopIntents.forEach((t, i) => (t.domain = newTop[i].domain));
    const newRest = assembled.intents.filter((i) => i.depth !== 1);

    // Orphan retries: assemble under a throwaway top, then re-parent its sub-intents to the real orphan.
    const orphanAssembled = assemble(
      input,
      {
        ...plan,
        intents: orphans.map((o) => ({
          name: o.name,
          description: o.description,
          stage: stageNameOf(o.stageId),
          examples: o.examples,
          response: o.response,
        })),
      },
      orphanExpansions,
    );
    const orphanTops = orphanAssembled.intents.filter((i) => i.depth === 1);
    const reparent = new Map(orphanTops.map((t, i) => [t.id, orphans[i]]));
    const orphanRest = orphanAssembled.intents
      .filter((i) => i.depth !== 1)
      .map((i) => {
        const real = i.depth === 2 ? reparent.get(i.parentId ?? "") : undefined;
        return real ? { ...i, parentId: real.id, stageId: real.stageId } : i;
      });

    // Merge and re-embed everything. Vectors are cheap, and this keeps ids and vectors in sync.
    const finalIntents = sortByDepth([...existing, ...newTopIntents, ...newRest, ...orphanRest]);
    propagateDomains(finalIntents);

    await setProgress(botId, `Embedding ${finalIntents.length} intents`);
    const vectors = await embedIntents(finalIntents);
    await saveVectors(botId, vectors);

    await updateBot(botId, (b) => {
      b.intents = finalIntents;
      if (!topup) {
        b.facts = assembled.facts;
        b.stages = assembled.stages;
        b.greeting = assembled.greeting;
        b.fallback = assembled.fallback;
      }
      b.docNotes = [...b.docNotes, ...notes];
      b.status = "ready";
      b.progress = "Ready";
      b.error = null;
    });

    return computeStats(
      (await getBot(botId)) ?? bot,
      brief,
      notes,
    );
  } catch (err) {
    await updateBot(botId, (b) => {
      b.status = "error";
      b.progress = "Failed";
      b.error = errorMessage(err);
    });
    throw err;
  }
}

export function computeStats(bot: Bot, brief: Brief, notes: string[] = []): GenStats {
  const byDepth = { "1": 0, "2": 0, "3": 0 } as GenStats["byDepth"];
  for (const i of bot.intents) byDepth[String(i.depth) as "1" | "2" | "3"]++;

  const tops = bot.intents.filter((i) => i.depth === 1);
  const parentsWithKids = new Set(bot.intents.filter((i) => i.depth === 2).map((i) => i.parentId));
  const areaNames = [...brief.domains.map((d) => d.name), "(unassigned)"];
  const byDomain = areaNames
    .map((name) => {
      const inArea = (i: Intent) => (i.domain ?? "(unassigned)") === name;
      return { name, top: tops.filter(inArea).length, total: bot.intents.filter(inArea).length };
    })
    .filter((d) => d.top > 0 || d.total > 0);

  return {
    botId: bot.id,
    total: bot.intents.length,
    byDepth,
    byDomain,
    topWithoutChildren: tops.filter((t) => !parentsWithKids.has(t.id)).map((t) => t.name),
    notes: [...notes],
  };
}