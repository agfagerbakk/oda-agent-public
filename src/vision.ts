import OpenAI from "openai";
import { config } from "./config.js";

// The image-understanding step of the bot. A photo can be anything — a recipe
// screenshot, a handwritten list, a photo of groceries — so we ask a vision model
// to say what it is and extract the grocery-relevant items, then hand that text to
// the normal shopping flow (which does the Oda search + dietary screening).
//
// Uses OpenAI chat completions with image input, via the `openai` SDK.
// Model gpt-4.1-mini was chosen in VISION-REPORT.md (100% ingredient recall at
// ~$0.0008/image, avoiding gpt-4o-mini's image-token blow-up).

const VISION_PROMPT = `You are the vision step of a grocery shopping assistant for the Norwegian online store Oda. Look at the image and respond with:
1. One short line stating what it is (e.g. "a recipe for tacos", "a photo of grocery items", "a handwritten shopping list", "a restaurant menu").
2. Then, one item per line, every grocery item or recipe ingredient the user would need to buy — simple generic names (e.g. "cheese", not "1/4 cup shredded cheese"). Include the ingredients from every recipe if there are several. Note quantities or number of portions if the image shows them.
Output only that summary line followed by the list. No extra commentary.`;

type VisionProvider = {
  model: string;
  apiKey: string | undefined;
  maxTokens: number;
};

/** The vision provider: an OpenAI vision-capable chat model. */
function resolveProvider(): VisionProvider {
  return {
    model: config.openaiVisionModel,
    apiKey: config.openaiApiKey,
    // Keep the answer short: the prompt asks for a summary line + item list,
    // and a tight cap avoids image-token blow-up (see VISION-REPORT.md).
    maxTokens: 1024,
  };
}

/** True if the bot can process images (a vision key is configured). */
export function visionEnabled(): boolean {
  return Boolean(resolveProvider().apiKey);
}

/**
 * Read an image and return a text description + extracted grocery/ingredient list,
 * suitable to feed into the shopping agent. Throws if vision isn't configured.
 */
export async function extractFromImage(
  base64: string,
  mimeType: string,
  caption?: string,
): Promise<string> {
  const provider = resolveProvider();
  if (!provider.apiKey) throw new Error("Vision is not configured (no vision key).");
  const text = caption
    ? `${VISION_PROMPT}\n\nThe user sent this note with the image: "${caption}"`
    : VISION_PROMPT;

  const res = await new OpenAI({ apiKey: provider.apiKey }).chat.completions.create({
    model: provider.model,
    max_tokens: provider.maxTokens,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text },
          { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}` } },
        ],
      },
    ],
  });
  const out = res.choices?.[0]?.message?.content?.trim();
  if (!out) throw new Error("Vision model returned no content.");
  return out;
}
