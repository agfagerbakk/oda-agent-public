# oda-agent

A Telegram bot that fills your [Oda.com](https://oda.com) grocery cart from natural-language
messages. You text it ("taco night for 4 + milk and bananas"); it searches Oda, adds the
products, and replies with a cart summary. You open the Oda app and buy. It never purchases.

Built on the [OpenAI SDK](https://platform.openai.com/docs) driving
the [`gbbirkisson/mcp-oda`](https://github.com/gbbirkisson/mcp-oda) MCP server (pinned)
— MCP tools are bridged into OpenAI function calls by a small in-repo tool loop.

## How it works

```
Telegram (phone) --long-polling--> grammy bot --> OpenAI tool loop (chat completions + functions)
                                                        |  mcp__oda__* tools
                                                        v
                                           mcp-oda --HTTP--> Oda /api/v1/cart/
```

The Oda cart is server-side state (mcp-oda persists a cookie session), so each message acts on
the live cart. Per-chat session resume gives conversational follow-ups ("two more of those").

## Configuration

Values come from Docker Swarm secrets (`/run/secrets/<NAME>`) in production, or a local `.env`
for development. See `.env.example`.

| Name | Purpose |
|------|---------|
| `OPENAI_API_KEY` | OpenAI key for all LLM calls (loop, vision, seeder) |
| `TELEGRAM_BOT_TOKEN` | from `@BotFather` |
| `ODA_USER`, `ODA_PASS` | Oda login (used to (re)authenticate the cookie session) |
| `ALLOWED_TELEGRAM_USER_ID` | only this Telegram user may drive the bot |
| `ODA_AGENT_MODEL` (opt) | default `gpt-4.1-mini` |
| `MCP_ODA_DATA_DIR` (opt) | cookie-session dir; `/data/.mcp-oda` in the image |

## Local development

Prerequisites: Node 20 (see `.nvmrc`), an Oda account, a Telegram bot token from
`@BotFather`, and your Telegram user id from `@userinfobot`.

```bash
npm install                 # also builds the pinned mcp-oda
cp .env.example .env         # fill in the values
npm run agent:once -- "add milk and 6 eggs"   # one shot, no Telegram
npm run dev                  # run the Telegram bot (long-polling)
```

Or self-host with Docker (no Swarm needed):

```bash
cp .env.example .env         # fill in the values
docker compose up --build    # persists session in the oda-session volume
```

Telegram commands: `/start`, `/cart`, `/lists`, `/basics`, `/delivery`, `/clear`, `/pref term = product`.

### Delivery times

`/delivery` lists upcoming slots as tappable buttons (day, window, price), highlighting your
usual day/time with ⭐, and books the one you tap (booking is deterministic — the LLM never
books). After a cart change with no slot set, the bot gently offers `/delivery` (throttled).
Slot data comes from the forked MCP server [`agfagerbakk/mcp-oda`](https://github.com/agfagerbakk/mcp-oda)
(`slot list/select`); booked slots are recorded in SQLite to learn your preferred times.

### Saved lists

`/lists` shows your saved Oda lists ("Lister") — reusable named groups of products, separate
from the cart. Ask conversationally to manage them: "save the cart as my weekly list", "what's
on my Essentials list", "add milk to my Yurr list", "add list Essentials to cart". Backed by the
fork's `list list/get/create/rename/delete/add/remove/add-to-cart` commands.

Dictate your own recipe (e.g. "save this taco recipe: [ingredients], steps: brown the beef...")
and the bot saves it as a self-authored recipe on Oda's own site (Recipes → Your Dinners) — same
list mechanics, plus free-text cooking instructions. Distinct from browsing Oda's curated recipe
catalog (`recipes_search`), which is unaffected.

### Basics auto-restock

Starting a new shopping session (the cart is empty) autonomously restocks your "usual basics",
before your message is even processed — deterministic, not an LLM decision, same as
delivery-slot booking. A basic is a product bought often enough and regularly enough (cadence in
days) to be one of your usuals; restocking isn't gated on each item individually being "due" by
that cadence (starting a real shop already is that signal — a person doesn't check milk's exact
interval before buying more), it only skips something bought suspiciously recently (a near-certain
duplicate). Up to 12 of the most frequently-bought ones are added per trigger so a long list
doesn't dump dozens of items in one go. `/basics`
shows the full list (active / phased out / excluded by you) with cadence and last-bought info;
`/basics remove <term>` stops one from being auto-restocked, `/basics restore <term>` undoes
that (or brings a phased-out one back). The list is "living": re-running the history seeder
(below) refreshes cadence from real orders, auto-detects brand switches (prefers whichever
product you bought most *recently* for a term over the historically higher-count one) and
phases out anything you've stopped buying — while always preserving your manual excludes.

### Household coordination

The Oda cart is shared (one account), so both allow-listed users edit the same cart. Turns are
serialized on the cart (in-process lock) so simultaneous requests don't interfere, and each
cart change is logged with who/when/what — when the *other* person last touched it (or after a
gap), the bot leads with e.g. "🛒 Anna added milk, eggs & 3 more ~2h ago."

### Images (photos / screenshots)

Send the bot a photo — a recipe screenshot, a handwritten list, a picture of groceries. A
vision model (`gpt-4.1-mini` by default, chosen in `VISION-REPORT.md`) reads the image and
extracts the grocery-relevant items, which then flow into the normal shopping path (Oda search
+ additive/lactose screening). Captions are honoured (e.g. send a recipe photo with "for 4,
skip the milk"). Vision is optional — if no OpenAI key is configured, photos get a friendly
"not configured" reply and text still works. See `src/vision.ts`.

## Preferences

`preferences.json` maps a generic term to the exact Oda product you usually want; the agent
prefers these. Edit the file or use `/pref melk = Q Lettmelk 1,5% 1L` from Telegram.

Learned buy-again choices (and basics, see above) live in SQLite (`oda.db` in the mcp-oda data
dir / prod volume) and grow as you order and as `save_choice`/`/pref` are used. To (re-)seed
from real purchase history, `scripts/seed-history.ts` pulls the last ~2 years of Oda orders
(rolling window, paginating the real order API), computes each product's purchase cadence, and
asks OpenAI (`gpt-4.1-mini` by default) to map products to generic terms — weighting
purchase *frequency* first (a one-off trial never outranks an established staple;
recency only breaks ties or wins when the old staple is long unbought, i.e. a
brand switch). Terms
whose chosen product is bought often and regularly enough become tracked basics; run it
periodically (it's idempotent and preserves your `/basics remove` excludes) to keep cadence and
phase-out detection current. `npx tsx scripts/seed-history.ts` for a dry run (prints the
per-product cadence classification, writes nothing); `SEED_WRITE=1` to write. Reads the
authenticated Oda session from the mcp-oda cookie store.

## Deployment (Docker Swarm on the manager node)

CI (`.github/workflows/build-push.yml`) builds and pushes `ghcr.io/agfagerbakk/oda-agent` on
every branch and, on `main`, updates the swarm service via the self-hosted `swarm-manager`
runner.

First-time setup on the node:

```bash
# 1) create the secrets (once)
printf '%s' 'sk-...'          | docker secret create OPENAI_API_KEY -
printf '%s' '123456:ABC-...'  | docker secret create TELEGRAM_BOT_TOKEN -
printf '%s' 'you@example.com' | docker secret create ODA_USER -
printf '%s' 'oda-password'    | docker secret create ODA_PASS -
printf '%s' '123456789'       | docker secret create ALLOWED_TELEGRAM_USER_ID -

# 2) deploy the stack (compose file lives in ~/projects/services)
docker stack deploy -c oda-agent.yml oda-agent

# logs
docker service logs -f oda-agent_oda-agent
```

It's a worker (no ports, no Traefik route). The `oda-session` volume persists the Oda cookie
session across redeploys; `ODA_USER`/`ODA_PASS` re-authenticate automatically if it expires.

## End-to-end tests (model / provider swap safety)

`tests/e2e/` runs the **real OpenAI tool-loop with a real model** against an in-memory
**fake Oda** (`tests/fixtures/`) that mirrors the real tool names. This exercises the bot's
actual behaviour — Norwegian search, dietary screening, lactose-free preference, buy-again
reuse, cart clearing, learning — with no network and **without touching your real cart**. Use
it to confirm a different model still works before switching prod to it.

```bash
npm run test:e2e                       # default model (gpt-4.1-mini)
E2E_MODELS="gpt-4.1-mini,gpt-4.1" npm run test:e2e
E2E_MATRIX_FILE=tests/model-matrix.example.json npm run test:e2e
```

The matrix supports swapping **model** per case via env (see `tests/model-matrix.example.json`).

⚠️ **Run these in a clean Linux environment (CI, a plain shell, or the container).**

### Cost experiment

`scripts/experiment.ts` runs the scenario suite across several models, capturing pass/fail,
latency, token usage and cost, and writes `EXPERIMENT-REPORT.md`. Run it with
`npx tsx scripts/experiment.ts` (needs `OPENAI_API_KEY`; uses the in-memory fake Oda,
so it never touches your real cart).
