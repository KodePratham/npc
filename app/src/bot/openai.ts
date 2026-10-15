import OpenAI from "openai";
import type { EmbedConfig } from "./types";
import { normalize, type Vec } from "./vector";

const EMBED_BATCH = 1000;
/** sessionStorage is scoped to this tab and cleared when it closes. The key never goes to our server. */
const KEY_STORAGE = "npc:openai-key";

export function getApiKey(): string | null {
  try {
    return sessionStorage.getItem(KEY_STORAGE);
  } catch {
    return null;
  }
}

export function setApiKey(key: string): void {
  sessionStorage.setItem(KEY_STORAGE, key);
}

export function clearApiKey(): void {
  sessionStorage.removeItem(KEY_STORAGE);
  client = null;
}

function makeClient(apiKey: string, timeout: number, maxRetries: number): OpenAI {
  return new OpenAI({ apiKey, dangerouslyAllowBrowser: true, timeout, maxRetries });
}

let client: OpenAI | null = null;
let clientKey = "";

export function getClient(): OpenAI {
  const key = getApiKey();
  if (!key) throw new Error("Add your OpenAI API key first.");
  if (!client || clientKey !== key) {
    client = makeClient(key, 300_000, 2);
    clientKey = key;
  }
  return client;
}

/** Check a key with a tiny embedding call, which needs the same permission the bot uses at chat time. */
export async function verifyKey(key: string): Promise<void> {
  await makeClient(key, 20_000, 0).embeddings.create({
    model: "text-embedding-3-small",
    input: "ping",
    dimensions: 8,
  });
}

/** Embed texts in batches. Returns unit-length vectors in input order. */
export async function embed(inputs: string[], cfg: EmbedConfig, signal?: AbortSignal): Promise<Vec[]> {
  const out: Vec[] = [];
  for (let i = 0; i < inputs.length; i += EMBED_BATCH) {
    const batch = inputs.slice(i, i + EMBED_BATCH);
    const res = await getClient().embeddings.create(
      { model: cfg.model, input: batch, dimensions: cfg.dimensions, encoding_format: "float" },
      { signal },
    );
    const rows = [...res.data].sort((a, b) => a.index - b.index);
    for (const row of rows) out.push(normalize(Float32Array.from(row.embedding)));
  }
  return out;
}
