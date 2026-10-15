/** Browser port of src/lib/types.ts. Bots live in IndexedDB instead of data/bots. */

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
}

export interface BotInput {
  name: string;
  businessDescription: string;
  pricing: string;
  /** Pasted documentation text. The browser cannot fetch arbitrary links because of CORS. */
  docs: string;
  faqs: string;
  goals: string;
  tone: string;
  dataToCollect: string;
}

export type EmbedModel = "text-embedding-3-small" | "text-embedding-3-large";

export interface EmbedConfig {
  model: EmbedModel;
  dimensions: number;
}

export interface Bot {
  id: string;
  name: string;
  createdAt: string;
  input: BotInput;
  genModel: string;
  /** Messages must be embedded with the same model and dimensions as the examples. */
  embed: EmbedConfig;
  /** Minimum cosine similarity for an intent match. Below this the bot uses the fallback. */
  threshold: number;
  /** Bot-level variables usable as {{key}} in templates. */
  facts: Record<string, string>;
  stages: Stage[];
  /** Flat list: all depth-1 intents, then their children, then grandchildren. */
  intents: Intent[];
  greeting: Template;
  fallback: Template;
  notes: string[];
}

export interface VectorItem {
  intentId: string;
  text: string;
  /** Unit length, so dot product equals cosine similarity. */
  vec: Float32Array;
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
  offer: Offer | null;
}

export interface Submission {
  id: string;
  botId: string;
  sessionId: string;
  intentId: string;
  intentName: string;
  data: Record<string, string>;
  createdAt: string;
}

export interface ChatRequest {
  message?: string;
  init?: boolean;
}

export interface ChatResponse {
  reply: string;
  quickReplies: string[];
  intent: { id: string; name: string; depth: Depth } | null;
  /** Raw cosine similarity of the best match (null when no classification ran). */
  score: number | null;
  /** Slot key the bot is currently asking for, if any. */
  collecting: string | null;
  submitted: Submission | null;
}
