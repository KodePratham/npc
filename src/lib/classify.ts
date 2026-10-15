import { embed } from "./openai";
import { getVectorIndex } from "./store";
import { SYSTEM_PREFIX, getSystemIndex, type SystemKind } from "./system";
import { dot, type Vec } from "./vector";
import type { Bot, Intent } from "./types";

const CONTEXT_BOOST = Number(process.env.CONTEXT_BOOST) || 0.05;

export interface Classification {
  /** Winning bot intent, or null when a built-in intent won or nothing matched. */
  intent: Intent | null;
  /** Raw cosine similarity of the winning intent's best example. */
  score: number;
  /** Set when a built-in intent (not a bot intent) wins. */
  system: SystemKind | null;
}

/** One candidate in the ranking. `id` is a bot intent id or a `system:` id. */
export interface RankedIntent {
  id: string;
  intent: Intent | null;
  system: SystemKind | null;
  /** Raw cosine similarity of the best example. Used for the threshold. */
  raw: number;
  /** Score used for ranking (raw plus context boost and specificity). */
  ranked: number;
}

/** Depth-3 intents are eligible only under their parent, or beside the active intent as siblings. */
export function isEligible(intent: Intent, active: Intent | null): boolean {
  if (intent.depth < 3) return true;
  if (!active) return false;
  if (intent.parentId === active.id) return true;
  return active.parentId !== null && intent.parentId === active.parentId;
}

/**
 * Rank every eligible intent (bot and built-in) for an already-embedded message, best first.
 * Children of the active intent get a small ranking boost so follow-ups win in context.
 * The boost only affects ranking; the threshold check uses the raw score.
 */
export async function rankIntents(bot: Bot, query: Vec, activeIntentId: string | null): Promise<RankedIntent[]> {
  const index = await getVectorIndex(bot.id);
  const systemIndex = await getSystemIndex();

  const active = activeIntentId ? (bot.intents.find((i) => i.id === activeIntentId) ?? null) : null;
  const boosted = new Set(
    activeIntentId ? bot.intents.filter((i) => i.parentId === activeIntentId).map((i) => i.id) : [],
  );
  const byId = new Map(bot.intents.map((i) => [i.id, i]));

  const best = new Map<string, { raw: number; ranked: number }>();
  for (const item of [...index, ...systemIndex]) {
    const intent = byId.get(item.intentId);
    // Follow-ups only make sense in their own branch, so skip them unless that branch is active.
    if (intent && !isEligible(intent, active)) continue;
    const raw = dot(query, item.vec);
    // Deeper (more specific) intents win exact ties. The bonus is too small to change real rankings.
    const specificity = (intent?.depth ?? 1) * 0.001;
    const ranked = raw + (boosted.has(item.intentId) ? CONTEXT_BOOST : 0) + specificity;
    const current = best.get(item.intentId);
    if (!current || ranked > current.ranked) best.set(item.intentId, { raw, ranked });
  }

  // Array.sort is stable, so ties keep insertion order, as the original "first max wins" loop did.
  return [...best]
    .map(([id, s]) => {
      const system = id.startsWith(SYSTEM_PREFIX) ? (id.slice(SYSTEM_PREFIX.length) as SystemKind) : null;
      const intent = system ? null : (byId.get(id) ?? null);
      return { id, intent, system, raw: s.raw, ranked: s.ranked };
    })
    .sort((a, b) => b.ranked - a.ranked);
}

/**
 * Embed the message and find the intent whose best example is closest.
 * Thin wrapper over rankIntents, so the chat engine and the benchmark share one code path.
 */
export async function classifyMessage(bot: Bot, text: string, activeIntentId: string | null): Promise<Classification> {
  const [query] = await embed([text]);
  const [top] = await rankIntents(bot, query, activeIntentId);
  if (!top) return { intent: null, score: -1, system: null };
  return { intent: top.intent, score: top.raw, system: top.system };
}
