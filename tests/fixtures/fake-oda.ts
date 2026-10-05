// In-process fake of the Oda tool surface. Registers the SAME tool names as the
// real setup (mcp__oda__* and mcp__odax__*) so the agent code and allowedTools
// are unchanged — only the backend is swapped. Handlers mutate a `state` object
// the test holds a reference to, so assertions inspect real tool outcomes.

import { createSdkMcpServer, tool, type McpServerConfig } from "../../src/mcp-shim.js";
import { z } from "zod";
import { CATALOG, searchCatalog, findById, type FixtureProduct } from "./catalog.js";

export type CartLine = {
  id: number;
  name: string;
  subtitle: string;
  quantity: number;
  price: number;
  availability: { is_available: boolean; code: string; description: string };
};
export type SavedChoice = { term: string; id?: number; name: string };

export type FakeState = {
  cart: CartLine[];
  saved: SavedChoice[];
  /** Tool-call log, useful for debugging a failing model. */
  calls: string[];
};

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

/** Mirror of the real availability shape (incl. the "available_later" code). */
function fakeAvailability(p: FixtureProduct): CartLine["availability"] {
  if (p.available === false) {
    return {
      is_available: false,
      code: "sold_out",
      description: p.availabilityDesc ?? "Utilgjengelig",
    };
  }
  if (p.availableLater) {
    return {
      is_available: true,
      code: "available_later",
      description: p.availableLaterDesc ?? "Leveres senere",
    };
  }
  return { is_available: true, code: "available", description: "" };
}

function addToCart(state: FakeState, p: FixtureProduct, count: number) {
  const existing = state.cart.find((c) => c.id === p.id);
  if (existing) existing.quantity += count;
  else
    state.cart.push({
      id: p.id,
      name: p.name,
      subtitle: p.subtitle,
      quantity: count,
      price: p.price,
      availability: fakeAvailability(p),
    });
}

function ingredientReport(p: FixtureProduct): string {
  if (!p.ingredients) {
    return `Product ${p.id}: no ingredient declaration published — cannot verify. Treat as unverified.`;
  }
  const eNumbers = p.ingredients.match(/\bE[\s-]?\d{3}[a-z]?\b/gi) ?? [];
  const detected = [...new Set([...(p.additives ?? []), ...eNumbers])];
  const ultraProcessed = detected.length > 0;
  return [
    `Product ${p.id}`,
    `Ingredienser: ${p.ingredients}`,
    `Additives detected: ${detected.length ? detected.join(", ") : "none"}`,
    `Ultra-processed: ${ultraProcessed ? "YES" : "no"}`,
    `Lactose-free: ${
      p.lactoseFree ? "yes" : p.containsMilk ? "no (contains milk/lactose)" : "n/a"
    }`,
  ].join("\n");
}

export type FakeOda = {
  oda: McpServerConfig;
  odax: McpServerConfig;
  state: FakeState;
};

/** Build a fresh fake Oda backend, optionally with a pre-populated cart / saved choices. */
export function buildFakeOda(opts: { initialCart?: number[]; initialSaved?: SavedChoice[] } = {}): FakeOda {
  const state: FakeState = { cart: [], saved: [...(opts.initialSaved ?? [])], calls: [] };
  for (const id of opts.initialCart ?? []) {
    const p = findById(id);
    if (p) addToCart(state, p, 1);
  }

  const oda = createSdkMcpServer({
    name: "oda",
    version: "1.0.0",
    tools: [
      tool("check_login", "Check Oda login status.", {}, async () => {
        state.calls.push("check_login");
        return text("Logged in as: E2E Test User");
      }),
      tool(
        "products_search",
        "Search Oda products.",
        { query: z.string(), page: z.number().optional() },
        async ({ query }) => {
          state.calls.push(`products_search(${query})`);
          const items = searchCatalog(query).map((p) => ({
            id: p.id,
            name: p.name,
            subtitle: p.subtitle,
            price: p.price,
            availability: fakeAvailability(p),
          }));
          return text(JSON.stringify({ items }));
        },
      ),
      tool(
        "product_add_to_cart",
        "Add a product to the cart by id.",
        { id: z.number(), count: z.number().optional() },
        async ({ id, count }) => {
          state.calls.push(`product_add_to_cart(${id},${count ?? 1})`);
          const p = findById(id);
          if (!p) return text(`No product with id ${id}.`);
          addToCart(state, p, count ?? 1);
          return text(`Added ${count ?? 1} × ${p.name} to the cart.`);
        },
      ),
      tool("cart_get_contents", "Get the current cart contents.", {}, async () => {
        state.calls.push("cart_get_contents");
        return text(JSON.stringify(state.cart));
      }),
      tool(
        "cart_remove_item",
        "Remove a product from the cart by id.",
        { id: z.number(), count: z.number().optional() },
        async ({ id, count }) => {
          state.calls.push(`cart_remove_item(${id})`);
          const line = state.cart.find((c) => c.id === id);
          if (line) {
            line.quantity -= count ?? 1;
            if (line.quantity <= 0) state.cart = state.cart.filter((c) => c.id !== id);
          }
          return text(`Removed ${id} from the cart.`);
        },
      ),
      tool("cart_clear", "Empty the cart.", {}, async () => {
        state.calls.push("cart_clear");
        state.cart = [];
        return text("Cart cleared.");
      }),
      // Recipe tools: minimal stubs so the names resolve; fixtures have no recipes.
      tool(
        "recipes_search",
        "Search recipes.",
        { query: z.string().optional(), page: z.number().optional(), filter_ids: z.array(z.string()).optional() },
        async () => {
          state.calls.push("recipes_search");
          return text(JSON.stringify({ items: [] }));
        },
      ),
      tool("recipes_get_details", "Recipe details by id.", { id: z.number() }, async () =>
        text("No recipe details available in this environment."),
      ),
      tool(
        "recipe_add_to_cart",
        "Add recipe ingredients to the cart.",
        { id: z.number(), portions: z.number() },
        async () => text("No recipes available in this environment."),
      ),
      tool("recipe_remove_from_cart", "Remove a recipe from the cart.", { id: z.number() }, async () =>
        text("No recipes available in this environment."),
      ),
    ],
  });

  const odax = createSdkMcpServer({
    name: "odax",
    version: "1.0.0",
    tools: [
      tool(
        "product_ingredients",
        "Fetch ingredient declaration + additive/lactose screening for a product id.",
        { id: z.number() },
        async ({ id }) => {
          state.calls.push(`product_ingredients(${id})`);
          const p = findById(id);
          if (!p) return text(`No product with id ${id}.`);
          return text(ingredientReport(p));
        },
      ),
      tool(
        "save_choice",
        "Remember the user's usual product for a generic term.",
        { term: z.string(), product_id: z.number().optional(), product_name: z.string() },
        async ({ term, product_id, product_name }) => {
          state.calls.push(`save_choice(${term})`);
          state.saved.push({ term, id: product_id, name: product_name });
          return text(`Saved: "${term}" → "${product_name}".`);
        },
      ),
      tool(
        "buy_again_lookup",
        "Check whether the user already has a saved usual product for a generic term.",
        { term: z.string() },
        async ({ term }) => {
          state.calls.push(`buy_again_lookup(${term})`);
          const needle = term.trim().toLowerCase();
          const hit =
            state.saved.find((s) => s.term.toLowerCase() === needle) ??
            state.saved.find(
              (s) =>
                s.term.toLowerCase().includes(needle) || needle.includes(s.term.toLowerCase()),
            );
          return text(
            hit
              ? `Saved: "${hit.term}" → ${hit.name}${hit.id ? ` (product id ${hit.id})` : ""}`
              : `No saved buy-again choice for "${term}".`,
          );
        },
      ),
      tool(
        "last_bought",
        "Answer when the user last bought a product or term. Use ONLY for history questions; NEVER call it while shopping for or adding items.",
        { term: z.string() },
        async ({ term }) => {
          state.calls.push(`last_bought(${term})`);
          return text(`No order history in this test environment for "${term}".`);
        },
      ),
    ],
  });

  return { oda, odax, state };
}

/** Convenience for assertions. */
export const cartIds = (state: FakeState): number[] => state.cart.map((c) => c.id);
export { CATALOG };
