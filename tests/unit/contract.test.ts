// Tandem contract tests: pin the agent↔mcp-oda interface so refactors on
// either side break loudly here instead of silently at runtime.
// Dynamic import after setting env so src/config.ts resolves a temp dir.
import { describe, test, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "oda-contract-test-"));
process.env.MCP_ODA_DATA_DIR = dir;
process.env.OPENAI_API_KEY ||= "unit-test-dummy";
process.env.ODA_USER ||= "unit-test";
process.env.ODA_PASS ||= "unit-test";

const agent = await import("../../src/agent.js");
const slots = await import("../../src/slots.js");
const avail = await import("../../src/availability.js");

describe("ODA_TOOLS allowlist (agent → MCP contract)", () => {
  test("every entry parses to a known server key", () => {
    for (const entry of agent.ODA_TOOLS) {
      const parsed = agent.parseAllowed(entry);
      expect(parsed, entry).not.toBeNull();
      expect(["oda", "odax"]).toContain(parsed!.serverKey);
    }
  });

  test("LLM can read slots but never book (booking is button-only)", () => {
    expect(agent.ODA_TOOLS).toContain("mcp__oda__delivery_slots_list");
    expect(agent.ODA_TOOLS).toContain("mcp__oda__delivery_addresses_list");
    expect(agent.ODA_TOOLS).not.toContain("mcp__oda__delivery_slot_select");
  });

  test("saved-list CRUD surface stays intact", () => {
    for (const name of [
      "mcp__oda__list_all",
      "mcp__oda__list_get",
      "mcp__oda__list_create",
      "mcp__oda__list_rename",
      "mcp__oda__list_delete",
      "mcp__oda__list_add_products",
      "mcp__oda__list_remove_product",
      "mcp__oda__list_add_to_cart",
    ]) {
      expect(agent.ODA_TOOLS, name).toContain(name);
    }
  });

  test("local odax tools stay intact", () => {
    for (const name of [
      "mcp__odax__product_ingredients",
      "mcp__odax__save_choice",
      "mcp__odax__buy_again_lookup",
      "mcp__odax__last_bought",
    ]) {
      expect(agent.ODA_TOOLS, name).toContain(name);
    }
  });
});

describe("cart_info.delivery_slot shapes (MCP object vs legacy number)", () => {
  test("null → no selection", () => {
    expect(slots.resolveSelectedSlotId(null)).toBeNull();
    expect(slots.resolveSelectedSlotId(undefined)).toBeNull();
  });

  test("live object shape {id, name_short} → id", () => {
    expect(slots.resolveSelectedSlotId({ id: 1607524, name_short: "tor 17-20" })).toBe(1607524);
  });

  test("object without id → null", () => {
    expect(slots.resolveSelectedSlotId({ name_short: "tor" })).toBeNull();
  });

  test("legacy numeric shapes → id", () => {
    expect(slots.resolveSelectedSlotId(1607524)).toBe(1607524);
    expect(slots.resolveSelectedSlotId("1607524")).toBe(1607524);
  });

  test("garbage → null (never crash the turn)", () => {
    expect(slots.resolveSelectedSlotId("soon")).toBeNull();
    expect(slots.resolveSelectedSlotId({})).toBeNull();
  });

  test("buildSelectedSlot prefers name_short, falls back to slot id", () => {
    expect(slots.buildSelectedSlot(null, undefined, [])).toBeNull();
    expect(slots.buildSelectedSlot(7, undefined, [])).toMatchObject({ id: 7, label: "slot 7", open: null });
    expect(slots.buildSelectedSlot(7, "tor 17-20", [])).toMatchObject({ id: 7, label: "tor 17-20" });
  });

  test("buildSelectedSlot recovers the delivery date from listed slots", () => {
    const listed = [
      {
        id: 7,
        group: "Evening",
        open: "2026-07-17T15:00:00Z",
        close: "2026-07-17T18:00:00Z",
        cutoff: "2026-07-16T18:00:00Z",
        price: "kr 9",
        isFull: false,
        isUnavailable: false,
        unavailableReason: null,
        isCheapest: false,
      },
    ];
    expect(slots.buildSelectedSlot(7, undefined, listed)).toMatchObject({ id: 7, open: listed[0].open });
  });
});

describe("availability dual-shape (cart snake vs search camel)", () => {
  test("both wire shapes normalize identically", () => {
    expect(avail.normalizeAvailability({ is_available: false, code: "sold_out", description: "x" })).toMatchObject({
      isAvailable: false,
      code: "sold_out",
    });
    expect(avail.normalizeAvailability({ isAvailable: false, code: "sold_out", description: "x" })).toMatchObject({
      isAvailable: false,
      code: "sold_out",
    });
  });

  test("missing input → undefined (never hides products)", () => {
    expect(avail.normalizeAvailability(undefined)).toBeUndefined();
    expect(avail.isOrderable(avail.normalizeAvailability(undefined))).toBe(true);
  });
});
