// Trust guard: deterministic checks that run on every payment an agent proposes.
// The LLM can explain a decision, but it can never override one.

import * as store from "./store.js";

export const DECISION = { ALLOW: "allow", ASK: "ask", BLOCK: "block" };

/**
 * @returns {{decision: string, checks: {rule: string, ok: boolean, severity: string, detail: string}[], amount: number}}
 */
export function evaluate({ productId, quantity = 1, deadlineDays }) {
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
  const spent = store.spentToday();
  add("daily_limit", spent + amount <= mandate.dailyLimit, "block", `$${spent} already committed today + $${amount} vs daily limit $${mandate.dailyLimit}`);
  add("stock", product.stock >= quantity, "block", `${product.stock} in stock, ${quantity} requested`);
  add("merchant_trust", merchant.trust.score >= mandate.minMerchantTrust, "block", `Merchant trust ${merchant.trust.score}/100 vs minimum ${mandate.minMerchantTrust}: ${merchant.trust.reasons.join("; ")}`);
  if (mandate.requireRefundPolicy) {
    add("refund_policy", Boolean(merchant.refundPolicy?.trim()), "block", merchant.refundPolicy?.trim() ? "Merchant publishes a refund policy" : "Merchant has no refund policy");
  }
  const scamText = `${merchant.deliveryPolicy} ${merchant.refundPolicy} ${product.name}`.toLowerCase();
  const scamSignals = ["friends & family", "friends and family", "gift card", "crypto only", "wire transfer", "all sales final", "95% off"].filter((s) => scamText.includes(s));
  add("scam_signals", scamSignals.length === 0, "block", scamSignals.length ? `Red flags: ${scamSignals.join(", ")}` : "No known scam phrases");
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

/** Trust score for a newly onboarded merchant, from facts we can check. */
export function scoreNewMerchant({ refundPolicy, deliveryPolicy, paypalEmail, aiRedFlags = [] }) {
  let score = 55; // new merchants start below the default minimum trust until they earn history
  const reasons = ["New merchant: no order history yet"];
  if (paypalEmail) { score += 10; reasons.push("PayPal payee email provided"); }
  if (refundPolicy?.trim()) { score += 10; reasons.push("Publishes a refund policy"); } else { score -= 15; reasons.push("No refund policy"); }
  if (deliveryPolicy?.trim()) { score += 5; reasons.push("States delivery terms"); }
  for (const flag of aiRedFlags) { score -= 15; reasons.push(`AI flagged: ${flag}`); }
  score = Math.max(0, Math.min(100, score));
  return { score, level: score >= 75 ? "high" : score >= 50 ? "medium" : "low", reasons };
}
