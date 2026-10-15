import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { z } from "zod";
import { normalize, type Vec } from "./vector";

export const GEN_MODEL = process.env.OPENAI_GEN_MODEL || "gpt-6-luna";
export const EMBED_MODEL = process.env.OPENAI_EMBED_MODEL || "text-embedding-3-small";
export const EMBED_DIMENSIONS = Number(process.env.OPENAI_EMBED_DIMENSIONS) || 512;

const EMBED_BATCH = 1000;

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not set. Add it to .env.local and restart the dev server.");
  }
  client ??= new OpenAI({ timeout: 300_000, maxRetries: 3 });
  return client;
}

/** One structured (JSON-schema) call through the Responses API. */
export async function generateStructured<S extends z.ZodType>(opts: {
  name: string;
  schema: S;
  instructions: string;
  input: string;
  maxOutputTokens: number;
}): Promise<z.infer<S>> {
  const res = await getClient().responses.parse({
    model: GEN_MODEL,
    instructions: opts.instructions,
    input: opts.input,
    reasoning: { effort: "low" },
    max_output_tokens: opts.maxOutputTokens,
    text: { format: zodTextFormat(opts.schema, opts.name) },
  });
  if (!res.output_parsed) {
    throw new Error(`Model returned no parsable output for ${opts.name} (status: ${res.status ?? "unknown"})`);
  }
  return res.output_parsed as z.infer<S>;
}

/** Embed texts in batches. Returns unit-length vectors in input order. */
export async function embed(inputs: string[]): Promise<Vec[]> {
  const out: Vec[] = [];
  for (let i = 0; i < inputs.length; i += EMBED_BATCH) {
    const batch = inputs.slice(i, i + EMBED_BATCH);
    const res = await getClient().embeddings.create({
      model: EMBED_MODEL,
      input: batch,
      dimensions: EMBED_DIMENSIONS,
      encoding_format: "float",
    });
    const rows = [...res.data].sort((a, b) => a.index - b.index);
    for (const row of rows) out.push(normalize(Float32Array.from(row.embedding)));
  }
  return out;
}
