import { handleChat, newSession } from "./engine";
import { errorMessage, isAbort } from "./errors";
import type { Progress } from "./generate";
import { EMBED_MODELS } from "./models";
import { clearApiKey, getApiKey, setApiKey, verifyKey } from "./openai";
import { deleteBot, getBot, listBots, listSubmissions, saveBot } from "./store";
import type { Bot, BotInput, ChatResponse, EmbedModel, Intent, Session } from "./types";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const EXAMPLE: BotInput = {
  name: "Pixel Paws Grooming",
  businessDescription:
    "Dog and cat grooming salon in Austin, TX (412 Lamar Blvd). Open Tuesday to Saturday, 9am to 6pm. Services: bath and brush, full groom, nail trims, teeth cleaning, de-shedding, puppy's first groom. Walk-ins for nail trims only; everything else is by appointment.",
  pricing:
    "Bath and brush: $45 small, $60 medium, $75 large dogs. Full groom: $70 small, $90 medium, $110 large. Cats: $85 full groom. Nail trim: $15. Teeth cleaning add-on: $12. De-shedding add-on: $20. 10% off for first visit.",
  docs: "",
  faqs:
    "Q: Do you need vaccination records? A: Yes, rabies and DHPP (dogs) or FVRCP (cats), up to date.\nQ: How long does a groom take? A: 2 to 3 hours. We text you when your pet is ready.\nQ: Cancellation policy? A: Free up to 24 hours before. Later cancellations cost $20.\nQ: Do you groom anxious pets? A: Yes, we offer quiet appointments first thing in the morning.",
  goals: "Answer questions about services and prices, and book grooming appointments.",
  tone: "warm, playful and concise",
  dataToCollect: "Pet name, pet type and size, preferred date, owner name, phone or email.",
};

type View = "key" | "home" | "gen" | "chat";

let current: { bot: Bot; session: Session } | null = null;
let generation: AbortController | null = null;
let busy = false;

function show(view: View) {
  for (const v of ["key", "home", "gen", "chat"] as View[]) $(`${v}-view`).hidden = v !== view;
  const key = getApiKey();
  $("key-bar").hidden = view === "key" || !key;
  if (key) $("key-mask").textContent = `sk-...${key.slice(-4)}`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function setError(id: string, message: string | null) {
  const node = $(id);
  node.textContent = message ?? "";
  node.hidden = !message;
}

// ---------- routing ----------

function botIdFromHash(): string | null {
  return new URLSearchParams(location.hash.slice(1)).get("bot");
}

async function route() {
  if (!getApiKey()) {
    show("key");
    $<HTMLInputElement>("key-input").focus();
    return;
  }
  if (generation) {
    show("gen");
    return;
  }
  const id = botIdFromHash();
  if (id) {
    if (current?.bot.id === id) show("chat");
    else await openBot(id);
    return;
  }
  current = null;
  await renderBotList();
  show("home");
}

// ---------- API key ----------

async function onKeySubmit(e: SubmitEvent) {
  e.preventDefault();
  const input = $<HTMLInputElement>("key-input");
  const button = $<HTMLButtonElement>("key-submit");
  const key = input.value.trim();
  if (!key.startsWith("sk-")) {
    setError("key-error", "OpenAI API keys start with sk-.");
    return;
  }
  setError("key-error", null);
  button.disabled = true;
  button.textContent = "Checking...";
  try {
    await verifyKey(key);
    setApiKey(key);
    input.value = "";
    await route();
  } catch (err) {
    setError("key-error", errorMessage(err));
  } finally {
    button.disabled = false;
    button.textContent = "Start";
  }
}

function forgetKey() {
  generation?.abort();
  clearApiKey();
  void route();
}

// ---------- bot list and form ----------

async function renderBotList() {
  const bots = await listBots();
  const list = $("bot-list");
  list.replaceChildren();
  $("bot-empty").hidden = bots.length > 0;
  for (const bot of bots) {
    const link = el("a", "pixel-box block bg-white p-4 hover:bg-cream");
    link.href = `#bot=${encodeURIComponent(bot.id)}`;
    link.append(
      el("span", "block font-pixel text-[0.65rem] leading-relaxed", bot.name),
      el("span", "mt-2 block text-lg text-ink/70", `${bot.intents.length} intents, ${new Date(bot.createdAt).toLocaleDateString()}`),
    );
    const li = el("li");
    li.append(link);
    list.append(li);
  }
}

function fillExample() {
  const form = $<HTMLFormElement>("bot-form");
  for (const [name, value] of Object.entries(EXAMPLE)) {
    const input = form.elements.namedItem(name);
    if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) input.value = value;
  }
}

function readForm(form: HTMLFormElement): { input: BotInput; model: EmbedModel; expand: boolean } {
  const data = new FormData(form);
  const text = (name: string) => String(data.get(name) ?? "").trim();
  const model = (text("embedModel") in EMBED_MODELS ? text("embedModel") : "text-embedding-3-small") as EmbedModel;
  return {
    input: {
      name: text("name"),
      businessDescription: text("businessDescription"),
      pricing: text("pricing"),
      docs: text("docs"),
      faqs: text("faqs"),
      goals: text("goals"),
      tone: text("tone") || "friendly and concise",
      dataToCollect: text("dataToCollect"),
    },
    model,
    expand: data.get("expand") === "on",
  };
}

// ---------- generation ----------

let genStarted = 0;
let genTimer: number | undefined;
let lastProgress: Progress | null = null;

function renderProgress(p: Progress | null) {
  if (p) lastProgress = p;
  const progress = lastProgress;
  if (!progress) return;
  const pct =
    progress.phase === "plan" ? 5 : progress.phase === "embed" ? 95 : 10 + (80 * (progress.done ?? 0)) / (progress.total || 1);
  $("gen-bar").style.width = `${pct}%`;
  $("gen-bar").parentElement?.setAttribute("aria-valuenow", String(Math.round(pct)));
  $("gen-step").textContent = progress.step;
  const secs = Math.round((Date.now() - genStarted) / 1000);
  const elapsed = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")} elapsed`;
  const count = progress.total ? `${progress.done ?? 0} of ${progress.total} intents, ` : "";
  $("gen-count").textContent = count + elapsed;
}

function warnBeforeUnload(e: BeforeUnloadEvent) {
  e.preventDefault();
}

async function onBotSubmit(e: SubmitEvent) {
  e.preventDefault();
  const form = e.currentTarget as HTMLFormElement;
  const { input, model, expand } = readForm(form);
  if (!input.name || !input.businessDescription) {
    setError("form-error", "Add a business name and a description.");
    return;
  }
  setError("form-error", null);

  generation = new AbortController();
  genStarted = Date.now();
  lastProgress = null;
  $("gen-name").textContent = input.name;
  $("gen-cancel").hidden = false;
  $("gen-back").hidden = true;
  setError("gen-error", null);
  renderProgress({ phase: "plan", step: "Starting" });
  genTimer = window.setInterval(() => renderProgress(null), 1000);
  window.addEventListener("beforeunload", warnBeforeUnload);
  show("gen");

  try {
    // Loaded on demand: the generator pulls in zod, which chatting doesn't need.
    const { generateBot } = await import("./generate");
    const { bot, vectors } = await generateBot({
      input,
      embed: { model, dimensions: EMBED_MODELS[model].dimensions },
      expand,
      signal: generation.signal,
      onProgress: renderProgress,
    });
    await saveBot(bot, vectors);
    form.reset();
    generation = null;
    location.hash = `bot=${bot.id}`;
  } catch (err) {
    const cancelled = isAbort(err) || generation?.signal.aborted;
    generation = null;
    if (cancelled) {
      await route();
    } else {
      setError("gen-error", errorMessage(err));
      $("gen-cancel").hidden = true;
      $("gen-back").hidden = false;
    }
  } finally {
    window.clearInterval(genTimer);
    window.removeEventListener("beforeunload", warnBeforeUnload);
  }
}

// ---------- chat ----------

async function openBot(id: string) {
  const bot = await getBot(id);
  if (!bot) {
    location.hash = "";
    return;
  }
  current = { bot, session: newSession(bot.id) };
  $("chat-title").textContent = bot.name;
  renderStats(bot);
  renderTemplates(bot);
  renderNotes(bot);
  await renderSubmissions();
  show("chat");
  await startConversation();
}

async function startConversation() {
  if (!current) return;
  current.session = newSession(current.bot.id);
  $("messages").replaceChildren();
  addReply(await handleChat(current.bot, current.session, { init: true }), "greeting");
  $<HTMLInputElement>("chat-input").focus();
}

function renderStats(bot: Bot) {
  const byDepth = [1, 2, 3].map((d) => bot.intents.filter((i) => i.depth === d).length);
  $("bot-stats").textContent =
    `${bot.intents.length} intents (${byDepth[0]} top-level, ${byDepth[1]} sub-intents, ${byDepth[2]} follow-ups). ` +
    `Written by ${bot.genModel}, matched with ${bot.embed.model} at ${bot.embed.dimensions} dimensions.`;
  const slider = $<HTMLInputElement>("threshold");
  slider.value = String(bot.threshold);
  $("threshold-value").textContent = bot.threshold.toFixed(2);
}

function renderNotes(bot: Bot) {
  $("notes-box").hidden = bot.notes.length === 0;
  $("notes").replaceChildren(...bot.notes.map((n) => el("li", "", n)));
}

async function renderSubmissions() {
  if (!current) return;
  const subs = await listSubmissions(current.bot.id);
  $("subs-empty").hidden = subs.length > 0;
  $("submissions").replaceChildren(
    ...subs.map((s) => {
      const li = el("li", "border-b-2 border-dashed border-ink/30 pb-2");
      li.append(el("p", "text-grass-dark", `${s.intentName}, ${new Date(s.createdAt).toLocaleString()}`));
      for (const [key, value] of Object.entries(s.data)) {
        if (value) li.append(el("p", "", `${key}: ${value}`));
      }
      return li;
    }),
  );
}

function renderIntent(bot: Bot, intent: Intent): HTMLElement {
  const details = el("details", intent.depth > 1 ? "ml-4 border-l-2 border-ink/20 pl-3" : "");
  const summary = el("summary", "cursor-pointer py-1 hover:text-red", intent.name);
  details.append(summary, el("p", "mt-1 whitespace-pre-line bg-cream p-2", intent.response.text));
  if (intent.slots.length) {
    details.append(el("p", "mt-1 text-grass-dark", `Collects: ${intent.slots.map((s) => s.key).join(", ")}`));
  }
  details.append(el("p", "mt-1 text-ink/70", `${intent.examples.length} examples, e.g. "${intent.examples.slice(1, 3).join('", "')}"`));
  for (const child of bot.intents.filter((i) => i.parentId === intent.id)) details.append(renderIntent(bot, child));
  return details;
}

function renderTemplates(bot: Bot) {
  const facts = el("details", "mb-2");
  facts.append(el("summary", "cursor-pointer py-1 text-grass-dark hover:text-red", `Facts used as {{placeholders}} (${Object.keys(bot.facts).length})`));
  for (const [key, value] of Object.entries(bot.facts)) {
    if (value) facts.append(el("p", "ml-4 truncate", `{{${key}}}: ${value}`));
  }
  const fallback = el("details", "mb-2");
  fallback.append(el("summary", "cursor-pointer py-1 text-grass-dark hover:text-red", "Greeting and fallback"));
  fallback.append(el("p", "mt-1 bg-cream p-2", bot.greeting.text), el("p", "mt-1 bg-cream p-2", bot.fallback.text));
  $("templates").replaceChildren(facts, fallback, ...bot.intents.filter((i) => i.depth === 1).map((i) => renderIntent(bot, i)));
}

function addMessage(role: "player" | "npc" | "error", text: string, meta?: string) {
  const wrap = el("div", role === "player" ? "ml-auto max-w-[85%] text-right" : "max-w-[85%]");
  const label = role === "player" ? "PLAYER" : role === "npc" ? "NPC" : "SYSTEM";
  wrap.append(el("p", `font-pixel text-[0.55rem] ${role === "player" ? "text-ink/60" : "text-red"}`, label));
  wrap.append(el("p", `mt-1 whitespace-pre-line text-2xl ${role === "error" ? "text-red" : ""}`, text));
  if (meta) wrap.append(el("p", "mt-1 text-lg text-grass-dark", `-- ${meta} --`));
  const messages = $("messages");
  messages.append(wrap);
  messages.scrollTop = messages.scrollHeight;
  return wrap;
}

function describeMatch(res: ChatResponse, threshold: number, fallbackLabel?: string): string {
  const score = res.score !== null ? ` (${res.score.toFixed(2)})` : "";
  if (res.submitted) return `saved details for ${res.submitted.intentName}`;
  if (res.collecting) return `asking for ${res.collecting}${res.intent ? ` in ${res.intent.name}` : ""}`;
  if (res.intent) return `matched intent: ${res.intent.name}${score}`;
  if (res.score !== null && res.score < threshold) return `no intent above ${threshold.toFixed(2)}, best was ${res.score.toFixed(2)}: fallback`;
  if (res.score !== null) return `built-in reply${score}`;
  return fallbackLabel ?? "built-in reply";
}

function addReply(res: ChatResponse, fallbackLabel?: string) {
  if (!current) return;
  addMessage("npc", res.reply, describeMatch(res, current.bot.threshold, fallbackLabel));
  $("chips").replaceChildren(
    ...res.quickReplies.map((chip) => {
      const button = el("button", "pixel-btn bg-white px-3 py-2 text-[0.55rem]", chip);
      button.type = "button";
      button.addEventListener("click", () => void send(chip));
      return button;
    }),
  );
}

async function send(raw: string) {
  const text = raw.trim();
  if (!current || busy || !text) return;
  if (!getApiKey()) {
    show("key");
    return;
  }
  busy = true;
  const input = $<HTMLInputElement>("chat-input");
  input.value = "";
  $("chips").replaceChildren();
  addMessage("player", text);
  const typing = addMessage("npc", "...");
  const { bot, session } = current;
  try {
    const res = await handleChat(bot, session, { message: text });
    typing.remove();
    if (current?.bot.id !== bot.id) return;
    addReply(res);
    if (res.submitted) await renderSubmissions();
  } catch (err) {
    typing.remove();
    addMessage("error", errorMessage(err));
  } finally {
    busy = false;
    input.focus();
  }
}

async function onDelete() {
  if (!current || !confirm(`Delete "${current.bot.name}" and its collected details from this browser?`)) return;
  await deleteBot(current.bot.id);
  current = null;
  location.hash = "";
}

// ---------- wiring ----------

export function start() {
  $<HTMLFormElement>("key-form").addEventListener("submit", (e) => void onKeySubmit(e));
  $("forget-key").addEventListener("click", forgetKey);
  $("example-btn").addEventListener("click", fillExample);
  $<HTMLFormElement>("bot-form").addEventListener("submit", (e) => void onBotSubmit(e));
  $("gen-cancel").addEventListener("click", () => generation?.abort());
  $("gen-back").addEventListener("click", () => void route());
  $<HTMLFormElement>("chat-form").addEventListener("submit", (e) => {
    e.preventDefault();
    void send($<HTMLInputElement>("chat-input").value);
  });
  $("chat-restart").addEventListener("click", () => void startConversation());
  $("chat-delete").addEventListener("click", () => void onDelete());

  const slider = $<HTMLInputElement>("threshold");
  slider.addEventListener("input", () => {
    if (!current) return;
    current.bot.threshold = Number(slider.value);
    $("threshold-value").textContent = current.bot.threshold.toFixed(2);
  });
  slider.addEventListener("change", () => {
    if (current) void saveBot(current.bot);
  });

  window.addEventListener("hashchange", () => void route());
  void route();
}
