import type { Slot, SlotType, Template } from "./types";

/** Trim, collapse whitespace, drop empties and case-insensitive duplicates. */
export function cleanExamples(raw: string[], fallbackName: string, max = 30): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const text = item.trim().replace(/\s+/g, " ");
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= max) break;
  }
  if (out.length === 0 && fallbackName) out.push(fallbackName);
  return out;
}

export function cleanTemplate(t: Template): Template {
  return {
    text: t.text.trim(),
    quickReplies: t.quickReplies.map((q) => q.trim()).filter(Boolean).slice(0, 4),
  };
}

const SLOT_TYPES: SlotType[] = ["text", "email", "phone", "number", "date", "choice", "contact"];

/** Make slot keys snake_case and unique, and repair choice slots that have no choices. */
export function cleanSlots(raw: Slot[]): Slot[] {
  const used = new Set<string>();
  return raw.slice(0, 10).map((s, i) => {
    let key = s.key
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    if (!key) key = `field_${i + 1}`;
    while (used.has(key)) key = `${key}_${i + 1}`;
    used.add(key);

    const type: SlotType = SLOT_TYPES.includes(s.type) ? s.type : "text";
    const choices = type === "choice" ? s.choices.map((c) => c.trim()).filter(Boolean) : [];
    return {
      key,
      prompt: s.prompt.trim(),
      type: type === "choice" && choices.length === 0 ? "text" : type,
      choices,
      required: s.required,
    };
  });
}

export function snakeKey(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}
