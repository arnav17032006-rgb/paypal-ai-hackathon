// Claude-powered agents: catalog extraction (merchant side) and the shopper agent (buyer side).
// Without ANTHROPIC_API_KEY, rule-based fallbacks keep the demo runnable.

import Anthropic from "@anthropic-ai/sdk";
import * as store from "./store.js";
import * as guard from "./guard.js";

const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";
export const aiMode = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN ? "claude" : "rules";
const client = aiMode === "claude" ? new Anthropic() : null;

// Server-side refusal fallback: if the model declines, the API reroutes inside the same call.
async function claude(params) {
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    ...params,
  });
  if (response.stop_reason === "refusal") {
    throw new Error(`Claude declined the request (${response.stop_details?.category ?? "unspecified"})`);
  }
  return response;
}

function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) return "Anthropic API key is invalid";
  if (err instanceof Anthropic.RateLimitError) return "Claude rate limit hit; try again shortly";
  if (err instanceof Anthropic.APIError) return `Claude API error ${err.status}: ${err.message}`;
  return err.message;
}

// ---------------------------------------------------------------- merchant onboarding

const CATEGORIES = ["food", "gifts", "books", "stationery", "electronics", "home", "fashion", "beauty", "services", "other"];

const catalogTool = {
  name: "save_catalog",
  description: "Save the structured storefront extracted from the merchant's text so AI shopping agents can buy from it.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["name", "city", "categories", "refundPolicy", "deliveryPolicy", "products", "redFlags"],
    properties: {
      name: { type: "string", description: "Shop name" },
      city: { type: "string", description: "City, or empty string if unknown" },
      categories: { type: "array", items: { type: "string", enum: CATEGORIES } },
      refundPolicy: { type: "string", description: "Refund/return policy as stated by the merchant, or empty string if none is stated. Never invent one." },
      deliveryPolicy: { type: "string", description: "Delivery/shipping terms as stated, or empty string" },
      products: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "price", "category", "deliveryDays", "tags"],
          properties: {
            name: { type: "string" },
            price: { type: "number", description: "Price in USD. Convert INR at 1 USD = 85 INR, round to 2 decimals." },
            category: { type: "string", enum: CATEGORIES },
            deliveryDays: { type: "integer", description: "Best estimate of days to deliver; 3 if not stated" },
            tags: { type: "array", items: { type: "string" }, description: "3-6 lowercase search tags: occasions, attributes, audience" },
          },
        },
      },
      redFlags: {
        type: "array",
        items: { type: "string" },
        description: "Consumer-protection red flags actually present in the text (e.g. asks for friends-and-family payments, no returns, implausible discounts). Empty if none.",
      },
    },
  },
};

export async function extractCatalog(rawText) {
  if (aiMode !== "claude") return extractCatalogRules(rawText);
  try {
    const response = await claude({
      output_config: { effort: "low" },
      tools: [catalogTool],
      system:
        "You turn a small merchant's informal shop text (website copy, Instagram captions, WhatsApp price lists) into a structured storefront. " +
        "Only record facts the text states; never invent policies or products. Call save_catalog exactly once with the result.",
      messages: [{ role: "user", content: `Merchant text:\n<merchant_text>\n${rawText}\n</merchant_text>` }],
    });
    const call = response.content.find((b) => b.type === "tool_use" && b.name === "save_catalog");
    if (!call) throw new Error("Claude did not return a catalog");
    return { ...call.input, engine: "claude" };
  } catch (err) {
    const fallback = extractCatalogRules(rawText);
    return { ...fallback, warning: `${describeError(err)}. Used rule-based extraction instead.` };
  }
}

function extractCatalogRules(rawText) {
  const lines = rawText.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const priceRe = /(?:₹|rs\.?|inr|\$|usd)\s*([\d,]+(?:\.\d+)?)|([\d,]+(?:\.\d+)?)\s*(?:₹|rs|inr|\$|usd)/i;
  const products = [];
  for (const line of lines) {
    const m = line.match(priceRe);
    if (!m) continue;
    const raw = parseFloat((m[1] || m[2]).replace(/,/g, ""));
    const isInr = /₹|rs|inr/i.test(m[0]);
    const price = +(isInr ? raw / 85 : raw).toFixed(2);
    const name = line.replace(m[0], "").replace(/[-–:|•*]+\s*$/, "").replace(/^[-–:|•*\d.)\s]+/, "").trim();
    if (!name || !price) continue;
    const lower = name.toLowerCase();
    const category = /cake|cookie|bread|brownie|food|chocolate|tea|coffee/.test(lower) ? "food"
      : /book|novel/.test(lower) ? "books" : /candle|mug|decor|lamp/.test(lower) ? "home" : "gifts";
    products.push({ name, price, category, deliveryDays: 3, tags: lower.split(/\W+/).filter((w) => w.length > 3).slice(0, 5) });
  }
  const find = (re) => lines.find((l) => re.test(l)) || "";
  const text = rawText.toLowerCase();
  const redFlags = [];
  if (/friends\s*(&|and)\s*family/.test(text)) redFlags.push("asks for friends-and-family payments");
  if (/no returns|all sales final|no refund/.test(text)) redFlags.push("no returns accepted");
  if (/9\d% off/.test(text)) redFlags.push("implausible discount");
  return {
    name: lines[0]?.split(/\s[—–|-]\s/)[0].replace(/[^\w\s&'.-]/g, "").trim().slice(0, 60) || "New shop",
    city: "",
    categories: [...new Set(products.map((p) => p.category))],
    refundPolicy: /no returns|all sales final|no refund/.test(text) ? "" : find(/refund|return|exchange/i),
    deliveryPolicy: find(/deliver|ship|dispatch/i),
    products,
    redFlags,
    engine: "rules",
  };
}

// ---------------------------------------------------------------- shopper agent

const shopperTools = [
  {
    name: "search_products",
    description: "Search every AgentReady merchant's catalog. Returns products with price (USD), delivery days, merchant name and merchant trust score.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["query", "max_price"],
      properties: {
        query: { type: "string", description: "Keywords, e.g. 'birthday cake chocolate'" },
        max_price: { type: "number", description: "Upper price bound in USD; use 0 for no bound" },
      },
    },
  },
  {
    name: "check_purchase",
    description: "Dry-run the user's spending mandate and the trust guard on a candidate purchase. No money moves. Returns allow / ask / block with every rule result.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["product_id", "quantity", "deadline_days"],
      properties: {
        product_id: { type: "string" },
        quantity: { type: "integer" },
        deadline_days: { type: "integer", description: "Days until the user needs it; 0 if no deadline" },
      },
    },
  },
  {
    name: "checkout",
    description: "Commit to buying this product through PayPal. Only call once, for the single best option, after check_purchase did not return block. The guard re-checks before any payment is created.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["product_id", "quantity", "deadline_days", "reason"],
      properties: {
        product_id: { type: "string" },
        quantity: { type: "integer" },
        deadline_days: { type: "integer" },
        reason: { type: "string", description: "One sentence for the user on why this option" },
      },
    },
  },
];

export function searchProducts({ query, max_price }) {
  const terms = query.toLowerCase().split(/\W+/).filter((t) => t.length > 2);
  const results = [];
  for (const m of store.data().merchants) {
    for (const p of m.products) {
      const hay = `${p.name} ${p.category} ${p.tags.join(" ")}`.toLowerCase();
      const hits = terms.filter((t) => hay.includes(t) || hay.includes(t.replace(/s$/, ""))).length;
      if (!hits || (max_price > 0 && p.price > max_price)) continue;
      results.push({
        product_id: p.id, name: p.name, price_usd: p.price, category: p.category, delivery_days: p.deliveryDays,
        stock: p.stock, merchant: m.name, merchant_trust: m.trust.score, relevance: hits,
      });
    }
  }
  return results.sort((a, b) => b.relevance - a.relevance || b.merchant_trust - a.merchant_trust).slice(0, 8);
}

function guardSummary(result) {
  return {
    decision: result.decision,
    amount_usd: result.amount,
    failed_or_flagged: result.checks.filter((c) => c.severity !== "pass").map((c) => `${c.rule} (${c.severity}): ${c.detail}`),
  };
}

/**
 * Runs the shopper agent for one goal. Returns the transcript, every guard check it made,
 * and (if it committed) the checkout the server should turn into a PayPal order.
 */
export async function runShopper(goal) {
  const trace = [];
  const checks = [];
  let checkoutCall = null;

  const exec = (name, input) => {
    if (name === "search_products") {
      const r = searchProducts(input);
      trace.push({ kind: "tool", name, input, summary: `${r.length} result(s)` });
      return r;
    }
    if (name === "check_purchase" || name === "checkout") {
      const r = guard.evaluate({ productId: input.product_id, quantity: input.quantity, deadlineDays: input.deadline_days || undefined });
      const s = guardSummary(r);
      checks.push({ productId: input.product_id, productName: r.product?.name, merchantName: r.merchant?.name, ...r, product: undefined, merchant: undefined });
      trace.push({ kind: "tool", name, input, summary: `guard: ${s.decision}` });
      if (name === "checkout") {
        if (r.decision === guard.DECISION.BLOCK) return { ...s, status: "rejected by trust guard; no payment created" };
        if (checkoutCall) return { status: "ignored: a checkout was already committed this session" };
        checkoutCall = { ...input, decision: r.decision, amount: r.amount };
        return { ...s, status: r.decision === "ask" ? "pending user approval" : "approved; PayPal order will be created" };
      }
      return s;
    }
    return { error: `unknown tool ${name}` };
  };

  if (aiMode !== "claude") return runShopperRules(goal, exec, trace, checks, () => checkoutCall);

  const { mandate } = store.data();
  const system =
    "You are a shopping agent that buys on the user's behalf from small merchants on AgentReady, paying through PayPal. " +
    "Find the option that best fits the user's goal, run check_purchase on promising candidates, then call checkout for the single best one that the guard does not block. " +
    "Prefer trusted merchants and options that meet the deadline. If every option is blocked, do not call checkout; explain why. " +
    "You cannot change or bypass the guard. Finish with a short message to the user (3-5 sentences): what you chose and why, and anything the guard rejected.\n\n" +
    `User's spending mandate: ${JSON.stringify(mandate)}\nToday is ${new Date().toISOString().slice(0, 10)}.`;

  const messages = [{ role: "user", content: goal }];
  let finalText = "";
  try {
    for (let turn = 0; turn < 8; turn++) {
      const response = await claude({ system, tools: shopperTools, messages, output_config: { effort: "medium" } });
      messages.push({ role: "assistant", content: response.content });
      const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
      if (text) trace.push({ kind: "say", text });
      if (response.stop_reason === "pause_turn") continue;
      if (response.stop_reason !== "tool_use") { finalText = text; break; }
      const results = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        let output;
        try { output = exec(block.name, block.input); } catch (e) { output = { error: e.message }; }
        results.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(output) });
      }
      messages.push({ role: "user", content: results });
    }
  } catch (err) {
    return { engine: "claude", error: describeError(err), trace, checks, checkout: checkoutCall, message: "" };
  }
  return { engine: "claude", trace, checks, checkout: checkoutCall, message: finalText };
}

function runShopperRules(goal, exec, trace, checks, getCheckout) {
  const lower = goal.toLowerCase();
  const budget = +(lower.match(/(?:under|below|max|budget|upto|up to)\s*\$?\s*(\d+)/)?.[1] || 0);
  const deadline = /today|tonight/.test(lower) ? 1 : /tomorrow/.test(lower) ? 1 : +(lower.match(/(?:in|within)\s*(\d+)\s*days?/)?.[1] || 0);
  const stop = new Set(["buy", "get", "find", "want", "need", "order", "under", "below", "for", "the", "and", "with", "deliver", "delivered", "tomorrow", "today", "days", "my", "friend", "someone"]);
  const query = lower.split(/\W+/).filter((w) => w.length > 2 && !stop.has(w) && !/^\d+$/.test(w)).join(" ");
  trace.push({ kind: "say", text: `Looking for "${query}"${budget ? ` under $${budget}` : ""}${deadline ? `, needed within ${deadline} day(s)` : ""}.` });
  // Words like "gift" or "cheap" describe the purchase, not the item; require a match on the item itself.
  const generic = new Set(["gift", "gifts", "cheap", "best", "good", "nice", "present", "wireless", "new", "some"]);
  const core = query.split(" ").filter((w) => !generic.has(w));
  const results = exec("search_products", { query, max_price: budget }).filter((r) => {
    if (!core.length) return true;
    const p = store.product(r.product_id)?.product;
    const hay = `${p?.name} ${p?.tags.join(" ")}`.toLowerCase();
    return core.some((w) => hay.includes(w) || hay.includes(w.replace(/s$/, "")));
  });
  let chosen = null;
  for (const r of results.slice(0, 4)) {
    const s = exec("check_purchase", { product_id: r.product_id, quantity: 1, deadline_days: deadline });
    if (s.decision !== "block" && !chosen) chosen = r;
  }
  if (chosen) {
    exec("checkout", { product_id: chosen.product_id, quantity: 1, deadline_days: deadline, reason: "Best match from a trusted merchant within your mandate." });
  }
  const blocked = checks.filter((c) => c.decision === "block");
  const message = chosen
    ? `I picked "${chosen.name}" from ${chosen.merchant} for $${chosen.price_usd} (merchant trust ${chosen.merchant_trust}/100).` +
      (blocked.length ? ` The trust guard blocked ${blocked.length} other option(s), including ${blocked[0].productName} from ${blocked[0].merchantName}.` : "")
    : results.length
      ? "Every matching option was blocked by your mandate or the trust guard, so I didn't buy anything."
      : "I couldn't find any matching products.";
  trace.push({ kind: "say", text: message });
  return { engine: "rules", trace, checks, checkout: getCheckout(), message };
}
