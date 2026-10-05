import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import { getChoice } from "./store.js";

// Read-only lookup into the user's Oda order history. Answers "when did I last
// buy X?" — the one thing the bot couldn't do before — by walking the real order
// API (the same endpoints scripts/seed-history.ts uses) newest-first and matching
// against both the buy-again mapping (a generic term -> its chosen product) and
// the raw product descriptions. Never writes anything, never touches the cart.

const API_BASE = "https://oda.com";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36";
const REQUEST_DELAY_MS = 120; // be a polite citizen against Oda's order-detail endpoint
const CONCURRENCY = 5; // bounded fan-out when fetching order details
const MAX_PAGES = 5; // safety cap on the date-paginated order list

const NORWEGIAN_MONTHS: Record<string, number> = {
  januar: 0,
  februar: 1,
  mars: 2,
  april: 3,
  mai: 4,
  juni: 5,
  juli: 6,
  august: 7,
  september: 8,
  oktober: 9,
  november: 10,
  desember: 11,
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function cookieHeader(): string {
  const path = join(config.odaDataDir, "cookies.json");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error("No Oda session found — please log in to Oda first.");
  }
  const parsed = JSON.parse(raw) as unknown;
  const cookieObj = Array.isArray(parsed)
    ? parsed
    : ((parsed as { cookies?: unknown }).cookies ?? parsed);
  const pairs = Array.isArray(cookieObj)
    ? cookieObj.map((c: { name: string; value: string }) => `${c.name}=${c.value}`)
    : Object.entries(cookieObj as Record<string, unknown>).map(([k, v]) => `${k}=${String(v)}`);
  return pairs.join("; ");
}

async function odaGet(url: string, cookie: string): Promise<any> {
  const r = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json", Cookie: cookie },
  });
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return r.json();
}

/** "Desember 2025" -> 2025; "Juli" (no year) -> the current year (Oda omits it). */
function parseGroupYear(name: string): number {
  const m = name.match(/(\d{4})/);
  return m ? Number(m[1]) : new Date().getFullYear();
}

/** "søn 7. desember, 12:28" + year -> Date, or null if the format doesn't match. */
function parseDeliveryDate(deliveryTime: string, year: number): Date | null {
  const m = deliveryTime.match(/(\d{1,2})\.\s*([a-zæøå]+)/i);
  if (!m) return null;
  const month = NORWEGIAN_MONTHS[m[2].toLowerCase()];
  if (month === undefined) return null;
  return new Date(Date.UTC(year, month, Number(m[1])));
}

type OrderRef = { orderNumber: string; date: Date };

async function collectOrderRefs(cookie: string, limit: number): Promise<OrderRef[]> {
  const refs: OrderRef[] = [];
  let url: string | null = `${API_BASE}/api/v1/orders/`;
  for (let page = 0; url && page < MAX_PAGES && refs.length < limit; page++) {
    const data: {
      results?: { name: string; orders?: { order_number: string; delivery?: { delivery_time?: string } }[] }[];
      has_more?: boolean;
      get_more_url?: string;
    } = await odaGet(url, cookie);
    for (const g of data.results ?? []) {
      const year = parseGroupYear(g.name);
      for (const o of g.orders ?? []) {
        if (!o.order_number) continue;
        const date = o.delivery?.delivery_time ? parseDeliveryDate(o.delivery.delivery_time, year) : null;
        // Only keep orders with a parseable date — a fallback of `new Date()`
        // would mis-date unparseable orders as "today" and sort them to the top,
        // reporting a bogus "last bought today". Matches seed-history.ts.
        if (date) refs.push({ orderNumber: o.order_number, date });
        if (refs.length >= limit) break;
      }
      if (refs.length >= limit) break;
    }
    url = data.has_more && data.get_more_url ? String(data.get_more_url) : null;
  }
  return refs.sort((a, b) => b.date.getTime() - a.date.getTime()); // newest first
}

type OrderItem = { productId: number; description: string; quantity: number };

interface OrderRecord {
  date: Date;
  items: OrderItem[];
}

/** Fetch the N most recent orders (with their line items), newest first. */
async function fetchOrders(maxOrders: number): Promise<OrderRecord[]> {
  const cookie = cookieHeader();
  const refs = await collectOrderRefs(cookie, maxOrders);
  const records: OrderRecord[] = [];

  for (let i = 0; i < refs.length; i += CONCURRENCY) {
    const chunk = refs.slice(i, i + CONCURRENCY);
    const details = await Promise.all(
      chunk.map((ref) =>
        odaGet(`${API_BASE}/api/v1/orders/${encodeURIComponent(ref.orderNumber)}/`, cookie),
      ),
    );
    for (let j = 0; j < chunk.length; j++) {
      const det = details[j];
      const items = ((det?.items?.item_groups ?? []) as { items?: unknown[] }[]).flatMap(
        (g) => g.items ?? [],
      ) as { product_id?: number; description?: string; quantity?: number }[];
      records.push({
        date: chunk[j].date,
        items: items
          .filter((it) => Number.isFinite(it.product_id) && it.product_id != null)
          .map((it) => ({
            productId: it.product_id as number,
            description: it.description?.trim() || String(it.product_id),
            quantity: Number(it.quantity) || 1,
          })),
      });
    }
    if (i + CONCURRENCY < refs.length) await sleep(REQUEST_DELAY_MS);
  }
  return records;
}

export interface LastBoughtMatch {
  productId: number;
  description: string;
  lastBought: string; // ISO date of the most recent order containing it
  timesBought: number; // distinct orders containing it, within the scanned window
}

export interface LastBoughtResult {
  term: string;
  resolvedProductName: string | null;
  matches: LastBoughtMatch[];
  windowOrders: number;
}

/**
 * Find when the user last bought something, scanning their most recent orders
 * newest-first. "Something" is resolved as a generic buy-again term first (e.g.
 * "melk" -> the specific milk product they usually buy); the raw descriptions are
 * also substring-matched so a concrete product name ("Q Lettmelk 1,5% 1L") works
 * even when it has no saved choice.
 */
export async function whenLastBought(term: string, opts: { maxOrders?: number } = {}): Promise<LastBoughtResult> {
  const maxOrders = opts.maxOrders ?? 20;
  const trimmed = term.trim();
  if (!trimmed) return { term: "", resolvedProductName: null, matches: [], windowOrders: 0 };
  const needle = trimmed.toLowerCase();
  const choice = getChoice(trimmed); // fuzzy: "melk" matches a saved "lettmelk"
  const resolvedId = choice?.productId ?? null;
  const resolvedName = choice?.productName ?? null;
  const resolvedNameLower = resolvedName?.toLowerCase() ?? null;

  const records = await fetchOrders(maxOrders);

  const byId = new Map<number, { description: string; lastDate: Date; timesBought: number }>();
  for (const rec of records) {
    const seenInOrder = new Set<number>();
    for (const item of rec.items) {
      const desc = item.description.toLowerCase();
      const matches =
        (resolvedId != null && item.productId === resolvedId) ||
        (resolvedNameLower != null && desc.includes(resolvedNameLower)) ||
        (needle.length > 0 && desc.includes(needle));
      if (!matches) continue;

      const cur = byId.get(item.productId) ?? {
        description: item.description,
        lastDate: rec.date,
        timesBought: 0,
      };
      if (!seenInOrder.has(item.productId)) {
        cur.timesBought += 1;
        seenInOrder.add(item.productId);
      }
      if (rec.date.getTime() > cur.lastDate.getTime()) {
        cur.lastDate = rec.date;
        cur.description = item.description; // prefer the most recent spelling
      }
      byId.set(item.productId, cur);
    }
  }

  const matches: LastBoughtMatch[] = [...byId.entries()]
    .map(([productId, m]) => ({
      productId,
      description: m.description,
      lastBought: m.lastDate.toISOString(),
      timesBought: m.timesBought,
    }))
    .sort((a, b) => {
      // Put the resolved "usual" product first (that's what the user means by a
      // generic term), then by recency.
      const aRes = resolvedId != null && a.productId === resolvedId;
      const bRes = resolvedId != null && b.productId === resolvedId;
      if (aRes !== bRes) return aRes ? -1 : 1;
      return Date.parse(b.lastBought) - Date.parse(a.lastBought);
    });

  return { term: trimmed, resolvedProductName: resolvedName, matches, windowOrders: records.length };
}

function daysAgo(iso: string): string {
  const d = Math.round((Date.now() - Date.parse(iso)) / 86_400_000);
  if (d <= 0) return "today";
  if (d === 1) return "yesterday";
  if (d < 30) return `${d} days ago`;
  const m = Math.round(d / 30);
  return `${m} month${m > 1 ? "s" : ""} ago`;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** Human-readable, phone-friendly answer for Telegram. */
export function formatLastBought(r: LastBoughtResult): string {
  if (!r.matches.length) {
    return `I couldn't find a purchase of "${r.term}" in your last ${r.windowOrders} orders.`;
  }
  const lines = r.matches.slice(0, 5).map((m) => {
    const when = `${fmtDate(m.lastBought)} (${daysAgo(m.lastBought)})`;
    return `• ${m.description}\n   last bought ${when} — ${m.timesBought}× in your last ${r.windowOrders} orders`;
  });
  return `"${r.term}" — last bought:\n\n${lines.join("\n")}`;
}
