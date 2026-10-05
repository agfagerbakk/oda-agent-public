// Unit tests for slot picking/formatting (src/slots.ts).
// Dynamic import after setting env so src/config.ts resolves a temp dir.
import { describe, test, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Slot } from "../../src/slots.js";

const dir = mkdtempSync(join(tmpdir(), "oda-slots-test-"));
process.env.MCP_ODA_DATA_DIR = dir;
process.env.OPENAI_API_KEY ||= "unit-test-dummy";
process.env.ODA_USER ||= "unit-test";
process.env.ODA_PASS ||= "unit-test";

const slots = await import("../../src/slots.js");

function mkSlot(id: number, open: string, price = "kr 9", extra = {}): Slot {
  return {
    id,
    group: "Evening",
    open,
    close: "2026-07-17T18:00:00Z",
    cutoff: "2026-07-16T18:00:00Z",
    price,
    isFull: false,
    isUnavailable: false,
    unavailableReason: null,
    isCheapest: false,
    ...extra,
  };
}

describe("orderable", () => {
  test("filters full and unavailable slots", () => {
    const all = [
      mkSlot(1, "2026-07-17T15:00:00Z"),
      mkSlot(2, "2026-07-17T16:00:00Z", "kr 9", { isFull: true }),
      mkSlot(3, "2026-07-17T17:00:00Z", "kr 9", { isUnavailable: true }),
    ];
    expect(slots.orderable(all).map((s) => s.id)).toEqual([1]);
  });
});

describe("isPreferred", () => {
  test("matches UTC (dow, hour) buckets", () => {
    // 2026-07-17T15:00:00Z is a Friday (dow 5), hour 15 UTC.
    const s = mkSlot(1, "2026-07-17T15:00:00Z");
    expect(slots.isPreferred(s, [{ dow: 5, hour: 15, count: 3 }])).toBe(true);
    expect(slots.isPreferred(s, [{ dow: 5, hour: 16, count: 3 }])).toBe(false);
    expect(slots.isPreferred(s, [])).toBe(false);
  });
});

describe("pickSlots", () => {
  test("caps at 6, preferred included, time-ordered", () => {
    const all = Array.from({ length: 8 }, (_, i) =>
      mkSlot(i + 1, `2026-07-${17 + Math.floor(i / 3)}T1${i % 10}:00:00Z`),
    );
    const prefs = [{ dow: new Date(all[7].open).getUTCDay(), hour: new Date(all[7].open).getUTCHours(), count: 5 }];
    const picked = slots.pickSlots(all, prefs);
    expect(picked.length).toBeLessThanOrEqual(6);
    expect(picked.map((s) => s.id)).toContain(8); // preferred slot survives the cap…
    const times = picked.map((s) => Date.parse(s.open));
    expect([...times].sort((a, b) => a - b)).toEqual(times); // …but shown time-ordered
  });

  test("empty input → empty output", () => {
    expect(slots.pickSlots([], [])).toEqual([]);
  });
});

describe("priceNok", () => {
  test("parses Norwegian price labels", () => {
    expect(slots.priceNok("kr 9")).toBe(9);
    expect(slots.priceNok("kr 129")).toBe(129);
    expect(slots.priceNok("Gratis")).toBe(0);
  });
});
