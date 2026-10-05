// Unit tests for basics lifecycle (src/store.ts): restock candidacy, user
// veto/restore, seeder phase-out, and the /basics summary grouping.
// Uses an isolated temp SQLite dir so the real dev DB is never touched.
import { describe, test, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "oda-basics-test-"));
process.env.MCP_ODA_DATA_DIR = dir;
process.env.OPENAI_API_KEY ||= "unit-test-dummy";
process.env.ODA_USER ||= "unit-test";
process.env.ODA_PASS ||= "unit-test";

const store = await import("../../src/store.js");

const daysAgoIso = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();

describe("basics lifecycle", () => {
  test("recently-bought staple is a restock candidate; just-bought one is not", () => {
    store.upsertBasicStats(
      "basics-milk",
      { productId: 7101, productName: "Milk 1L", cadenceDays: 7, lastBought: daysAgoIso(6), orderCount: 8 },
      "test",
    );
    store.upsertBasicStats(
      "basics-fresh",
      { productId: 7102, productName: "Fresh Bread", cadenceDays: 7, lastBought: daysAgoIso(0.1), orderCount: 8 },
      "test",
    );
    const terms = store.restockCandidates().map((c) => c.term);
    expect(terms).toContain("basics-milk");
    expect(terms).not.toContain("basics-fresh");
  });

  test("candidates sort most-essential (shortest cadence) first", () => {
    store.upsertBasicStats(
      "basics-often",
      { productId: 7103, productName: "Daily Eggs", cadenceDays: 2, lastBought: daysAgoIso(5), orderCount: 20 },
      "test",
    );
    const cands = store.restockCandidates().filter((c) => c.term.startsWith("basics-"));
    expect(cands[0].term).toBe("basics-often");
  });

  test("exclude removes from candidates; restore brings it back", () => {
    expect(store.excludeBasic("basics-milk")).toBe(true);
    expect(store.restockCandidates().map((c) => c.term)).not.toContain("basics-milk");
    expect(store.restoreBasic("basics-milk")).toBe(true);
    expect(store.restockCandidates().map((c) => c.term)).toContain("basics-milk");
  });

  test("long-unbought staple phases out automatically", () => {
    store.upsertBasicStats(
      "basics-ancient",
      { productId: 7104, productName: "Old Flakes", cadenceDays: 7, lastBought: daysAgoIso(60), orderCount: 9 },
      "test",
    );
    expect(store.restockCandidates().map((c) => c.term)).not.toContain("basics-ancient");
  });

  test("user exclude survives a seeder re-upsert", () => {
    store.upsertBasicStats(
      "basics-veto",
      { productId: 7105, productName: "Veto Yogurt", cadenceDays: 7, lastBought: daysAgoIso(6), orderCount: 8 },
      "test",
    );
    expect(store.excludeBasic("basics-veto")).toBe(true);
    store.upsertBasicStats(
      "basics-veto",
      { productId: 7105, productName: "Veto Yogurt", cadenceDays: 7, lastBought: daysAgoIso(6), orderCount: 9 },
      "seed",
    );
    expect(store.restockCandidates().map((c) => c.term)).not.toContain("basics-veto");
  });

  test("basicsSummary groups active / phased_out / excluded", () => {
    const summary = store.basicsSummary();
    expect(summary).toContain("Active basics");
    expect(summary).toContain("basics-often");
    expect(summary).toContain("Excluded by you");
    expect(summary).toContain("basics-veto");
  });

  test("exclude unknown term returns false", () => {
    expect(store.excludeBasic("no-such-basic-xyz")).toBe(false);
  });
});
