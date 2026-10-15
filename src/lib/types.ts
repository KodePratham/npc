/** "contact" accepts an email address or a phone number. */
export type SlotType = "text" | "email" | "phone" | "number" | "date" | "choice" | "contact";

export interface Stage {
  id: string;
  name: string;
  description: string;
  order: number;
}

export interface Template {
  text: string;
  quickReplies: string[];
}

export interface Slot {
  key: string;
  prompt: string;
  type: SlotType;
  choices: string[];
  required: boolean;
}

export type Depth = 1 | 2 | 3;

export interface Intent {
  id: string;
  parentId: string | null;
  depth: Depth;
  stageId: string;
  name: string;
  description: string;
  examples: string[];
  response: Template;
  slots: Slot[];
  onComplete: Template | null;
  nextStageId: string | null;
  /** Business area for multi-domain bots (set by generate-multi). Descendants inherit their top-level domain. */
  domain?: string;
}

export interface BotInput {
  name: string;
  businessDescription: string;
  pricing: string;
  docsLinks: string[];
  faqs: string;
  goals: string;
  tone: string;
  dataToCollect: string;
}

export type BotStatus = "generating" | "ready" | "error";

export interface Bot {
  id: string;
  name: string;
  status: BotStatus;
  progress: string;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  input: BotInput;
  /** Bot-level variables usable as {{key}} in templates. */
  facts: Record<string, string>;
  stages: Stage[];
  /** Flat list: all depth-1 intents, then their children, then grandchildren. */
  intents: Intent[];
  greeting: Template;
  fallback: Template;
  docNotes: string[];
  /** Optional override for the contact handoff used after a follow-up offer. Defaults live in system.ts. */
  handoff?: { slots: Slot[]; onComplete: Template };
}

export interface BotSummary {
  id: string;
  name: string;
  status: BotStatus;
  progress: string;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  intentCount: number;
}

/** A reply asked for personal details without collecting them. Accepting starts a handoff. */
export interface Offer {
  /** The intent whose reply made the offer, or null when it was the fallback. */
  intentId: string | null;
}

export interface Session {
  id: string;
  botId: string;
  activeIntentId: string | null;
  stageId: string | null;
  pendingIntentId: string | null;
  pendingSlots: Slot[];
  collected: Record<string, string>;
  /** Optional so sessions created before offers existed still load. */
  offer?: Offer | null;
  updatedAt: string;
}

export interface Submission {
  id: string;
  sessionId: string;
  intentId: string;
  intentName: string;
  data: Record<string, string>;
  createdAt: string;
}

/** On-disk vector row. `vec` is base64 of a little-endian Float32Array (unit length). */
export interface VectorRecord {
  intentId: string;
  text: string;
  vec: string;
}

export interface ChatRequest {
  sessionId?: string | null;
  message?: string;
  init?: boolean;
}

export interface ChatResponse {
  sessionId: string;
  reply: string;
  quickReplies: string[];
  intent: { id: string; name: string; depth: Depth; stageId: string } | null;
  /** Raw cosine similarity of the best match (null when no classification ran). */
  score: number | null;
  /** Slot key the bot is currently asking for, if any. */
  collecting: string | null;
  submitted: Submission | null;
}
