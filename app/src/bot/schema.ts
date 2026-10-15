import { z } from "zod";

// Same shapes as src/lib/schema.ts. OpenAI strict mode requires every key to be present,
// so optional values use nullable/arrays.

export const TemplateSchema = z.object({
  text: z.string(),
  quickReplies: z.array(z.string()),
});

export const SlotSchema = z.object({
  key: z.string(),
  prompt: z.string(),
  type: z.enum(["text", "email", "phone", "number", "date", "choice", "contact"]),
  choices: z.array(z.string()),
  required: z.boolean(),
});

const LeafSchema = z.object({
  name: z.string(),
  description: z.string(),
  examples: z.array(z.string()),
  response: TemplateSchema,
  slots: z.array(SlotSchema),
  onComplete: TemplateSchema.nullable(),
  nextStage: z.string().nullable(),
});

/** Pass 1: stages, bot facts, greeting/fallback and top-level intents. */
export const Pass1Schema = z.object({
  facts: z.array(z.object({ key: z.string(), value: z.string() })),
  stages: z.array(z.object({ name: z.string(), description: z.string() })),
  greeting: TemplateSchema,
  fallback: TemplateSchema,
  intents: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      stage: z.string(),
      examples: z.array(z.string()),
      response: TemplateSchema,
    }),
  ),
});

/** Pass 2: per top-level intent, its sub-intents and their follow-ups. */
export const Pass2Schema = z.object({
  subIntents: z.array(LeafSchema.extend({ followUps: z.array(LeafSchema) })),
});

export type Pass1 = z.infer<typeof Pass1Schema>;
export type Pass2 = z.infer<typeof Pass2Schema>;
