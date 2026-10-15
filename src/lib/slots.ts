import type { Slot, SlotType } from "./types";

export type SlotResult = { ok: true; value: string } | { ok: false; error: string };

const SKIP_RE = /^(skip|no|none|n\/a|-)$/i;

function parseEmail(text: string): string | null {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) ? text.toLowerCase() : null;
}

function parsePhone(text: string): string | null {
  const digits = text.replace(/[\s\-().]/g, "");
  return /^\+?\d{7,15}$/.test(digits) ? digits : null;
}

/** True when the text is a valid email address or phone number. */
export function looksLikeContact(text: string): boolean {
  const t = text.trim();
  return parseEmail(t) !== null || parsePhone(t) !== null;
}

/**
 * Existing bots generated "text" slots for contact details such as `espresso_price_contact`.
 * Treat those as "contact" at validation time so they accept only an email or phone number.
 */
export function effectiveType(slot: Slot): SlotType {
  if (slot.type === "text" && /_contact$/.test(slot.key)) return "contact";
  return slot.type;
}

/** Validate a user's answer against a slot. Returns the normalized value to store. */
export function validateSlot(slot: Slot, raw: string): SlotResult {
  const text = raw.trim();

  if (!slot.required && SKIP_RE.test(text)) return { ok: true, value: "" };

  if (!text) return { ok: false, error: "I didn't get anything there." };

  switch (effectiveType(slot)) {
    case "email": {
      const email = parseEmail(text);
      return email ? { ok: true, value: email } : { ok: false, error: "That doesn't look like an email address." };
    }
    case "phone": {
      const phone = parsePhone(text);
      return phone ? { ok: true, value: phone } : { ok: false, error: "That doesn't look like a phone number." };
    }
    case "contact": {
      const value = parseEmail(text) ?? parsePhone(text);
      return value
        ? { ok: true, value }
        : { ok: false, error: "Please share an email address or a phone number so the team can reach you." };
    }
    case "number": {
      const match = text.replace(/,/g, "").match(/-?\d+(\.\d+)?/);
      return match ? { ok: true, value: match[0] } : { ok: false, error: "Please reply with a number." };
    }
    case "date": {
      const time = Date.parse(text);
      if (Number.isNaN(time)) return { ok: false, error: "Please give a date, for example 2026-11-03." };
      return { ok: true, value: new Date(time).toISOString().slice(0, 10) };
    }
    case "choice": {
      const lower = text.toLowerCase();
      const byNumber = /^\d+$/.test(text) ? slot.choices[Number(text) - 1] : undefined;
      const match =
        byNumber ??
        slot.choices.find((c) => c.toLowerCase() === lower) ??
        slot.choices.find((c) => lower.length > 1 && c.toLowerCase().includes(lower));
      return match
        ? { ok: true, value: match }
        : { ok: false, error: `Please pick one of: ${slot.choices.join(", ")}.` };
    }
    case "text":
    default:
      if (text.length > 500) return { ok: false, error: "That's a bit long. Could you shorten it?" };
      return { ok: true, value: text };
  }
}
