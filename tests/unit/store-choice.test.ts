// Unit tests for the evidence-weighted buy-again lookup (src/store.ts).
// Uses an isolated temp SQLite dir so the real dev DB is never touched.
// Dynamic imports (after setting env) so src/config.ts resolves the temp dir.
import { describe, test, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "oda-choice-test-"));
process.env.MCP_ODA_DATA_DIR = dir;
process.env.OPENAI_API_KEY ||= "unit-test-dummy";
process.env.ODA_USER ||= "unit-test";
process.env.ODA_PASS ||= "unit-test";

const store = await import("../../src/store.js");

describe("getChoice fuzzy weighting", () => {
  test("an established staple beats a one-off trial sharing the substring", () => {
    // A single soda trial saved as a plain choice (no repeat history)…
    store.setChoice("sodax-trial", { id: 9002, name: "Trial Mango Soda" }, "test");
    // …vs the actually-usual product, bought 6x and tracked as an active basic.
    store.upsertBasicStats(
      "sodax-staple",
      {
        productId: 9001,
        productName: "Staple Cola 6x",
        cadenceDays: 14,
        lastBought: new Date().toISOString(),
        orderCount: 6,
      },
      "test",
    );

    // "sodax" is a substring of both terms; the old shortest-term-first
    // ordering would return the trial ("sodax-trial" is shorter).
    const hit = store.getChoice("sodax");
    expect(hit?.productName).toBe("Staple Cola 6x");
    expect(hit?.orderCount).toBe(6);
  });

  test("exact term match still wins over a stronger fuzzy candidate", () => {
    const hit = store.getChoice("sodax-trial");
    expect(hit?.productName).toBe("Trial Mango Soda");
  });

  test("unknown term returns null", () => {
    expect(store.getChoice("something-never-saved-xyz")).toBeNull();
  });
});
