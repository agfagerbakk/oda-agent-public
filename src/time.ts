export const MS_PER_DAY = 86_400_000;
export const MS_PER_MINUTE = 60_000;

/** Whole days between two timestamps (ms). */
export function daysSince(fromMs: number, toMs = Date.now()): number {
  return (toMs - fromMs) / MS_PER_DAY;
}

/** Whole minutes between an ISO timestamp and now. */
export function minutesSinceIso(iso: string, nowMs = Date.now()): number {
  return Math.max(0, (nowMs - Date.parse(iso)) / MS_PER_MINUTE);
}
