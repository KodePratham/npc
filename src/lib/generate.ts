import { randomUUID } from "node:crypto";
import { fetchDocs, type DocResult } from "./docs";
import { embed, generateStructured } from "./openai";
import { Pass1Schema, Pass2Schema, type Pass1, type Pass2 } from "./schema";
import { cleanExamples, cleanSlots, cleanTemplate, snakeKey } from "./normalize";
import { encodeVector } from "./vector";
import { getBot, replaceIntentVectors, saveVectors, updateBot } from "./store";
import { errorMessage } from "./errors";
import type { BotInput, Intent, Stage, Template, VectorRecord } from "./types";

export const SUB_CONCURRENCY = 5;
export const PASS1_MAX_TOKENS = 60_000;
export const PASS2_MAX_TOKENS = 30_000;

// ---------- Prompts ----------

export const RULES = `You are designing a template-based chatbot. At chat time there is NO language model:
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

export function pass2System(docsBlock: string): string {
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

BUSINESS DOCUMENTATION (fetched from the links the business provided):
${docsBlock}`;
}

export function describeInput(input: BotInput): string {
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

export function docsToBlock(docs: DocResult[]): string {
  const usable = docs.filter((d) => d.text);
  if (usable.length === 0) return "(no documentation available)";
  return usable.map((d) => `### Source: ${d.url}\n${d.text}`).join("\n\n");
}

// ---------- Progress helper ----------

async function setProgress(botId: string, progress: string) {
  await updateBot(botId, (b) => {
    b.progress = progress;
  });
}

// ---------- Concurrency helper ----------

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
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

export interface Assembled {
  facts: Record<string, string>;
  stages: Stage[];
  intents: Intent[];
  greeting: Template;
  fallback: Template;
}

export function buildFacts(input: BotInput, pass1: Pass1): Record<string, string> {
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

export function assemble(input: BotInput, pass1: Pass1, expansions: (Pass2 | null)[]): Assembled {
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
    const examples = cleanExamples([t.name, ...t.examples], t.name);
    const topIntent: Intent = {
      id: randomUUID(),
      parentId: null,
      depth: 1,
      stageId: resolveStage(t.stage) ?? stages[0].id,
      name: t.name.trim(),
      description: t.description.trim(),
      examples,
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
        id: randomUUID(),
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
          id: randomUUID(),
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

export async function embedIntents(intents: Intent[]): Promise<VectorRecord[]> {
  const rows: { intentId: string; text: string }[] = [];
  for (const intent of intents) {
    for (const text of intent.examples) rows.push({ intentId: intent.id, text });
  }
  const vectors = await embed(rows.map((r) => r.text));
  return rows.map((r, i) => ({ intentId: r.intentId, text: r.text, vec: encodeVector(vectors[i]) }));
}

/** Re-embed one intent's examples (used after edits in the UI). */
export async function reembedIntent(botId: string, intent: Intent): Promise<void> {
  const rows = await embedIntents([intent]);
  await replaceIntentVectors(botId, intent.id, rows);
}

// ---------- Main pipeline (runs in the background) ----------

export async function generateBot(botId: string): Promise<void> {
  try {
    const bot = await getBot(botId);
    if (!bot) return;
    const input = bot.input;

    await setProgress(botId, "Reading documentation links");
    const docs = await fetchDocs(input.docsLinks);
    const docNotes = docs.filter((d) => d.error).map((d) => `${d.url}: ${d.error}`);
    const docsBlock = docsToBlock(docs);

    await setProgress(botId, "Designing stages and top-level intents (pass 1)");
    const pass1 = await generateStructured({
      name: "bot_plan",
      schema: Pass1Schema,
      instructions: `${PASS1_SYSTEM}\n\nBUSINESS DOCUMENTATION (fetched from the links the business provided):\n${docsBlock}`,
      input: describeInput(input),
      maxOutputTokens: PASS1_MAX_TOKENS,
    });

    const topNames = pass1.intents.map((i) => i.name);
    const stageNames = pass1.stages.map((s) => s.name);
    const total = pass1.intents.length;
    let done = 0;
    await setProgress(botId, `Expanding sub-intents and follow-ups (0/${total})`);

    const expansions = await mapLimit(pass1.intents, SUB_CONCURRENCY, async (intent, i) => {
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
        });
      } catch (err) {
        docNotes.push(`Could not expand "${intent.name}": ${errorMessage(err)}`);
        return null;
      } finally {
        done++;
        await setProgress(botId, `Expanding sub-intents and follow-ups (${done}/${total})`);
      }
    });

    const assembled = assemble(input, pass1, expansions);

    await setProgress(botId, `Embedding ${assembled.intents.length} intents`);
    const vectors = await embedIntents(assembled.intents);
    await saveVectors(botId, vectors);

    await updateBot(botId, (b) => {
      b.facts = assembled.facts;
      b.stages = assembled.stages;
      b.intents = assembled.intents;
      b.greeting = assembled.greeting;
      b.fallback = assembled.fallback;
      b.docNotes = docNotes;
      b.status = "ready";
      b.progress = "Ready";
      b.error = null;
    });
  } catch (err) {
    await updateBot(botId, (b) => {
      b.status = "error";
      b.progress = "Failed";
      b.error = errorMessage(err);
    });
  }
}
