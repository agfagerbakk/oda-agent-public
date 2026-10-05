// Unit tests for history formatting + time helpers. formatLastBought is pure
// (no network); whenLastBought itself needs the live Oda API and stays e2e-only.
import { describe, test, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "oda-history-test-"));
process.env.MCP_ODA_DATA_DIR = dir;
process.env.OPENAI_API_KEY ||= "unit-test-dummy";
process.env.ODA_USER ||= "unit-test";
process.env.ODA_PASS ||= "unit-test";

const history = await import("../../src/history.js");
const time = await import("../../src/time.js");

describe("formatLastBought", () => {
  test("empty window says so plainly", () => {
    const out = history.formatLastBought({ term: "melk", resolvedProductName: null, matches: [], windowOrders: 20 });
    expect(out).toContain("melk");
    expect(out).toContain("20");
  });

  test("matches render with date and count", () => {
    const out = history.formatLastBought({
      term: "melk",
      resolvedProductName: "Q Lettmelk 1,5% 1L",
      matches: [
        { productId: 1, description: "Q Lettmelk 1,5% 1L", lastBought: new Date().toISOString(), timesBought: 4 },
      ],
      windowOrders: 20,
    });
    expect(out).toContain("Q Lettmelk");
    expect(out).toContain("4×");
  });

  test("caps at 5 lines", () => {
    const matches = Array.from({ length: 8 }, (_, i) => ({
      productId: i,
      description: `Product ${i}`,
      lastBought: new Date().toISOString(),
      timesBought: 1,
    }));
    const out = history.formatLastBought({ term: "x", resolvedProductName: null, matches, windowOrders: 20 });
    expect(out.match(/•/g)?.length).toBe(5);
  });
});

describe("time helpers", () => {
  test("daysSince measures day gaps", () => {
    expect(time.daysSince(Date.now() - 3 * time.MS_PER_DAY)).toBeCloseTo(3, 5);
  });

  test("minutesSinceIso floors at zero for future timestamps", () => {
    expect(time.minutesSinceIso(new Date(Date.now() + 60_000).toISOString())).toBe(0);
  });
});
