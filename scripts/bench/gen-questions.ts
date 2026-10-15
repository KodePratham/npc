/**
 * Write a frozen set of labeled customer questions for a bot, using claude-haiku-5.5 (or BENCH_QGEN_MODEL).
 *
 *   npm run bench:questions -- --bot <botId> [--n 1000] [--oos 0.12] [--seed 42] [--force]
 *
 * Haiku sees the business brief and each intent's path, name and description. It never sees the
 * example utterances or reply templates, so it cannot copy the embedding index.
 * Output: data/bench/sets/<botId>/{questions.jsonl, manifest.json, label-audit.csv}
 */
import "./env";
import Anthropic from "@anthropic-ai/sdk";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { mapLimit } from "../../src/lib/generate";
import { embed } from "../../src/lib/openai";
import { getBot } from "../../src/lib/store";
import type { Bot, Intent } from "../../src/lib/types";
import { dot } from "../../src/lib/vector";
import {
  NONE,
  numArg,
  parseArgs,
  requireBotId,
  rng,
  setDir,
  sha256File,
  shuffle,
  writeJson,
  type Question,
} from "./common";

const DEFAULT_MODEL = "claude-haiku-5.5";
/** Length the prompt asks for. */
const STYLE_CAP = 300;
/** Hard limit when cleaning. Slightly looser than the prompt, so a rambling message is not dropped for a few characters. */
const MAX_TEXT_CHARS = 500;
const BATCH_QUESTIONS = 12;
const OOS_BATCH = 20;
/** Near-duplicate cutoff on text-embedding cosine. Paraphrases of the same ask can be close, so this is strict. */
const NEAR_DUP = 0.97;
const D3_TARGET = 150;

const STYLES: { key: string; instruction: string }[] = [
  { key: "terse", instruction: "2 to 6 words, lowercase, no punctuation" },
  { key: "typos", instruction: "a normal sentence with 2 or 3 typos and missing capitals" },
  { key: "rambling", instruction: "2 to 3 sentences of backstory before the actual request" },
  { key: "frustrated", instruction: "annoyed tone, but still asks something specific" },
  { key: "non_native", instruction: "simple grammar, as written by a non-native English speaker" },
  { key: "formal", instruction: "polite, complete sentences" },
  { key: "indirect", instruction: "describes the situation or symptom without naming the product, feature or service" },
  { key: "casual", instruction: "friendly texting style with slang" },
  { key: "question", instruction: "a direct question ending with a question mark" },
  { key: "fragment", instruction: "a short noun phrase, not a full sentence" },
];

const OOS_CATEGORIES = [
  "everyday topics unrelated to telecom (weather, recipes, homework, sports scores)",
  "other companies and their products (named competitors or other brands) and their prices",
  "things a telecom company does not sell (groceries, car insurance, mortgages, flights, medical advice)",
  "casual chit-chat and personal questions to a bot (jokes, opinions, feelings)",
  "requests for work outside a chat assistant (write an essay, build a website, translate a contract)",
];

const BatchOutput = z.object({
  messages: z.array(z.object({ ref: z.number().int(), text: z.string().min(1) })),
});
const OosOutput = z.object({ messages: z.array(z.object({ text: z.string().min(1) })) });

type Style = (typeof STYLES)[number];

interface Task {
  ref: number;
  intent: Intent;
  path: string;
  area: string;
  parentName: string | null;
  styles: Style[];
}

// ---------- intent helpers ----------

function topOf(intent: Intent, byId: Map<string, Intent>): Intent {
  let cur = intent;
  while (cur.parentId && byId.get(cur.parentId)) cur = byId.get(cur.parentId)!;
  return cur;
}

function pathOf(intent: Intent, byId: Map<string, Intent>): string {
  const names: string[] = [intent.name];
  let cur = intent;
  while (cur.parentId && byId.get(cur.parentId)) {
    cur = byId.get(cur.parentId)!;
    names.unshift(cur.name);
  }
  return names.join(" > ");
}

/** Plan how many questions each intent gets. Every depth-1 and depth-2 intent gets at least one. */
function planQuotas(intents: Intent[], inScopeTarget: number, maxPerIntent: number, rand: () => number) {
  const d1 = intents.filter((i) => i.depth === 1);
  const d2 = intents.filter((i) => i.depth === 2);
  const d3 = intents.filter((i) => i.depth === 3);
  const quota = new Map<string, number>();
  for (const i of [...d1, ...d2]) quota.set(i.id, 1);

  // Depth-3 follow-ups are asked in context: each one is labeled with its parent as the active intent.
  const d3Budget = Math.max(0, Math.min(D3_TARGET, inScopeTarget - quota.size));
  const d3Pick = shuffle(d3, rand).slice(0, d3Budget);
  for (const i of d3Pick) quota.set(i.id, 1);

  let remaining = inScopeTarget - [...quota.values()].reduce((a, b) => a + b, 0);
  const pool = shuffle([...d1, ...d2], rand);
  while (remaining > 0) {
    let progressed = false;
    for (const i of pool) {
      if (remaining <= 0) break;
      const q = quota.get(i.id) ?? 0;
      if (q < maxPerIntent) {
        quota.set(i.id, q + 1);
        remaining--;
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  return { quota, shortfall: Math.max(0, remaining), d3Count: d3Pick.length };
}

// ---------- Haiku ----------

async function callTool<T>(
  client: Anthropic,
  model: string,
  system: string,
  user: string,
  toolName: string,
  schema: z.ZodType<T>,
): Promise<T> {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  delete json.$schema;
  const res = await client.messages.create({
    model,
    max_tokens: 6000,
    temperature: 1,
    system,
    messages: [{ role: "user", content: user }],
    tools: [
      {
        name: toolName,
        description: "Return the customer messages you wrote.",
        input_schema: json as Anthropic.Tool["input_schema"],
      },
    ],
    tool_choice: { type: "tool", name: toolName },
  });
  const block = res.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") throw new Error(`No tool output (stop_reason=${res.stop_reason})`);
  return schema.parse(block.input);
}

async function withRetry<T>(fn: () => Promise<T>, label: string, attempts = 3): Promise<T> {
  let last: unknown = null;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (i < attempts) await new Promise((r) => setTimeout(r, 2000 * i * i));
    }
  }
  throw new Error(`${label}: ${last instanceof Error ? last.message : String(last)}`);
}

function businessContext(bot: Bot): string {
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}...` : s);
  return [
    `BUSINESS: ${bot.name}. ${clip(bot.input.businessDescription, 1500)}`,
    bot.input.pricing ? `PRICING (context only): ${clip(bot.input.pricing, 800)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

const WRITING_RULES = `You write realistic messages that customers send to the chat assistant of a business.
Write each message as the customer would type it. Never write as the business.
Keep each message under ${STYLE_CAP} characters.
Vary wording, length and structure. No two messages may share a template.
Do not mention intents, categories, numbers, or the business's internal area names.`;

function inScopeTask(bot: Bot, batch: Task[]): { system: string; user: string } {
  const system = `${WRITING_RULES}

${businessContext(bot)}

RULES FOR THESE MESSAGES:
- Each message must clearly be about its assigned intent, not about another topic.
- Do NOT copy the intent name or its key phrases. Describe the need in the customer's own words.
- Follow the STYLE given for each message exactly.`;
  const user = batch
    .map((t) => {
      const follow = t.parentName
        ? ` The customer is already talking about "${t.parentName}" with the assistant, so this message is a follow-up.`
        : "";
      const styles = t.styles.map((s, i) => `#${i + 1} style=${s.key} (${s.instruction})`).join("; ");
      return `[ref ${t.ref}] Area: ${t.area}. Topic path: ${t.path}. What the intent covers: ${t.intent.description}.${follow}\n  Write ${t.styles.length} messages: ${styles}`;
    })
    .join("\n\n");
  return { system, user: `${user}\n\nCall the tool with one entry per message, giving its ref and text.` };
}

function oosTask(bot: Bot, areas: string[], category: string, count: number): { system: string; user: string } {
  const system = `${WRITING_RULES}

${businessContext(bot)}

TASK: Write messages a customer might send to this business's chat that the business does NOT handle.
Mix short, long, polite, rude, typo-filled and direct styles. Each message should look like a real chat message.`;
  const user = `Category: ${category}.
The business only covers these areas: ${areas.join(", ")}. Do not write anything about these areas.
Write ${count} messages. Call the tool with one entry per message.`;
  return { system, user };
}

// ---------- main ----------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const botId = requireBotId(args);
  const total = numArg(args, "n", 1000);
  const oosShare = numArg(args, "oos", 0.12);
  const seed = numArg(args, "seed", 42);
  const maxPerIntent = numArg(args, "max-per-intent", 4);
  const model = process.env.BENCH_QGEN_MODEL || DEFAULT_MODEL;
  const outDir = args.out && args.out !== "true" ? path.resolve(args.out) : setDir(botId);
  const outFile = path.join(outDir, "questions.jsonl");

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set. Add it to .env.local (see .env.local.example).");
  }
  try {
    await fs.access(outFile);
    if (args.force !== "true") {
      throw new Error(`${outFile} already exists. The question set is frozen; pass --force to regenerate it.`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const bot = await getBot(botId);
  if (!bot) throw new Error(`Bot ${botId} not found in data/bots`);
  if (bot.status !== "ready") throw new Error(`Bot is ${bot.status}, not ready`);

  const client = new Anthropic({ maxRetries: 4, timeout: 180_000 });
  try {
    await client.messages.create({ model, max_tokens: 5, messages: [{ role: "user", content: "Reply with OK." }] });
  } catch (err) {
    throw new Error(
      `Preflight call to Anthropic model "${model}" failed: ${err instanceof Error ? err.message : String(err)}. ` +
        "Check ANTHROPIC_API_KEY, and set BENCH_QGEN_MODEL to a model id your key can use.",
    );
  }

  const rand = rng(seed);
  const byId = new Map(bot.intents.map((i) => [i.id, i]));
  const oosTarget = Math.round(total * oosShare);
  const inScopeTarget = total - oosTarget;

  // ---- in-scope plan ----
  const { quota, shortfall, d3Count } = planQuotas(bot.intents, inScopeTarget, maxPerIntent, rand);
  const styleOrder = shuffle(STYLES, rand);
  let styleIdx = 0;
  const nextStyle = () => styleOrder[styleIdx++ % styleOrder.length];

  const makeTask = (intent: Intent, styles: Style[]): Omit<Task, "ref"> => {
    const parent = intent.parentId ? byId.get(intent.parentId) : undefined;
    return {
      intent,
      path: pathOf(intent, byId),
      area: intent.domain ?? topOf(intent, byId).name,
      parentName: intent.depth === 3 && parent ? parent.name : null,
      styles,
    };
  };
  const toBatches = (list: Omit<Task, "ref">[]): Task[][] => {
    const out: Task[][] = [];
    let cur: Task[] = [];
    let curCount = 0;
    for (const t of list) {
      cur.push({ ...t, ref: cur.length + 1 });
      curCount += t.styles.length;
      if (curCount >= BATCH_QUESTIONS) {
        out.push(cur);
        cur = [];
        curCount = 0;
      }
    }
    if (cur.length) out.push(cur);
    return out;
  };
  const tasks: Omit<Task, "ref">[] = [];
  for (const intent of bot.intents) {
    const q = quota.get(intent.id) ?? 0;
    if (q === 0) continue;
    tasks.push(makeTask(intent, Array.from({ length: q }, () => nextStyle())));
  }
  const batches = toBatches(tasks);

  // ---- out-of-scope plan ----
  const areas = bot.intents.filter((i) => i.depth === 1).map((i) => i.domain ?? i.name);
  const uniqueAreas = [...new Set(areas)];
  const oosBatches = Array.from({ length: Math.ceil(oosTarget / OOS_BATCH) }, (_, i) => ({
    category: OOS_CATEGORIES[i % OOS_CATEGORIES.length],
    count: Math.min(OOS_BATCH, oosTarget - i * OOS_BATCH),
  }));

  console.log(
    `Bot ${bot.name}: ${bot.intents.length} intents. Target ${total} = ${inScopeTarget} in scope + ${oosTarget} out of scope.` +
      `\nPlanned in-scope: ${[...quota.values()].reduce((a, b) => a + b, 0)} from ${quota.size} intents (${d3Count} follow-ups)` +
      (shortfall ? `, short by ${shortfall}: raise --max-per-intent or add intents` : "") +
      `\nWriting with ${model}: ${batches.length} in-scope batches, ${oosBatches.length} out-of-scope batches`,
  );

  // ---- Haiku calls ----
  const raw: Omit<Question, "id">[] = [];
  const shortfalls: string[] = [];

  const runInScope = (list: Task[][]) =>
    mapLimit(list, 6, async (batch, bi) => {
    const { system, user } = inScopeTask(bot, batch);
    const countMessages = (m: Map<number, string[]>) => [...m.values()].reduce((a, v) => a + v.length, 0);
    // Keep the best attempt. A later retry must never replace a fuller one.
    let best = new Map<number, string[]>();
    for (let attempt = 1; attempt <= 3; attempt++) {
      const out = await withRetry(() => callTool(client, model, system, user, "record_messages", BatchOutput), `batch ${bi}`);
      const got = new Map<number, string[]>();
      for (const m of out.messages) got.set(m.ref, [...(got.get(m.ref) ?? []), m.text]);
      if (countMessages(got) > countMessages(best)) best = got;
      if (batch.every((t) => (best.get(t.ref)?.length ?? 0) >= t.styles.length)) break;
    }
    const got = best;
    const rows: Omit<Question, "id">[] = [];
    for (const t of batch) {
      const texts = got.get(t.ref) ?? [];
      if (texts.length < t.styles.length) shortfalls.push(`${t.path}: wanted ${t.styles.length}, got ${texts.length}`);
      t.styles.forEach((style, i) => {
        const text = texts[i];
        if (!text) return;
        rows.push({
          text,
          expectedIntentId: t.intent.id,
          expectedName: t.intent.name,
          depth: t.intent.depth,
          domain: t.area,
          activeIntentId: t.intent.depth === 3 ? (t.intent.parentId ?? null) : null,
          style: style.key,
          kind: "in_scope",
        });
      });
    }
    return rows;
  });

  const inScopeResults = await runInScope(batches);
  // Every depth-1 and depth-2 intent needs at least one question. Fill the ones the first pass missed.
  const covered = new Set(inScopeResults.flat().map((r) => r.expectedIntentId));
  const missing = bot.intents.filter((i) => i.depth < 3 && !covered.has(i.id));
  if (missing.length) {
    console.log(`Filling ${missing.length} intents the first pass missed`);
    inScopeResults.push(...(await runInScope(toBatches(missing.map((i) => makeTask(i, [nextStyle()]))))));
  }
  for (const rows of inScopeResults) raw.push(...rows);

  const oosResults = await mapLimit(oosBatches, 4, async (b, bi) => {
    const { system, user } = oosTask(bot, uniqueAreas, b.category, b.count);
    const out = await withRetry(() => callTool(client, model, system, user, "record_messages", OosOutput), `oos ${bi}`);
    return out.messages.slice(0, b.count).map((m, i) => ({
      text: m.text,
      expectedIntentId: NONE,
      expectedName: null,
      depth: null,
      domain: null,
      activeIntentId: null,
      style: STYLES[(bi * OOS_BATCH + i) % STYLES.length].key,
      kind: "out_of_scope" as const,
    }));
  });
  for (const rows of oosResults) raw.push(...rows);

  // ---- clean, dedupe ----
  const cleaned = raw
    .map((q) => ({ ...q, text: q.text.replace(/\s+/g, " ").trim().replace(/^["'\u201c\u201d]+|["'\u201c\u201d]+$/g, "").trim() }))
    .filter((q) => q.text.length > 0 && q.text.length <= MAX_TEXT_CHARS);
  const seenKeys = new Set<string>();
  const exact = cleaned.filter((q) => {
    const key = q.text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (seenKeys.has(key)) return false;
    seenKeys.add(key);
    return true;
  });
  const vecs = await embed(exact.map((q) => q.text));
  const kept: { q: (typeof exact)[number]; v: (typeof vecs)[number] }[] = [];
  for (let i = 0; i < exact.length; i++) {
    if (kept.some((k) => dot(k.v, vecs[i]) >= NEAR_DUP)) continue;
    kept.push({ q: exact[i], v: vecs[i] });
  }

  const finalRows = shuffle(kept.map((k) => k.q), rand).map((q, i) => ({
    id: `q${String(i + 1).padStart(4, "0")}`,
    ...q,
  })) as Question[];

  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(outFile, finalRows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const body = await fs.readFile(outFile, "utf8");

  // ---- manifest and audit sample ----
  const byDepth: Record<string, number> = {};
  const byStyle: Record<string, number> = {};
  for (const q of finalRows) {
    const d = q.depth === null ? NONE : String(q.depth);
    byDepth[d] = (byDepth[d] ?? 0) + 1;
    byStyle[q.style] = (byStyle[q.style] ?? 0) + 1;
  }
  const inScopeKept = finalRows.filter((q) => q.kind === "in_scope");
  const coveredIds = new Set(inScopeKept.map((q) => q.expectedIntentId));
  const uncovered = bot.intents.filter((i) => i.depth < 3 && !coveredIds.has(i.id)).map((i) => i.name);

  await writeJson(path.join(outDir, "manifest.json"), {
    botId,
    botName: bot.name,
    model,
    seed,
    createdAt: new Date().toISOString(),
    requested: { total, oosShare, inScopeTarget, oosTarget, maxPerIntent, d3Target: D3_TARGET, nearDupCutoff: NEAR_DUP },
    counts: {
      final: finalRows.length,
      inScope: inScopeKept.length,
      outOfScope: finalRows.length - inScopeKept.length,
      byDepth,
      byStyle,
      intentsCovered: coveredIds.size,
      intentsInBot: bot.intents.length,
    },
    dropped: { generated: raw.length, cleanedOrEmpty: raw.length - cleaned.length, exactDup: cleaned.length - exact.length, nearDup: exact.length - kept.length },
    shortfalls: shortfalls.slice(0, 50),
    uncoveredDepth12Intents: uncovered.slice(0, 50),
    questionsFile: "questions.jsonl",
    questionsSha256: sha256File(body),
  });

  const audit = shuffle(finalRows, rng(seed + 1)).slice(0, 50);
  const csvCell = (s: unknown) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const csv = [
    ["id", "kind", "domain", "depth", "expected", "active_intent", "style", "text", "label_ok"].join(","),
    ...audit.map((q) =>
      [q.id, q.kind, q.domain, q.depth, q.expectedName ?? NONE, q.activeIntentId ? byId.get(q.activeIntentId)?.name : "", q.style, q.text, ""]
        .map(csvCell)
        .join(","),
    ),
  ].join("\n");
  await fs.writeFile(path.join(outDir, "label-audit.csv"), csv + "\n");

  console.log(
    `\nWrote ${finalRows.length} questions to ${outFile}` +
      `\n  in scope ${inScopeKept.length}, out of scope ${finalRows.length - inScopeKept.length}, intents covered ${coveredIds.size}/${bot.intents.length}` +
      `\n  dropped: ${raw.length - cleaned.length} empty, ${cleaned.length - exact.length} exact dup, ${exact.length - kept.length} near dup` +
      `\n  Review ${path.join(outDir, "label-audit.csv")} before starting the run.`,
  );
  if (finalRows.length < total) console.warn(`  Short of target ${total}. Check shortfalls in manifest.json.`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
