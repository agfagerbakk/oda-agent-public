export type Availability = { isAvailable: boolean; code: string; description: string };

type RawAvailability = {
  is_available?: boolean;
  isAvailable?: boolean;
  code?: string;
  description?: string;
};

/** Normalize the two Oda availability shapes (cart lines + search items) into one. */
export function normalizeAvailability(raw: RawAvailability | undefined): Availability | undefined {
  if (!raw) return undefined;
  return {
    isAvailable: (raw.is_available ?? raw.isAvailable) !== false,
    code: raw.code ?? "available",
    description: raw.description ?? "",
  };
}

/** True when Oda says this line can actually arrive in the selected slot. */
export function isOrderable(a: Availability | undefined): boolean {
  if (!a) return true; // absent data must never hide products (matches mcp-oda default)
  if (!a.isAvailable) return false;
  // "available_later" arrives in a later delivery, not the near-future slot the
  // user is shopping for — treat it as not orderable.
  if (a.code === "available_later") return false;
  return true;
}
