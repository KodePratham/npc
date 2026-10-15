import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { EMBED_DIMENSIONS, EMBED_MODEL, embed } from "./openai";
import type { VectorItem } from "./store";
import type { Slot, VectorRecord } from "./types";
import { decodeVector, encodeVector } from "./vector";

/**
 * Built-in intents that every bot gets without generation. They are embedded like bot intents,
 * but their replies are written in code. Accept and decline are regex-only, since short replies
 * like "yes" and "no" are too ambiguous for embeddings.
 */
export type SystemKind = "why_info";

export const SYSTEM_PREFIX = "system:";

export const SYSTEM_EXAMPLES: Record<SystemKind, string[]> = {
  why_info: [
    "why do I have to share my name?",
    "why do you need my phone number",
    "why do you need my details",
    "do I have to give you my name",
    "is it required to share my email?",
    "what will you do with my number?",
    "why are you asking for my contact info",
    "I don't want to give my name, why do you need it",
    "do I need to leave my details",
    "why do you need that information",
    "what do you use my phone number for",
    "is sharing my name mandatory",
    "why would I give you my email",
    "do you store my personal info",
    "is this info required to keep chatting",
  ],
};

const ACCEPT_RE =
  /^(?:yes|yeah|yep|yup|yea|sure|ok|okay|absolutely|definitely|of course|go ahead|sounds good|leave my details|leave my info|please)(?:[\s,]+(?:please|thanks|thank you|go ahead|do it))*[\s.!]*$/i;

const DECLINE_RE =
  /^(?:no|nope|nah|no thanks|no thank you|not now|not right now|skip|none|pass|i'?d rather not|i would rather not|i don'?t want to|i do not want to|no need|not interested)(?:[\s,]+(?:please|thanks|thank you))*[\s.!]*$/i;

const QUESTION_START_RE = /^(?:why|what|how|when|where|who|which)\b/i;

/** Short yes/no replies. Returns null for anything else. */
export function offerAct(text: string): "accept" | "decline" | null {
  const t = text.trim();
  if (ACCEPT_RE.test(t)) return "accept";
  if (DECLINE_RE.test(t)) return "decline";
  return null;
}

/** A question rather than an answer. Used so questions are never stored as a slot value. */
export function looksLikeQuestion(text: string): boolean {
  const t = text.trim();
  return t.endsWith("?") || QUESTION_START_RE.test(t);
}

/** Readable form of a snake_case intent name, e.g. "weekend_music_events" -> "weekend music events". */
export function topicName(intentName: string | null | undefined): string | null {
  if (!intentName) return null;
  return intentName.replace(/_/g, " ").trim() || null;
}

export function explainWhy(topic: string | null, mode: "offer" | "optional" | "required"): string {
  const base = topic
    ? `We'd only use it so a team member can follow up about ${topic}.`
    : "We'd only use it so a team member can follow up with you.";
  const tail =
    mode === "offer"
      ? "Feel free to keep chatting without it."
      : mode === "optional"
        ? "You can skip this one."
        : "If you'd rather not, just say so and we'll stop there.";
  return `You don't have to share anything. ${base} ${tail}`;
}

export const DECLINE_REPLY = "No problem, no details needed. Anything else I can help with?";

/** Slots collected when a visitor accepts a follow-up offer that has no slot-bearing child. */
export const DEFAULT_HANDOFF_SLOTS: Slot[] = [
  { key: "name", prompt: "What name should we use? You can skip this.", type: "text", choices: [], required: false },
  {
    key: "contact",
    prompt: "What's the best email or phone number for the team to reach you?",
    type: "contact",
    choices: [],
    required: true,
  },
];

export function handoffComplete(topic: string | null): string {
  return `Thanks, I've passed your details to the team. They'll follow up${topic ? ` about ${topic}` : ""}.`;
}

// ---------- Embedded system examples (cached on disk) ----------

const CACHE_FILE = path.join(process.cwd(), "data", "system-vectors.json");

interface SystemCache {
  key: string;
  rows: VectorRecord[];
}

let memo: Promise<VectorItem[]> | null = null;

/** Embedded system examples. Computed once per process and cached in data/system-vectors.json. */
export function getSystemIndex(): Promise<VectorItem[]> {
  memo ??= loadSystemIndex().catch((err: unknown) => {
    memo = null;
    throw err;
  });
  return memo;
}

async function loadSystemIndex(): Promise<VectorItem[]> {
  const rows: { intentId: string; text: string }[] = [];
  for (const [kind, examples] of Object.entries(SYSTEM_EXAMPLES)) {
    for (const text of examples) rows.push({ intentId: `${SYSTEM_PREFIX}${kind}`, text });
  }

  // The key changes whenever the model, dimensions, or examples change, which forces a re-embed.
  const key = createHash("sha256")
    .update(JSON.stringify({ model: EMBED_MODEL, dims: EMBED_DIMENSIONS, examples: SYSTEM_EXAMPLES }))
    .digest("hex");

  let cache = await readCache();
  if (!cache || cache.key !== key) {
    const vectors = await embed(rows.map((r) => r.text));
    cache = {
      key,
      rows: rows.map((r, i) => ({ intentId: r.intentId, text: r.text, vec: encodeVector(vectors[i]) })),
    };
    await writeCache(cache);
  }
  return cache.rows.map((r) => ({ intentId: r.intentId, vec: decodeVector(r.vec) }));
}

async function readCache(): Promise<SystemCache | null> {
  try {
    return JSON.parse(await fs.readFile(CACHE_FILE, "utf8")) as SystemCache;
  } catch {
    return null;
  }
}

async function writeCache(cache: SystemCache): Promise<void> {
  await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
  await fs.writeFile(CACHE_FILE, JSON.stringify(cache));
}