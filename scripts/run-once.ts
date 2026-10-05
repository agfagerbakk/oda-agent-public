// Local end-to-end check WITHOUT Telegram:
//   npm run agent:once -- "add milk and 6 eggs"
// Requires OPENAI_API_KEY, ODA_USER, ODA_PASS in .env (plus a dummy
// TELEGRAM_BOT_TOKEN / ALLOWED_TELEGRAM_USER_ID so config validation passes).
import { ensureLoggedIn } from "../src/oda-auth.js";
import { runShoppingTurn } from "../src/agent.js";

const text = process.argv.slice(2).join(" ") || "add milk and 6 eggs";

async function main() {
  await ensureLoggedIn();
  console.log(`\n> ${text}\n`);
  const reply = await runShoppingTurn(0, text);
  console.log("\n--- reply ---\n" + reply);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
