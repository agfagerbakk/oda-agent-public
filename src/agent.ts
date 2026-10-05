import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import { config } from "./config.js";
import { SYSTEM_PROMPT } from "./prompt.js";
import { resolveOdaBin, odaSpawnEnv } from "./oda-spawn.js";
import { loadPreferencesText } from "./prefs.js";
import { logActivity, restockCandidates } from "./store.js";
import { localTools } from "./localtools.js";
import { withLock } from "./lock.js";
import { cartItems, addProductToCart, removeProductFromCart, searchProducts } from "./oda-cli.js";
import { isOrderable } from "./availability.js";
import { listSlots, describeSelectedSlot } from "./slots.js";
import {
  connectMcpServer,
  toolResultText,
  type BridgedServer,
  type McpServerConfig,
} from "./mcp-shim.js";

// The Oda cart lives server-side (mcp-oda persists a cookie session), so per-chat
// memory is only needed for conversational follow-ups ("two more of those").
const sessions = new Map<number, string>();

/** Every tool the agent is allowed to call, namespaced by MCP server key. */
export const ODA_TOOLS = [
  "mcp__oda__check_login",
  "mcp__oda__products_search",
  "mcp__oda__product_add_to_cart",
  "mcp__oda__cart_get_contents",
  "mcp__oda__cart_remove_item",
  "mcp__oda__cart_clear",
  "mcp__oda__recipes_search",
  "mcp__oda__recipes_get_details",
  "mcp__oda__recipe_add_to_cart",
  "mcp__oda__recipe_remove_from_cart",
  // Read-only delivery info (fork). Booking (delivery_slot_select) is intentionally
  // NOT allowed here — slots are booked deterministically via tappable buttons.
  "mcp__oda__delivery_slots_list",
  "mcp__oda__delivery_addresses_list",
  // Saved product lists (fork) — Oda's reusable "Lister", distinct from the cart.
  "mcp__oda__list_all",
  "mcp__oda__list_get",
  "mcp__oda__list_create",
  "mcp__oda__list_rename",
  "mcp__oda__list_delete",
  "mcp__oda__list_add_products",
  "mcp__oda__list_remove_product",
  "mcp__oda__list_add_to_cart",
  // custom in-process tools (see localtools.ts)
  "mcp__odax__product_ingredients",
  "mcp__odax__save_choice",
  "mcp__odax__buy_again_lookup",
  "mcp__odax__last_bought",
];

/**
 * Everything needed to run one agent turn. Injectable so tests can swap the
 * model and point the tools at an in-memory fake Oda, while production
 * uses the real mcp-oda server + live cart. The tool *names* (ODA_TOOLS) and the
 * system prompt are held constant so only the model under test varies.
 */
export type TurnDeps = {
  model: string;
  mcpServers: Record<string, McpServerConfig>;
  allowedTools: string[];
  /** Appended to SYSTEM_PROMPT — the preference seed + learned buy-again block. */
  systemContext: string;
  resume?: string;
  /** Abort the turn. Used by the test/experiment harness. */
  abortController?: AbortController;
};

export type TurnResult = {
  reply: string;
  sessionId?: string;
  /** OpenAI usage totals summed across the turn's model calls. */
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  numTurns?: number;
  durationMs?: number;
};

// Conversational history per resumed session (the old SDK kept this server-side;
// with plain chat completions we carry it ourselves, capped so a long-lived
// chat can't grow the prompt without bound).
const conversations = new Map<string, OpenAI.Chat.ChatCompletionMessageParam[]>();
const HISTORY_LIMIT = 60;
/** Safety cap on model↔tool rounds per turn. */
const MAX_ROUNDS = 30;
/** Cap on basics auto-restocked per fresh-cart trigger. */
const RESTOCK_LIMIT = 12;
/** Cap on retained conversation histories (evict oldest). */
const MAX_CONVERSATIONS = 500;

const openai = new OpenAI({ apiKey: config.openaiApiKey });

/** `mcp__oda__products_search` → { serverKey: "oda", toolName: "products_search" }. */
export function parseAllowed(entry: string): { serverKey: string; toolName: string } | null {
  if (!entry.startsWith("mcp__")) return null;
  const [serverKey, ...rest] = entry.slice("mcp__".length).split("__");
  if (!serverKey || !rest.length) return null;
  return { serverKey, toolName: rest.join("__") };
}

/** Run one agent turn against the given deps. No global state besides history. */
export async function runAgentTurn(text: string, deps: TurnDeps): Promise<TurnResult> {
  const t0 = Date.now();
  const bridged: BridgedServer[] = [];
  try {
    for (const [key, cfg] of Object.entries(deps.mcpServers)) {
      bridged.push(await connectMcpServer(key, cfg));
    }

    // Expose only the pre-approved tools as OpenAI functions, routed back to
    // the owning MCP server. OpenAI function names allow [a-zA-Z0-9_-].
    // List tools once per server, then match the allowlist (was: N×listTools per turn).
    const functions: OpenAI.Chat.ChatCompletionTool[] = [];
    const route = new Map<string, BridgedServer & { toolName: string }>();
    const listedByServer = new Map<string, Awaited<ReturnType<BridgedServer["client"]["listTools"]>>["tools"]>();
    for (const server of bridged) {
      try {
        const listed = await server.client.listTools();
        listedByServer.set(server.key, listed.tools);
      } catch (e) {
        console.error(`[agent] listTools failed for ${server.key}`, e);
      }
    }
    for (const entry of deps.allowedTools) {
      const parsed = parseAllowed(entry);
      if (!parsed) continue;
      const server = bridged.find((b) => b.key === parsed.serverKey);
      if (!server) continue;
      const tools = listedByServer.get(parsed.serverKey);
      if (!tools) continue;
      const match = tools.find((t) => t.name === parsed.toolName);
      if (!match) continue;
      const fname = `${parsed.serverKey}__${parsed.toolName}`;
      functions.push({
        type: "function",
        function: {
          name: fname,
          description: match.description ?? "",
          parameters: match.inputSchema as unknown as Record<string, unknown>,
        },
      });
      route.set(fname, { ...server, toolName: parsed.toolName });
    }

    const history = deps.resume ? (conversations.get(deps.resume) ?? []) : [];
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: "system", content: `${SYSTEM_PROMPT}\n\n${deps.systemContext}` },
      ...history,
      { role: "user", content: text },
    ];

    let reply = "";
    let rounds = 0;
    const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    const signal = deps.abortController?.signal;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      rounds = round + 1;
      const res = await openai.chat.completions.create(
        {
          model: deps.model,
          messages,
          tools: functions.length ? functions : undefined,
          // Deterministic tool routing: the shopping flow depends on the model
          // following the prompt's tool order (buy_again_lookup → search → add).
          temperature: 0,
        },
        signal ? { signal } : undefined,
      );
      const u = res.usage;
      if (u) {
        usage.prompt_tokens += u.prompt_tokens;
        usage.completion_tokens += u.completion_tokens;
        usage.total_tokens += u.total_tokens;
      }
      const msg = res.choices[0]?.message;
      if (!msg) break;
      messages.push(msg as OpenAI.Chat.ChatCompletionMessageParam);
      const calls = msg.tool_calls?.filter((c) => c.type === "function") ?? [];
      if (!calls.length) {
        reply = msg.content ?? "";
        break;
      }
      for (const call of calls) {
        const target = route.get(call.function.name);
        if (!target) {
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: `Unknown tool "${call.function.name}".`,
          });
          continue;
        }
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(call.function.arguments || "{}");
        } catch {
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: `Invalid JSON arguments: ${call.function.arguments.slice(0, 200)}`,
          });
          continue;
        }
        try {
          const result = await target.client.callTool({ name: target.toolName, arguments: args });
          messages.push({ role: "tool", tool_call_id: call.id, content: toolResultText(result) });
        } catch (e) {
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: `Tool error: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500),
          });
        }
      }
    }

    const sessionId = randomUUID();
    conversations.set(sessionId, messages.slice(-HISTORY_LIMIT));
    if (conversations.size > MAX_CONVERSATIONS) {
      const oldest = conversations.keys().next().value;
      if (oldest) conversations.delete(oldest);
    }
    return {
      reply: reply || "I couldn't produce a summary — please check the Oda cart directly.",
      sessionId,
      usage,
      numTurns: rounds,
      durationMs: Date.now() - t0,
    };
  } finally {
    for (const b of bridged) {
      try {
        await b.close();
      } catch {
        /* ignore */
      }
    }
  }
}

/** The production tool backends: the real mcp-oda stdio server + in-process localtools. */
export function prodMcpServers(): Record<string, McpServerConfig> {
  return {
    oda: {
      type: "stdio",
      command: process.execPath, // the current node binary
      args: [resolveOdaBin(), "--data-dir", config.odaDataDir, "mcp"],
      env: odaSpawnEnv(),
    },
    odax: localTools,
  };
}

/**
 * The production system context: just the (small, static) preference seed.
 * Learned buy-again choices are NOT dumped in here — that table only grows,
 * and baking it into every turn means paying to re-cache all of it whenever
 * the ephemeral prompt cache expires between messages. The agent looks up a
 * specific term on demand via the buy_again_lookup tool instead.
 */
export function prodSystemContext(): string {
  return `## Preference seed (baseline)\n${loadPreferencesText()}`;
}

/**
 * Production entry point: run one shopping turn for a Telegram chat, keeping
 * per-chat conversational context. Serialized on the shared Oda cart so two
 * household members can't interleave edits, and logs what was added (who/when/what).
 */
export async function runShoppingTurn(
  chatId: number,
  text: string,
  person = "someone",
): Promise<string> {
  return withLock("oda-cart", async () => {
    const beforeItems = await cartItems();
    const before = new Map(beforeItems.map((i) => [i.id, i.quantity]));

    // A fresh shopping session (empty cart) is the trigger to autonomously restock
    // usual basics — deterministic, not an LLM decision (same reasoning as slot
    // booking: reliability matters more than letting the model improvise here). This
    // is NOT gated on per-item cadence timing ("is milk due yet") — starting a real
    // shop is itself the signal; restockCandidates only excludes near-certain
    // duplicates (bought within the cooldown window). Capped per trigger since a
    // household can have a couple dozen legitimate basics and dumping all of them in
    // one cart would be overwhelming — add the most frequently-bought (most
    // "essential") ones, surface the rest via /basics.
    let augmentedText = text;
    if (beforeItems.length === 0) {
      const candidates = restockCandidates();
      const toRestock = candidates.slice(0, RESTOCK_LIMIT);
      const restocked: string[] = [];
      const skippedUnavailable: string[] = [];
      for (const basic of toRestock) {
        try {
          // Deterministic availability pre-check: never restock something Oda
          // says can't arrive (sold out, or only in a later delivery). Search
          // by the known product name and look for our exact id — if Oda
          // reports it not orderable, skip it rather than adding it.
          let availableForSlot: boolean | null = null;
          try {
            const results = await searchProducts(basic.productName);
            const match = results.find((r) => r.id === basic.productId);
            if (match?.availability) availableForSlot = isOrderable(match.availability);
          } catch (e) {
            console.error("[basics] availability pre-check failed for", basic.term, e);
          }
          if (availableForSlot === false) {
            skippedUnavailable.push(basic.productName);
            continue;
          }
          await addProductToCart(basic.productId);
          restocked.push(basic.productName);
        } catch (e) {
          console.error("[basics] restock failed for", basic.term, e);
        }
      }
      // Post-add verification: the search index can be stale, so re-check what
      // actually landed in the cart — the cart lines carry Oda's authoritative
      // availability for the selected slot. Remove anything that can't arrive.
      if (restocked.length) {
        try {
          const afterRestock = await cartItems();
          const restockIds = new Set(toRestock.map((b) => b.productId));
          for (const line of afterRestock) {
            if (!restockIds.has(line.id)) continue;
            if (line.availability && !isOrderable(line.availability)) {
              try {
                await removeProductFromCart(line.id, line.quantity);
              } catch (e) {
                console.error("[basics] failed to remove unavailable restock", line.id, e);
                continue;
              }
              const idx = restocked.findIndex((n) => n === line.name);
              if (idx !== -1) restocked.splice(idx, 1);
              skippedUnavailable.push(line.name);
            }
          }
        } catch (e) {
          console.error("[basics] post-restock availability sweep failed", e);
        }
      }
      if (restocked.length || skippedUnavailable.length) {
        const extra = candidates.length - toRestock.length;
        augmentedText =
          `${text}\n\n(System note: the cart was empty, so these usual basics were already ` +
          `auto-restocked before this message: ${restocked.length ? restocked.join(", ") : "(none — all candidates were unavailable)"}` +
          (extra > 0 ? ` (+${extra} more basics — mention the user can see them all via /basics)` : "") +
          (skippedUnavailable.length
            ? ` Skipped as unavailable for the delivery slot: ${skippedUnavailable.join(", ")}.`
            : "") +
          ` Mention them in your summary as already-added basics — don't remove or re-add them unless ` +
          `the user's message says otherwise.)`;
      }
    }

    // Surface the currently-booked delivery slot — which may have been picked
    // directly in the Oda app, outside this bot — so the agent doesn't tell the
    // user to choose a time that already exists, and knows which slot Oda judges
    // product availability against. Best-effort: never fail a shopping turn over
    // delivery info.
    try {
      const { selectedSlot } = await listSlots(4);
      if (selectedSlot) {
        augmentedText +=
          `\n\n(System note: a delivery slot is ALREADY selected: ${describeSelectedSlot(selectedSlot)}. ` +
          `Treat delivery as set — do NOT tell the user to pick or confirm a delivery time. ` +
          `Oda reports each product's availability against this slot, so only add items whose ` +
          `availability.is_available is true; skip anything sold out or not deliverable in this ` +
          `slot and flag it.)`;
      }
    } catch (e) {
      console.error("[delivery] selected-slot lookup failed", e);
    }

    const { reply: rawReply, sessionId } = await runAgentTurn(augmentedText, {
      model: config.model,
      mcpServers: prodMcpServers(),
      allowedTools: ODA_TOOLS,
      systemContext: prodSystemContext(),
      resume: sessions.get(chatId),
    });
    if (sessionId) {
      const prev = sessions.get(chatId);
      sessions.set(chatId, sessionId);
      if (prev && prev !== sessionId) conversations.delete(prev);
    }
    let reply = rawReply;
    // Deterministic availability sweep: the prompt tells the model to skip
    // unavailable items, but it doesn't always obey — so enforce it here. Any
    // line this turn ADDED that Oda reports as not orderable (sold out, or
    // only arriving in a later delivery) is removed again and flagged.
    // Pre-existing unavailable lines are left alone (the summary calls them
    // out instead) — only this turn's additions are auto-removed.
    let swept: string[] = [];
    let addedNames: string[] = [];
    try {
      const after = await cartItems();
      const added = after.filter((i) => i.quantity > (before.get(i.id) ?? 0));
      addedNames = added.map((i) => i.name);
      const bad = added.filter((i) => i.availability && !isOrderable(i.availability));
      for (const line of bad) {
        const addedQty = line.quantity - (before.get(line.id) ?? 0);
        try {
          await removeProductFromCart(line.id, addedQty);
          swept.push(line.name);
        } catch (e) {
          console.error("[availability] sweep-remove failed for", line.id, e);
        }
      }
      addedNames = addedNames.filter((n) => !swept.includes(n));
      if (swept.length) {
        reply +=
          `\n\n⚠️ Removed ${swept.join(", ")} — sold out or not available for your delivery slot, ` +
          `so I took it back out of the cart.`;
      }
    } catch (e) {
      console.error("[availability] post-turn sweep failed", e);
    }
    // Record what this turn added to the shared cart, for the activity note.
    try {
      logActivity(person, addedNames);
    } catch (e) {
      console.error("[activity] log failed", e);
    }
    return reply;
  });
}

/** Drop conversational context for a chat (used by /clear so "that" doesn't linger). */
export function resetSession(chatId: number): void {
  const sessionId = sessions.get(chatId);
  sessions.delete(chatId);
  if (sessionId) conversations.delete(sessionId);
}
