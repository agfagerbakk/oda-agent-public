# Model cost / functionality experiment

**Goal:** lower the bot's running cost without losing functionality. Each model runs the full
shopping scenario suite against an in-memory **fake Oda** (no real cart touched, no network to
Oda). "Functionality" = the behaviours the bot depends on. Harness is
`scripts/experiment.ts` + `tests/fixtures/` (run with `npx tsx scripts/experiment.ts`).

Models tested: Claude below Opus (Haiku 4.5, Sonnet 5) and all DeepSeek (chat = V3, reasoner =
R1, via DeepSeek's Anthropic-compatible endpoint). Opus and above excluded per the cost goal.

## Cost methodology (important)

Cost = **token count × official list price (cache-miss)** — an apples-to-apples upper bound.
Two notes:

- The SDK's own `total_cost_usd` is **not** used: DeepSeek runs behind the Anthropic-compatible
  shim, so the SDK prices its tokens at Claude rates and overstates DeepSeek cost ~4×. Token
  counts are ground truth; dollars are derived per provider.
- Real cost is **lower** for every model thanks to automatic prompt caching (the ~80k-token
  system prompt + tool context is re-sent each tool step but largely cache-hit). Claude's
  cache-aware figure ran ~2× below the cache-miss number here; DeepSeek caches too. Ranking is
  unaffected — DeepSeek is cheaper per token on every axis.

List prices used ($/M tokens, in / out): Haiku 1.00/5.00 · Sonnet 3.00/15.00 ·
deepseek-chat 0.27/1.10 · deepseek-reasoner 0.55/2.19.

## Results

| Model | Functionality | Input tok | Output tok | Cost / 6-scenario suite | ≈ Cost / order | Avg latency |
|---|---|---|---|---|---|---|
| **deepseek-chat** | **6/6 ✅** | 434,645 | 2,170 | **$0.120** | **$0.020** | 13.9 s |
| deepseek-reasoner | 6/6 ✅ | 390,146 | 3,417 | $0.222 | $0.037 | 15.0 s |
| claude-haiku-4-5 | 5/6 | 388,933 | 1,875 | $0.398 | $0.066 | 11.6 s |
| claude-sonnet-5 *(current prod)* | 5/6 | 600,770 | 3,142 | $1.849 | $0.308 | 18.4 s |

### Functionality matrix

| Scenario | haiku-4-5 | sonnet-5 | deepseek-chat | deepseek-reasoner |
|---|---|---|---|---|
| adds staples | ✅ | ✅ | ✅ | ✅ |
| prefers lactose-free | ✅ | ✅ | ✅ | ✅ |
| avoids ultra-processed (picks clean) | ✅ | ✅ | ✅ | ✅ |
| buy-again reuse by id | ✅ | ✅ | ✅ | ✅ |
| clears cart | ✅ | ✅ | ✅ | ✅ |
| learns choice (proactive `save_choice`) | ❌ | ❌ | ✅ | ✅ |

**Only failure across the board:** both Claude models did **not** proactively call `save_choice`
after picking a new staple, so the buy-again list wouldn't self-populate. Every other core
behaviour — including the dietary screening (avoiding E250/E410/emulsifiers) and lactose-free
preference — worked on all four models.

## Findings

1. **DeepSeek-chat is cheapest *and* most functional.** ~15× cheaper per order than the current
   Sonnet 5 default and ~3× cheaper than Haiku, while passing all 6 scenarios. deepseek-reasoner
   costs ~2× chat with no functional gain here — not worth it.
2. **Cost is input-token-dominated.** A dietary-screened item (search → `product_ingredients` →
   add → verify) runs ~80–120k input tokens/turn; a learned buy-again id or a clear command runs
   ~30k. The screening + re-sent context is the cost driver, not the model.
3. **The Claude `learns-choice` miss is likely prompt-fixable** — it's prompt adherence, not a
   capability gap. Strengthening the `save_choice` instruction would probably bring Haiku to 6/6.
4. Single run per scenario; `learns-choice` is the most behaviourally variable. Latencies are
   inflated by the fake in-process tools and are only a rough guide.

## Recommendation

**Primary — switch the default model to `deepseek-chat`** if a third-party dependency is
acceptable. Biggest cost cut (~15× vs Sonnet), full functionality (6/6), comparable latency.
Set via env on the service: `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`,
`ANTHROPIC_AUTH_TOKEN=<deepseek key>`, `ANTHROPIC_MODEL=deepseek-chat`. Trade-offs: reliance on
DeepSeek's endpoint (rate limits/uptime) and data leaving Anthropic (fine for a personal grocery
bot — no customer data).

**Conservative alternative — switch to `claude-haiku-4-5`** and add one line to the system
prompt to force `save_choice`. Stays entirely on existing Anthropic infra/billing, no new
dependency, still ~2.5–4.6× cheaper than the Sonnet default. Reach 6/6 once the prompt is fixed.

**Avoid:** deepseek-reasoner (2× the cost of chat, no benefit) and staying on Sonnet 5 (most
expensive by far for no functional edge over Haiku).
