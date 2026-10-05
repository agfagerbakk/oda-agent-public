# Brief: fork mcp-oda and add delivery-slot support

**Goal:** fork `gbbirkisson/mcp-oda` to `agfagerbakk/mcp-oda`, add delivery-slot
functionality (list slots, select a slot, list delivery addresses) as both MCP tools
and CLI subcommands, mirroring the existing cart/product/recipe features. Keep the
existing code style, session/cookie/CSRF handling, and test patterns. Bump the version,
update the README, and push to `main` on the fork.

## Existing structure to follow
- `src/oda-client.ts` — authenticated HTTP client. It already loads/saves the cookie
  session and sends `X-CSRFToken` (from the `csrftoken` cookie) on POSTs (see the cart
  add/clear methods). **Reuse that same authenticated request helper** for the slot POST.
- `src/server.ts` — registers MCP tools. Add the new tools here.
- `src/index.ts` — commander CLI. Add a `slot` parent command with subcommands.
- `src/types.ts` — shared types. Add the slot/address types.
- `tests/integration.test.ts` — add coverage mirroring existing tests.

## Oda API (already reverse-engineered — implement against these exactly)

### List slots
`GET https://oda.com/api/v1/slot-picker/slots/?num-days=<N>&from-index=<i>`
(authenticated; same cookie session as the cart). Response (trimmed):
```jsonc
{
  "deliverySlots": [
    {
      "id": 1700001,
      "routeGroup": 1,
      "routeGroupStr": "Morning",              // or "Evening"
      "openDatetime": "2026-07-17T02:00:00Z",  // UTC
      "closeDatetime": "2026-07-17T07:00:00Z",
      "cutoffTime": "2026-07-16T18:00:00Z",
      "isSelected": false,
      "isFull": false,
      "price": "kr 9",
      "isUnavailable": false,
      "unavailableDescription": null,          // reason when isUnavailable
      "isCheapest": false,
      "validationMessages": [],
      "tag": null
    }
    // ...
  ],
  "hasEarlier": false,
  "hasLater": true,
  "fromIndex": 0,
  "cartInfo": {
    "deliverySlot": null,                       // currently-selected slot id, or null
    "isUnattendedDelivery": false,
    "deliveryAddress": { "id": 1000001, "addressDisplayFull": "Exampleveien 1, 0000 Oslo", "isPrimary": true },
    "country": "NO"
  },
  "deliveryAddresses": [
    { "id": 1000001, "addressDisplayFull": "Exampleveien 1, 0000 Oslo", "isPrimary": true, "isDeliveryAvailable": true }
  ],
  "validatorMessages": ["Noen av varene ... er ikke tilgjengelige før 17. juli 2026."],
  "timeZone": "Europe/Oslo"
}
```

### Select a slot
`POST https://oda.com/api/v1/slot-picker/info/` (authenticated; **must send `X-CSRFToken`**,
same as cart POSTs). JSON body:
```json
{ "deliverySlotId": 1700001, "isUnattendedDelivery": false, "inModal": true, "deliveryAddressId": 1000001 }
```
`deliveryAddressId` defaults to the current `cartInfo.deliveryAddress.id`. Treat a 2xx as
success; surface any returned validation message.

## What to add

### oda-client.ts
- `getDeliverySlots(numDays = 4, fromIndex = 0)` → returns the parsed response above.
- `selectDeliverySlot(slotId: number, addressId?: number, unattended = false)` → POSTs the
  body; if `addressId` is omitted, first GET slots to read `cartInfo.deliveryAddress.id`.

### server.ts (MCP tools) — namespaced like the others (`mcp__oda__*`)
- `delivery_slots_list` — params `{ num_days?: number, from_index?: number }`. Returns the
  slots (id, day/time window in the Europe/Oslo zone, price, isFull, isUnavailable + reason,
  isCheapest), the delivery addresses, and the currently-selected slot.
- `delivery_slot_select` — params `{ id: number, address_id?: number, unattended?: boolean }`.
- `delivery_addresses_list` — params `{}`. Returns the addresses (from the slots response).

### index.ts (CLI) — a `slot` command, JSON output like `cart list`
- `slot list [--num-days <n>] [--from-index <i>]` → prints the slots JSON.
- `slot select <id> [--address <id>] [--unattended]`.
- `slot addresses`.
(JSON output matters — the oda-agent bot parses these like it parses `cart list`.)

## Constraints
- No new dependencies; reuse the existing fetch/cookie/CSRF plumbing.
- Match existing naming, error handling, and formatting conventions.
- Add/extend tests. Bump `package.json` version. Note the new commands in the README.
- Do NOT change existing cart/product/recipe behaviour.
- Commit and push to `main` on the fork `agfagerbakk/mcp-oda`.
