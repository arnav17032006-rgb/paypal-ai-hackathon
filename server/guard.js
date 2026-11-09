// Trust guard: deterministic checks that run on every payment an agent proposes.
// The LLM can explain a decision, but it can never override one.

import * as store from "./store.js";

export const DECISION = { ALLOW: "allow", ASK: "ask", BLOCK: "block" };

/**
 * `excludeOrderId` re-checks an existing order without counting it against its own limits.
 * @returns {{decision: string, checks: {rule: string, ok: boolean, severity: string, detail: string}[], amount: number}}
 */
export function evaluate({ productId, quantity = 1, deadlineDays, excludeOrderId }) {
  const { mandate } = store.data();
  const found = store.product(productId);
  if (!found) {
    return { decision: DECISION.BLOCK, amount: 0, checks: [{ rule: "product_exists", ok: false, severity: "block", detail: `Unknown product ${productId}` }] };
  }
  const { product, merchant } = found;
  const amount = +(product.price * quantity).toFixed(2);
  const checks = [];
  const add = (rule, ok, severity, detail) => checks.push({ rule, ok, severity: ok ? "pass" : severity, detail });

  add("currency", product.currency === mandate.currency, "block", `Priced in ${product.currency}; mandate allows ${mandate.currency}`);
  add("category", mandate.allowedCategories.includes(product.category), "block", `Category "${product.category}" ${mandate.allowedCategories.includes(product.category) ? "is" : "is not"} allowed by the mandate`);
  add("per_order_limit", amount <= mandate.perOrderLimit, "block", `$${amount} vs per-order limit $${mandate.perOrderLimit}`);
  const spent = store.spentToday(excludeOrderId);
  add("daily_limit", spent + amount <= mandate.dailyLimit, "block", `$${spent} already committed today + $${amount} vs daily limit $${mandate.dailyLimit}`);
  const reserved = store.reservedUnits(productId, excludeOrderId);
  add("stock", product.stock - reserved >= quantity, "block", `${product.stock} in stock, ${reserved} reserved by unpaid orders, ${quantity} requested`);
  add("merchant_trust", merchant.trust.score >= mandate.minMerchantTrust, "block", `Merchant trust ${merchant.trust.score}/100 vs minimum ${mandate.minMerchantTrust}: ${merchant.trust.reasons.join("; ")}`);
  if (mandate.requireRefundPolicy) {
    add("refund_policy", Boolean(merchant.refundPolicy?.trim()), "block", merchant.refundPolicy?.trim() ? "Merchant publishes a refund policy" : "Merchant has no refund policy");
  }
  const scamSignals = scanShopText([merchant.deliveryPolicy, merchant.refundPolicy, product.name, ...(product.tags || [])].join("\n"));
  add("scam_signals", scamSignals.length === 0, "block", scamSignals.length ? `Red flags: ${scamSignals.map((f) => f.label).join("; ")}` : "No known scam phrases");
  if (deadlineDays) {
    add("delivery_deadline", product.deliveryDays <= deadlineDays, "ask", `Delivers in ${product.deliveryDays} day(s), needed within ${deadlineDays}`);
  }
  add("approval_threshold", amount <= mandate.askAbove, "ask", `$${amount} vs auto-approve threshold $${mandate.askAbove}`);

  const decision = checks.some((c) => c.severity === "block")
    ? DECISION.BLOCK
    : checks.some((c) => c.severity === "ask")
      ? DECISION.ASK
      : DECISION.ALLOW;
  return { decision, checks, amount, product, merchant };
}

// Checked in code on the merchant's own text, so neither the merchant nor the model can talk its way past them.
// Severe flags cap a new merchant's trust below any sensible minimum.
const SHOP_RED_FLAGS = [
  {
    id: "unprotected_payment",
    severe: true,
    label: "Asks for an unprotected payment method (friends & family, gift cards, crypto or wire)",
    re: /friends\s*(?:&|and|n)\s*family|pay\w*\s+(?:with|via|in|by|using)\s+(?:gift\s*cards?|crypto|bitcoin|btc|usdt|wire)|gift\s*cards?\s+(?:as\s+payment|only|accepted)|crypto\s*only|western\s*union|wire\s*transfer/i,
  },
  {
    id: "agent_instructions",
    severe: true,
    label: "Contains instructions aimed at AI agents (possible prompt injection)",
    re: /\b(?:ignore|disregard|override)\b[^.\n]{0,30}\b(?:previous|prior|earlier|above|your|all)\b[^.\n]{0,20}\b(?:instructions|rules|prompts?|guard|limits)|\b(?:ai|llm|shopping)\s+(?:agents?|assistants?|models?|bots?)\b[^.\n]{0,80}\b(?:must|should|are\s+(?:required|instructed|allowed)|always|never|pre-?approved|verified)\b|\b(?:rate|mark|report|treat|score)\b[^.\n]{0,40}\b(?:fully\s+trusted|as\s+trusted|as\s+verified|no\s+red\s+flags?)\b|\bsystem\s+prompt\b/i,
  },
  {
    id: "no_returns",
    severe: false,
    label: "Refuses all returns (\"all sales final\" or \"no refunds\")",
    re: /all\s+sales\s+(?:are\s+)?final|\bno\s+refunds?\b|\bno\s+returns?\b(?!\s+(?:on|for)\s+(?:perishable|food|custom|personali[sz]ed))/i,
  },
  { id: "implausible_discount", severe: false, label: "Implausible discount (80% off or more)", re: /\b[89]\d\s*%\s*off\b/i },
];

/** Deterministic red-flag scan of shop text. */
export function scanShopText(text = "") {
  return SHOP_RED_FLAGS.filter((f) => f.re.test(text)).map(({ id, severe, label }) => ({ id, severe, label }));
}

/** True when most meaningful words of `snippet` appear in `source`: catches policies the model made up. */
export function isGrounded(snippet = "", source = "") {
  const words = (s) => s.toLowerCase().match(/[a-z0-9]{4,}/g) || [];
  const want = words(snippet);
  if (!want.length) return false;
  const have = new Set(words(source));
  return want.filter((w) => have.has(w)).length / want.length >= 0.6;
}

const levelFor = (score) => (score >= 75 ? "high" : score >= 50 ? "medium" : "low");

/**
 * Trust score for a newly onboarded merchant, from facts we can check.
 * With `sourceText` (the shop's own words), the refund policy only counts if it is really in the text,
 * and the text is scanned for red flags in code.
 */
export function scoreNewMerchant({ refundPolicy, deliveryPolicy, paypalEmail, aiRedFlags = [], sourceText }) {
  let score = 55; // new merchants start below the default minimum trust until they earn history
  const reasons = ["New merchant: no order history yet"];
  const flags = sourceText === undefined ? [] : scanShopText(sourceText);
  const refundGrounded = Boolean(refundPolicy?.trim()) && (sourceText === undefined || isGrounded(refundPolicy, sourceText));
  if (paypalEmail) { score += 10; reasons.push("PayPal payee email provided"); }
  if (refundGrounded) { score += 10; reasons.push("Publishes a refund policy"); }
  else if (refundPolicy?.trim()) { score -= 15; reasons.push("Claimed refund policy is not in the shop's own text, so it was ignored"); }
  else { score -= 15; reasons.push("No refund policy"); }
  if (deliveryPolicy?.trim()) { score += 5; reasons.push("States delivery terms"); }
  for (const flag of aiRedFlags) { score -= 15; reasons.push(`AI flagged: ${flag}`); }
  for (const f of flags) { score -= f.severe ? 30 : 15; reasons.push(`Found in shop text: ${f.label}`); }
  if (flags.some((f) => f.severe)) score = Math.min(score, 30);
  score = Math.max(0, Math.min(100, score));
  return { score, level: levelFor(score), reasons, flags, refundGrounded };
}

/** Disputes and chargebacks lower trust, so the guard reacts on the merchant's very next sale. */
export function penalize(merchant, points, reason) {
  merchant.trust.score = Math.max(0, merchant.trust.score - points);
  merchant.trust.level = levelFor(merchant.trust.score);
  merchant.trust.reasons.push(reason);
}
