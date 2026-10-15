import type { Bot, Submission, VectorItem } from "./types";

/**
 * IndexedDB storage, local to this browser. Object stores:
 *   bots         keyed by id
 *   vectors      keyed by botId, { botId, items: VectorItem[] }
 *   submissions  keyed by id, indexed by botId
 */

const DB_NAME = "npc-app";
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("bots", { keyPath: "id" });
      db.createObjectStore("vectors", { keyPath: "botId" });
      db.createObjectStore("submissions", { keyPath: "id" }).createIndex("botId", "botId");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

// ---------- Bots ----------

export async function listBots(): Promise<Bot[]> {
  const db = await openDb();
  const bots = await promisify(db.transaction("bots").objectStore("bots").getAll() as IDBRequest<Bot[]>);
  return bots.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getBot(botId: string): Promise<Bot | null> {
  const db = await openDb();
  return (await promisify(db.transaction("bots").objectStore("bots").get(botId) as IDBRequest<Bot | undefined>)) ?? null;
}

/** Save a bot, and its vectors when given, in one transaction. */
export async function saveBot(bot: Bot, vectors?: VectorItem[]): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(["bots", "vectors"], "readwrite");
  tx.objectStore("bots").put(bot);
  if (vectors) {
    tx.objectStore("vectors").put({ botId: bot.id, items: vectors });
    vectorCache.set(bot.id, vectors);
  }
  await done(tx);
}

export async function deleteBot(botId: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(["bots", "vectors", "submissions"], "readwrite");
  tx.objectStore("bots").delete(botId);
  tx.objectStore("vectors").delete(botId);
  const subs = tx.objectStore("submissions");
  const keys = subs.index("botId").getAllKeys(botId);
  keys.onsuccess = () => {
    for (const key of keys.result) subs.delete(key);
  };
  await done(tx);
  vectorCache.delete(botId);
}

// ---------- Vectors ----------

const vectorCache = new Map<string, VectorItem[]>();

export async function getVectorIndex(botId: string): Promise<VectorItem[]> {
  const cached = vectorCache.get(botId);
  if (cached) return cached;
  const db = await openDb();
  const row = await promisify(
    db.transaction("vectors").objectStore("vectors").get(botId) as IDBRequest<{ items: VectorItem[] } | undefined>,
  );
  const items = row?.items ?? [];
  vectorCache.set(botId, items);
  return items;
}

// ---------- Submissions ----------

export async function listSubmissions(botId: string): Promise<Submission[]> {
  const db = await openDb();
  const rows = await promisify(
    db.transaction("submissions").objectStore("submissions").index("botId").getAll(botId) as IDBRequest<Submission[]>,
  );
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function appendSubmission(submission: Submission): Promise<void> {
  const db = await openDb();
  const tx = db.transaction("submissions", "readwrite");
  tx.objectStore("submissions").put(submission);
  await done(tx);
}
