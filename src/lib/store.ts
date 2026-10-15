import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Bot, BotSummary, Session, Submission, VectorRecord } from "./types";
import { decodeVector, type Vec } from "./vector";

/**
 * Local JSON storage. Layout:
 *   data/bots/<botId>/bot.json
 *   data/bots/<botId>/vectors.json
 *   data/bots/<botId>/sessions/<sessionId>.json
 *   data/bots/<botId>/submissions.json
 *
 * Writes are atomic (temp file + rename) and serialized per file inside this process.
 */

const DATA_DIR = path.join(process.cwd(), "data", "bots");
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

export function isValidId(id: string): boolean {
  return ID_RE.test(id);
}

const locks = new Map<string, Promise<unknown>>();

function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  locks.set(key, next);
  return next;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data));
  // Windows can briefly lock the target file (antivirus, editors), so retry the rename.
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(tmp, file);
      return;
    } catch (err) {
      if (attempt >= 5) throw err;
      await sleep(40 * (attempt + 1));
    }
  }
}

function botDir(botId: string) {
  return path.join(DATA_DIR, botId);
}

// ---------- Bots ----------

export async function listBots(): Promise<Bot[]> {
  let dirs: string[];
  try {
    dirs = await fs.readdir(DATA_DIR);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const bots = await Promise.all(dirs.filter(isValidId).map((id) => getBot(id)));
  return bots.filter((b): b is Bot => b !== null).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getBot(botId: string): Promise<Bot | null> {
  if (!isValidId(botId)) return null;
  return readJson<Bot>(path.join(botDir(botId), "bot.json"));
}

export async function saveBot(bot: Bot): Promise<void> {
  await withLock(`bot:${bot.id}`, async () => {
    bot.updatedAt = new Date().toISOString();
    await writeJsonAtomic(path.join(botDir(bot.id), "bot.json"), bot);
  });
}

/** Read-modify-write a bot under the per-bot lock. Returns the updated bot or null if missing. */
export async function updateBot(botId: string, mutate: (bot: Bot) => void): Promise<Bot | null> {
  return withLock(`bot:${botId}`, async () => {
    const bot = await getBot(botId);
    if (!bot) return null;
    mutate(bot);
    bot.updatedAt = new Date().toISOString();
    await writeJsonAtomic(path.join(botDir(botId), "bot.json"), bot);
    return bot;
  });
}

export async function deleteBot(botId: string): Promise<void> {
  if (!isValidId(botId)) return;
  vectorCache.delete(botId);
  await fs.rm(botDir(botId), { recursive: true, force: true });
}

export function summarize(bot: Bot): BotSummary {
  return {
    id: bot.id,
    name: bot.name,
    status: bot.status,
    progress: bot.progress,
    error: bot.error,
    createdAt: bot.createdAt,
    updatedAt: bot.updatedAt,
    intentCount: bot.intents.length,
  };
}

// ---------- Vectors ----------

export interface VectorItem {
  intentId: string;
  vec: Vec;
}

const vectorCache = new Map<string, VectorItem[]>();

/** Decoded vectors for a bot, cached in memory until the bot's vectors change. */
export async function getVectorIndex(botId: string): Promise<VectorItem[]> {
  const cached = vectorCache.get(botId);
  if (cached) return cached;
  const rows = (await readJson<VectorRecord[]>(path.join(botDir(botId), "vectors.json"))) ?? [];
  const items = rows.map((r) => ({ intentId: r.intentId, vec: decodeVector(r.vec) }));
  vectorCache.set(botId, items);
  return items;
}

export async function saveVectors(botId: string, rows: VectorRecord[]): Promise<void> {
  await withLock(`vec:${botId}`, async () => {
    await writeJsonAtomic(path.join(botDir(botId), "vectors.json"), rows);
    vectorCache.delete(botId);
  });
}

/** Replace all vectors belonging to one intent, keeping the rest. */
export async function replaceIntentVectors(botId: string, intentId: string, rows: VectorRecord[]): Promise<void> {
  await withLock(`vec:${botId}`, async () => {
    const file = path.join(botDir(botId), "vectors.json");
    const existing = (await readJson<VectorRecord[]>(file)) ?? [];
    const kept = existing.filter((r) => r.intentId !== intentId);
    await writeJsonAtomic(file, [...kept, ...rows]);
    vectorCache.delete(botId);
  });
}

// ---------- Sessions ----------

export async function getSession(botId: string, sessionId: string): Promise<Session | null> {
  if (!isValidId(botId) || !isValidId(sessionId)) return null;
  return readJson<Session>(path.join(botDir(botId), "sessions", `${sessionId}.json`));
}

export async function saveSession(session: Session): Promise<void> {
  session.updatedAt = new Date().toISOString();
  await withLock(`session:${session.id}`, () =>
    writeJsonAtomic(path.join(botDir(session.botId), "sessions", `${session.id}.json`), session),
  );
}

// ---------- Submissions ----------

export async function listSubmissions(botId: string): Promise<Submission[]> {
  if (!isValidId(botId)) return [];
  return (await readJson<Submission[]>(path.join(botDir(botId), "submissions.json"))) ?? [];
}

export async function appendSubmission(botId: string, submission: Submission): Promise<void> {
  await withLock(`subs:${botId}`, async () => {
    const file = path.join(botDir(botId), "submissions.json");
    const rows = (await readJson<Submission[]>(file)) ?? [];
    rows.push(submission);
    await writeJsonAtomic(file, rows);
  });
}
