import { readFileSync, existsSync } from "node:fs";

// One model/provider configuration to test. `env` is applied to process.env for
// the duration of each turn, so provider selection (Bedrock/Vertex/gateway) and
// per-provider credentials/model ids can be set per case.
export type ModelCase = {
  name: string;
  model: string;
  env?: Record<string, string>;
};

/**
 * Resolve the matrix from, in priority order:
 *   1. E2E_MATRIX_FILE  — path to a JSON file: ModelCase[]
 *   2. E2E_MODEL_MATRIX — inline JSON: ModelCase[]
 *   3. E2E_MODELS       — comma-separated model ids
 *   4. default          — the current prod default model
 */
export function loadMatrix(): ModelCase[] {
  const file = process.env.E2E_MATRIX_FILE;
  if (file && existsSync(file)) {
    return JSON.parse(readFileSync(file, "utf8")) as ModelCase[];
  }
  const inline = process.env.E2E_MODEL_MATRIX;
  if (inline) return JSON.parse(inline) as ModelCase[];

  const models = (process.env.E2E_MODELS ?? "gpt-4.1-mini")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return models.map((m) => ({ name: m, model: m }));
}

/** True if a real OpenAI key is configured so the loop can actually run. */
export function hasProviderCreds(): boolean {
  const key = process.env.OPENAI_API_KEY;
  return Boolean(key && key !== "e2e-unused");
}

/** Apply per-case env overrides, returning a restore function. */
export function withEnv(env?: Record<string, string>): () => void {
  if (!env) return () => {};
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    prev[k] = process.env[k];
    process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}
