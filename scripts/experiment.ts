// Cost/functionality experiment: run the shopping scenario suite against several
// models/providers, capture pass/fail + latency + token usage + cost, and write a
// JSONL log plus a Markdown report. Reuses the same fake-Oda fixtures as the e2e
// tests, so "functionality" here means the exact behaviours the bot depends on.
//
// Run (in background):  npx tsx scripts/experiment.ts
// Output:               experiment-results.jsonl, EXPERIMENT-REPORT.md

import "dotenv/config";
process.env.ODA_USER ||= "e2e@example.com";
process.env.ODA_PASS ||= "e2e";
process.env.TELEGRAM_BOT_TOKEN ||= "e2e";
process.env.ALLOWED_TELEGRAM_USER_ID ||= "0";

import { appendFileSync, writeFileSync } from "node:fs";
import { runAgentTurn, ODA_TOOLS } from "../src/agent.js";
import { buildFakeOda } from "../tests/fixtures/fake-oda.js";
import { withEnv, loadMatrix, type ModelCase } from "../tests/fixtures/matrix.js";
import { SCENARIOS, EMPTY_CONTEXT, type Scenario } from "../tests/fixtures/scenarios.js";

const PER_TURN_MS = 150_000;
const JSONL = "experiment-results.jsonl";
const REPORT = "EXPERIMENT-REPORT.md";

const DEFAULT_MATRIX: ModelCase[] = [
  { name: "gpt-4.1-mini", model: "gpt-4.1-mini" },
  { name: "gpt-4.1", model: "gpt-4.1" },
  { name: "gpt-4o-mini", model: "gpt-4o-mini" },
];

// Honour E2E_MODELS / E2E_MATRIX_FILE when set (same as the e2e suite).
const MATRIX: ModelCase[] = process.env.E2E_MODELS ?? process.env.E2E_MATRIX_FILE ? loadMatrix() : DEFAULT_MATRIX;

// Rough public list prices ($/million tokens), input/output. Ground truth is the
// token counts we log; edit these if pricing changes.
const PRICES: Record<string, { in: number; out: number }> = {
  "gpt-4.1-mini": { in: 0.4, out: 1.6 },
  "gpt-4.1": { in: 2.0, out: 8.0 },
  "gpt-4o-mini": { in: 0.15, out: 0.6 },
};

type Rec = {
  model: string;
  scenario: string;
  pass: boolean;
  status: "pass" | "fail" | "timeout" | "error";
  ms: number;
  costUsd?: number;
  inTok?: number;
  outTok?: number;
  detail: string;
};

function tokens(usage: unknown): { inTok?: number; outTok?: number } {
  const u = usage as Record<string, number> | undefined;
  if (!u) return {};
  // OpenAI usage fields (Claude-style fields kept as a fallback).
  const inTok = u.prompt_tokens ?? u.input_tokens ?? 0;
  return { inTok: inTok || undefined, outTok: (u.completion_tokens ?? u.output_tokens) || undefined };
}

async function runOne(c: ModelCase, sc: Scenario): Promise<Rec> {
  const fake = buildFakeOda({ initialCart: sc.opts?.initialCart, initialSaved: sc.opts?.initialSaved });
  const restore = withEnv(c.env);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PER_TURN_MS);
  const t0 = Date.now();
  try {
    const r = await runAgentTurn(sc.prompt, {
      model: c.model,
      mcpServers: { oda: fake.oda, odax: fake.odax },
      allowedTools: ODA_TOOLS,
      systemContext: EMPTY_CONTEXT,
      abortController: ac,
    });
    let pass = true;
    let failDetail = "";
    try {
      sc.check(fake.state, r.reply);
    } catch (e) {
      pass = false;
      failDetail = ` check-fail=${((e as Error).message ?? String(e)).slice(0, 160)}`;
    }
    const { inTok, outTok } = tokens(r.usage);
    return {
      model: c.name,
      scenario: sc.key,
      pass,
      status: pass ? "pass" : "fail",
      ms: Date.now() - t0,
      inTok,
      outTok,
      detail: `cart=${JSON.stringify(fake.state.cart.map((x) => x.id))} calls=${fake.state.calls.length}${failDetail}`,
    };
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    return {
      model: c.name,
      scenario: sc.key,
      pass: false,
      status: /abort|timeout/i.test(msg) ? "timeout" : "error",
      ms: Date.now() - t0,
      detail: msg.slice(0, 200),
    };
  } finally {
    clearTimeout(timer);
    restore();
  }
}

// Always compute from tokens × list price. OpenAI reports usage directly, so
// this is exact (before any prompt-caching discounts).
function estCost(model: string, inTok?: number, outTok?: number, _costUsd?: number): number {
  const p = PRICES[model];
  if (!p || (!inTok && !outTok)) return 0;
  return ((inTok ?? 0) * p.in + (outTok ?? 0) * p.out) / 1_000_000;
}

function writeReport(recs: Rec[]) {
  const models = [...new Set(recs.map((r) => r.model))];
  const scenarios = SCENARIOS.map((s) => s.key);
  const lines: string[] = [];
  lines.push("# Model cost / functionality experiment\n");
  lines.push(
    "Each model runs the full shopping scenario suite against an in-memory fake Oda " +
      "(no real cart touched). Functionality = the behaviours the bot depends on. Cost " +
      "uses the SDK-reported `total_cost_usd` where available, else token counts × the " +
      "list prices in `PRICES` (see script — edit if pricing changed).\n",
  );

  // Summary table
  lines.push("## Summary\n");
  lines.push("| Model | Passed | Total cost | Avg latency | Notes |");
  lines.push("|---|---|---|---|---|");
  for (const m of models) {
    const mr = recs.filter((r) => r.model === m);
    const passed = mr.filter((r) => r.pass).length;
    const cost = mr.reduce((a, r) => a + estCost(m, r.inTok, r.outTok, r.costUsd), 0);
    const avgMs = Math.round(mr.reduce((a, r) => a + r.ms, 0) / (mr.length || 1));
    const timeouts = mr.filter((r) => r.status === "timeout").length;
    const errors = mr.filter((r) => r.status === "error").length;
    const notes = [timeouts ? `${timeouts} timeout` : "", errors ? `${errors} error` : ""]
      .filter(Boolean)
      .join(", ");
    lines.push(
      `| ${m} | ${passed}/${mr.length} | $${cost.toFixed(4)} | ${(avgMs / 1000).toFixed(1)}s | ${notes || "—"} |`,
    );
  }

  // Per-scenario matrix
  lines.push("\n## Scenario matrix (pass/fail)\n");
  lines.push(`| Scenario | ${models.join(" | ")} |`);
  lines.push(`|---|${models.map(() => "---").join("|")}|`);
  for (const sc of scenarios) {
    const cells = models.map((m) => {
      const r = recs.find((x) => x.model === m && x.scenario === sc);
      if (!r) return "·";
      return r.status === "pass" ? "✅" : r.status === "timeout" ? "⏱" : r.status === "error" ? "💥" : "❌";
    });
    lines.push(`| ${sc} | ${cells.join(" | ")} |`);
  }

  lines.push("\n## Per-turn detail\n");
  lines.push("| Model | Scenario | Status | ms | in tok | out tok | est $ | detail |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const r of recs) {
    lines.push(
      `| ${r.model} | ${r.scenario} | ${r.status} | ${r.ms} | ${r.inTok ?? "?"} | ${r.outTok ?? "?"} | ${estCost(
        r.model,
        r.inTok,
        r.outTok,
        r.costUsd,
      ).toFixed(5)} | ${r.detail} |`,
    );
  }

  writeFileSync(REPORT, lines.join("\n") + "\n");
}

async function main() {
  writeFileSync(JSONL, "");
  const recs: Rec[] = [];
  for (const c of MATRIX) {
    for (const sc of SCENARIOS) {
      const rec = await runOne(c, sc);
      recs.push(rec);
      appendFileSync(JSONL, JSON.stringify(rec) + "\n");
      writeReport(recs); // rewrite report incrementally so polling shows progress
      console.log(
        `[${c.name}/${sc.key}] ${rec.status} ${rec.ms}ms in=${rec.inTok ?? "?"} out=${rec.outTok ?? "?"}`,
      );
    }
  }
  console.log(`\nDone. See ${REPORT}`);
}

main().catch((e) => {
  console.error("experiment failed:", e);
  process.exit(1);
});
