import { readFileSync, existsSync } from "node:fs";
import { config as loadDotenv } from "dotenv";

loadDotenv();

/**
 * Resolve a config value, preferring a Docker Swarm secret file at
 * /run/secrets/<NAME> and falling back to the environment variable of the
 * same name (used for local dev via .env).
 */
function secret(name: string): string | undefined {
  const path = `/run/secrets/${name}`;
  if (existsSync(path)) {
    return readFileSync(path, "utf8").trim();
  }
  return process.env[name];
}

function required(name: string): string {
  const value = secret(name);
  if (!value) {
    throw new Error(
      `Missing required config "${name}". Provide it as a Docker secret ` +
        `(/run/secrets/${name}) or an environment variable.`,
    );
  }
  return value;
}

// All LLM calls use OpenAI through the `openai` SDK:
//   - the shopping agent loop (chat completions + function calling),
//   - vision (chat completions with image input),
//   - the seeder's term mapping (chat completions, JSON mode).
// The key is supplied as OPENAI_API_KEY (Docker secret in prod, .env locally).
const openaiKey = secret("OPENAI_API_KEY");
if (!openaiKey) {
  throw new Error('Missing OpenAI API key. Set OPENAI_API_KEY.');
}

export const config = {
  odaUser: required("ODA_USER"),
  odaPass: required("ODA_PASS"),
  // Only needed by the live Telegram bot — validated in index.ts, not at import,
  // so `npm run agent:once` works with just the three values above.
  telegramBotToken: secret("TELEGRAM_BOT_TOKEN"),
  allowedTelegramUserId: secret("ALLOWED_TELEGRAM_USER_ID"),
  model: secret("ODA_AGENT_MODEL") ?? "gpt-4.1-mini",
  // Where mcp-oda stores its cookie session. In prod this is a mounted volume.
  odaDataDir: secret("MCP_ODA_DATA_DIR") ?? "./.mcp-oda",
  // OpenAI is the only LLM provider. `gpt-4.1-mini` handles the shopping loop
  // (function calling), JSON term mapping, and image input; override per
  // surface if more capability is needed.
  openaiApiKey: openaiKey,
  openaiChatModel: secret("OPENAI_CHAT_MODEL") ?? "gpt-4.1-mini",
  openaiVisionModel: secret("OPENAI_VISION_MODEL") ?? "gpt-4.1-mini",
};

/** Validate + return the config the Telegram bot needs. Call before bot start. */
export function requireBotConfig(): { telegramBotToken: string; allowedTelegramUserIds: Set<number> } {
  if (!config.telegramBotToken) throw new Error('Missing required config "TELEGRAM_BOT_TOKEN".');
  if (!config.allowedTelegramUserId)
    throw new Error('Missing required config "ALLOWED_TELEGRAM_USER_ID".');
  // Comma-separated list of numeric Telegram ids allowed to drive the bot.
  const ids = config.allowedTelegramUserId
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (ids.length === 0) throw new Error('"ALLOWED_TELEGRAM_USER_ID" has no valid numeric ids.');
  return { telegramBotToken: config.telegramBotToken, allowedTelegramUserIds: new Set(ids) };
}
