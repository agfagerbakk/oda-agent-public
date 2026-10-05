import { runOda } from "./oda-spawn.js";

// Thin wrapper over the forked mcp-oda `slot` CLI (agfagerbakk/mcp-oda). Used by
// the deterministic delivery UX (list + button-book), so the LLM never books.

export type Slot = {
  id: number;
  group: string; // "Morning" | "Evening" | "Same day" | ...
  open: string; // ISO UTC
  close: string;
  cutoff: string;
  price: string; // "kr 9"
  isFull: boolean;
  isUnavailable: boolean;
  unavailableReason: string | null;
  isCheapest: boolean;
};
export type Address = { id: number; label: string; isPrimary: boolean };
/** The slot currently booked on the account — possibly picked in the Oda app, outside this bot. */
export type SelectedSlot = { id: number; label: string; open: string | null };
export type SlotsResult = {
  slots: Slot[];
  addresses: Address[];
  selectedSlotId: number | null;
  selectedSlot: SelectedSlot | null;
  currentAddressId: number | null;
  blockers: string[];
};

type RawSlot = {
  id: number;
  route_group_str: string;
  open_datetime: string;
  close_datetime: string;
  cutoff_time: string;
  price: string;
  is_full?: boolean;
  is_unavailable?: boolean;
  unavailable_description?: string | null;
  is_cheapest?: boolean;
};

type RawAddress = {
  id: number;
  address_display_full?: string;
  address_display?: string;
  is_primary?: boolean;
};

type RawSlotsEnvelope = {
  delivery_slots?: RawSlot[];
  delivery_addresses?: RawAddress[];
  cart_info?: {
    delivery_slot?: number | { id?: number; name_short?: string } | null;
    delivery_address?: { id?: number } | null;
  } | null;
  validator_messages?: string[];
};

function parseSlot(s: RawSlot): Slot {
  return {
    id: s.id,
    group: s.route_group_str,
    open: s.open_datetime,
    close: s.close_datetime,
    cutoff: s.cutoff_time,
    price: s.price,
    isFull: !!s.is_full,
    isUnavailable: !!s.is_unavailable,
    unavailableReason: s.unavailable_description ?? null,
    isCheapest: !!s.is_cheapest,
  };
}

function parseAddress(a: RawAddress): Address {
  return {
    id: a.id,
    label: a.address_display_full ?? a.address_display ?? `address ${a.id}`,
    isPrimary: !!a.is_primary,
  };
}

/**
 * cart_info.delivery_slot is an OBJECT ({id, name_short, …}) when a slot is
 * booked (via this bot OR picked directly in the Oda app), else null. Older
 * code stored the whole object as the "id"; pull the real id.
 */
export function resolveSelectedSlotId(rawSel: unknown): number | null {
  if (rawSel == null) return null;
  if (typeof rawSel === "object") return (rawSel as { id?: number }).id ?? null;
  return Number(rawSel) || null;
}

/** Cross-reference the listed slots to recover the concrete delivery date. */
export function buildSelectedSlot(
  selectedSlotId: number | null,
  rawNameShort: string | undefined,
  slots: Slot[],
): SelectedSlot | null {
  if (selectedSlotId == null) return null;
  const matched = slots.find((s) => s.id === selectedSlotId) ?? null;
  return {
    id: selectedSlotId,
    label: rawNameShort || (matched ? formatSlot(matched) : `slot ${selectedSlotId}`),
    open: matched?.open ?? null,
  };
}

export async function listSlots(numDays = 4): Promise<SlotsResult> {
  const j = JSON.parse(await runOda(["slot", "list", "--num-days", String(numDays)])) as RawSlotsEnvelope;
  const slots: Slot[] = (j.delivery_slots ?? []).map(parseSlot);
  const addresses: Address[] = (j.delivery_addresses ?? []).map(parseAddress);
  const rawSel = j.cart_info?.delivery_slot;
  const selectedSlotId = resolveSelectedSlotId(rawSel);
  const rawNameShort = typeof rawSel === "object" && rawSel !== null ? rawSel.name_short : undefined;
  const selectedSlot = buildSelectedSlot(selectedSlotId, rawNameShort, slots);
  return {
    slots,
    addresses,
    selectedSlotId,
    selectedSlot,
    currentAddressId:
      j.cart_info?.delivery_address?.id ?? addresses.find((a) => a.isPrimary)?.id ?? null,
    blockers: j.validator_messages ?? [],
  };
}

/** Select (book) a delivery slot via the fork's CLI. State-changing. */
export async function selectSlot(id: number, addressId?: number, unattended = false): Promise<void> {
  const args = ["slot", "select", String(id)];
  if (addressId) args.push("--address", String(addressId));
  if (unattended) args.push("--unattended");
  await runOda(args);
}

/** Slots the user can actually book right now. */
export function orderable(slots: Slot[]): Slot[] {
  return slots.filter((s) => !s.isUnavailable && !s.isFull);
}

const OSLO = "Europe/Oslo";
const priceNok = (p: string): number => Number(p.replace(/[^\d]/g, "")) || 0;

/** "tor. 17. jul, 17:00–20:00 · kr 9" (Oslo time). */
export function formatSlot(s: Slot): string {
  const open = new Date(s.open);
  const close = new Date(s.close);
  const day = new Intl.DateTimeFormat("nb-NO", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: OSLO,
  }).format(open);
  const hm = (d: Date) =>
    new Intl.DateTimeFormat("nb-NO", { hour: "2-digit", minute: "2-digit", timeZone: OSLO }).format(d);
  return `${day}, ${hm(open)}–${hm(close)} · ${s.price}`;
}

/** Booked-slot description for the agent's system context, with an absolute date when known. */
export function describeSelectedSlot(sel: SelectedSlot): string {
  if (!sel.open) return sel.label;
  const abs = new Intl.DateTimeFormat("nb-NO", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: OSLO,
  }).format(new Date(sel.open));
  return `${sel.label} (${abs})`;
}

export { priceNok };

export type PrefRow = { dow: number; hour: number; count: number };

/** True when the slot starts at one of the household's usual (dow, hour) buckets (UTC). */
export function isPreferred(s: Slot, prefs: PrefRow[]): boolean {
  const d = new Date(s.open);
  return prefs.some((p) => p.dow === d.getUTCDay() && p.hour === d.getUTCHours());
}

/** Up to 6 buttons: preferred first, then cheapest, then earliest; shown time-ordered. */
export function pickSlots(all: Slot[], prefs: PrefRow[]): Slot[] {
  const ok = orderable(all).sort((a, b) => Date.parse(a.open) - Date.parse(b.open));
  const chosen: Slot[] = [];
  const add = (s: Slot) => {
    if (chosen.length < 6 && !chosen.some((x) => x.id === s.id)) chosen.push(s);
  };
  ok.filter((s) => isPreferred(s, prefs)).forEach(add); // ⭐ usual times
  [...ok].sort((a, b) => priceNok(a.price) - priceNok(b.price)).slice(0, 2).forEach(add); // cheapest
  ok.forEach(add); // fill with earliest
  return chosen.sort((a, b) => Date.parse(a.open) - Date.parse(b.open));
}
