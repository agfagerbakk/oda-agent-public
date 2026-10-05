import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

/** Resolve the mcp-oda entry point that npm installed (its "main" is dist/index.js). */
export function resolveOdaBin(): string {
  return require.resolve("mcp-oda");
}

/** Base CLI args: binary + data-dir. Resolved per-call so config changes apply. */
export function odaBaseArgs(): string[] {
  return [resolveOdaBin(), "--data-dir", config.odaDataDir];
}

/** Child env: inherit process env + point mcp-oda at the data dir. */
export function odaSpawnEnv(): NodeJS.ProcessEnv {
  return { ...process.env, MCP_ODA_DATA_DIR: config.odaDataDir };
}

const MAX_BUFFER = 32 * 1024 * 1024;

/** Run the mcp-oda CLI and return trimmed stdout. */
export async function runOda(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(process.execPath, [...odaBaseArgs(), ...args], {
    env: odaSpawnEnv(),
    maxBuffer: MAX_BUFFER,
  });
  return stdout.trim();
}

/** Run the mcp-oda CLI and return raw stdout + stderr (for auth checks). */
export async function runOdaRaw(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, [...odaBaseArgs(), ...args], {
    env: odaSpawnEnv(),
    maxBuffer: MAX_BUFFER,
  });
}
