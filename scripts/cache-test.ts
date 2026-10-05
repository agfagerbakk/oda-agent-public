// Measures per-turn token usage for real shopping turns: runs a few chained
// messages (same resumed conversation) against the in-memory fake Oda (tests/fixtures)
// so no real cart is touched, but with the REAL production system context
// (actual preferences.json) so the token counts reflect what a live turn costs.
//
//   npx tsx scripts/cache-test.ts
import "dotenv/config";
import { runAgentTurn, ODA_TOOLS, prodSystemContext } from "../src/agent.js";
import { buildFakeOda } from "../tests/fixtures/fake-oda.js";

const MESSAGES = ["Add milk and bananas.", "Also add eggs.", "What's in my cart?"];

async function main() {
  const fake = buildFakeOda({});
  const systemContext = prodSystemContext();
  console.log(`system context length: ${systemContext.length} chars (~${Math.round(systemContext.length / 4)} tokens)\n`);

  let resume: string | undefined;
  for (const [i, text] of MESSAGES.entries()) {
    const result = await runAgentTurn(text, {
      model: process.env.ODA_AGENT_MODEL || "gpt-4.1-mini",
      mcpServers: { oda: fake.oda, odax: fake.odax },
      allowedTools: ODA_TOOLS,
      systemContext,
      resume,
    });
    resume = result.sessionId;
    const u = result.usage as Record<string, number> | undefined;
    console.log(`--- turn ${i + 1}: "${text}" ---`);
    console.log(`  reply: ${result.reply.slice(0, 100)}${result.reply.length > 100 ? "…" : ""}`);
    console.log(`  turns: ${result.numTurns}  duration: ${result.durationMs}ms`);
    console.log(`  usage: ${JSON.stringify(u)}`);
    console.log();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
