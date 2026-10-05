import Database from "better-sqlite3";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

// Single-file SQLite store on the mcp-oda data dir / persistent volume. Holds the
// shared household state: buy-again choices, the cart-activity log (who/when/what),
// and booked delivery slots (for preferred-slot highlighting). The Oda cart itself
// is NOT stored here — Oda is the source of truth for cart contents.

let _db: Database.Database | null = null;

/** Add a column if an older DB file predates it (SQLite ALTER TABLE ADD COLUMN is safe/cheap). */
function ensureColumn(d: Database.Database, table: string, column: string, ddl: string): void {
  const cols = d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

function db(): Database.Database {
  if (_db) return _db;
  mkdirSync(config.odaDataDir, { recursive: true });
  const d = new Database(join(config.odaDataDir, "oda.db"));
  d.pragma("journal_mode = WAL");
  d.exec(`
    CREATE TABLE IF NOT EXISTS choices (
      term TEXT PRIMARY KEY, product_id INTEGER, product_name TEXT,
      updated_at TEXT, updated_by TEXT
    );
    CREATE TABLE IF NOT EXISTS cart_activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT, person TEXT, ts TEXT, items TEXT
    );
    CREATE TABLE IF NOT EXISTS slot_bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT, slot_id INTEGER, route_group TEXT,
      open_dt TEXT, close_dt TEXT, price TEXT, address_id INTEGER,
      dow INTEGER, hour INTEGER, booked_at TEXT, booked_by TEXT
    );
    CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
  `);
  // "Basics" (see below) extend the same choices row rather than a parallel table —
  // a basic is just a choice with strong-enough purchase-cadence evidence.
  ensureColumn(d, "choices", "cadence_days", "REAL");
  ensureColumn(d, "choices", "last_bought", "TEXT");
  ensureColumn(d, "choices", "order_count", "INTEGER");
  ensureColumn(d, "choices", "status", "TEXT DEFAULT 'learned'");
  _db = d;
  migrateHistoryJson(d);
  return d;
}

function migrateHistoryJson(d: Database.Database): void {
  const { c } = d.prepare("SELECT COUNT(*) AS c FROM choices").get() as { c: number };
  if (c > 0) return;
  const path = join(config.odaDataDir, "history.json");
  if (!existsSync(path)) return;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      choices?: Record<string, { id?: number; name: string }>;
    };
    const now = new Date().toISOString();
    const ins = d.prepare(
      "INSERT OR REPLACE INTO choices(term,product_id,product_name,updated_at,updated_by) VALUES(?,?,?,?,?)",
    );
    const entries = Object.entries(parsed.choices ?? {});
    const tx = d.transaction(() => {
      for (const [term, ch] of entries) ins.run(term, ch.id ?? null, ch.name, now, "migrated");
    });
    tx();
    console.log(`[store] migrated ${entries.length} buy-again choices from history.json`);
  } catch (e) {
    console.error("[store] history.json migration failed:", e);
  }
}

// --- buy-again choices ------------------------------------------------------
export type Choice = { id?: number; name: string };

/**
 * Look up a single saved buy-again choice by term — fetched on demand by the
 * buy_again_lookup tool rather than dumping the whole (unboundedly growing)
 * table into the system prompt on every turn. An indexed single-row lookup
 * costs the same regardless of how many terms have accumulated.
 *
 * Falls back to a substring match (either direction) when there's no exact
 * hit, since the canonical stored term may be a variant of what's asked for
 * (e.g. asking "melk" should still find a canonical "lettmelk" entry) — the
 * old full-table-dump approach let the model browse and match this loosely;
 * an exact-only lookup would silently regress those cases.
 *
 * The fuzzy fallback is weighted by purchase evidence, not just term length:
 * an established staple (active basic, high order count, recently bought)
 * beats a one-off trial that happens to share a substring. Without this, a
 * product bought once (e.g. a single soda trial) could shadow the product
 * bought six times for the same concept.
 */
export type ChoiceLookup = {
  productId: number | null;
  productName: string;
  orderCount: number | null;
  lastBought: string | null;
  status: string | null;
};

export function getChoice(term: string): ChoiceLookup | null {
  const needle = term.trim().toLowerCase();
  const exact = db()
    .prepare(
      "SELECT product_id, product_name, order_count, last_bought, status FROM choices WHERE term = ?",
    )
    .get(needle) as
    | {
        product_id: number | null;
        product_name: string;
        order_count: number | null;
        last_bought: string | null;
        status: string | null;
      }
    | undefined;
  if (exact)
    return {
      productId: exact.product_id,
      productName: exact.product_name,
      orderCount: exact.order_count,
      lastBought: exact.last_bought,
      status: exact.status,
    };

  const fuzzy = db()
    .prepare(
      `SELECT product_id, product_name, order_count, last_bought, status FROM choices
        WHERE term LIKE '%' || ? || '%' OR ? LIKE '%' || term || '%'
        ORDER BY
          CASE status WHEN 'active' THEN 0 WHEN 'learned' THEN 1 ELSE 2 END ASC,
          order_count DESC NULLS LAST,
          last_bought DESC NULLS LAST,
          length(term) ASC
        LIMIT 1`,
    )
    .get(needle, needle) as
    | {
        product_id: number | null;
        product_name: string;
        order_count: number | null;
        last_bought: string | null;
        status: string | null;
      }
    | undefined;
  return fuzzy
    ? {
        productId: fuzzy.product_id,
        productName: fuzzy.product_name,
        orderCount: fuzzy.order_count,
        lastBought: fuzzy.last_bought,
        status: fuzzy.status,
      }
    : null;
}

/** All known term strings, for the seeder to reuse rather than invent a new spelling. */
export function allTerms(): string[] {
  return (db().prepare("SELECT term FROM choices ORDER BY term").all() as { term: string }[]).map(
    (r) => r.term,
  );
}

/** The product currently mapped to a term, if any — lets the seeder refuse to regress a term to a staler product than what it already had. */
export function getChoiceProduct(
  term: string,
): { productId: number; lastBought: string | null; orderCount: number | null } | null {
  const row = db()
    .prepare("SELECT product_id, last_bought, order_count FROM choices WHERE term = ?")
    .get(term.trim().toLowerCase()) as
    | { product_id: number | null; last_bought: string | null; order_count: number | null }
    | undefined;
  if (!row || row.product_id == null) return null;
  return { productId: row.product_id, lastBought: row.last_bought, orderCount: row.order_count };
}

/**
 * The term (other than `excludeTerm`) that already owns this product, if any — a
 * product should have exactly one canonical term, so the seeder can refuse a second,
 * competing term for the same product (whether that term already existed before this
 * run, or was just written moments ago earlier in the same run).
 */
export function getExistingTermForProduct(productId: number, excludeTerm: string): string | null {
  const row = db()
    .prepare("SELECT term FROM choices WHERE product_id = ? AND term != ? LIMIT 1")
    .get(productId, excludeTerm.trim().toLowerCase()) as { term: string } | undefined;
  return row?.term ?? null;
}

export function setChoice(term: string, choice: Choice, by = "agent"): void {
  // ON CONFLICT UPDATE (not INSERT OR REPLACE) so an ad-hoc product-mapping change
  // doesn't wipe an existing basic's cadence_days/last_bought/status columns.
  db()
    .prepare(
      `INSERT INTO choices(term,product_id,product_name,updated_at,updated_by) VALUES(?,?,?,?,?)
       ON CONFLICT(term) DO UPDATE SET
         product_id=excluded.product_id, product_name=excluded.product_name,
         updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
    )
    .run(term.trim().toLowerCase(), choice.id ?? null, choice.name.trim(), new Date().toISOString(), by);
}

// --- Basics (recurring staples detected from purchase cadence) --------------
//
// A "basic" is a choices row with enough purchase-cadence evidence to be one of your
// "usuals" — restocked whenever a new shopping session starts with an empty cart, not
// gated on individually being "due" (see restockCandidates below for why). Populated by
// scripts/seed-history.ts from real Oda order history; editable by the user via
// /basics so they can veto anything the detector got wrong. `status` lifecycle:
//   learned    -> a plain buy-again choice, no cadence evidence (the vast majority)
//   active     -> confirmed basic, eligible for auto-restock
//   phased_out -> was a basic, but not bought in a long time — auto-detected, no
//                 longer restocked, but the user can /basics restore it
//   excluded   -> the user explicitly said "stop adding this" — never touched
//                 again by the seeder's auto status logic

/**
 * A real shopping session ("start a new order, cart is empty") is itself the signal
 * to restock usual basics — a person doesn't check each item's exact interval before
 * deciding to buy more milk, they just get their usuals. So restock candidacy is NOT
 * gated on being individually "due" by cadence; it only skips an item bought within
 * this fraction of its cadence, to avoid re-adding something the very next message
 * after it was already added (e.g. cart cleared by mistake, session restarted).
 */
const COOLDOWN_FACTOR = 0.25;
/** Consider a basic phased out once it's this many multiples of its cadence overdue. */
const PHASEOUT_MULTIPLIER = 3;

export type BasicStats = {
  productId: number;
  productName: string;
  cadenceDays: number;
  lastBought: string; // ISO date
  orderCount: number;
};

/** Upsert cadence data for a term from the seeder. Preserves a user's 'excluded' override. */
export function upsertBasicStats(term: string, stats: BasicStats, by = "seed"): void {
  const key = term.trim().toLowerCase();
  const existing = db().prepare("SELECT status FROM choices WHERE term = ?").get(key) as
    | { status?: string }
    | undefined;
  const daysSinceLast = (Date.now() - Date.parse(stats.lastBought)) / 86_400_000;
  const autoStatus = daysSinceLast > stats.cadenceDays * PHASEOUT_MULTIPLIER ? "phased_out" : "active";
  const status = existing?.status === "excluded" ? "excluded" : autoStatus;
  db()
    .prepare(
      `INSERT INTO choices(term,product_id,product_name,cadence_days,last_bought,order_count,status,updated_at,updated_by)
       VALUES(?,?,?,?,?,?,?,?,?)
       ON CONFLICT(term) DO UPDATE SET
         product_id=excluded.product_id, product_name=excluded.product_name,
         cadence_days=excluded.cadence_days, last_bought=excluded.last_bought,
         order_count=excluded.order_count, status=excluded.status,
         updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
    )
    .run(
      key,
      stats.productId,
      stats.productName,
      stats.cadenceDays,
      stats.lastBought,
      stats.orderCount,
      status,
      new Date().toISOString(),
      by,
    );
}

type BasicRow = {
  term: string;
  product_id: number | null;
  product_name: string;
  cadence_days: number | null;
  last_bought: string | null;
  order_count: number | null;
  status: string;
};

function allBasicRows(): BasicRow[] {
  return db()
    .prepare(
      `SELECT term, product_id, product_name, cadence_days, last_bought, order_count, status
       FROM choices WHERE status IN ('active','excluded','phased_out') ORDER BY term`,
    )
    .all() as BasicRow[];
}

export type RestockCandidate = { term: string; productId: number; productName: string; cadenceDays: number };

/**
 * Active basics worth restocking on a fresh shopping session, most frequently-bought
 * (shortest cadence, i.e. most "essential") first. Excludes only items bought within
 * COOLDOWN_FACTOR of their cadence (a near-certain duplicate, not "not due yet") — the
 * caller still decides how many to actually act on, since a household can have dozens
 * of legitimate recurring items and that's too many to silently dump in a cart at once.
 */
export function restockCandidates(): RestockCandidate[] {
  const now = Date.now();
  return allBasicRows()
    .filter((r) => {
      if (r.status !== "active" || !r.product_id || !r.cadence_days || !r.last_bought) return false;
      const daysSince = (now - Date.parse(r.last_bought)) / 86_400_000;
      return daysSince >= r.cadence_days * COOLDOWN_FACTOR;
    })
    .map((r) => ({
      term: r.term,
      productId: r.product_id as number,
      productName: r.product_name,
      cadenceDays: r.cadence_days as number,
    }))
    .sort((a, b) => a.cadenceDays - b.cadenceDays);
}

/** User veto: stop auto-restocking this term. Returns false if it wasn't a tracked basic. */
export function excludeBasic(term: string): boolean {
  const res = db()
    .prepare(
      "UPDATE choices SET status='excluded', updated_at=?, updated_by='user' WHERE term=? AND status IN ('active','phased_out')",
    )
    .run(new Date().toISOString(), term.trim().toLowerCase());
  return res.changes > 0;
}

/** Undo an exclude, or bring a phased-out basic back into rotation. */
export function restoreBasic(term: string): boolean {
  const res = db()
    .prepare(
      "UPDATE choices SET status='active', updated_at=?, updated_by='user' WHERE term=? AND status IN ('excluded','phased_out')",
    )
    .run(new Date().toISOString(), term.trim().toLowerCase());
  return res.changes > 0;
}

/** Human-readable /basics overview for Telegram. */
export function basicsSummary(): string {
  const rows = allBasicRows();
  if (!rows.length) {
    return "No basics tracked yet — run the history seeder (scripts/seed-history.ts) to detect them from your Oda order history.";
  }
  const fmt = (r: BasicRow) => {
    const daysAgo = r.last_bought ? Math.round((Date.now() - Date.parse(r.last_bought)) / 86_400_000) : null;
    const cadence = r.cadence_days ? Math.round(r.cadence_days) : "?";
    return `- ${r.term} → ${r.product_name} (every ~${cadence}d, last bought ${daysAgo ?? "?"}d ago)`;
  };
  const groups: [string, string][] = [
    ["Active basics (auto-restocked when a fresh session starts)", "active"],
    ["Phased out (stopped restocking — /basics restore <term> to bring back)", "phased_out"],
    ["Excluded by you (/basics restore <term> to undo)", "excluded"],
  ];
  return groups
    .map(([label, status]) => [label, rows.filter((r) => r.status === status)] as const)
    .filter(([, group]) => group.length)
    .map(([label, group]) => `${label}:\n${group.map(fmt).join("\n")}`)
    .join("\n\n");
}

// --- cart activity log (who / when / what) ----------------------------------
export type Activity = { person: string; ts: string; items: string[] };

export function logActivity(person: string, items: string[]): void {
  if (!items.length) return;
  db()
    .prepare("INSERT INTO cart_activity(person,ts,items) VALUES(?,?,?)")
    .run(person, new Date().toISOString(), JSON.stringify(items));
}

export function getLastActivity(): Activity | null {
  const r = db()
    .prepare("SELECT person, ts, items FROM cart_activity ORDER BY id DESC LIMIT 1")
    .get() as { person: string; ts: string; items: string } | undefined;
  return r ? { person: r.person, ts: r.ts, items: JSON.parse(r.items) } : null;
}

// --- booked delivery slots (for preferred highlighting) ---------------------
export function recordBooking(
  slot: { id: number; routeGroupStr: string; openDatetime: string; closeDatetime: string; price: string },
  addressId: number,
  by: string,
): void {
  const open = new Date(slot.openDatetime);
  db()
    .prepare(
      `INSERT INTO slot_bookings(slot_id,route_group,open_dt,close_dt,price,address_id,dow,hour,booked_at,booked_by)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      slot.id,
      slot.routeGroupStr,
      slot.openDatetime,
      slot.closeDatetime,
      slot.price,
      addressId,
      open.getUTCDay(),
      open.getUTCHours(),
      new Date().toISOString(),
      by,
    );
}

/** Preferred (day-of-week, hour) buckets, most-booked first. */
export function preferredSlots(): { dow: number; hour: number; count: number }[] {
  return db()
    .prepare("SELECT dow, hour, COUNT(*) AS count FROM slot_bookings GROUP BY dow, hour ORDER BY count DESC")
    .all() as { dow: number; hour: number; count: number }[];
}

// --- small key/value flags --------------------------------------------------
export function getKV(key: string): string | null {
  const r = db().prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
  return r?.value ?? null;
}

export function setKV(key: string, value: string): void {
  db().prepare("INSERT OR REPLACE INTO kv(key,value) VALUES(?,?)").run(key, value);
}
