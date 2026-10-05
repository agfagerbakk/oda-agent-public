// Unit tests for the deterministic availability gate (src/oda-cli.ts).
// Dynamic import after setting env so src/config.ts resolves a temp dir.
import { describe, test, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "oda-avail-test-"));
process.env.MCP_ODA_DATA_DIR = dir;
process.env.OPENAI_API_KEY ||= "unit-test-dummy";
process.env.ODA_USER ||= "unit-test";
process.env.ODA_PASS ||= "unit-test";

const cli = await import("../../src/oda-cli.js");

describe("isOrderable", () => {
  test("sold-out lines are not orderable", () => {
    expect(cli.isOrderable({ isAvailable: false, code: "sold_out", description: "Utilgjengelig" })).toBe(
      false,
    );
  });

  test("available_later is NOT orderable (later delivery, not the near-future slot)", () => {
    expect(
      cli.isOrderable({ isAvailable: true, code: "available_later", description: "Leveres 10. okt" }),
    ).toBe(false);
  });

  test("plain available lines are orderable", () => {
    expect(cli.isOrderable({ isAvailable: true, code: "available", description: "" })).toBe(true);
  });

  test("missing availability data never hides a product (matches mcp-oda default)", () => {
    expect(cli.isOrderable(undefined)).toBe(true);
  });
});
