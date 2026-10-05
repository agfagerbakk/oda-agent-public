import { describe, test, expect } from "vitest";
import { runAgentTurn, ODA_TOOLS } from "../../src/agent.js";
import { buildFakeOda } from "../fixtures/fake-oda.js";
import { loadMatrix, hasProviderCreds, withEnv, type ModelCase } from "../fixtures/matrix.js";
import { SCENARIOS, EMPTY_CONTEXT, type Scenario } from "../fixtures/scenarios.js";

// These are true end-to-end runs of the real OpenAI tool-loop with a real
// model, against an in-memory fake Oda (no network, no real cart touched). They
// verify that a given model still drives the bot correctly. Cost: a
// handful of model calls per model in the matrix — gated behind real creds and
// the `test:e2e` script so they never run by accident.
// Scenarios live in ../fixtures/scenarios.ts, shared with scripts/experiment.ts.

const matrix = loadMatrix();
const enabled = hasProviderCreds();

if (!enabled) {
  // Surfaces clearly in the runner instead of silently passing with 0 tests.
  describe.skip("shopping agent e2e (no model provider configured)", () => {
    test.skip("set OPENAI_API_KEY to run", () => {});
  });
}

async function runTurn(entry: ModelCase, sc: Scenario) {
  const fake = buildFakeOda({ initialCart: sc.opts?.initialCart, initialSaved: sc.opts?.initialSaved });
  const restore = withEnv(entry.env);
  try {
    const { reply } = await runAgentTurn(text(sc), {
      model: entry.model,
      mcpServers: { oda: fake.oda, odax: fake.odax },
      allowedTools: ODA_TOOLS,
      systemContext: EMPTY_CONTEXT,
    });
    return { reply, state: fake.state };
  } finally {
    restore();
  }
}

const text = (sc: Scenario) => sc.prompt;

// When no provider is configured, run zero cases (the skip block above explains why).
const cases = enabled ? matrix : [];

describe.each(cases)("shopping agent e2e — $name", (entry) => {
  for (const sc of SCENARIOS) {
    test(sc.title, async () => {
      const { reply, state } = await runTurn(entry, sc);
      // node:assert throws on failure; surface cart + calls for debugging.
      try {
        sc.check(state, reply);
      } catch (e) {
        const detail = `cart: ${JSON.stringify(state.cart)} calls: ${state.calls.join(" ")} reply: ${reply.slice(0, 300)}`;
        expect(`scenario "${sc.key}" failed: ${(e as Error).message}\n${detail}`).toBe("");
      }
    });
  }
});
