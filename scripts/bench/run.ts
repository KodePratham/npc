/**
 * Run the two contestants over a frozen question set. Resumable: finished ids are skipped on rerun.
 *
 *   npm run bench:run -- --bot <botId> [--run <runId>] [--arms embed,llm] [--limit 30] [--concurrency 8]
 *
 * Embed arm: rankIntents() from the chat engine, with no session or offer state. Predicts "none"
 *            when the raw score is below INTENT_THRESHOLD, exactly as the engine falls back.
 * LLM arm:   gpt-6-luna (BENCH_LLM_MODEL) with the depth 1-2 intent catalog in the instructions, so the
 *            prefix is cacheable. The question comes last. Output is integers only (0 = none).
 *
 * Output: data/bench/runs/<runId>/{run.json, embed.results.jsonl, llm.results.jsonl}
 */
import "./env";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { isEligible, rankIntents } from "../../src/lib/classify";
import { mapLimit } from "../../src/lib/generate";
import { EMBED_MODEL, embed } from "../../src/lib/openai";
import { getBot } from "../../src/lib/store";
import type { Bot, Intent } from "../../src/lib/types";
import {
  NONE,
  readJsonl,
  readJson,
  requireBotId,
  runDir,
  setDir,
  sha256File,
  jsonlAppender,
  numArg,
  parseArgs,
  writeJson,
  type Question,
  type ResultRow,
} from "./common";

const threshold = Number(process.env.INTENT_THRESHOLD) || 0.45;
const contextBoost = Number(process.env.CONTEXT_BOOST) || 0.05;
const LLM_MODEL = process.env.BENCH_LLM_MODEL || "gpt-6-luna";
const LLM_EFFORT = (process.env.BENCH_LLM_EFFORT || "low") as "low" | "medium" | "high";

const RouteSchema = z.object({
  best: z.number().int().min(0),
  top3: z.array(z.number().int().min(0)).max(3),
});

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

function sortByDepth(intents: Intent[]): Intent[] {
  return [...intents].sort((a, b) => a.depth - b.depth);
}

function pathOf(intent: Intent, byId: Map<string, Intent>): string {
  const parent = intent.parentId ? byId.get(intent.parentId) : undefined;
  return parent ? `${parent.name} > ${intent.name}` : intent.name;
}

async function doneIds(file: string): Promise<Set<string>> {
  const rows = await readJsonl<ResultRow>(file);
  return new Set(rows.filter((r) => !r.error).map((r) => r.id));
}

// ---------- embed arm ----------

async function runEmbed(bot: Bot, questions: Question[], file: string, concurrency: number) {
  const done = await doneIds(file);
  const todo = questions.filter((q) => !done.has(q.id));
  const write = jsonlAppender(file);
  console.log(`[embed] ${todo.length} to run (${done.size} already done)`);
  let finished = 0;

  await mapLimit(todo, concurrency, async (q) => {
    const t0 = Date.now();
    let row: ResultRow;
    try {
      const [vec] = await embed([q.text]);
      const ranked = await rankIntents(bot, vec, q.activeIntentId);
      const top = ranked[0];
      const score = top ? top.raw : -1;
      row = {
        id: q.id,
        arm: "embed",
        predicted: !top || score < threshold ? NONE : top.id,
        top3: ranked.slice(0, 3).map((r) => r.id),
        latencyMs: Date.now() - t0,
        score,
        topId: top?.id ?? null,
      };
    } catch (err) {
      row = {
        id: q.id,
        arm: "embed",
        predicted: null,
        top3: [],
        latencyMs: Date.now() - t0,
        score: null,
        topId: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    await write(row);
    finished++;
    if (finished % 100 === 0 || finished === todo.length) console.log(`[embed] ${finished}/${todo.length}`);
  });
}

// ---------- llm arm ----------

interface LlmSetup {
  instructions: string;
  catalogNumbers: Map<number, string>;
  catalogLength: number;
}

function buildLlmSetup(bot: Bot): LlmSetup {
  const byId = new Map(bot.intents.map((i) => [i.id, i]));
  const catalog = sortByDepth(bot.intents.filter((i) => i.depth <= 2));
  const catalogNumbers = new Map<number, string>();
  const lines = catalog.map((intent, idx) => {
    const n = idx + 1;
    catalogNumbers.set(n, intent.id);
    return `${n} | ${pathOf(intent, byId)} | ${oneLine(intent.description)}`;
  });
  const instructions = `You route customer chat messages for ${bot.name} to the right topic in a catalog.
${oneLine(bot.input.businessDescription).slice(0, 600)}

Each catalog line is: number | topic path | what the topic covers.
For the customer message, return:
- best: the number of the topic the customer wants help with. Use 0 only if the message is not about anything in the catalog, for example off-topic, or something this business does not offer.
- top3: up to three numbers, best first.
Judge what the customer needs, not keyword overlap. Pick the most specific topic that fits. If the context block lists follow-up topics, you may pick one of those numbers.

CATALOG
${lines.join("\n")}`;
  return { instructions, catalogNumbers, catalogLength: catalog.length };
}

/** Per-question dynamic part: the active topic and its eligible follow-ups, numbered after the catalog. */
function contextFor(
  bot: Bot,
  byId: Map<string, Intent>,
  activeId: string | null,
  setup: LlmSetup,
): { block: string; numbers: Map<number, string> } | null {
  if (!activeId) return null;
  const active = byId.get(activeId);
  if (!active) return null;
  const numbers = new Map<number, string>();
  const followUps = bot.intents.filter((i) => i.depth === 3 && isEligible(i, active));
  const lines = followUps.map((f, k) => {
    const n = setup.catalogLength + k + 1;
    numbers.set(n, f.id);
    return `${n} | ${pathOf(f, byId)} | ${oneLine(f.description)}`;
  });
  const block =
    `CONTEXT: the customer is in the topic "${pathOf(active, byId)}".` +
    (lines.length ? `\nFollow-up topics that apply to this message:\n${lines.join("\n")}` : "");
  return { block, numbers };
}

async function runLlm(bot: Bot, questions: Question[], file: string, concurrency: number) {
  const done = await doneIds(file);
  const todo = questions.filter((q) => !done.has(q.id));
  const write = jsonlAppender(file);
  const setup = buildLlmSetup(bot);
  const byId = new Map(bot.intents.map((i) => [i.id, i]));
  const client = new OpenAI({ timeout: 180_000, maxRetries: 6 });
  console.log(`[llm] ${LLM_MODEL} (effort ${LLM_EFFORT}), catalog ${setup.catalogLength} topics, ${todo.length} to run`);
  let finished = 0;

  await mapLimit(todo, concurrency, async (q) => {
    const t0 = Date.now();
    const ctx = contextFor(bot, byId, q.activeIntentId, setup);
    const numbers = new Map([...setup.catalogNumbers, ...(ctx?.numbers ?? [])]);
    const input = `${ctx ? `${ctx.block}\n\n` : ""}MESSAGE: ${q.text}`;
    const toPredicted = (n: number): string | null => (n === 0 ? NONE : (numbers.get(n) ?? null));

    let row: ResultRow;
    try {
      let parsed: z.infer<typeof RouteSchema> | null = null;
      let usage = { input_tokens: 0, cached: 0, output_tokens: 0 };
      let lastErr = "no parsed output";
      for (let attempt = 1; attempt <= 2 && !parsed; attempt++) {
        const res = await client.responses.parse({
          model: LLM_MODEL,
          instructions: setup.instructions,
          input,
          reasoning: { effort: LLM_EFFORT },
          max_output_tokens: 4000,
          prompt_cache_key: `bench-catalog-${bot.id}`,
          text: { format: zodTextFormat(RouteSchema, "route") },
        });
        usage = {
          input_tokens: res.usage?.input_tokens ?? 0,
          cached: res.usage?.input_tokens_details?.cached_tokens ?? 0,
          output_tokens: res.usage?.output_tokens ?? 0,
        };
        if (res.output_parsed) parsed = res.output_parsed;
        else lastErr = `unparsable output (status ${res.status ?? "unknown"})`;
      }
      if (!parsed) throw new Error(lastErr);

      const predicted = toPredicted(parsed.best);
      const top3 = parsed.top3.map(toPredicted).filter((x): x is string => x !== null);
      row = {
        id: q.id,
        arm: "llm",
        predicted,
        top3,
        latencyMs: Date.now() - t0,
        inputTokens: usage.input_tokens,
        cachedTokens: usage.cached,
        outputTokens: usage.output_tokens,
        ...(predicted === null ? { error: `invalid catalog number ${parsed.best}` } : {}),
      };
    } catch (err) {
      row = {
        id: q.id,
        arm: "llm",
        predicted: null,
        top3: [],
        latencyMs: Date.now() - t0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    await write(row);
    finished++;
    if (finished % 50 === 0 || finished === todo.length) console.log(`[llm] ${finished}/${todo.length}`);
  });
}

// ---------- main ----------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const botId = requireBotId(args);
  const arms = (args.arms && args.arms !== "true" ? args.arms : "embed,llm").split(",").map((a) => a.trim());
  for (const a of arms) if (a !== "embed" && a !== "llm") throw new Error(`Unknown arm "${a}"`);
  const limit = numArg(args, "limit", Number.POSITIVE_INFINITY);
  const concurrency = numArg(args, "concurrency", 8);
  const questionsFile = args.questions && args.questions !== "true" ? path.resolve(args.questions) : path.join(setDir(botId), "questions.jsonl");

  const bot = await getBot(botId);
  if (!bot) throw new Error(`Bot ${botId} not found in data/bots`);
  if (bot.status !== "ready") throw new Error(`Bot is ${bot.status}, not ready`);

  const fullText = await fs.readFile(questionsFile, "utf8").catch(() => {
    throw new Error(`No question set at ${questionsFile}. Run npm run bench:questions first.`);
  });
  const sha = sha256File(fullText);
  const questions = (await readJsonl<Question>(questionsFile)).slice(0, limit);

  const runId = args.run && args.run !== "true" ? args.run : `${botId.slice(0, 8)}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const dir = runDir(runId);
  const metaFile = path.join(dir, "run.json");
  const meta = {
    runId,
    botId,
    botName: bot.name,
    questionsFile,
    questionsSha256: sha,
    embedModel: EMBED_MODEL,
    llmModel: LLM_MODEL,
    llmEffort: LLM_EFFORT,
    threshold,
    contextBoost,
    createdAt: new Date().toISOString(),
  };
  try {
    const prev = await readJson<typeof meta>(metaFile);
    if (prev.botId !== botId || prev.questionsSha256 !== sha) {
      throw new Error(`Run ${runId} was started with a different bot or question set. Use a new --run id.`);
    }
    console.log(`Resuming run ${runId}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    await writeJson(metaFile, meta);
    console.log(`New run ${runId}`);
  }
  console.log(`${questions.length} questions, arms: ${arms.join(", ")}, threshold ${threshold}`);

  if (arms.includes("embed")) await runEmbed(bot, questions, path.join(dir, "embed.results.jsonl"), Math.max(concurrency, 8));
  if (arms.includes("llm")) await runLlm(bot, questions, path.join(dir, "llm.results.jsonl"), concurrency);

  console.log(`\nDone. Report with: npm run bench:report -- --run ${runId}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
