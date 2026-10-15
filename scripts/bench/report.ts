/**
 * Score a run and write report.md, summary.json and disagreements.csv into data/bench/runs/<runId>/.
 *
 *   npm run bench:report -- --run <runId>
 *
 * Only questions answered by both arms are used for the paired McNemar test. Each arm's own accuracy
 * uses every question it answered without error.
 */
import "./env";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getBot } from "../../src/lib/store";
import type { Bot, Intent } from "../../src/lib/types";
import {
  NONE,
  SYSTEM_WHY,
  mcnemarExact,
  parseArgs,
  percentile,
  readJson,
  readJsonl,
  runDir,
  wilson,
  writeJson,
  type Question,
  type ResultRow,
} from "./common";

type Arm = "embed" | "llm";
const ARMS: Arm[] = ["embed", "llm"];
const ARM_LABEL: Record<Arm, string> = { embed: "stealth-01", llm: "gpt-6-luna" };

interface RunMeta {
  runId: string;
  botId: string;
  botName: string;
  questionsFile: string;
  questionsSha256: string;
  embedModel: string;
  llmModel: string;
  llmEffort: string;
  threshold: number;
  contextBoost: number;
  createdAt: string;
}

interface Evaluated {
  q: Question;
  row: ResultRow;
  correct: boolean;
  /** Right business area (top-level ancestor). For out-of-scope questions this equals "correctly refused". */
  area: boolean;
  /** In scope only: expected intent in the top 3. */
  top3: boolean | null;
  /** In scope only: predicted none (the bot would fall back). */
  fallback: boolean;
  /** Out of scope only: predicted something (the bot would answer). */
  falseAnswer: boolean;
}

// ---------- loading ----------

/** Last row per id wins, so a retried error is replaced by its later success. */
async function loadRows(file: string): Promise<Map<string, ResultRow>> {
  const map = new Map<string, ResultRow>();
  for (const row of await readJsonl<ResultRow>(file)) map.set(row.id, row);
  return map;
}

// ---------- scoring ----------

function evaluate(q: Question, row: ResultRow, ancestorOf: (id: string) => string): Evaluated {
  const pred = row.predicted ?? "";
  const inScope = q.kind === "in_scope";
  const correct = pred === q.expectedIntentId;
  return {
    q,
    row,
    correct,
    area: inScope ? ancestorOf(pred) === ancestorOf(q.expectedIntentId) : pred === NONE,
    top3: inScope ? row.top3.includes(q.expectedIntentId) : null,
    fallback: inScope && pred === NONE,
    falseAnswer: !inScope && pred !== NONE,
  };
}

function rate(num: number, den: number) {
  return den === 0 ? null : num / den;
}

interface Group {
  n: number;
  correct: number;
  acc: number | null;
  ci: [number, number] | null;
}

function group(items: Evaluated[]): Group {
  const correct = items.filter((e) => e.correct).length;
  const n = items.length;
  return { n, correct, acc: rate(correct, n), ci: n ? wilson(correct, n) : null };
}

function groupBy(items: Evaluated[], key: (e: Evaluated) => string): Record<string, Group> {
  const buckets = new Map<string, Evaluated[]>();
  for (const e of items) {
    const k = key(e);
    buckets.set(k, [...(buckets.get(k) ?? []), e]);
  }
  return Object.fromEntries([...buckets].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, group(v)]));
}

interface ArmSummary {
  arm: Arm;
  label: string;
  evaluated: number;
  errors: number;
  accuracy: Group;
  inScope: { n: number; top3: number | null; fallbackRate: number | null; top3Rate: number | null; areaRate: number | null };
  outOfScope: { n: number; falseAnswerRate: number | null; refusedRate: number | null };
  areaAccuracy: number | null;
  latency: { p50: number | null; p95: number | null };
  tokens: { input: number; cached: number; output: number } | null;
  costUsd: number | null;
}

function summarizeArm(arm: Arm, evals: Evaluated[], errors: number, rows: ResultRow[], costUsd: number | null): ArmSummary {
  const inScope = evals.filter((e) => e.q.kind === "in_scope");
  const oos = evals.filter((e) => e.q.kind === "out_of_scope");
  const top3Hits = inScope.filter((e) => e.top3).length;
  const llmRows = rows.filter((r) => r.inputTokens !== undefined);
  const tokens = llmRows.length
    ? {
        input: llmRows.reduce((a, r) => a + (r.inputTokens ?? 0), 0),
        cached: llmRows.reduce((a, r) => a + (r.cachedTokens ?? 0), 0),
        output: llmRows.reduce((a, r) => a + (r.outputTokens ?? 0), 0),
      }
    : null;
  const lat = rows.map((r) => r.latencyMs);
  return {
    arm,
    label: ARM_LABEL[arm],
    evaluated: evals.length,
    errors,
    accuracy: group(evals),
    inScope: {
      n: inScope.length,
      top3: top3Hits,
      top3Rate: rate(top3Hits, inScope.length),
      fallbackRate: rate(inScope.filter((e) => e.fallback).length, inScope.length),
      areaRate: rate(inScope.filter((e) => e.area).length, inScope.length),
    },
    outOfScope: {
      n: oos.length,
      falseAnswerRate: rate(oos.filter((e) => e.falseAnswer).length, oos.length),
      refusedRate: rate(oos.filter((e) => !e.falseAnswer).length, oos.length),
    },
    areaAccuracy: rate(evals.filter((e) => e.area).length, evals.length),
    latency: { p50: percentile(lat, 50), p95: percentile(lat, 95) },
    tokens,
    costUsd,
  };
}

// ---------- formatting ----------

const pct = (x: number | null | undefined) => (x === null || x === undefined ? "n/a" : `${(x * 100).toFixed(1)}%`);
const pctCi = (g: Group) => (g.acc === null || !g.ci ? "n/a" : `${pct(g.acc)} [${pct(g.ci[0])}, ${pct(g.ci[1])}]`);
const money = (x: number | null) => (x === null ? "n/a (set BENCH_PRICE_* in .env.local)" : `$${x.toFixed(2)}`);

function table(headers: string[], rows: (string | number)[][]): string {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.map((c) => String(c)).join(" | ")} |`),
  ].join("\n");
}

function csvCell(s: string | number | boolean | null | undefined): string {
  return `"${String(s ?? "").replace(/"/g, '""')}"`;
}

// ---------- main ----------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runId = args.run;
  if (!runId || runId === "true") throw new Error("Missing --run <runId>");
  const dir = runDir(runId);
  const meta = await readJson<RunMeta>(path.join(dir, "run.json"));

  const questions = await readJsonl<Question>(meta.questionsFile);
  const bot: Bot | null = await getBot(meta.botId);
  if (!bot) throw new Error(`Bot ${meta.botId} not found`);
  const byId = new Map<string, Intent>(bot.intents.map((i) => [i.id, i]));
  const ancestorOf = (id: string): string => {
    if (id === NONE || id.startsWith("system:")) return id;
    let cur = byId.get(id);
    while (cur?.parentId && byId.get(cur.parentId)) cur = byId.get(cur.parentId);
    return cur?.id ?? id;
  };
  const nameOf = (id: string | null): string => {
    if (id === null) return "error";
    if (id === NONE) return "none";
    if (id === SYSTEM_WHY) return "why_info (built-in)";
    return byId.get(id)?.name ?? `unknown:${id}`;
  };

  const rowsByArm = Object.fromEntries(
    await Promise.all(ARMS.map(async (a) => [a, await loadRows(path.join(dir, `${a}.results.jsonl`))])),
  ) as Record<Arm, Map<string, ResultRow>>;

  // Prices (USD per 1M tokens) are optional; without them the cost is reported as n/a.
  const price = (k: string) => (process.env[k] ? Number(process.env[k]) : null);
  const pIn = price("BENCH_PRICE_LLM_INPUT");
  const pCached = price("BENCH_PRICE_LLM_CACHED_INPUT") ?? pIn;
  const pOut = price("BENCH_PRICE_LLM_OUTPUT");
  const pEmbed = price("BENCH_PRICE_EMBED");

  const evalsByArm = {} as Record<Arm, Evaluated[]>;
  const summaries = {} as Record<Arm, ArmSummary>;
  for (const arm of ARMS) {
    const rows = rowsByArm[arm];
    const evals: Evaluated[] = [];
    let errors = 0;
    const used: ResultRow[] = [];
    for (const q of questions) {
      const row = rows.get(q.id);
      if (!row) continue;
      if (row.error || row.predicted === null) {
        errors++;
        continue;
      }
      evals.push(evaluate(q, row, ancestorOf));
      used.push(row);
    }
    evalsByArm[arm] = evals;
    let cost: number | null = null;
    if (arm === "llm") {
      const t = used.reduce(
        (acc, r) => ({ i: acc.i + (r.inputTokens ?? 0), c: acc.c + (r.cachedTokens ?? 0), o: acc.o + (r.outputTokens ?? 0) }),
        { i: 0, c: 0, o: 0 },
      );
      if (pIn !== null && pOut !== null) cost = ((t.i - t.c) * pIn + t.c * (pCached ?? pIn) + t.o * pOut) / 1e6;
    } else if (pEmbed !== null) {
      const qById = new Map(questions.map((q) => [q.id, q]));
      const tokens = used.reduce((acc, r) => acc + Math.ceil((qById.get(r.id)?.text.length ?? 0) / 4), 0);
      cost = (tokens * pEmbed) / 1e6;
    }
    summaries[arm] = summarizeArm(arm, evals, errors, [...rows.values()], cost);
  }

  // ---- paired comparison on questions both arms answered ----
  const embedById = new Map(evalsByArm.embed.map((e) => [e.q.id, e]));
  const llmById = new Map(evalsByArm.llm.map((e) => [e.q.id, e]));
  const paired = questions.filter((q) => embedById.has(q.id) && llmById.has(q.id));
  let b = 0; // embed right, llm wrong
  let c = 0; // embed wrong, llm right
  for (const q of paired) {
    const e = embedById.get(q.id)!;
    const l = llmById.get(q.id)!;
    if (e.correct && !l.correct) b++;
    if (!e.correct && l.correct) c++;
  }
  const pValue = mcnemarExact(b, c);
  const pairedEmbed = paired.filter((q) => embedById.get(q.id)!.correct).length;
  const pairedLlm = paired.filter((q) => llmById.get(q.id)!.correct).length;
  let verdict: string;
  if (paired.length === 0) verdict = "No questions answered by both arms yet.";
  else if (pValue >= 0.05) verdict = `No significant difference (McNemar p = ${pValue.toFixed(3)}, ${paired.length} paired questions).`;
  else if (pairedEmbed > pairedLlm) verdict = `stealth-01 wins (McNemar p = ${pValue.toFixed(4)}, ${paired.length} paired questions).`;
  else verdict = `gpt-6-luna wins (McNemar p = ${pValue.toFixed(4)}, ${paired.length} paired questions).`;

  // ---- threshold sweep (embed arm, tuned on this test set) ----
  const sweepPoints = [...new Set([0.35, 0.4, 0.45, 0.5, 0.55, 0.6, meta.threshold])].sort((x, y) => x - y);
  const embedRows = questions.map((q) => ({ q, row: rowsByArm.embed.get(q.id) })).filter((x) => x.row && !x.row.error && x.row.score !== null && x.row.score !== undefined);
  const sweep = sweepPoints.map((t) => {
    let correct = 0;
    let fallback = 0;
    for (const { q, row } of embedRows) {
      const pred = (row!.score ?? -1) >= t ? (row!.topId ?? NONE) : NONE;
      if (pred === q.expectedIntentId) correct++;
      if (q.kind === "in_scope" && pred === NONE) fallback++;
    }
    const inScopeN = embedRows.filter((x) => x.q.kind === "in_scope").length;
    return {
      threshold: t,
      configured: t === meta.threshold,
      accuracy: embedRows.length ? correct / embedRows.length : null,
      fallbackRate: inScopeN ? fallback / inScopeN : null,
      correct,
      n: embedRows.length,
    };
  });

  // ---- breakdowns ----
  const depthKey = (e: Evaluated) => (e.q.depth === null ? "out of scope" : `depth ${e.q.depth}`);
  const byDepth = Object.fromEntries(ARMS.map((a) => [a, groupBy(evalsByArm[a], depthKey)]));
  const byStyle = Object.fromEntries(ARMS.map((a) => [a, groupBy(evalsByArm[a], (e) => e.q.style)]));
  const byDomain = Object.fromEntries(ARMS.map((a) => [a, groupBy(evalsByArm[a], (e) => e.q.domain ?? "(out of scope)")]));

  // ---- disagreements ----
  const diffRows: (string | number | boolean | null)[][] = [];
  for (const q of paired) {
    const e = embedById.get(q.id)!;
    const l = llmById.get(q.id)!;
    if (e.correct && l.correct) continue;
    const category = !e.correct && !l.correct ? "both missed" : e.correct ? "stealth-01 only" : "gpt-6-luna only";
    diffRows.push([
      q.id, category, q.kind, q.domain, q.depth, q.expectedName ?? NONE, q.style, q.text,
      nameOf(e.row.predicted), e.correct, nameOf(l.row.predicted), l.correct, e.row.score ?? null,
    ]);
  }
  const csvHeader = ["id", "category", "kind", "domain", "depth", "expected", "style", "text", "stealth01_pred", "stealth01_correct", "gpt6luna_pred", "gpt6luna_correct", "stealth01_score"];
  await fs.writeFile(path.join(dir, "disagreements.csv"), [csvHeader.join(","), ...diffRows.map((r) => r.map(csvCell).join(","))].join("\n") + "\n");
  const bothMissed = diffRows.filter((r) => r[1] === "both missed").length;

  // ---- report.md ----
  const headline = table(
    ["Arm", "Evaluated", "Accuracy (95% CI)", "Top-3 (in scope)", "Right area", "False fallback (in scope)", "False answer (out of scope)", "Errors", "p50 ms", "p95 ms", "Cost"],
    ARMS.map((a) => {
      const s = summaries[a];
      return [
        s.label,
        s.evaluated,
        pctCi(s.accuracy),
        pct(s.inScope.top3Rate),
        pct(s.areaAccuracy),
        pct(s.inScope.fallbackRate),
        pct(s.outOfScope.falseAnswerRate),
        s.errors,
        s.latency.p50?.toFixed(0) ?? "n/a",
        s.latency.p95?.toFixed(0) ?? "n/a",
        money(s.costUsd),
      ];
    }),
  );
  const depthRows = ["depth 1", "depth 2", "depth 3", "out of scope"].map((d) => [
    d,
    ...ARMS.flatMap((a) => {
      const g = byDepth[a][d];
      return [g ? g.n : 0, g ? pct(g.acc) : "n/a"];
    }),
  ]);
  const styleKeys = [...new Set(questions.map((q) => q.style))].sort();
  const styleRows = styleKeys.map((k) => [k, ...ARMS.flatMap((a) => { const g = byStyle[a][k]; return [g ? g.n : 0, g ? pct(g.acc) : "n/a"]; })]);
  const domainKeys = [...new Set(questions.map((q) => q.domain ?? "(out of scope)"))].sort();
  const domainRows = domainKeys.map((k) => [k, ...ARMS.flatMap((a) => { const g = byDomain[a][k]; return [g ? g.n : 0, g ? pct(g.acc) : "n/a"]; })]);

  const md = `# Intent accuracy: ${meta.botName}

Run \`${runId}\` on ${questions.length} questions in \`${path.basename(meta.questionsFile)}\` (sha256 ${meta.questionsSha256.slice(0, 12)}...). Created ${meta.createdAt}.
stealth-01: threshold ${meta.threshold}, context boost ${meta.contextBoost}. gpt-6-luna: reasoning effort ${meta.llmEffort}.

## Result

**${verdict}**

${headline}

Accuracy counts a prediction as correct only when it is the exact expected intent (or "none" for out-of-scope questions). "Right area" counts a prediction under the same top-level business area as correct, so it separates near-duplicate confusion from real misses.

## Paired comparison

Questions answered by both arms: ${paired.length}. stealth-01 right and gpt-6-luna wrong: ${b}. gpt-6-luna right and stealth-01 wrong: ${c}. Exact McNemar p = ${pValue.toFixed(4)} (two-sided).
Accuracy on those questions: stealth-01 ${pct(pairedEmbed / (paired.length || 1))}, gpt-6-luna ${pct(pairedLlm / (paired.length || 1))}.

## By expected depth

${table(["Depth", "stealth-01 n", "stealth-01 acc", "gpt-6-luna n", "gpt-6-luna acc"], depthRows)}

Depth 3 questions are follow-ups labeled with their parent as the active intent. Depth 3 is not reachable cold.

## By style

${table(["Style", "stealth-01 n", "stealth-01 acc", "gpt-6-luna n", "gpt-6-luna acc"], styleRows)}

## By business area

${table(["Area", "stealth-01 n", "stealth-01 acc", "gpt-6-luna n", "gpt-6-luna acc"], domainRows)}

## stealth-01 threshold sweep

Tuned on this same test set, so treat the best point as optimistic. The headline uses the configured threshold.

${table(
  ["Threshold", "Accuracy", "False fallback (in scope)", "Configured"],
  sweep.map((s) => [s.threshold.toFixed(2), pct(s.n ? s.correct / s.n : null), pct(s.fallbackRate), s.configured ? "yes" : ""]),
)}

## Cost and volume

- stealth-01 tokens are estimated from question length (about 4 characters per token).
- LLM tokens: input ${summaries.llm.tokens?.input ?? "n/a"} (cached ${summaries.llm.tokens?.cached ?? "n/a"}), output ${summaries.llm.tokens?.output ?? "n/a"}.
- Cost: stealth-01 ${money(summaries.embed.costUsd)}, gpt-6-luna ${money(summaries.llm.costUsd)}.

## Caveats

- ${bothMissed} paired questions were missed by both arms. Read \`disagreements.csv\` (category "both missed") for likely label noise before you trust a gap of a few points.
- gpt-6-luna wrote the intent catalog and is also a contestant. Haiku wrote the questions from the brief and intent descriptions only, never the examples or replies.
- Questions are synthetic. Treat results as a proxy for real customer traffic.
- Coverage: stealth-01 ${summaries.embed.evaluated}/${questions.length}, gpt-6-luna ${summaries.llm.evaluated}/${questions.length}. Rerun \`bench:run\` with the same \`--run\` id to finish missing rows.
`;

  await fs.writeFile(path.join(dir, "report.md"), md);
  await writeJson(path.join(dir, "summary.json"), {
    runId,
    botId: meta.botId,
    questions: questions.length,
    verdict,
    paired: { n: paired.length, embedOnlyCorrect: b, llmOnlyCorrect: c, pValue, embedCorrect: pairedEmbed, llmCorrect: pairedLlm },
    arms: summaries,
    byDepth,
    byStyle,
    byDomain,
    thresholdSweep: sweep,
    bothMissed,
  });

  console.log(`${verdict}\nWrote ${path.join(dir, "report.md")}`);
  console.log(`      ${path.join(dir, "summary.json")}`);
  console.log(`      ${path.join(dir, "disagreements.csv")}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
