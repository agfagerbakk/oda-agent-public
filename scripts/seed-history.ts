// Seed buy-again choices AND recurring "basics" from real Oda order history
// (last ~2 years, rolling window). Pulls orders via the authenticated Oda API
// (session cookie from the mcp-oda data dir), computes per-product purchase
// cadence (median days between orders), asks OpenAI to map products to
// generic grocery terms (weighting purchase frequency first — see mapToTerms),
// then writes:
//   - a buy-again choice for every mapped term (as before)
//   - a "basic" (cadence_days/last_bought/status) for terms whose chosen product
//     is bought often enough and regularly enough to be worth auto-restocking
//     (see src/store.ts for the active/phased_out/excluded status lifecycle)
//
// Dry run (default): prints the aggregated products + classification, writes nothing.
//   npx tsx scripts/seed-history.ts
// Commit the seed:
//   SEED_WRITE=1 npx tsx scripts/seed-history.ts
import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import OpenAI from "openai";
import { config } from "../src/config.js";
import {
  setChoice,
  upsertBasicStats,
  allTerms,
  getChoiceProduct,
  getExistingTermForProduct,
} from "../src/store.js";
import {
  isChoiceWorthy,
  replacementBlocked,
} from "../src/choice-weight.js";

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36";
const LOOKBACK_DAYS = 730; // ~2 years, rolling from today (not calendar-year boundaries)
const REQUEST_DELAY_MS = 150; // be a polite citizen against Oda's order-detail endpoint
const MAX_PAGES = 20; // safety cap on the through-date pagination (each page ~5 months)

// Basic-candidacy thresholds (see src/store.ts for the restock/phase-out thresholds
// applied downstream — these are just "is this even a candidate" gates).
const MIN_ORDERS_FOR_BASIC = 3;
const CADENCE_MIN_DAYS = 3;
const CADENCE_MAX_DAYS = 45;
const CV_MAX = 0.9; // coefficient of variation of gaps; irregular buying fails this unless very frequent

// Note: the minimum-orders bar for becoming a buy-again choice
// (MIN_ORDERS_FOR_CHOICE) lives in src/choice-weight.ts alongside the
// replacement rules, so unit tests cover the same logic the seeder enforces.

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
  const raw = JSON.parse(readFileSync(join(config.odaDataDir, "cookies.json"), "utf8"));
  const obj = Array.isArray(raw) ? raw : raw.cookies ?? raw;
  const pairs = Array.isArray(obj)
    ? obj.map((c: { name: string; value: string }) => `${c.name}=${c.value}`)
    : Object.entries(obj).map(([k, v]) => `${k}=${v}`);
  return pairs.join("; ");
}

async function odaGet(url: string, cookie: string): Promise<any> {
  const r = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json", Cookie: cookie },
  });
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return r.json();
}

/** "Desember 2025" -> 2025; "Juli" (no year) -> the real current year (Oda omits it for this year). */
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

async function collectOrderRefs(cookie: string, cutoff: Date): Promise<OrderRef[]> {
  const refs: OrderRef[] = [];
  let url: string | null = "https://oda.com/api/v1/orders/";
  for (let page = 0; url && page < MAX_PAGES; page++) {
    const data: {
      results?: { name: string; orders?: { order_number: string; delivery?: { delivery_time?: string } }[] }[];
      has_more?: boolean;
      get_more_url?: string;
    } = await odaGet(url, cookie);
    for (const g of data.results ?? []) {
      const year = parseGroupYear(g.name);
      for (const o of g.orders ?? []) {
        const deliveryTime = o.delivery?.delivery_time;
        const date = deliveryTime ? parseDeliveryDate(deliveryTime, year) : null;
        if (date) refs.push({ orderNumber: o.order_number, date });
      }
    }
    console.log(`  page ${page + 1}: ${data.results?.length ?? 0} groups, has_more=${data.has_more}`);
    url = data.has_more && data.get_more_url ? data.get_more_url : null;
  }
  return refs.filter((r) => r.date >= cutoff);
}

type Agg = { id: number; name: string; qty: number; dates: number[] /* epoch ms */ };

async function aggregate(): Promise<Agg[]> {
  const cookie = cookieHeader();
  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000);
  console.log(`Fetching order refs back to ${cutoff.toISOString().slice(0, 10)}...`);
  const refs = await collectOrderRefs(cookie, cutoff);
  console.log(`${refs.length} orders within the last ${LOOKBACK_DAYS} days.`);

  const byId = new Map<number, Agg>();
  for (const [i, ref] of refs.entries()) {
    const det = await odaGet(`https://oda.com/api/v1/orders/${ref.orderNumber}/`, cookie);
    const items = (det.items?.item_groups ?? []).flatMap((g: { items?: unknown[] }) => g.items ?? []);
    for (const it of items as { product_id: number; description: string; quantity: number }[]) {
      if (!it.product_id) continue;
      const cur = byId.get(it.product_id) ?? {
        id: it.product_id,
        name: it.description ?? String(it.product_id),
        qty: 0,
        dates: [],
      };
      cur.qty += it.quantity ?? 1;
      cur.dates.push(ref.date.getTime());
      byId.set(it.product_id, cur);
    }
    if ((i + 1) % 10 === 0) console.log(`  fetched ${i + 1}/${refs.length} order details...`);
    await sleep(REQUEST_DELAY_MS);
  }
  return [...byId.values()].sort((a, b) => b.dates.length - a.dates.length || b.qty - a.qty);
}

// --- Cadence stats -----------------------------------------------------------

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stdev(xs: number[]): number {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

type Stats = {
  id: number;
  name: string;
  orderCount: number;
  qtyTotal: number;
  cadenceDays: number | null;
  cv: number | null;
  lastBought: Date;
  daysSinceLast: number;
  isBasicCandidate: boolean;
};

function computeStats(agg: Agg): Stats {
  const dates = [...agg.dates].sort((a, b) => a - b);
  const gaps = dates.slice(1).map((d, i) => (d - dates[i]) / 86_400_000);
  const cadenceDays = gaps.length ? median(gaps) : null;
  const cv = gaps.length >= 2 ? stdev(gaps) / mean(gaps) : null;
  const lastBought = new Date(dates[dates.length - 1]);
  const daysSinceLast = (Date.now() - dates[dates.length - 1]) / 86_400_000;
  const isBasicCandidate =
    dates.length >= MIN_ORDERS_FOR_BASIC &&
    cadenceDays !== null &&
    cadenceDays >= CADENCE_MIN_DAYS &&
    cadenceDays <= CADENCE_MAX_DAYS &&
    (cv === null || cv <= CV_MAX || dates.length >= 6);
  return {
    id: agg.id,
    name: agg.name,
    orderCount: dates.length,
    qtyTotal: agg.qty,
    cadenceDays,
    cv,
    lastBought,
    daysSinceLast,
    isBasicCandidate,
  };
}

// --- Term mapping (LLM) ------------------------------------------------------

async function mapToTerms(
  stats: Stats[],
  existingTerms: string[],
): Promise<Record<string, { id: number; name: string }>> {
  const list = stats
    .map(
      (s) =>
        `${s.id} | ${s.name} | bought ${s.orderCount}x over ~2 years, last bought ${Math.round(s.daysSinceLast)}d ago` +
        (s.cadenceDays ? `, roughly every ${Math.round(s.cadenceDays)}d` : ""),
    )
    .join("\n");
  const prompt =
    "You maintain a Norwegian grocery buy-again list. Below are products a user bought over the last " +
    "~2 years (id | name | frequency/recency). Produce a JSON object mapping a short generic Norwegian " +
    'grocery term (e.g. "melk", "gulost", "bananer", "kaffe") to the single product the user CURRENTLY ' +
    "means by that term. Weight FREQUENCY first: prefer the product bought most often and most " +
    "regularly — a product bought only once or twice is a one-off trial, NOT the user's usual, and must " +
    "never outrank a product bought many times for the same term. Use recency only as a tiebreaker " +
    "between similarly-frequent products, or when the historically-frequent product has not been bought " +
    "in a very long time (likely discontinued — then the recent replacement wins). Skip one-off items " +
    "(bought once) entirely if a frequently-bought alternative exists for the same term. " +
    "Use lowercase terms. Skip one-off/ambiguous items if unclear. " +
    (existingTerms.length
      ? "This list already has terms from a previous run — REUSE the exact same term string (same " +
        "spelling/spacing) whenever a product still matches one of them; only invent a new term for a " +
        `concept that has none yet. Existing terms: ${existingTerms.join(", ")}. `
      : "") +
    'Return ONLY json: {"term": {"id": <product_id>, "name": "<product name>"}, ...}.\n\nProducts:\n' +
    list;

  const client = new OpenAI({ apiKey: config.openaiApiKey });
  let content: string;
  try {
    const r = await client.chat.completions.create({
      model: config.openaiChatModel,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      max_tokens: 16384,
    });
    content = r.choices?.[0]?.message?.content ?? "";
  } catch (e) {
    throw new Error(`term mapping failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300));
  }
  try {
    return JSON.parse(content);
  } catch {
    throw new Error(`term mapping returned invalid JSON (${content.length} chars): ${content.slice(0, 300)}`);
  }
}

async function main() {
  const aggs = await aggregate();
  const stats = aggs.map(computeStats);

  console.log(`\n${stats.length} distinct products:`);
  for (const s of stats) {
    const cadence = s.cadenceDays ? `every ~${Math.round(s.cadenceDays)}d` : "irregular";
    const flag = s.isBasicCandidate ? " [basic candidate]" : "";
    console.log(`  ${s.orderCount}x, ${cadence}, last ${Math.round(s.daysSinceLast)}d ago  [${s.id}] ${s.name}${flag}`);
  }

  if (!process.env.SEED_WRITE) {
    console.log("\n(dry run — set SEED_WRITE=1 to map to terms and write choices/basics)");
    return;
  }
  if (!config.openaiApiKey) throw new Error("OPENAI_API_KEY needed for term mapping.");

  // The LLM's output is NOT trusted blindly — an id/name it echoes back could be
  // hallucinated or mismatched (observed in practice: a made-up id, or the same id
  // assigned to two unrelated terms). Every write below re-derives the product from
  // OUR OWN aggregated stats (byId) rather than the model's copy of the name, and a
  // term is never regressed to a staler product than whatever it already pointed to.
  const mapped = await mapToTerms(stats, allTerms());
  const byId = new Map(stats.map((s) => [s.id, s]));
  let choiceCount = 0;
  let basicCount = 0;
  let skipped = 0;
  for (const [rawTerm, choice] of Object.entries(mapped)) {
    const term = rawTerm.toLowerCase();
    // The model occasionally emits a null/garbled entry for a term — skip it
    // rather than crashing the whole run (observed in practice on prod data).
    if (!choice || typeof (choice as { id?: unknown }).id !== "number") {
      console.log(`  ! skipping "${term}": mapper returned no usable product id`);
      skipped++;
      continue;
    }
    const s = byId.get((choice as { id: number }).id);
    if (!s) {
      console.log(`  ! skipping "${term}": product ${choice.id} isn't in this run's aggregated stats`);
      skipped++;
      continue;
    }
    // A product should have exactly one canonical term — checked live against the DB
    // (not an in-memory set) so this also catches a second term for the same product
    // written moments ago earlier in this very run, not just ones from prior runs.
    const conflictingTerm = getExistingTermForProduct(s.id, term);
    if (conflictingTerm) {
      console.log(`  ! skipping "${term}": product ${s.id} already has the established term "${conflictingTerm}"`);
      skipped++;
      continue;
    }
    const existing = getChoiceProduct(term);
    const blocked =
      existing && existing.productId !== s.id
        ? replacementBlocked(
            { lastBought: existing.lastBought, orderCount: existing.orderCount },
            { lastBoughtIso: s.lastBought.toISOString(), orderCount: s.orderCount },
          )
        : null;
    if (blocked) {
      console.log(`  ! skipping "${term}": ${blocked}`);
      skipped++;
      continue;
    }
    // A product bought only once is a trial, not a usual — don't enshrine it as
    // the canonical choice for a term.
    if (!isChoiceWorthy(s.orderCount)) {
      console.log(`  ! skipping "${term}": product ${s.id} bought only ${s.orderCount}x (one-off, not a usual)`);
      skipped++;
      continue;
    }
    setChoice(term, { id: s.id, name: s.name }, "seed");
    choiceCount++;

    if (s.isBasicCandidate && s.cadenceDays) {
      upsertBasicStats(
        term,
        {
          productId: s.id,
          productName: s.name,
          cadenceDays: s.cadenceDays,
          lastBought: s.lastBought.toISOString(),
          orderCount: s.orderCount,
        },
        "seed",
      );
      basicCount++;
    }
  }
  console.log(
    `\nWrote ${choiceCount} buy-again choices (${basicCount} of them tracked as basics)` +
      (skipped ? `, skipped ${skipped} untrustworthy mapping(s)` : "") +
      ".",
  );
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
