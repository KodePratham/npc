import { randomUUID } from "node:crypto";
import { classifyMessage, type Classification } from "./classify";
import { HttpError } from "./errors";
import { effectiveType, looksLikeContact, validateSlot } from "./slots";
import { appendSubmission, getBot, getSession, saveSession } from "./store";
import {
  DECLINE_REPLY,
  DEFAULT_HANDOFF_SLOTS,
  explainWhy,
  handoffComplete,
  looksLikeQuestion,
  offerAct,
  topicName,
} from "./system";
import { render, templateVars } from "./template";
import type { Bot, ChatRequest, ChatResponse, Intent, Offer, Session, Slot, Submission } from "./types";

const INTENT_THRESHOLD = Number(process.env.INTENT_THRESHOLD) || 0.45;
/** A free-text slot answer only breaks out to another intent if that match is this much stronger. */
const BREAKOUT_MARGIN = 0.15;
const CANCEL_RE = /^(cancel|stop|nevermind|never mind|start over|exit)$/i;
const MAX_CHIPS = 4;
/** Pseudo-intent id for the contact handoff that follows an offer with no slot-bearing child. */
const HANDOFF_ID = "__handoff__";
const OFFER_CHIP = "Leave my details";
const OFFER_CHIPS = [OFFER_CHIP, "No thanks"];
/**
 * Replies that ask for personal details, or promise a team follow-up. Matching one makes an offer:
 * the next "yes" starts a contact handoff, so the bot never promises a follow-up it cannot take.
 */
const ASKS_DETAILS_RE = new RegExp(
  [
    /\b(?:share|leave|give|send|provide)\b[^.?!]{0,60}\b(?:name|phone|email|number|details|contact)\b/.source,
    /\b(?:your name|your phone|your email|your number|phone number|email address|reach you)\b/.source,
    /\b(?:team member|team|someone|colleague)\b[^.?!]{0,40}\b(?:follow up|follow-up|reach out|get back|call|contact)\b/.source,
    /\bfollow[- ]up\b[^.?!]{0,30}\?/.source,
  ].join("|"),
  "i",
);

// ---------- helpers ----------

function findIntent(bot: Bot, id: string | null): Intent | null {
  if (!id) return null;
  return bot.intents.find((i) => i.id === id) ?? null;
}

function childrenOf(bot: Bot, id: string | null): Intent[] {
  if (!id) return [];
  return bot.intents.filter((i) => i.parentId === id);
}

/** Suggested next steps as chips: children of the active intent, else top-level intents. */
function suggestions(bot: Bot, activeIntentId: string | null): string[] {
  const kids = childrenOf(bot, activeIntentId);
  const pool = kids.length ? kids : bot.intents.filter((i) => i.depth === 1);
  return pool.slice(0, MAX_CHIPS).map((i) => i.name);
}

function slotChips(slot: Slot | undefined): string[] {
  return slot && slot.type === "choice" ? slot.choices.slice(0, 8) : [];
}

/** Put the "Leave my details" chip first while an offer is open, so the visitor can accept it with one tap. */
function withOfferChip(session: Session, chips: string[]): string[] {
  if (!session.offer || chips.some((c) => c.toLowerCase() === OFFER_CHIP.toLowerCase())) return chips;
  return [OFFER_CHIP, ...chips].slice(0, MAX_CHIPS);
}

function newSession(botId: string): Session {
  return {
    id: randomUUID(),
    botId,
    activeIntentId: null,
    stageId: null,
    pendingIntentId: null,
    pendingSlots: [],
    collected: {},
    offer: null,
    updatedAt: new Date().toISOString(),
  };
}

function summarizeIntent(intent: Intent | null): ChatResponse["intent"] {
  return intent ? { id: intent.id, name: intent.name, depth: intent.depth, stageId: intent.stageId } : null;
}

interface Turn {
  reply: string;
  quickReplies: string[];
  intent?: Intent | null;
  score?: number | null;
  collecting?: string | null;
  submitted?: Submission | null;
}

function toResponse(session: Session, turn: Turn): ChatResponse {
  return {
    sessionId: session.id,
    reply: turn.reply,
    quickReplies: turn.quickReplies,
    intent: summarizeIntent(turn.intent ?? null),
    score: turn.score ?? null,
    collecting: turn.collecting ?? null,
    submitted: turn.submitted ?? null,
  };
}

function clearPending(session: Session) {
  session.pendingIntentId = null;
  session.pendingSlots = [];
}

/** The intent whose reply made the open offer, if any. */
function originOf(bot: Bot, session: Session): Intent | null {
  return findIntent(bot, session.offer?.intentId ?? null);
}

// ---------- handoff (contact capture after an offer) ----------

/** Synthetic intent for the bot-level contact handoff. Its submission is filed under the origin intent. */
function handoffIntent(bot: Bot, origin: Intent | null): Intent {
  return {
    id: origin?.id ?? HANDOFF_ID,
    parentId: null,
    depth: 1,
    stageId: origin?.stageId ?? "",
    name: origin ? `${origin.name} follow-up` : "Follow-up request",
    description: "",
    examples: [],
    response: { text: "", quickReplies: [] },
    slots: bot.handoff?.slots ?? DEFAULT_HANDOFF_SLOTS,
    onComplete: bot.handoff?.onComplete ?? { text: handoffComplete(topicName(origin?.name)), quickReplies: [] },
    nextStageId: null,
  };
}

function resolvePending(bot: Bot, session: Session): Intent | null {
  if (session.pendingIntentId === HANDOFF_ID) return handoffIntent(bot, originOf(bot, session));
  return findIntent(bot, session.pendingIntentId);
}

/**
 * Start collecting details after an accepted offer. Uses the origin's first slot-bearing child
 * if there is one (e.g. a reservation flow), otherwise the bot-level handoff.
 */
function beginHandoff(bot: Bot, session: Session): Intent {
  const origin = originOf(bot, session);
  const child = origin ? childrenOf(bot, origin.id).find((c) => c.slots.length > 0) : undefined;
  if (child) {
    session.pendingIntentId = child.id;
    session.pendingSlots = [...child.slots];
    return child;
  }
  const handoff = handoffIntent(bot, origin);
  session.pendingIntentId = HANDOFF_ID;
  session.pendingSlots = [...handoff.slots];
  return handoff;
}

/** Whether a reply should make an offer: it asks for details, or it has a slot-bearing child to hand off to. */
function offerFor(bot: Bot, intent: Intent, reply: string): Offer | null {
  if (intent.slots.length) return null;
  const hasSlotChild = childrenOf(bot, intent.id).some((c) => c.slots.length > 0);
  return hasSlotChild || ASKS_DETAILS_RE.test(reply) ? { intentId: intent.id } : null;
}

// ---------- turn handlers ----------

function greetingTurn(bot: Bot, session: Session): Turn {
  return {
    reply: render(bot.greeting.text, templateVars(bot, session)),
    quickReplies: bot.greeting.quickReplies.length ? bot.greeting.quickReplies : suggestions(bot, null),
  };
}

function fallbackTurn(bot: Bot, session: Session, score: number | null): Turn {
  const reply = render(bot.fallback.text, templateVars(bot, session));
  // Keep the previous origin if the fallback asks for details, so a later "yes" still knows the topic.
  session.offer = ASKS_DETAILS_RE.test(reply) ? { intentId: session.offer?.intentId ?? null } : null;
  const chips = bot.fallback.quickReplies.length ? bot.fallback.quickReplies : suggestions(bot, session.activeIntentId);
  return { reply, quickReplies: withOfferChip(session, chips), score };
}

/** Ask the prompt for a slot. `lead` (an explanation or error) goes before it. */
function askSlot(bot: Bot, session: Session, intent: Intent, slot: Slot, lead: string | null): Turn {
  const prompt = render(slot.prompt, templateVars(bot, session));
  return {
    reply: lead ? `${lead}\n\n${prompt}` : prompt,
    quickReplies: slotChips(slot),
    collecting: slot.key,
    intent,
  };
}

/** Store the value (or skip with ""), then ask the next slot or save the submission. */
async function advanceSlot(bot: Bot, session: Session, pending: Intent, value: string): Promise<Turn> {
  const slot = session.pendingSlots[0];
  if (value) session.collected[slot.key] = value;
  session.pendingSlots = session.pendingSlots.slice(1);

  const next = session.pendingSlots[0];
  if (next) return askSlot(bot, session, pending, next, null);

  // All slots collected: store a submission for this intent.
  const data: Record<string, string> = {};
  for (const s of pending.slots) data[s.key] = session.collected[s.key] ?? "";
  const submission: Submission = {
    id: randomUUID(),
    sessionId: session.id,
    intentId: pending.id,
    intentName: pending.name,
    data,
    createdAt: new Date().toISOString(),
  };
  await appendSubmission(bot.id, submission);

  clearPending(session);
  session.offer = null;
  const done = pending.onComplete;
  const vars = templateVars(bot, session);
  return {
    reply: done ? render(done.text, vars) : "Thanks, I've saved your details.",
    quickReplies: done?.quickReplies.length ? done.quickReplies : suggestions(bot, pending.id),
    intent: pending,
    submitted: submission,
  };
}

/** The visitor declined a required slot: stop collecting instead of looping on it. */
function stopCollecting(bot: Bot, session: Session): Turn {
  clearPending(session);
  session.offer = null;
  return {
    reply: "No problem, I won't take those details. Anything else I can help with?",
    quickReplies: suggestions(bot, session.activeIntentId),
  };
}

/**
 * Answer a message while a slot is pending. Declines, "why" questions, and questions are handled
 * before validation, so they are never stored as a value.
 */
async function answerSlot(bot: Bot, session: Session, text: string): Promise<Turn> {
  const slot = session.pendingSlots[0];
  const pending = resolvePending(bot, session);
  if (!slot || !pending) {
    clearPending(session);
    return greetingTurn(bot, session);
  }

  const act = offerAct(text);
  if (act === "decline") {
    if (slot.required) return stopCollecting(bot, session);
    return advanceSlot(bot, session, pending, "");
  }
  if (act === "accept") return askSlot(bot, session, pending, slot, "Sure.");

  // An email or phone typed into a text slot (e.g. the name) belongs in the contact slot, if one comes later.
  if (effectiveType(slot) === "text" && looksLikeContact(text)) {
    const idx = session.pendingSlots.findIndex((s) => effectiveType(s) === "contact");
    if (idx > 0) {
      session.pendingSlots = session.pendingSlots.slice(idx);
      return answerSlot(bot, session, text);
    }
  }

  const match = await classifyMessage(bot, text, session.activeIntentId);
  const topic = topicName(originOf(bot, session)?.name);
  if (match.system === "why_info" && match.score >= INTENT_THRESHOLD) {
    const mode = slot.required ? "required" : "optional";
    return askSlot(bot, session, pending, slot, explainWhy(topic, mode));
  }

  // A confident match to another intent breaks out of the slot. Questions never fill a slot.
  const strong = !!match.intent && match.intent.id !== pending.id && match.score >= INTENT_THRESHOLD + BREAKOUT_MARGIN;
  if (strong && (effectiveType(slot) === "text" || looksLikeQuestion(text))) {
    clearPending(session);
    return respondWithIntent(bot, session, match);
  }
  if (looksLikeQuestion(text)) {
    return askSlot(bot, session, pending, slot, "Sorry, I didn't catch that.");
  }

  const result = validateSlot(slot, text);
  if (!result.ok) return askSlot(bot, session, pending, slot, result.error);
  return advanceSlot(bot, session, pending, result.value);
}

/** Answer a message while an offer is open (no slot pending). */
async function answerOffer(bot: Bot, session: Session, text: string): Promise<Turn> {
  const act = offerAct(text);
  if (act === "decline" || CANCEL_RE.test(text)) {
    session.offer = null;
    return { reply: DECLINE_REPLY, quickReplies: suggestions(bot, null) };
  }
  if (act === "accept") {
    const pending = beginHandoff(bot, session);
    return askSlot(bot, session, pending, pending.slots[0], null);
  }
  if (looksLikeContact(text)) {
    // The visitor typed their contact straight away: jump to the contact slot and store it.
    const pending = beginHandoff(bot, session);
    const idx = pending.slots.findIndex((s) => effectiveType(s) === "contact");
    if (idx < 0) return askSlot(bot, session, pending, pending.slots[0], null);
    session.pendingSlots = session.pendingSlots.slice(idx);
    return answerSlot(bot, session, text);
  }

  return routeMatch(bot, session, await classifyMessage(bot, text, session.activeIntentId));
}

/** Route a classification: explain "why" questions, otherwise respond with the matched intent. */
function routeMatch(bot: Bot, session: Session, match: Classification): Turn {
  if (match.system === "why_info" && match.score >= INTENT_THRESHOLD) {
    // Explaining does not change the offer, so the visitor can still accept it afterwards.
    const topic = topicName(originOf(bot, session)?.name);
    return {
      reply: explainWhy(topic, "offer"),
      quickReplies: session.offer ? OFFER_CHIPS : suggestions(bot, session.activeIntentId),
      score: match.score,
    };
  }
  return respondWithIntent(bot, session, match);
}

/** Route a free-text message to an intent and respond with its template. */
function respondWithIntent(bot: Bot, session: Session, match: Classification): Turn {
  const intent = match.intent;
  if (!intent || match.score < INTENT_THRESHOLD) return fallbackTurn(bot, session, match.score);

  session.activeIntentId = intent.id;
  session.stageId = intent.nextStageId ?? intent.stageId;

  const vars = templateVars(bot, session);
  let reply = render(intent.response.text, vars);
  let quickReplies = intent.response.quickReplies;
  let collecting: string | null = null;

  if (intent.slots.length) {
    session.pendingIntentId = intent.id;
    session.pendingSlots = intent.slots;
    session.offer = null;
    const first = intent.slots[0];
    reply = `${reply}\n\n${render(first.prompt, vars)}`.trim();
    quickReplies = slotChips(first);
    collecting = first.key;
  } else {
    clearPending(session);
    session.offer = offerFor(bot, intent, reply);
  }

  if (!quickReplies.length) quickReplies = suggestions(bot, intent.id);
  quickReplies = withOfferChip(session, quickReplies);
  return { reply, quickReplies, intent, score: match.score, collecting };
}

// ---------- entry point ----------

export async function handleChat(botId: string, req: ChatRequest): Promise<ChatResponse> {
  const bot = await getBot(botId);
  if (!bot) throw new HttpError(404, "Bot not found");
  if (bot.status !== "ready") throw new HttpError(409, `Bot is not ready yet (${bot.progress})`);

  const existing = req.sessionId ? await getSession(botId, req.sessionId) : null;
  const session = existing ?? newSession(botId);

  if (req.init) {
    const turn = greetingTurn(bot, session);
    await saveSession(session);
    return toResponse(session, turn);
  }

  const text = (req.message ?? "").trim();
  if (!text) throw new HttpError(400, "Message is empty");

  let turn: Turn;

  if (session.pendingIntentId) {
    if (CANCEL_RE.test(text)) {
      clearPending(session);
      session.offer = null;
      turn = {
        reply: "No problem, I've stopped that. What else can I help with?",
        quickReplies: suggestions(bot, session.activeIntentId),
      };
    } else {
      turn = await answerSlot(bot, session, text);
    }
  } else if (session.offer) {
    turn = await answerOffer(bot, session, text);
  } else {
    turn = routeMatch(bot, session, await classifyMessage(bot, text, session.activeIntentId));
  }

  await saveSession(session);
  return toResponse(session, turn);
}
