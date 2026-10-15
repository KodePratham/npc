/**
 * Import this first in every bench script. Module bodies in src/lib read env at load time
 * (INTENT_THRESHOLD, CONTEXT_BOOST, model names), so .env.local must load before those imports run.
 */
import path from "node:path";

if (typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile(path.join(process.cwd(), ".env.local"));
  } catch {
    // No .env.local: rely on the existing environment.
  }
}

export {};
