import type { Bot, Session } from "./types";

/** Variables available to templates: bot facts, overridden by values collected in this session. */
export function templateVars(bot: Bot, session: Session | null): Record<string, string> {
  return { ...bot.facts, ...(session?.collected ?? {}) };
}

/** Replace {{key}} placeholders. Unknown keys render as empty text. */
export function render(text: string, vars: Record<string, string>): string {
  return text
    .replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_, key: string) => vars[key] ?? "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
