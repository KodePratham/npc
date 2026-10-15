import { embed } from "./openai";
import { getVectorIndex } from "./store";
import { SYSTEM_PREFIX, type SystemKind } from "./system";
import { dot } from "./vector";
import type { Bot, Intent } from "./types";

const CONTEXT_BOOST = 0.05;

export interface Classification {
  /** Winning bot intent, or null when a built-in intent won or nothing matched. */
  intent: Intent | null;
  /** Raw cosine similarity of the winning intent's best example. */
  score: number;
  /** Set when a built-in intent (not a bot intent) wins. */
  system: SystemKind | null;
}

/** Depth-3 intents are eligible only under their parent, or beside the active intent as siblings. */
function isEligible(intent: Intent, active: Intent | null): boolean {
  if (intent.depth < 3) return true;
  if (!active) return false;
  if (intent.parentId === active.id) return true;
  return active.parentId !== null && intent.parentId === active.parentId;
}

/**
 * Embed the message and find the intent whose best example is closest.
 * Children of the active intent get a small ranking boost so follow-ups win in context.
 * The boost only affects ranking; the threshold check uses the raw score.
 */
export async function classifyMessage(bot: Bot, text: string, activeIntentId: string | null): Promise<Classification> {
  const [[query], index] = await Promise.all([embed([text], bot.embed), getVectorIndex(bot.id)]);

  const byId = new Map(bot.intents.map((i) => [i.id, i]));
  const active = activeIntentId ? (byId.get(activeIntentId) ?? null) : null;
  const boosted = new Set(activeIntentId ? bot.intents.filter((i) => i.parentId === activeIntentId).map((i) => i.id) : []);

  let top: { id: string; raw: number; ranked: number } | null = null;
  for (const item of index) {
    const intent = byId.get(item.intentId);
    if (intent && !isEligible(intent, active)) continue;
    const raw = dot(query, item.vec);
    // Deeper (more specific) intents win exact ties. The bonus is too small to change real rankings.
    const specificity = (intent?.depth ?? 1) * 0.001;
    const ranked = raw + (boosted.has(item.intentId) ? CONTEXT_BOOST : 0) + specificity;
    if (!top || ranked > top.ranked) top = { id: item.intentId, raw, ranked };
  }

  if (!top) return { intent: null, score: -1, system: null };
  const system = top.id.startsWith(SYSTEM_PREFIX) ? (top.id.slice(SYSTEM_PREFIX.length) as SystemKind) : null;
  return { intent: system ? null : (byId.get(top.id) ?? null), score: top.raw, system };
}
