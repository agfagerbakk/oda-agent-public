// Vitest global setup. Load .env first (real creds win), then fill only the
// genuinely-missing config vars with harmless dummies so importing src/config.ts
// doesn't throw. The fake-Oda e2e tests never use ODA/Telegram creds; they only
// need an OpenAI key, which the suite checks for and skips if absent.
import "dotenv/config";

process.env.ODA_USER ||= "e2e@example.com";
process.env.ODA_PASS ||= "e2e-unused";
process.env.TELEGRAM_BOT_TOKEN ||= "e2e-unused";
process.env.ALLOWED_TELEGRAM_USER_ID ||= "0";
process.env.MCP_ODA_DATA_DIR ||= "./.mcp-oda";
process.env.OPENAI_API_KEY ||= "e2e-unused";
