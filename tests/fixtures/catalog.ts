// Deterministic in-memory product catalog for e2e tests. Mirrors the shape of
// Oda search results and product declarations closely enough to exercise the
// agent's real behaviour (Norwegian search, dietary screening, buy-again) with
// no network and no risk to the real cart.

export type FixtureProduct = {
  id: number;
  name: string;
  subtitle: string;
  price: number;
  /** Lowercase search terms this product matches (Norwegian + English). */
  terms: string[];
  /** Ingredient declaration text, if Oda publishes one. */
  ingredients?: string;
  /** Additive tokens present (E-numbers / additive-class words). Empty = clean. */
  additives?: string[];
  lactoseFree?: boolean;
  containsMilk?: boolean;
  /** false = sold out / not deliverable in the selected slot. Defaults to available. */
  available?: boolean;
  /** Human availability note when not available, e.g. "Utilgjengelig". */
  availabilityDesc?: string;
  /**
   * true = Oda reports is_available true but code "available_later" (only
   * arrives in a later delivery, not the near-future slot). The bot must skip
   * these just like sold-out items.
   */
  availableLater?: boolean;
  /** Human note for the later delivery, e.g. "Leveres 10. okt". */
  availableLaterDesc?: string;
};

export const CATALOG: FixtureProduct[] = [
  // --- milk: a regular (contains lactose) and a lactose-free variant ----------
  {
    id: 1131,
    name: "Q Melk Lett 1%",
    subtitle: "1%, 1 l",
    price: 21.4,
    terms: ["melk", "milk", "lettmelk"],
    ingredients: "lettmelk",
    additives: [],
    lactoseFree: false,
    containsMilk: true,
  },
  {
    id: 12196,
    name: "Tine Laktosefri Lettmelk 0,5%",
    subtitle: "0,5%, 1 l",
    price: 26.9,
    terms: ["melk", "milk", "lettmelk", "laktosefri melk"],
    ingredients: "lettmelk (laktoseredusert), laktase",
    additives: [],
    lactoseFree: true,
    containsMilk: true,
  },
  // --- eggs / bananas: whole foods, no screening needed -----------------------
  {
    id: 69609,
    name: "Prior Egg Frittgående 12 stk",
    subtitle: "Str L, 12 stk",
    price: 46.9,
    terms: ["egg", "eggs", "egga"],
    ingredients: "egg",
    additives: [],
  },
  {
    id: 24854,
    name: "Bananer Ecuador",
    subtitle: "ca 1 kg",
    price: 24.9,
    terms: ["banan", "bananer", "banana", "bananas"],
  },
  // --- liver pâté: a cheap additive-laden option vs a clean organic one --------
  // products_search returns the additive one FIRST, so a correct model must
  // screen ingredients rather than just pick the first/cheapest result.
  {
    id: 5001,
    name: "Stabburet Leverpostei Original",
    subtitle: "syltet, 190 g",
    price: 24.9,
    terms: ["leverpostei", "liver pate", "liver pâté", "leverpaté"],
    ingredients:
      "svinelever, vann, svinefett, hvetemel, løk, salt, konserveringsmiddel (E250), " +
      "stabilisator (E410), emulgator (E471), krydder",
    additives: ["E250", "E410", "emulgator", "stabilisator", "konserveringsmiddel"],
  },
  {
    id: 5002,
    name: "Bjerke Økologisk Leverpostei",
    subtitle: "økologisk, 200 g",
    price: 54.9,
    terms: ["leverpostei", "liver pate", "liver pâté", "leverpaté"],
    ingredients: "økologisk svinelever, egg, løk, fløte, salt, timian, pepper",
    additives: [],
  },
  // --- pantry staples ---------------------------------------------------------
  {
    id: 6001,
    name: "Axa Havregryn Lettkokte",
    subtitle: "1 kg",
    price: 22.5,
    terms: ["havregryn", "oats", "havre"],
    ingredients: "havregryn",
    additives: [],
  },
  {
    id: 7001,
    name: "Synnøve Norvegia Gulost",
    subtitle: "26%, 500 g",
    price: 74.9,
    terms: ["gulost", "ost", "cheese", "norvegia"],
    ingredients: "pasteurisert melk, salt, syrningskultur, ostløpe",
    additives: [],
    containsMilk: true,
  },
  // --- an item that's sold out / not deliverable: the ONLY match for its term,
  // so a correct model must NOT add it and must flag it rather than pretend. ----
  {
    id: 8001,
    name: "Neutral Dusjsåpe Sensitiv",
    subtitle: "uparfymert, 250 ml",
    price: 39.9,
    terms: ["dusj", "dusjsåpe", "shower gel", "shower"],
    available: false,
    availabilityDesc: "Utilgjengelig",
  },
  // --- an item that only arrives in a LATER delivery (is_available true, code
  // "available_later"): the ONLY match for its term, so a correct model must
  // NOT add it either — the user shops for the near-future slot. --------------
  {
    id: 8002,
    name: "Freia Melkesjokolade Storplate",
    subtitle: "200 g",
    price: 49.9,
    terms: ["sjokolade", "chocolate"],
    availableLater: true,
    availableLaterDesc: "Leveres 10. okt",
  },
];

/** Case-insensitive term match used by the fake products_search. */
export function searchCatalog(query: string): FixtureProduct[] {
  const q = query.trim().toLowerCase();
  return CATALOG.filter((p) => p.terms.some((t) => q.includes(t) || t.includes(q)));
}

export function findById(id: number): FixtureProduct | undefined {
  return CATALOG.find((p) => p.id === id);
}
