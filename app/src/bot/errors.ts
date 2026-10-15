import { APIUserAbortError, AuthenticationError, PermissionDeniedError, RateLimitError } from "openai";

export function isAbort(err: unknown): boolean {
  return err instanceof APIUserAbortError || (err instanceof DOMException && err.name === "AbortError");
}

export function errorMessage(err: unknown): string {
  if (isAbort(err)) return "Cancelled.";
  if (err instanceof AuthenticationError) return "OpenAI rejected this API key. Check it and enter it again.";
  if (err instanceof PermissionDeniedError) return `This API key can't use that model or endpoint: ${err.message}`;
  if (err instanceof RateLimitError) return `OpenAI rate limit or quota reached: ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}
