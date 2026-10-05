import { runOda } from "./oda-spawn.js";
import { normalizeAvailability, isOrderable, type Availability } from "./availability.js";

export { isOrderable };
export type { Availability };

type CartItem = {
  name: string;
  subtitle?: string;
  quantity: number;
  price: number;
};

/** Human-readable current cart contents (for the /cart command). */
export async function cartList(): Promise<string> {
  const out = await runOda(["cart", "list"]);
  let items: CartItem[];
  try {
    items = JSON.parse(out || "[]");
  } catch (err) {
    console.warn(`[oda-cli] cart list: unparseable output, falling back to raw (${String(err).slice(0, 120)})`);
    return out || "Your Oda cart is empty."; // fall back to raw output
  }
  if (items.length === 0) return "Your Oda cart is empty. 🛒";

  const lines = items.map((it) => {
    const sub = it.subtitle ? ` (${it.subtitle})` : "";
    return `- ${it.name}${sub} × ${it.quantity} — kr ${it.price.toFixed(2)}`;
  });
  const total = items.reduce((sum, it) => sum + it.price * it.quantity, 0);
  return `${lines.join("\n")}\n\nTotal: ~kr ${total.toFixed(2)}\nReview & buy in Oda 🛒`;
}

/** Empty the Oda cart (for the /clear command). */
export async function cartClear(): Promise<void> {
  await runOda(["cart", "clear"]);
}

/** Remove a product from the cart (deterministic — used by the availability sweep). */
export async function removeProductFromCart(id: number, count = 1): Promise<void> {
  await runOda(["cart", "remove", String(id), "--count", String(count)]);
}

/** Add a product directly by id (deterministic — used for basics auto-restock, not by the LLM). */
export async function addProductToCart(id: number, count = 1): Promise<void> {
  await runOda(["product", "add", String(id), "--count", String(count)]);
}

type ProductListSummary = {
  id: number;
  title: string;
  description: string;
  number_of_products: number;
  total_quantity: number;
};

/** Human-readable saved lists overview (for the /lists command). */
export async function listsAll(): Promise<string> {
  const out = await runOda(["list", "all"]);
  let lists: ProductListSummary[];
  try {
    lists = JSON.parse(out || "[]");
  } catch (err) {
    console.warn(`[oda-cli] list all: unparseable output, falling back to raw (${String(err).slice(0, 120)})`);
    return out || "You have no saved lists yet.";
  }
  if (lists.length === 0) return "You have no saved lists yet.";

  const lines = lists.map(
    (l) => `- ${l.title} (#${l.id}) — ${l.number_of_products} products${l.description ? `: ${l.description}` : ""}`,
  );
  return `${lines.join("\n")}\n\nAsk me to add one to the cart, e.g. "add list ${lists[0].title} to cart".`;
}

export type RawCartItem = {
  id: number;
  name: string;
  quantity: number;
  availability?: Availability;
};

/** Raw cart line items (id + quantity + availability), used to diff before/after a turn. */
export async function cartItems(): Promise<RawCartItem[]> {
  const out = await runOda(["cart", "list"]);
  try {
    const arr = JSON.parse(out || "[]") as {
      id: number;
      name: string;
      quantity: number;
      availability?: { is_available?: boolean; isAvailable?: boolean; code?: string; description?: string };
    }[];
    return arr.map((x) => ({
      id: x.id,
      name: x.name,
      quantity: x.quantity,
      availability: normalizeAvailability(x.availability),
    }));
  } catch (err) {
    console.warn(`[oda-cli] cartItems: unparseable output, returning [] (${String(err).slice(0, 120)})`);
    return [];
  }
}

export type ProductSearchItem = {
  id: number;
  name: string;
  subtitle?: string;
  price?: number;
  availability?: Availability;
};

/** Search Oda products deterministically (used to pre-check basics availability). */
export async function searchProducts(query: string): Promise<ProductSearchItem[]> {
  const out = await runOda(["product", "search", query]);
  try {
    const parsed = JSON.parse(out || "{}") as {
      items?: {
        id: number;
        name: string;
        subtitle?: string;
        price?: number;
        availability?: { is_available?: boolean; isAvailable?: boolean; code?: string; description?: string };
      }[];
    };
    return (parsed.items ?? []).map((x) => ({
      id: x.id,
      name: x.name,
      subtitle: x.subtitle,
      price: x.price,
      availability: normalizeAvailability(x.availability),
    }));
  } catch (err) {
    console.warn(`[oda-cli] searchProducts: unparseable output for "${query}", returning [] (${String(err).slice(0, 120)})`);
    return [];
  }
}
