// Pure weighting rules for buy-again ("standard purchase") choices, shared by
// the history seeder and covered by unit tests (no DB, no network).
//
// The bug these fix: a product bought ONCE (e.g. a single soda trial) could
// outrank the product bought SIX times for the same concept — because the old
// mapper prompt told the LLM to "prefer the most recently bought", and nothing
// enforced a minimum repeat-purchase bar for becoming someone's "usual".

/** Minimum orders in the lookback window for a product to become a buy-again choice. */
export const MIN_ORDERS_FOR_CHOICE = 2;

/** A product bought fewer times than this is a trial, not a usual. */
export function isChoiceWorthy(orderCount: number): boolean {
  return orderCount >= MIN_ORDERS_FOR_CHOICE;
}

export type ExistingMapping = {
  lastBought: string | null;
  orderCount: number | null;
};

export type CandidateMapping = {
  lastBoughtIso: string;
  orderCount: number;
};

/**
 * Decide whether the seeder may replace a term's existing product mapping with
 * a new candidate. Returns null when replacement is allowed, otherwise a
 * human-readable reason (logged + counted as skipped).
 *
 * Rules (in order):
 * 1. Never regress to a staler product (existing recency wins).
 * 2. Never let a one-off trial (<=2 orders) dethrone an established staple
 *    (3+ orders) that was still bought recently (<180d ago). An old,
 *    long-unbought staple MAY be replaced — that's a genuine brand switch.
 */
export function replacementBlocked(
  existing: ExistingMapping | null,
  candidate: CandidateMapping,
  nowMs = Date.now(),
): string | null {
  if (!existing) return null;
  if (existing.lastBought && candidate.lastBoughtIso < existing.lastBought) {
    return "would replace a more recently bought product with a staler one";
  }
  const existingCount = existing.orderCount ?? 0;
  if (existingCount >= 3 && candidate.orderCount <= 2) {
    const staleDays =
      existing.lastBought != null
        ? (nowMs - Date.parse(existing.lastBought)) / 86_400_000
        : Number.POSITIVE_INFINITY;
    if (staleDays < 180) {
      return (
        `would replace an established staple (${existingCount}x) ` +
        `with a one-off (${candidate.orderCount}x)`
      );
    }
  }
  return null;
}
