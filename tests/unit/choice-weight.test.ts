// Unit tests for the buy-again weighting rules (src/choice-weight.ts).
// Pure logic, no DB, no network — always runs (unlike the model-backed e2e).
import { describe, test, expect } from "vitest";
import {
  MIN_ORDERS_FOR_CHOICE,
  isChoiceWorthy,
  replacementBlocked,
} from "../../src/choice-weight.js";

describe("isChoiceWorthy", () => {
  test("a product bought once is a trial, not a usual", () => {
    expect(isChoiceWorthy(1)).toBe(false);
  });

  test("a product bought twice qualifies", () => {
    expect(isChoiceWorthy(MIN_ORDERS_FOR_CHOICE)).toBe(true);
  });

  test("the reported case: 1x soda trial vs 6x staple", () => {
    expect(isChoiceWorthy(1)).toBe(false);
    expect(isChoiceWorthy(6)).toBe(true);
  });
});

describe("replacementBlocked", () => {
  const NOW = Date.parse("2026-10-03T00:00:00Z");
  const recent = "2026-09-20T00:00:00.000Z";

  test("no existing mapping — replacement allowed", () => {
    expect(replacementBlocked(null, { lastBoughtIso: recent, orderCount: 1 }, NOW)).toBeNull();
  });

  test("never regress to a staler product", () => {
    const blocked = replacementBlocked(
      { lastBought: recent, orderCount: 6 },
      { lastBoughtIso: "2026-01-01T00:00:00.000Z", orderCount: 10 },
      NOW,
    );
    expect(blocked).toMatch(/staler/);
  });

  test("a 1x recent trial must not dethrone a 6x recent staple", () => {
    const blocked = replacementBlocked(
      { lastBought: recent, orderCount: 6 },
      { lastBoughtIso: "2026-10-01T00:00:00.000Z", orderCount: 1 },
      NOW,
    );
    expect(blocked).toMatch(/one-off/);
  });

  test("a recent replacement wins when the old staple is long unbought (brand switch)", () => {
    const blocked = replacementBlocked(
      { lastBought: "2025-01-01T00:00:00.000Z", orderCount: 6 },
      { lastBoughtIso: recent, orderCount: 2 },
      NOW,
    );
    expect(blocked).toBeNull();
  });

  test("similarly-frequent products: recency breaks the tie", () => {
    const blocked = replacementBlocked(
      { lastBought: "2026-08-01T00:00:00.000Z", orderCount: 5 },
      { lastBoughtIso: recent, orderCount: 6 },
      NOW,
    );
    expect(blocked).toBeNull();
  });
});
