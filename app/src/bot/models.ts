import type { EmbedModel } from "./types";

export const GEN_MODEL = "gpt-6-luna";

/** OpenAI's newest embedding models. Vectors are shortened with `dimensions` to keep the bot small. */
export const EMBED_MODELS: Record<EmbedModel, { label: string; dimensions: number }> = {
  "text-embedding-3-small": { label: "text-embedding-3-small (fast, cheap)", dimensions: 512 },
  "text-embedding-3-large": { label: "text-embedding-3-large (most accurate)", dimensions: 1024 },
};
