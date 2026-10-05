import { z } from "zod";
import { createSdkMcpServer, tool } from "./mcp-shim.js";
import { runOda } from "./oda-spawn.js";
import { setChoice, getChoice } from "./store.js";
import { whenLastBought, formatLastBought } from "./history.js";

// Norwegian additive-class words that mark ultra-processing, plus E-numbers.
const ADDITIVE_TERMS = [
  "emulgator",
  "stabilisator",
  "konserveringsmiddel",
  "fortykningsmiddel",
  "surhetsregulerende",
  "antioksidant",
  "fargestoff",
  "søtstoff",
  "smaksforsterker",
];

async function dumpProduct(id: number): Promise<string> {
  return runOda(["dump", `https://oda.com/no/products/${id}/`]);
}

/** Pull one declaration value (e.g. "Ingredienser") out of the dumped page. */
function declaration(text: string, key: string): string | null {
  const re = new RegExp(`\\{\\s*"key":\\s*"${key}",\\s*"value":\\s*"([^"]*)"`, "i");
  return re.exec(text)?.[1]?.trim() || null;
}

export const localTools = createSdkMcpServer({
  name: "odax",
  version: "1.0.0",
  tools: [
    tool(
      "product_ingredients",
      "Fetch the ingredient declaration and allergens for an Oda product by id, and screen for ultra-processing additives (emulsifiers, stabilizers, preservatives, E-numbers) and lactose. Call this before adding processed/dairy items to check they meet the dietary rules.",
      { id: z.number().describe("Oda product id (from products_search)") },
      async ({ id }) => {
        let text: string;
        try {
          text = await dumpProduct(id);
        } catch {
          return {
            content: [
              { type: "text", text: `Could not fetch product ${id}; ingredients unknown.` },
            ],
          };
        }
        const ingredients = declaration(text, "Ingredienser");
        const allergens = declaration(text, "Allergener");
        if (!ingredients) {
          return {
            content: [
              {
                type: "text",
                text: `Product ${id}: no ingredient declaration published on Oda — cannot verify. Treat as unverified.`,
              },
            ],
          };
        }
        const hay = ingredients.toLowerCase();
        const additives = ADDITIVE_TERMS.filter((t) => hay.includes(t));
        const eNumbers = ingredients.match(/\bE[\s-]?\d{3}[a-z]?\b/gi) ?? [];
        const combined = `${id} ${ingredients} ${allergens ?? ""}`.toLowerCase();
        const lactoseFree = /laktosefri|uten laktose/.test(combined);
        const mentionsMilk = /melk|laktose/.test((allergens ?? "").toLowerCase());

        const report = [
          `Product ${id}`,
          `Ingredienser: ${ingredients}`,
          allergens ? `Allergener: ${allergens}` : null,
          `Additives detected: ${
            additives.length || eNumbers.length
              ? [...additives, ...eNumbers].join(", ")
              : "none"
          }`,
          `Ultra-processed: ${additives.length || eNumbers.length ? "YES" : "no"}`,
          `Lactose-free: ${lactoseFree ? "yes" : mentionsMilk ? "no (contains milk/lactose)" : "n/a"}`,
        ]
          .filter(Boolean)
          .join("\n");

        return { content: [{ type: "text", text: report }] };
      },
    ),
    tool(
      "save_choice",
      "Remember the user's usual product for a generic grocery term so it is reused on future orders. Call this after adding a recurring staple you had to choose (e.g. term 'melk' -> the specific milk product you added).",
      {
        term: z.string().describe("Generic term, e.g. 'melk', 'brød'"),
        product_id: z.number().optional().describe("Oda product id that was added"),
        product_name: z.string().describe("Full product name that was added"),
      },
      async ({ term, product_id, product_name }) => {
        setChoice(term, { id: product_id, name: product_name });
        return {
          content: [{ type: "text", text: `Saved: "${term}" → "${product_name}".` }],
        };
      },
    ),
    tool(
      "buy_again_lookup",
      "Check whether the user already has a saved usual product for a generic grocery term (e.g. 'melk', 'brød') before searching. Call this first for any recurring staple; if it returns a match, add that exact product id rather than searching again. The match includes purchase evidence (times bought) — a match bought only once is a weak one-off trial, not an established usual; if the user asks for that concept generally, prefer searching for the best current option over blindly re-adding a one-off.",
      { term: z.string().describe("Generic term, e.g. 'melk', 'brød'") },
      async ({ term }) => {
        const choice = getChoice(term);
        let text: string;
        if (!choice) {
          text = `No saved buy-again choice for "${term}".`;
        } else {
          const evidence =
            choice.orderCount != null && choice.orderCount > 0
              ? ` (bought ${choice.orderCount}x${choice.lastBought ? `, last bought ${choice.lastBought.slice(0, 10)}` : ""})`
              : " (one-off — no repeat-purchase history)";
          text =
            `Saved: "${term}" → ${choice.productName}` +
            `${choice.productId ? ` (product id ${choice.productId})` : ""}${evidence}`;
        }
        return { content: [{ type: "text", text }] };
      },
    ),
    tool(
      "last_bought",
      "Answer when the user last bought a product or generic grocery term (e.g. \"when did I last buy melk?\"). Read-only: scans their recent Oda orders and returns the last purchase date and how often it appears. Use this ONLY for history questions; NEVER call it while shopping for or adding items — it cannot search or choose products.",
      { term: z.string().min(1).describe("The product or generic term to look up, e.g. 'melk'") },
      async ({ term }) => {
        const r = await whenLastBought(term);
        return { content: [{ type: "text", text: formatLastBought(r) }] };
      },
    ),
  ],
});
