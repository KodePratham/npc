import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

// ---------- CLI ----------

/** Minimal `--key value` parser. A bare `--flag` becomes "true". */
export function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[a.slice(2)] = "true";
    } else {
      out[a.slice(2)] = next;
      i++;
    }
  }
  return out;
}

export function numArg(args: Record<string, string>, key: string, fallback: number): number {
  const v = args[key];
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`--${key} must be a number, got "${v}"`);
  return n;
}

// ---------- paths ----------

export const BENCH_ROOT = path.join(process.cwd(), "data", "bench");
export const BOTS_ROOT = path.join(process.cwd(), "data", "bots");

/** Frozen question sets: data/bench/sets/<botId>/. */
export function setDir(botId: string): string {
  return path.join(BENCH_ROOT, "sets", botId);
}

/** Run outputs: data/bench/runs/<runId>/. */
export function runDir(runId: string): string {
  return path.join(BENCH_ROOT, "runs", runId);
}

export function requireBotId(args: Record<string, string>): string {
  const botId = args.bot;
  if (!botId || botId === "true") throw new Error("Missing --bot <botId>");
  return botId;
}

// ---------- files ----------

export async function readJsonl<T>(file: string): Promise<T[]> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as T);
}

export async function writeJsonl(file: string, rows: unknown[]): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
}

/** Serialized appender so concurrent workers never interleave lines. */
export function jsonlAppender(file: string): (row: unknown) => Promise<void> {
  let chain: Promise<void> = fs.mkdir(path.dirname(file), { recursive: true }).then(() => undefined);
  return (row) => {
    chain = chain.then(() => fs.appendFile(file, JSON.stringify(row) + "\n"));
    return chain;
  };
}

export async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, "utf8")) as T;
}

export async function writeJson(file: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2));
}

export function sha256File(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// ---------- random (seeded, so question sets are reproducible) ----------

/** mulberry32: small seeded PRNG. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(items: T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ---------- stats ----------

/** Wilson score interval (95% by default). Returns [low, high] as proportions. */
export function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 0];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

/**
 * Exact two-sided McNemar test on discordant pairs. b = A right & B wrong, c = A wrong & B right.
 * Under H0 each discordant pair is a fair coin flip, so this is a two-sided binomial test.
 */
export function mcnemarExact(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  const logFact: number[] = [0];
  for (let i = 1; i <= n; i++) logFact[i] = logFact[i - 1] + Math.log(i);
  let cum = 0;
  for (let i = 0; i <= k; i++) {
    const logChoose = logFact[n] - logFact[i] - logFact[n - i];
    cum += Math.exp(logChoose - n * Math.LN2);
  }
  return Math.min(1, 2 * cum);
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export const NONE = "none";
export const SYSTEM_WHY = "system:why_info";

/** One labeled row of a frozen question set (questions.jsonl). */
export interface Question {
  id: string;
  text: string;
  /** Bot intent id, or "none" for out-of-scope questions. */
  expectedIntentId: string;
  expectedName: string | null;
  /** Depth of the expected intent (null for out-of-scope). */
  depth: 1 | 2 | 3 | null;
  /** Business area (top-level intent's domain). */
  domain: string | null;
  /** Active intent to classify under. Depth-3 questions use their parent. */
  activeIntentId: string | null;
  style: string;
  kind: "in_scope" | "out_of_scope";
}

/** One prediction row in embed.results.jsonl or llm.results.jsonl. Later rows for an id win. */
export interface ResultRow {
  id: string;
  arm: "embed" | "llm";
  /** Predicted bot intent id, "none", or "system:why_info". Null when the call failed. */
  predicted: string | null;
  top3: string[];
  latencyMs: number;
  /** Embed arm: raw score and top candidate before the threshold. */
  score?: number | null;
  topId?: string | null;
  /** LLM arm: token usage. */
  inputTokens?: number;
  cachedTokens?: number;
  outputTokens?: number;
  error?: string;
}
