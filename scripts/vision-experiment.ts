// Vision model cost / capability experiment. Direct API calls to each provider
// (Anthropic, OpenAI, DeepSeek) — no Claude SDK, so it runs locally. For each
// model × test image it captures token usage, cost, latency, and an ingredient
// recall score (did the model actually understand the recipe image), then writes
// VISION-REPORT.md.
//
// Run:  npx tsx scripts/vision-experiment.ts
// Needs ANTHROPIC_API_KEY, OPENAI_API_KEY, DEEPSEEK_API_KEY in .env, and images
// in tests/images/ (see GROUND_TRUTH).
import "dotenv/config";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, extname } from "node:path";

const IMG_DIR = "tests/images";
const REPORT = "VISION-REPORT.md";

const EXTRACT_PROMPT =
  "You are helping build a grocery shopping list. Look at this image and list every " +
  "distinct food ingredient or grocery item you can identify, one per line, using simple " +
  "generic names (e.g. 'cheese', not '1/4 cup shredded cheese'). If it is a recipe or set " +
  "of recipes, include the ingredients from all of them. Output only the list, no commentary.";

// Ground-truth ingredient keywords per image (lowercase). Recall = fraction found
// in the model's output. Keep to robust root words to avoid phrasing mismatches.
const GROUND_TRUTH: Record<string, string[]> = {
  "recipe-fingerfoods.jpg": [
    "broccoli", "egg", "cheese", "flour", "avocado", "banana", "potato", "cauliflower",
    "apple", "yoghurt", "cinnamon", "sweet potato", "chickpea", "carrot", "oat", "olive oil",
    "chicken", "breadcrumb",
  ],
  "recipe-alfredo.png": [
    "fettuccine", "chicken", "salt", "pepper", "oil", "butter", "garlic", "cream",
    "parmesan", "nutmeg", "parsley",
  ],
};

type Provider = "anthropic" | "openai" | "deepseek";
type ModelCase = { name: string; provider: Provider; model: string; price: { in: number; out: number }; priceNote?: string };

const MODELS: ModelCase[] = [
  { name: "claude-haiku-4-5", provider: "anthropic", model: "claude-haiku-4-5-20251001", price: { in: 1.0, out: 5.0 } },
  { name: "claude-sonnet-5", provider: "anthropic", model: "claude-sonnet-5", price: { in: 3.0, out: 15.0 } },
  { name: "gpt-4o-mini", provider: "openai", model: "gpt-4o-mini", price: { in: 0.15, out: 0.6 } },
  { name: "gpt-4.1-mini", provider: "openai", model: "gpt-4.1-mini", price: { in: 0.4, out: 1.6 } },
  { name: "gpt-4.1-nano", provider: "openai", model: "gpt-4.1-nano", price: { in: 0.1, out: 0.4 } },
  // DeepSeek V4 vision via the Anthropic-compatible endpoint (see callDeepSeekAnthropic).
  { name: "deepseek-v4-flash", provider: "deepseek", model: "deepseek-v4-flash", price: { in: 0.14, out: 0.28 } },
  { name: "deepseek-v4-pro", provider: "deepseek", model: "deepseek-v4-pro", price: { in: 0.435, out: 0.87 } },
];

function mimeOf(file: string): string {
  const e = extname(file).toLowerCase();
  return e === ".png" ? "image/png" : e === ".webp" ? "image/webp" : "image/jpeg";
}

type CallResult = { text: string; inTok: number; outTok: number };

async function callAnthropic(m: ModelCase, b64: string, mime: string): Promise<CallResult> {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: m.model,
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: EXTRACT_PROMPT },
            { type: "image", source: { type: "base64", media_type: mime, data: b64 } },
          ],
        },
      ],
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
  return {
    text: (j.content ?? []).map((c: { text?: string }) => c.text ?? "").join(""),
    inTok: j.usage?.input_tokens ?? 0,
    outTok: j.usage?.output_tokens ?? 0,
  };
}

async function callOpenAICompatible(
  url: string,
  key: string,
  m: ModelCase,
  b64: string,
  mime: string,
): Promise<CallResult> {
  const r = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: m.model,
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: EXTRACT_PROMPT },
            { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } },
          ],
        },
      ],
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
  return {
    text: j.choices?.[0]?.message?.content ?? "",
    inTok: j.usage?.prompt_tokens ?? 0,
    outTok: j.usage?.completion_tokens ?? 0,
  };
}

// DeepSeek V4 vision works ONLY via its Anthropic-compatible endpoint with
// Anthropic-style image blocks (the OpenAI image_url format is rejected).
async function callDeepSeekAnthropic(m: ModelCase, b64: string, mime: string): Promise<CallResult> {
  const r = await fetch("https://api.deepseek.com/anthropic/v1/messages", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: m.model,
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: EXTRACT_PROMPT },
            { type: "image", source: { type: "base64", media_type: mime, data: b64 } },
          ],
        },
      ],
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
  return {
    // V4 emits "thinking" + "text" blocks; keep only the text answer.
    text: (j.content ?? []).filter((c: { type: string }) => c.type === "text").map((c: { text?: string }) => c.text ?? "").join(""),
    inTok: j.usage?.input_tokens ?? 0,
    outTok: j.usage?.output_tokens ?? 0,
  };
}

function call(m: ModelCase, b64: string, mime: string): Promise<CallResult> {
  if (m.provider === "anthropic") return callAnthropic(m, b64, mime);
  if (m.provider === "openai")
    return callOpenAICompatible("https://api.openai.com/v1/chat/completions", process.env.OPENAI_API_KEY!, m, b64, mime);
  return callDeepSeekAnthropic(m, b64, mime);
}

function recall(output: string, keywords: string[]): { hits: string[]; misses: string[] } {
  const hay = output.toLowerCase();
  const hits: string[] = [];
  const misses: string[] = [];
  for (const k of keywords) (hay.includes(k) ? hits : misses).push(k);
  return { hits, misses };
}

type Rec = {
  model: string; image: string; status: "ok" | "error"; ms: number;
  inTok: number; outTok: number; cost: number; recallPct: number; misses: string[]; detail: string;
};

async function main() {
  const images = readdirSync(IMG_DIR).filter((f) => GROUND_TRUTH[f]);
  if (!images.length) throw new Error(`No known test images in ${IMG_DIR}`);
  const recs: Rec[] = [];

  for (const m of MODELS) {
    for (const img of images) {
      const mime = mimeOf(img);
      const b64 = readFileSync(join(IMG_DIR, img)).toString("base64");
      const t0 = Date.now();
      try {
        const res = await call(m, b64, mime);
        const gt = GROUND_TRUTH[img];
        const { hits, misses } = recall(res.text, gt);
        const cost = (res.inTok * m.price.in + res.outTok * m.price.out) / 1_000_000;
        recs.push({
          model: m.name, image: img, status: "ok", ms: Date.now() - t0,
          inTok: res.inTok, outTok: res.outTok, cost, recallPct: (hits.length / gt.length) * 100,
          misses, detail: `${hits.length}/${gt.length}`,
        });
        console.log(`[${m.name}/${img}] ok ${Date.now() - t0}ms in=${res.inTok} out=${res.outTok} recall=${hits.length}/${gt.length}`);
      } catch (e) {
        recs.push({
          model: m.name, image: img, status: "error", ms: Date.now() - t0,
          inTok: 0, outTok: 0, cost: 0, recallPct: 0, misses: GROUND_TRUTH[img], detail: (e as Error).message.slice(0, 160),
        });
        console.log(`[${m.name}/${img}] ERROR ${(e as Error).message.slice(0, 120)}`);
      }
    }
    writeReport(recs);
  }
  console.log(`\nDone. See ${REPORT}`);
}

function writeReport(recs: Rec[]) {
  const models = [...new Set(recs.map((r) => r.model))];
  const L: string[] = [];
  L.push("# Vision model cost / capability experiment\n");
  L.push(
    "Direct-API benchmark: each model gets the same 'extract every grocery item' prompt + one " +
      "image. **Capability** = ingredient recall vs. the known contents of each recipe screenshot. " +
      "**Cost** = provider-reported tokens × list price.\n\n" +
      "> **DeepSeek V4 (flash/pro) has no working API vision.** Its Anthropic-compatible endpoint " +
      "accepts the image block but silently replaces it with `[Unsupported Image]` (input_tokens≈24, " +
      "pixels discarded) — the model itself says it can't see any image. The 0% below is that, not " +
      "a quality miss. Vision is web-chat-only today.\n",
  );
  L.push("## Summary (averaged over images)\n");
  L.push("| Model | Avg recall | Avg cost / image | Avg latency | Notes |");
  L.push("|---|---|---|---|---|");
  for (const m of models) {
    const mr = recs.filter((r) => r.model === m);
    const ok = mr.filter((r) => r.status === "ok");
    const recAvg = ok.length ? ok.reduce((a, r) => a + r.recallPct, 0) / ok.length : 0;
    const costAvg = ok.length ? ok.reduce((a, r) => a + r.cost, 0) / ok.length : 0;
    const msAvg = mr.reduce((a, r) => a + r.ms, 0) / (mr.length || 1);
    const errs = mr.filter((r) => r.status === "error").length;
    const pn = MODELS.find((x) => x.name === m)?.priceNote;
    L.push(
      `| ${m} | ${recAvg.toFixed(0)}% | $${costAvg.toFixed(5)} | ${(msAvg / 1000).toFixed(1)}s | ${
        errs ? `${errs} error (likely no vision)` : pn ?? "—"
      } |`,
    );
  }
  L.push("\n## Per call\n");
  L.push("| Model | Image | Status | ms | in tok | out tok | cost | recall | misses |");
  L.push("|---|---|---|---|---|---|---|---|---|");
  for (const r of recs) {
    L.push(
      `| ${r.model} | ${r.image} | ${r.status} | ${r.ms} | ${r.inTok} | ${r.outTok} | $${r.cost.toFixed(5)} | ${
        r.status === "ok" ? r.detail + ` (${r.recallPct.toFixed(0)}%)` : "—"
      } | ${r.status === "ok" ? r.misses.join(", ") || "none" : r.detail} |`,
    );
  }
  writeFileSync(REPORT, L.join("\n") + "\n");
}

main().catch((e) => {
  console.error("vision experiment failed:", e);
  process.exit(1);
});
