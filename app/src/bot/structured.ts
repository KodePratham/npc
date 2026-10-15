import { zodTextFormat } from "openai/helpers/zod";
import type { z } from "zod";
import { GEN_MODEL } from "./models";
import { getClient } from "./openai";

/** One structured (JSON-schema) call through the Responses API. */
export async function generateStructured<S extends z.ZodType>(opts: {
  name: string;
  schema: S;
  instructions: string;
  input: string;
  maxOutputTokens: number;
  signal?: AbortSignal;
}): Promise<z.infer<S>> {
  const res = await getClient().responses.parse(
    {
      model: GEN_MODEL,
      instructions: opts.instructions,
      input: opts.input,
      reasoning: { effort: "low" },
      max_output_tokens: opts.maxOutputTokens,
      text: { format: zodTextFormat(opts.schema, opts.name) },
    },
    { signal: opts.signal },
  );
  if (!res.output_parsed) {
    throw new Error(`Model returned no parsable output for ${opts.name} (status: ${res.status ?? "unknown"})`);
  }
  return res.output_parsed as z.infer<S>;
}
