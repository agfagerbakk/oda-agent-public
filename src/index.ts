import { Bot, InlineKeyboard, type Context } from "grammy";
import { requireBotConfig } from "./config.js";
import { ensureLoggedIn } from "./oda-auth.js";
import { runShoppingTurn, resetSession } from "./agent.js";
import { cartList, cartClear, listsAll } from "./oda-cli.js";
import {
  setChoice,
  getLastActivity,
  getKV,
  setKV,
  preferredSlots,
  recordBooking,
  basicsSummary,
  excludeBasic,
  restoreBasic,
} from "./store.js";
import { whenLastBought, formatLastBought } from "./history.js";
import { extractFromImage, visionEnabled } from "./vision.js";
import { withLock } from "./lock.js";
import { listSlots, selectSlot, orderable, formatSlot, isPreferred, pickSlots } from "./slots.js";

/** Compact relative time, e.g. "25 min ago", "3h ago", "2d ago". */
function relTime(iso: string): string {
  const min = Math.max(0, (Date.now() - Date.parse(iso)) / 60000);
  if (min < 60) return `${Math.round(min)} min ago`;
  const h = min / 60;
  return h < 24 ? `${Math.round(h)}h ago` : `${Math.round(h / 24)}d ago`;
}

/**
 * A "who/when/what" note about the last cart change — shown only when someone
 * else last touched it, or after a ~45-min gap, so a rapid same-person session
 * isn't spammed. Returns null when no note is warranted.
 */
function activityNote(currentPerson: string): string | null {
  const last = getLastActivity();
  if (!last || !last.items.length) return null;
  const gapMin = (Date.now() - Date.parse(last.ts)) / 60000;
  if (last.person === currentPerson && gapMin < 45) return null;
  const shown = last.items.slice(0, 4).join(", ");
  const more = last.items.length > 4 ? ` & ${last.items.length - 4} more` : "";
  return `🛒 ${last.person} added ${shown}${more} ${relTime(last.ts)}.`;
}

const { telegramBotToken, allowedTelegramUserIds } = requireBotConfig();
const bot = new Bot(telegramBotToken);

// --- Security guard: only allow-listed users may drive the bot --------------
// Without this, anyone who finds the bot could fill (or clear) the cart.
bot.use(async (ctx, next) => {
  if (ctx.from === undefined || !allowedTelegramUserIds.has(ctx.from.id)) {
    if (ctx.chat) await ctx.reply("Not authorized.");
    console.warn(`[guard] ignored message from unauthorized user ${ctx.from?.id}`);
    return;
  }
  await next();
});

bot.command("start", (ctx) =>
  ctx.reply(
    "Hi! Text me what to add to your Oda cart — e.g. \"taco night for 4 + milk and bananas\".\n" +
      (visionEnabled() ? "You can also send a photo (recipe screenshot, a list, groceries) and I'll read it.\n" : "") +
      "\nCommands:\n" +
      "/cart – show current cart\n" +
      "/lists – show your saved lists\n" +
      "/basics – show your auto-restocked usual basics\n" +
      "/delivery – pick a delivery time\n" +
      "/clear – empty the cart\n" +
      "/pref term = product – save a usual product\n" +
      "/last term – when you last bought it\n" +
      "\nYou can also just ask, e.g. \"save the cart as my weekly list\" or \"add list Essentials to cart\".\n" +
      "Starting a new session (empty cart) auto-restocks your overdue basics — /basics remove <term> to opt out of one.",
  ),
);

bot.command("cart", async (ctx) => {
  await ctx.replyWithChatAction("typing");
  try {
    await ctx.reply(await cartList());
  } catch (err) {
    console.error("[cart]", err);
    await ctx.reply("Couldn't read the cart. Please try again.");
  }
});

bot.command("lists", async (ctx) => {
  await ctx.replyWithChatAction("typing");
  try {
    await ctx.reply(await listsAll());
  } catch (err) {
    console.error("[lists]", err);
    await ctx.reply("Couldn't read your saved lists. Please try again.");
  }
});

bot.command("clear", async (ctx) => {
  await ctx.replyWithChatAction("typing");
  try {
    await cartClear();
    resetSession(ctx.chat.id);
    await ctx.reply("Cart emptied. 🧹");
  } catch (err) {
    console.error("[clear]", err);
    await ctx.reply("Couldn't clear the cart. Please try again.");
  }
});

// /pref melk = Q Lettmelk 1,5% 1L
bot.command("pref", async (ctx) => {
  const raw = ctx.match?.trim() ?? "";
  const eq = raw.indexOf("=");
  if (eq === -1) {
    await ctx.reply("Usage: /pref term = product\nExample: /pref melk = Q Lettmelk 1,5% 1L");
    return;
  }
  const term = raw.slice(0, eq).trim();
  const product = raw.slice(eq + 1).trim();
  if (!term || !product) {
    await ctx.reply("Usage: /pref term = product");
    return;
  }
  setChoice(term, { name: product }, ctx.from?.first_name ?? "someone");
  await ctx.reply(`Saved: "${term}" → "${product}" ✅`);
});

// /last <term> — when did I last buy this?
bot.command("last", async (ctx) => {
  const q = ctx.match?.trim();
  if (!q) {
    await ctx.reply("Usage: /last <product or term>\nExample: /last melk");
    return;
  }
  await ctx.replyWithChatAction("typing");
  const typing = setInterval(() => ctx.replyWithChatAction("typing").catch(() => {}), 5000);
  try {
    const r = await whenLastBought(q);
    await ctx.reply(formatLastBought(r));
  } catch (err) {
    console.error("[last]", err);
    await ctx.reply(`Couldn't look up that purchase — ${String(err).slice(0, 200)}`);
  } finally {
    clearInterval(typing);
  }
});

// /basics, /basics remove <term>, /basics restore <term>
bot.command("basics", async (ctx) => {
  const raw = ctx.match?.trim() ?? "";
  if (!raw) {
    await ctx.reply(basicsSummary());
    return;
  }
  const [action, ...rest] = raw.split(/\s+/);
  const term = rest.join(" ").trim();
  if (!term || (action !== "remove" && action !== "restore")) {
    await ctx.reply("Usage: /basics, /basics remove <term>, /basics restore <term>");
    return;
  }
  const ok = action === "remove" ? excludeBasic(term) : restoreBasic(term);
  if (!ok) {
    await ctx.reply(`Couldn't find "${term}" in your basics.`);
    return;
  }
  await ctx.reply(
    action === "remove"
      ? `Removed "${term}" — it won't be auto-restocked anymore. /basics restore ${term} to undo.`
      : `Restored "${term}" to your active basics.`,
  );
});

// --- Free-text messages become shopping turns -------------------------------
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;
  if (text.startsWith("/")) return; // unknown command; ignore
  const person = ctx.from?.first_name ?? "someone";
  const note = activityNote(person);
  if (note) await ctx.reply(note);
  await ctx.replyWithChatAction("typing");
  // Keep the "typing…" indicator alive during longer runs.
  const typing = setInterval(() => ctx.replyWithChatAction("typing").catch(() => {}), 5000);
  try {
    const reply = await runShoppingTurn(ctx.chat.id, text, person);
    await ctx.reply(reply);
    await maybeOfferDelivery(ctx);
  } catch (err) {
    console.error("[shopping]", err);
    await ctx.reply("Something went wrong filling the cart. Please try again.");
  } finally {
    clearInterval(typing);
  }
});

// --- Image messages: read the picture, then shop from what it contains -------
// A photo can be anything (recipe screenshot, handwritten list, groceries). An
// OpenAI vision model extracts the grocery-relevant items, then the
// normal shopping flow searches Oda, screens for additives/lactose, and fills the cart.
async function handleImage(
  ctx: Context,
  fileId: string,
  mimeType: string,
  caption: string,
): Promise<void> {
  if (!ctx.chat) return;
  if (!visionEnabled()) {
    await ctx.reply("Image support isn't configured yet (no vision key).");
    return;
  }
  const person = ctx.from?.first_name ?? "someone";
  const note = activityNote(person);
  if (note) await ctx.reply(note);
  await ctx.replyWithChatAction("typing");
  const typing = setInterval(() => ctx.replyWithChatAction("typing").catch(() => {}), 5000);
  try {
    const file = await ctx.api.getFile(fileId);
    const url = `https://api.telegram.org/file/bot${telegramBotToken}/${file.file_path}`;
    const bytes = Buffer.from(await (await fetch(url)).arrayBuffer());
    const extracted = await extractFromImage(bytes.toString("base64"), mimeType, caption);
    const prompt =
      `The user sent an image. A vision model read it as:\n\n${extracted}\n\n` +
      (caption ? `The user's note with it: "${caption}"\n\n` : "") +
      `Add the relevant grocery items to the Oda cart, following all the usual rules ` +
      `(prefer their usuals, avoid ultra-processed, prefer lactose-free), then summarize.`;
    const reply = await runShoppingTurn(ctx.chat.id, prompt, person);
    await ctx.reply(`🖼️ ${extracted.split("\n")[0]}\n\n${reply}`);
    await maybeOfferDelivery(ctx);
  } catch (err) {
    console.error("[image]", err);
    await ctx.reply("Couldn't read that image. Please try again or type the items.");
  } finally {
    clearInterval(typing);
  }
}

bot.on("message:photo", (ctx) => {
  // Telegram sends several sizes (JPEG); the last is the largest.
  const sizes = ctx.message.photo;
  const largest = sizes[sizes.length - 1];
  return handleImage(ctx, largest.file_id, "image/jpeg", ctx.message.caption ?? "");
});

bot.on("message:document", async (ctx) => {
  const doc = ctx.message.document;
  if (!doc.mime_type?.startsWith("image/")) {
    await ctx.reply("I can read text messages and images. That file type isn't supported.");
    return;
  }
  await handleImage(ctx, doc.file_id, doc.mime_type, ctx.message.caption ?? "");
});

// --- Delivery slots: list (tappable) → book on tap -------------------------

async function showSlots(ctx: Context): Promise<void> {
  await ctx.replyWithChatAction("typing");
  let res;
  try {
    res = await listSlots(4);
  } catch (e) {
    console.error("[slots]", e);
    await ctx.reply("Couldn't load delivery times — please try again.");
    return;
  }
  const prefs = preferredSlots();
  if (!orderable(res.slots).length) {
    const why = res.blockers[0] ? `\n\n⚠️ ${res.blockers[0]}` : "";
    await ctx.reply(`No orderable delivery slots in the next few days.${why}`);
    return;
  }
  const chosen = pickSlots(res.slots, prefs);
  const addr = res.currentAddressId ?? res.addresses[0]?.id ?? 0;
  const kb = new InlineKeyboard();
  for (const s of chosen) {
    kb.text(`${isPreferred(s, prefs) ? "⭐ " : ""}${formatSlot(s)}`, `book:${s.id}:${addr}`).row();
  }
  const hasStar = chosen.some((s) => isPreferred(s, prefs)) ? " (⭐ = your usual)" : "";
  const sel = res.selectedSlotId ? "\n\nYou already have a slot — tap to change." : "";
  const blk = res.blockers[0] ? `\n\n⚠️ ${res.blockers[0]}` : "";
  await ctx.reply(`Pick a delivery time${hasStar}:${sel}${blk}`, { reply_markup: kb });
}

bot.command("delivery", (ctx) => showSlots(ctx));

bot.callbackQuery(/^book:(\d+):(\d+)$/, async (ctx) => {
  const slotId = Number(ctx.match[1]);
  const addressId = Number(ctx.match[2]) || undefined;
  await ctx.answerCallbackQuery({ text: "Booking…" });
  try {
    await withLock("oda-cart", async () => {
      const res = await listSlots(4);
      const slot = res.slots.find((s) => s.id === slotId);
      await selectSlot(slotId, addressId);
      if (slot) {
        recordBooking(
          {
            id: slot.id,
            routeGroupStr: slot.group,
            openDatetime: slot.open,
            closeDatetime: slot.close,
            price: slot.price,
          },
          addressId ?? res.currentAddressId ?? 0,
          ctx.from?.first_name ?? "someone",
        );
      }
      await ctx.editMessageText(
        `✅ Delivery booked: ${slot ? formatSlot(slot) : `slot ${slotId}`}\n\nReview & buy in Oda 🛒`,
      );
    });
  } catch (e) {
    console.error("[book]", e);
    await ctx.reply("Couldn't book that slot (it may have filled up) — try /delivery again.");
  }
});

/** After a cart change, gently offer to set a time (throttled, only if none chosen). */
async function maybeOfferDelivery(ctx: Context): Promise<void> {
  try {
    const last = Number(getKV("last_offer_ts") ?? "0");
    if (Date.now() - last < 3 * 60 * 60 * 1000) return; // at most every 3h
    const res = await listSlots(4);
    if (res.selectedSlotId || !res.slots.length) return; // already set, or empty cart
    setKV("last_offer_ts", String(Date.now()));
    await ctx.reply("🕒 No delivery time set yet — tap /delivery to pick one when you're ready.");
  } catch {
    /* non-critical */
  }
}

bot.catch((err) => console.error("[bot] unhandled error", err));

async function main() {
  await ensureLoggedIn();
  console.log("[bot] starting (long-polling)…");
  await bot.start();
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
