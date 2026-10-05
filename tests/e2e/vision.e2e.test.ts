import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { extractFromImage } from "../../src/vision.js";

// Vision extraction runs via a direct OpenAI call, so — unlike the
// shopping e2e — this works fine locally. Scores ingredient recall of the extracted
// text against the known contents of each sample image. Gated on an OpenAI key.
const enabled = Boolean(
  process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== "e2e-unused",
);

const CASES = [
  {
    file: "tests/images/recipe-alfredo.png",
    mime: "image/png",
    expect: ["fettuccine", "chicken", "butter", "garlic", "cream", "parmesan"],
  },
  {
    file: "tests/images/recipe-fingerfoods.jpg",
    mime: "image/jpeg",
    expect: ["broccoli", "egg", "cheese", "avocado", "banana", "potato", "chicken"],
  },
];

describe.skipIf(!enabled)("vision extraction", () => {
  for (const c of CASES) {
    test(`reads ingredients from ${c.file}`, async () => {
      const b64 = readFileSync(c.file).toString("base64");
      const out = (await extractFromImage(b64, c.mime)).toLowerCase();
      const hits = c.expect.filter((k) => out.includes(k));
      // Allow one miss; the vision step just needs to be reliably close.
      expect(hits.length, `expected most of ${c.expect} in:\n${out}`).toBeGreaterThanOrEqual(
        c.expect.length - 1,
      );
    }, 60_000);
  }
});
