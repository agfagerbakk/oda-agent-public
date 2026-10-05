# Vision model cost / capability experiment

Direct-API benchmark: each model gets the same 'extract every grocery item' prompt + one image. **Capability** = ingredient recall vs. the known contents of each recipe screenshot. **Cost** = provider-reported tokens × list price.

> **DeepSeek V4 (flash/pro) has no working API vision.** Its Anthropic-compatible endpoint accepts the image block but silently replaces it with `[Unsupported Image]` (input_tokens≈24, pixels discarded) — the model itself says it can't see any image. The 0% below is that, not a quality miss. Vision is web-chat-only today. (The OpenAI-compatible endpoint rejects images outright.)

## Summary (averaged over images)

| Model | Avg recall | Avg cost / image | Avg latency | Notes |
|---|---|---|---|---|
| claude-haiku-4-5 | 97% | $0.00135 | 1.5s | — |
| claude-sonnet-5 | 100% | $0.00590 | 2.6s | — |
| gpt-4o-mini | 97% | $0.00472 | 1.6s | — |
| gpt-4.1-mini | 100% | $0.00079 | 3.0s | — |
| gpt-4.1-nano | 92% | $0.00027 | 1.2s | — |
| deepseek-v4-flash | 0% | $0.00021 | 9.0s | — |
| deepseek-v4-pro | 0% | $0.00034 | 6.7s | — |

## Per call

| Model | Image | Status | ms | in tok | out tok | cost | recall | misses |
|---|---|---|---|---|---|---|---|---|
| claude-haiku-4-5 | recipe-alfredo.png | ok | 1529 | 508 | 53 | $0.00077 | 11/11 (100%) | none |
| claude-haiku-4-5 | recipe-fingerfoods.jpg | ok | 1560 | 1548 | 76 | $0.00193 | 17/18 (94%) | yoghurt |
| claude-sonnet-5 | recipe-alfredo.png | ok | 1785 | 538 | 64 | $0.00257 | 11/11 (100%) | none |
| claude-sonnet-5 | recipe-fingerfoods.jpg | ok | 3444 | 2638 | 88 | $0.00923 | 18/18 (100%) | none |
| gpt-4o-mini | recipe-alfredo.png | ok | 1211 | 14251 | 45 | $0.00216 | 11/11 (100%) | none |
| gpt-4o-mini | recipe-fingerfoods.jpg | ok | 1964 | 48253 | 54 | $0.00727 | 17/18 (94%) | oat |
| gpt-4.1-mini | recipe-alfredo.png | ok | 1613 | 606 | 41 | $0.00031 | 11/11 (100%) | none |
| gpt-4.1-mini | recipe-fingerfoods.jpg | ok | 4443 | 2923 | 58 | $0.00126 | 18/18 (100%) | none |
| gpt-4.1-nano | recipe-alfredo.png | ok | 964 | 877 | 46 | $0.00011 | 11/11 (100%) | none |
| gpt-4.1-nano | recipe-fingerfoods.jpg | ok | 1502 | 4168 | 66 | $0.00044 | 15/18 (83%) | cauliflower, yoghurt, breadcrumb |
| deepseek-v4-flash | recipe-alfredo.png | ok | 7583 | 86 | 611 | $0.00018 | 0/11 (0%) | fettuccine, chicken, salt, pepper, oil, butter, garlic, cream, parmesan, nutmeg, parsley |
| deepseek-v4-flash | recipe-fingerfoods.jpg | ok | 10502 | 86 | 815 | $0.00024 | 0/18 (0%) | broccoli, egg, cheese, flour, avocado, banana, potato, cauliflower, apple, yoghurt, cinnamon, sweet potato, chickpea, carrot, oat, olive oil, chicken, breadcrumb |
| deepseek-v4-pro | recipe-alfredo.png | ok | 4654 | 86 | 298 | $0.00030 | 0/11 (0%) | fettuccine, chicken, salt, pepper, oil, butter, garlic, cream, parmesan, nutmeg, parsley |
| deepseek-v4-pro | recipe-fingerfoods.jpg | ok | 8822 | 86 | 392 | $0.00038 | 0/18 (0%) | broccoli, egg, cheese, flour, avocado, banana, potato, cauliflower, apple, yoghurt, cinnamon, sweet potato, chickpea, carrot, oat, olive oil, chicken, breadcrumb |

## Findings

1. **DeepSeek V4 vision is not usable via API (researched + tested).** Blog posts claim it exists, but empirically: the OpenAI endpoint rejects images, and the Anthropic endpoint accepts the block then drops the pixels (`[Unsupported Image]`, 24 input tokens, model says it sees nothing). It's a chat.deepseek.com-only feature for now. So the image step **cannot** reuse our DeepSeek shopping provider — a hybrid with a real vision provider is required.
2. **`gpt-4.1-mini` wins: 100% recall on both images at ~$0.0008/image** — cheapest model that read everything, including the dense 946×2047 screenshot.
3. **"Vision is token-heavy" is true only for `gpt-4o-mini`** — it billed 48,253 input tokens for the tall image (old GPT-4o tiling) → ~6× the cost of gpt-4.1-mini for equal/worse accuracy. GPT-4.1 and Claude tokenize images ~15–30× more compactly.
4. **`gpt-4.1-nano`** is cheapest that *works* ($0.00027) but drops to 83% on the dense image — too lossy given "images can be anything."
5. **Claude Haiku 4.5** (97%, $0.00135) is the best no-OpenAI-dependency fallback; Sonnet 5 is flawless but ~7.5× gpt-4.1-mini.
6. Vision cost is negligible either way — a fraction of one text shopping turn.

## Recommendation

**`gpt-4.1-mini` for the image-understanding step**, in a hybrid: OpenAI reads the image → extracted items feed the existing DeepSeek shopping agent. Best capability at near-lowest cost, and it avoids the gpt-4o-mini token blow-up.

- **No-OpenAI fallback:** `claude-haiku-4-5` via the existing SDK (97% recall, keeps everything on Anthropic/DeepSeek).
- **Ruled out:** DeepSeek (no API vision), `gpt-4o-mini` (token-heavy), `gpt-4.1-nano` (lossy on dense images).

**Prod note:** needs the OpenAI key as a **distinct** Docker secret (e.g. `ODA_OPENAI_API_KEY`) — the existing `OPENAI_API_KEY` secret holds ved-api's different key.
