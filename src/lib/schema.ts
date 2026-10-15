import { z } from "zod";

// ---------- Shared pieces (also used as OpenAI structured-output schemas) ----------
// OpenAI strict mode requires every key to be present, so optional values use nullable/arrays.

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

// ---------- Generation passes ----------

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

// ---------- API input validation ----------

export const BotInputSchema = z.object({
  name: z.string().trim().min(1, "Bot name is required").max(120),
  businessDescription: z.string().trim().min(1, "Describe the business").max(8000),
  pricing: z.string().max(20000).default(""),
  docsLinks: z
    .array(z.string().trim().url("Invalid docs link").refine((u) => /^https?:\/\//.test(u), "Docs links must be http(s)"))
    .max(10)
    .default([]),
  faqs: z.string().max(20000).default(""),
  goals: z.string().max(4000).default(""),
  tone: z.string().max(500).default("friendly and concise"),
  dataToCollect: z.string().max(2000).default(""),
});

export const SlotPatchSchema = SlotSchema;

export const IntentPatchSchema = z.object({
  id: z.string(),
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  examples: z.array(z.string().max(500)).max(60).optional(),
  response: TemplateSchema.optional(),
  slots: z.array(SlotPatchSchema).max(10).optional(),
  onComplete: TemplateSchema.nullable().optional(),
});

export const BotPatchSchema = z.object({
  intent: IntentPatchSchema.optional(),
  facts: z.record(z.string(), z.string()).optional(),
  greeting: TemplateSchema.optional(),
  fallback: TemplateSchema.optional(),
});

export const ChatRequestSchema = z.object({
  sessionId: z.string().nullable().optional(),
  message: z.string().max(2000).optional(),
  init: z.boolean().optional(),
});

export type Pass1 = z.infer<typeof Pass1Schema>;
export type Pass2 = z.infer<typeof Pass2Schema>;
