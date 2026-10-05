// Shared shopping scenarios: the single source of truth for what the bot must
// do, imported by both tests/e2e/shopping.e2e.test.ts (per-model correctness)
// and scripts/experiment.ts (cross-model cost/functionality comparison).
// Uses node:assert (not vitest) so scripts can import it too.
import assert from "node:assert/strict";
import { cartIds, type FakeState } from "./fake-oda.js";

export const EMPTY_CONTEXT =
  "## Preference seed (baseline)\n(none)\n\n" +
  "## Learned buy-again choices (prefer these; add by product id when given)\n(nothing learned yet)";

export type ScenarioOpts = {
  initialCart?: number[];
  initialSaved?: { term: string; id?: number; name: string }[];
};

export type Scenario = {
  key: string;
  title: string;
  prompt: string;
  opts?: ScenarioOpts;
  /** Throws on failure (node:assert). */
  check: (state: FakeState, reply: string) => void;
};

const hasMilk = (s: FakeState) => s.cart.some((c) => /melk|milk/i.test(c.name));
const hasEgg = (s: FakeState) => s.cart.some((c) => /egg/i.test(c.name));

export const SCENARIOS: Scenario[] = [
  {
    key: "adds-staples",
    title: "adds requested staples to the cart",
    prompt: "Add milk and eggs to my Oda cart, please.",
    check: (s, reply) => {
      assert.ok(hasMilk(s), `no milk in cart: ${JSON.stringify(s.cart)}`);
      assert.ok(hasEgg(s), `no eggs in cart: ${JSON.stringify(s.cart)}`);
      assert.ok(reply.length > 0, "empty reply");
    },
  },
  {
    key: "lactose-free",
    title: "prefers the lactose-free milk",
    prompt: "Add milk.",
    check: (s) => {
      const milk = s.cart.find((c) => /melk|milk/i.test(c.name));
      // 12196 = Tine Laktosefri; 1131 = regular Q Melk (contains lactose)
      assert.equal(milk?.id, 12196, `chosen milk: ${JSON.stringify(milk)}`);
    },
  },
  {
    key: "avoid-ultraprocessed",
    title: "avoids ultra-processed and picks the clean option",
    prompt: "Add some liver pâté (leverpostei).",
    check: (s) => {
      const ids = cartIds(s);
      // 5002 = clean organic; 5001 = additive-laden (E250/E410/emulsifier), returned first by search
      assert.ok(ids.includes(5002), `cart: ${JSON.stringify(s.cart)} calls: ${s.calls.join(" ")}`);
      assert.ok(!ids.includes(5001), `added the additive-laden option: ${JSON.stringify(s.cart)}`);
    },
  },
  {
    key: "buy-again-reuse",
    title: "reuses a learned buy-again choice by id (via buy_again_lookup)",
    prompt: "Add leverpostei.",
    opts: { initialSaved: [{ term: "leverpostei", id: 5002, name: "Bjerke Økologisk Leverpostei" }] },
    check: (s) => {
      assert.ok(cartIds(s).includes(5002), `cart: ${JSON.stringify(s.cart)}`);
    },
  },
  {
    key: "unavailable-skip",
    title: "skips an unavailable item and flags it instead of adding it",
    prompt: "Add some shower gel (dusj).",
    check: (s, reply) => {
      // 8001 = Neutral Dusjsåpe, the only "dusj" match, marked unavailable.
      assert.ok(!cartIds(s).includes(8001), `added unavailable item: ${JSON.stringify(s.cart)}`);
      assert.match(
        reply.toLowerCase(),
        /unavailable|sold out|utilgjeng|couldn.t|not available|can.t add/,
        "must flag the skip, not silently drop it",
      );
    },
  },
  {
    key: "available-later-skip",
    title: "skips an item that only arrives in a later delivery (available_later)",
    prompt: "Add some chocolate (sjokolade).",
    check: (s, reply) => {
      // 8002 = Freia Melkesjokolade, the only "sjokolade" match, code available_later.
      assert.ok(!cartIds(s).includes(8002), `added later-delivery item: ${JSON.stringify(s.cart)}`);
      assert.match(
        reply.toLowerCase(),
        /later|delivers|delivery|unavailable|sold out|utilgjeng|couldn.t|not available|can.t add/,
        "must flag the skip, not silently drop it",
      );
    },
  },
  {
    key: "clear-cart",
    title: "clears the cart on request",
    prompt: "Clear my cart completely.",
    opts: { initialCart: [1131, 69609, 24854] },
    check: (s) => {
      assert.equal(s.cart.length, 0, `cart: ${JSON.stringify(s.cart)}`);
    },
  },
  {
    key: "learns-choice",
    title: "learns the chosen product for a staple (save_choice)",
    prompt: "Add havregryn (oats).",
    check: (s) => {
      assert.ok(s.saved.length >= 1, `saved: ${JSON.stringify(s.saved)} calls: ${s.calls.join(" ")}`);
    },
  },
];
