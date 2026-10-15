import { GEN_MODEL } from "./models";
import { embed } from "./openai";
import { generateStructured } from "./structured";
import { Pass1Schema, Pass2Schema, type Pass1, type Pass2 } from "./schema";
import { cleanExamples, cleanSlots, cleanTemplate, snakeKey } from "./normalize";
import { errorMessage, isAbort } from "./errors";
import { systemRows } from "./system";
import type { Bot, BotInput, EmbedConfig, Intent, Stage, Template, VectorItem } from "./types";

/** Browser port of src/lib/generate.ts. Same prompts and assembly, but results are returned instead of written to disk. */

const SUB_CONCURRENCY = 5;
const PASS1_MAX_TOKENS = 60_000;
const PASS2_MAX_TOKENS = 30_000;
const DOCS_CHAR_LIMIT = 60_000;
export const DEFAULT_THRESHOLD = 0.45;

// ---------- Prompts ----------

const RULES = `You are designing a template-based chatbot. At chat time there is NO language model:
each incoming user message is embedded and matched to the closest intent by its example utterances,
and the bot replies with that intent's fixed template. Therefore:
- Example utterances must sound like real customers typing: vary wording, length, politeness, typos,
  slang, and questions vs. statements. Do not repeat the same sentence with a different name.
- Reply templates are ready-to-send messages in the requested tone. Use {{key}} placeholders for facts.
  Known facts: business_name, business_description, pricing, faqs. You may define more in "facts".
- Never invent prices, discounts, links, policies, or contact details. Use only what the business info
  and docs say. If something is unknown, say a team member can follow up.
- Never ask the visitor for personal details (name, phone, email) in a reply unless that same intent
  defines slots that collect them. To offer a follow-up instead, end with a yes/no question such as
  "Would you like a team member to follow up?". The chat engine handles yes/no and collects the details.
- Keep reply templates short (1 to 4 sentences). Quick replies are optional short button labels.`;

const PASS1_SYSTEM = `${RULES}

TASK (pass 1 of 2): Produce the bot plan.
- "facts": 3 to 12 reusable facts extracted from the business info and docs (for example support hours,
  main product names, website, refund policy). Keys are snake_case. Values are short plain text.
- "stages": 3 to 6 customer-journey stages in order, for example "Discovery", "Evaluation", "Purchase", "Support".
- "greeting": the first message the bot sends. "fallback": used when no intent matches. The fallback must not
  ask for a name or phone number; it may offer to pass the question to a team member.
- "intents": 25 to 40 top-level intents that cover what customers actually ask about. Each has
  12 to 20 varied example utterances, a short description, the stage NAME it belongs to (must exactly match a stage name),
  and a reply template.
Cover FAQs, pricing, product details, booking or demos, support, complaints, and small talk such as thanks or goodbye.`;

function pass2System(docsBlock: string): string {
  return `${RULES}

TASK (pass 2 of 2): Expand ONE top-level intent into sub-intents and follow-ups.
- "subIntents": 2 to 5 more specific questions or next steps under the parent intent.
  Each has 8 to 12 examples, a reply template, and "followUps".
- "followUps": 1 to 3 conversational follow-ups under each sub-intent (for example a clarifying question or a
  confirmation step). Each has 6 to 10 examples and a reply template. Follow-up examples must not be bare
  yes/no answers such as "yes", "no", "sure", or "no thanks", and one follow-up must not mix accepting and
  declining. The chat engine handles those replies.
- "slots": ONLY add slots when the intent must collect information to act, for example a demo booking needs
  name, email and company. Slot "key" is snake_case and unique in the bot. Slot "prompt" is the question
  the bot asks. Use type "choice" with "choices" for fixed options and "" or [] otherwise. Ask for one thing per prompt: never ask for a name and a phone number in the same prompt. Use type "contact" for an email or phone number, and "email" or "phone" only when one specific format is required. The collected values
  can be used as {{key}} in later templates. Put a short confirmation in "onComplete" (for example "Thanks, {{first_name}}, our team will contact you at {{email}}.").
- "nextStage": a stage name when the conversation moves to a different stage after this intent, otherwise null.
- Do not repeat sub-intents that already belong to sibling top-level intents (their names are given to you).

BUSINESS DOCUMENTATION (provided by the business):
${docsBlock}`;
}

function describeInput(input: BotInput): string {
  return [
    `Business name: ${input.name}`,
    `What the business does:\n${input.businessDescription}`,
    input.pricing ? `Pricing:\n${input.pricing}` : "Pricing: not provided",
    input.faqs ? `FAQs:\n${input.faqs}` : "",
    input.goals ? `Bot goals:\n${input.goals}` : "",
    `Tone: ${input.tone || "friendly and concise"}`,
    input.dataToCollect ? `Information the bot should collect from users:\n${input.dataToCollect}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function docsToBlock(docs: string): string {
  const text = docs.trim().slice(0, DOCS_CHAR_LIMIT);
  return text || "(no documentation available)";
}

// ---------- Concurrency helper ----------

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------- Assembly ----------

interface Assembled {
  facts: Record<string, string>;
  stages: Stage[];
  intents: Intent[];
  greeting: Template;
  fallback: Template;
}

function buildFacts(input: BotInput, pass1: Pass1): Record<string, string> {
  const facts: Record<string, string> = {
    business_name: input.name,
    business_description: input.businessDescription,
    pricing: input.pricing || "",
    faqs: input.faqs || "",
  };
  for (const f of pass1.facts) {
    const key = snakeKey(f.key);
    if (key && !(key in facts) && f.value.trim()) facts[key] = f.value.trim();
  }
  return facts;
}

function assemble(input: BotInput, pass1: Pass1, expansions: (Pass2 | null)[]): Assembled {
  const stages: Stage[] = pass1.stages.slice(0, 6).map((s, i) => ({
    id: `stage-${i + 1}`,
    name: s.name.trim(),
    description: s.description.trim(),
    order: i + 1,
  }));
  if (stages.length === 0) {
    stages.push({ id: "stage-1", name: "General", description: "", order: 1 });
  }
  const stageByName = new Map(stages.map((s) => [s.name.toLowerCase(), s.id]));
  const resolveStage = (name: string | null | undefined): string | null => {
    if (!name) return null;
    return stageByName.get(name.trim().toLowerCase()) ?? null;
  };

  const top: Intent[] = [];
  const children: Intent[] = [];
  const grandchildren: Intent[] = [];

  pass1.intents.forEach((t, i) => {
    const topIntent: Intent = {
      id: crypto.randomUUID(),
      parentId: null,
      depth: 1,
      stageId: resolveStage(t.stage) ?? stages[0].id,
      name: t.name.trim(),
      description: t.description.trim(),
      examples: cleanExamples([t.name, ...t.examples], t.name),
      response: cleanTemplate(t.response),
      slots: [],
      onComplete: null,
      nextStageId: null,
    };
    top.push(topIntent);

    const expansion = expansions[i];
    if (!expansion) return;
    for (const sub of expansion.subIntents) {
      const subIntent: Intent = {
        id: crypto.randomUUID(),
        parentId: topIntent.id,
        depth: 2,
        stageId: topIntent.stageId,
        name: sub.name.trim(),
        description: sub.description.trim(),
        examples: cleanExamples([sub.name, ...sub.examples], sub.name),
        response: cleanTemplate(sub.response),
        slots: cleanSlots(sub.slots),
        onComplete: sub.onComplete ? cleanTemplate(sub.onComplete) : null,
        nextStageId: resolveStage(sub.nextStage),
      };
      children.push(subIntent);

      for (const f of sub.followUps) {
        grandchildren.push({
          id: crypto.randomUUID(),
          parentId: subIntent.id,
          depth: 3,
          stageId: subIntent.stageId,
          name: f.name.trim(),
          description: f.description.trim(),
          examples: cleanExamples([f.name, ...f.examples], f.name),
          response: cleanTemplate(f.response),
          slots: cleanSlots(f.slots),
          onComplete: f.onComplete ? cleanTemplate(f.onComplete) : null,
          nextStageId: resolveStage(f.nextStage),
        });
      }
    }
  });

  const fallback = cleanTemplate(pass1.fallback);
  return {
    facts: buildFacts(input, pass1),
    stages,
    intents: [...top, ...children, ...grandchildren],
    greeting: cleanTemplate(pass1.greeting),
    fallback: fallback.text
      ? fallback
      : { text: "Sorry, I didn't quite get that. Could you rephrase?", quickReplies: [] },
  };
}

/** Embed every intent example plus the built-in examples into one index. */
async function embedIntents(intents: Intent[], cfg: EmbedConfig, signal?: AbortSignal): Promise<VectorItem[]> {
  const rows: { intentId: string; text: string }[] = [];
  for (const intent of intents) {
    for (const text of intent.examples) rows.push({ intentId: intent.id, text });
  }
  rows.push(...systemRows());
  const vectors = await embed(
    rows.map((r) => r.text),
    cfg,
    signal,
  );
  return rows.map((r, i) => ({ intentId: r.intentId, text: r.text, vec: vectors[i] }));
}

// ---------- Main pipeline ----------

export interface Progress {
  phase: "plan" | "expand" | "embed";
  step: string;
  done?: number;
  total?: number;
}

export interface GenerateOptions {
  input: BotInput;
  embed: EmbedConfig;
  /** Run pass 2 (sub-intents and follow-ups). Slower, but covers far more questions. */
  expand: boolean;
  signal?: AbortSignal;
  onProgress?: (p: Progress) => void;
}

export async function generateBot(opts: GenerateOptions): Promise<{ bot: Bot; vectors: VectorItem[] }> {
  const { input, signal } = opts;
  const report = (phase: Progress["phase"], step: string, done?: number, total?: number) =>
    opts.onProgress?.({ phase, step, done, total });
  const docsBlock = docsToBlock(input.docs);
  const notes: string[] = [];

  report("plan", `Designing stages, intents and reply templates with ${GEN_MODEL}`);
  const pass1 = await generateStructured({
    name: "bot_plan",
    schema: Pass1Schema,
    instructions: `${PASS1_SYSTEM}\n\nBUSINESS DOCUMENTATION (provided by the business):\n${docsBlock}`,
    input: describeInput(input),
    maxOutputTokens: PASS1_MAX_TOKENS,
    signal,
  });

  let expansions: (Pass2 | null)[] = pass1.intents.map(() => null);
  if (opts.expand) {
    const topNames = pass1.intents.map((i) => i.name);
    const stageNames = pass1.stages.map((s) => s.name);
    const total = pass1.intents.length;
    let done = 0;
    report("expand", "Expanding sub-intents and follow-ups", 0, total);

    expansions = await mapLimit(pass1.intents, SUB_CONCURRENCY, async (intent, i) => {
      try {
        return await generateStructured({
          name: "intent_expansion",
          schema: Pass2Schema,
          instructions: pass2System(docsBlock),
          input: JSON.stringify({
            businessName: input.name,
            stages: stageNames,
            parentIntent: { name: intent.name, description: intent.description, stage: intent.stage },
            siblingIntentNames: topNames.filter((_, j) => j !== i),
          }),
          maxOutputTokens: PASS2_MAX_TOKENS,
          signal,
        });
      } catch (err) {
        if (isAbort(err) || signal?.aborted) throw err;
        notes.push(`Could not expand "${intent.name}": ${errorMessage(err)}`);
        return null;
      } finally {
        done++;
        report("expand", "Expanding sub-intents and follow-ups", done, total);
      }
    });
  }

  const assembled = assemble(input, pass1, expansions);
  const exampleCount = assembled.intents.reduce((n, i) => n + i.examples.length, 0);
  report("embed", `Embedding ${exampleCount} examples for ${assembled.intents.length} intents with ${opts.embed.model}`);
  const vectors = await embedIntents(assembled.intents, opts.embed, signal);

  const bot: Bot = {
    id: crypto.randomUUID(),
    name: input.name,
    createdAt: new Date().toISOString(),
    input,
    genModel: GEN_MODEL,
    embed: opts.embed,
    threshold: DEFAULT_THRESHOLD,
    facts: assembled.facts,
    stages: assembled.stages,
    intents: assembled.intents,
    greeting: assembled.greeting,
    fallback: assembled.fallback,
    notes,
  };
  return { bot, vectors };
}
