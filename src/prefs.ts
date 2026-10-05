import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
// preferences.json lives at the project root (one level up from dist/ or src/).
const PREFS_PATH = join(__dirname, "..", "preferences.json");

type PrefsFile = { _comment?: string; preferences: Record<string, string> };

function read(): PrefsFile {
  if (!existsSync(PREFS_PATH)) {
    return { preferences: {} };
  }
  try {
    const parsed = JSON.parse(readFileSync(PREFS_PATH, "utf8")) as PrefsFile;
    return { preferences: parsed.preferences ?? {}, _comment: parsed._comment };
  } catch (err) {
    console.warn(`[prefs] corrupt preferences file, using empty set (${String(err).slice(0, 120)})`);
    return { preferences: {} };
  }
}

/**
 * The baked-in preferences seed as a prompt block. This file is read-only at
 * runtime (git-tracked / baked into the image); runtime additions from /pref and
 * learned buy-again choices live in the history store instead (see store.ts).
 */
export function loadPreferencesText(): string {
  const { preferences } = read();
  const entries = Object.entries(preferences);
  if (entries.length === 0) return "(none)";
  return entries.map(([term, product]) => `- ${term} → ${product}`).join("\n");
}
