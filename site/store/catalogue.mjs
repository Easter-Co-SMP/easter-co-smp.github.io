// Fictional merchandising fixtures for the explicitly labelled mock store.
export const GAMES = [
  {
    id: "easter-smp",
    name: "Easter Co. SMP",
    genre: "Minecraft · Naval survival",
    status: "available",
    mark: "EC",
    description: "Ships, homes and adventures on the Isles.",
  },
  {
    id: "orbital-racing",
    name: "Orbital Racing",
    genre: "Arcade racing · Placeholder",
    status: "coming-soon",
    mark: "OR",
    description:
      "A fictional racing game to demonstrate future launcher support.",
    previews: ["Vehicle liveries", "Garage themes", "Driver cosmetics"],
  },
  {
    id: "frontier",
    name: "Frontier",
    genre: "Co-op exploration · Placeholder",
    status: "coming-soon",
    mark: "FR",
    description:
      "A fictional exploration game to demonstrate future launcher support.",
    previews: [
      "Explorer outfits",
      "Outpost decorations",
      "Expedition upgrades",
    ],
  },
];
export const CATEGORIES = [
  ["all", "Discover"],
  ["items", "Items"],
  ["ships", "Ships"],
  ["houses", "Player houses"],
  ["upgrades", "Account upgrades"],
  ["currency", "In-game money"],
];
export const CATALOGUE = [
  {
    id: "voyager-kit",
    category: "items",
    name: "Voyager’s provisions",
    tag: "Ready for the horizon",
    price: 450,
    kind: "supplies",
    description:
      "A little preparation for a long voyage. A one-time bundle of supplies for your next adventure.",
    includes: [
      "32 bread, 16 cooked fish and 16 torches",
      "One compass and one empty map",
    ],
    terms:
      "Consumed items are not replenished. Delivered to your in-game collection point.",
    repeatable: true,
    stock: null,
  },
  {
    id: "captains-colours",
    category: "items",
    name: "Captain’s colours",
    tag: "Make your mark",
    price: 650,
    kind: "flag",
    description:
      "A navy-and-gold decorative banner set for your base or ship. Your colours, wherever you make port.",
    includes: [
      "Four matching decorative banners",
      "A matching decorative shield design",
    ],
    terms: "Cosmetic decoration only. No combat bonuses.",
    repeatable: false,
    stock: null,
  },
  {
    id: "coastal-sloop",
    category: "ships",
    name: "The Coastal Sloop",
    tag: "Your first command",
    price: 1900,
    kind: "sloop",
    description:
      "A compact, single-mast vessel for coastal voyages. A modest deck, a sheltered cabin, and room for a small crew.",
    includes: [
      "One prebuilt sailing vessel",
      "A private collection berth",
      "One-time delivery to the selected game account",
    ],
    terms:
      "One vessel per purchase. No crew, cargo or loss protection included. Subject to the server’s normal damage and ownership rules.",
    repeatable: false,
    stock: 8,
  },
  {
    id: "merchant-brig",
    category: "ships",
    name: "The Merchant Brig",
    tag: "A bigger horizon",
    price: 3900,
    kind: "ship",
    description:
      "A two-masted merchant vessel with a broad working deck, cargo hold and captain’s quarters.",
    includes: [
      "One prebuilt two-masted vessel",
      "Cargo hold and captain’s cabin",
      "One-time berth collection",
    ],
    terms:
      "One vessel per purchase. Crew and trade goods are not included. Normal server rules still apply.",
    repeatable: false,
    stock: 3,
  },
  {
    id: "harbour-cottage",
    category: "houses",
    name: "Harbour Cottage",
    tag: "Somewhere to return",
    price: 2900,
    kind: "house",
    description:
      "A warm timber-and-stone home overlooking the quay. A place to gather, store your finds and plan what comes next.",
    includes: [
      "One furnished player house",
      "Interior storage and crafting area",
      "Ownership assigned to your game account",
    ],
    terms:
      "A single in-game property, not real estate. No land expansion or immunity from server rules. Placement is assigned at fulfilment.",
    repeatable: false,
    stock: 5,
  },
  {
    id: "clifftop-house",
    category: "houses",
    name: "Clifftop Residence",
    tag: "The sea at your door",
    price: 4900,
    kind: "house",
    description:
      "A larger stone residence with a sea-facing terrace, workshop and space to make your own.",
    includes: [
      "One furnished residence",
      "Workshop and terrace",
      "Ownership assigned to your game account",
    ],
    terms:
      "A single in-game property. Location and availability must be confirmed before payment. Normal server rules apply.",
    repeatable: false,
    stock: 0,
  },
  {
    id: "priority-30",
    category: "upgrades",
    name: "Priority boarding",
    tag: "More time on the Isles",
    price: 700,
    kind: "upgrade",
    description:
      "Thirty days of priority queue access for one game account. Spend less time waiting when the server is full.",
    includes: [
      "30 days of priority queue access",
      "Applies to one game account",
      "One-time purchase; no automatic renewal",
    ],
    terms:
      "Priority does not guarantee immediate entry or bypass maintenance. Starts when fulfilled. No gameplay stat bonuses.",
    repeatable: false,
    stock: null,
  },
  {
    id: "crowns-1000",
    category: "currency",
    name: "1,000 Crowns",
    tag: "For life on the Isles",
    price: 500,
    kind: "coins",
    description:
      "In-game money for trading and spending inside Easter Co. SMP.",
    includes: [
      "1,000 Crowns credited in-game",
      "Spend with supported in-game merchants and players",
    ],
    terms:
      "Spendable in-game only. Cannot pay for anything in this store, be cashed out or redeemed for real currency.",
    repeatable: true,
    stock: null,
  },
  {
    id: "crowns-2500",
    category: "currency",
    name: "2,500 Crowns",
    tag: "Stock up for your next voyage",
    price: 1100,
    kind: "coins",
    description:
      "A larger pack of in-game money for your next building project, trade or expedition.",
    includes: [
      "2,500 Crowns credited in-game",
      "Spend with supported in-game merchants and players",
    ],
    terms:
      "Spendable in-game only. Cannot pay for store products, be cashed out or redeemed for real currency.",
    repeatable: true,
    stock: null,
  },
].map((p) => ({ ...p, gameId: "easter-smp", currency: "USD" }));
export function money(minor, currency = "USD") {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
  }).format(minor / 100);
}
