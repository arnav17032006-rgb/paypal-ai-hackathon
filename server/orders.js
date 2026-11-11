// Order lifecycle shared by the built-in agent, MCP agents, PayPal redirects and webhooks.
// Limits and trust can change while an order waits, so the guard decides three times: when the agent
// checks out, when the owner OKs a waiting order, and just before funds are held.
// Once funds are held the decision is made; capturing only settles it.

import * as store from "./store.js";
import * as guard from "./guard.js";
import * as paypal from "./paypal.js";

export class OrderStateError extends Error {
  constructor(o, wanted) {
    super(`Order is ${o.status}, expected ${wanted}`);
    this.status = 409;
  }
}

export class GuardBlockedError extends Error {
  constructor(o, rules) {
    super(`The guard now blocks ${o.productName}: ${rules}`);
    this.status = 409;
  }
}

/** The guard's verdict on an existing order, without counting the order against its own limits. */
const recheck = (o) => guard.evaluate({ productId: o.productId, quantity: o.quantity, excludeOrderId: o.id });
const blockedRules = (verdict) => verdict.checks.filter((c) => c.severity === "block").map((c) => c.rule.replace(/_/g, " ")).join(", ");

// The PayPal return redirect and a webhook can race for the same order; only one may act on it.
const busy = new Set();
async function exclusive(o, fn) {
  if (busy.has(o.id)) return o;
  busy.add(o.id);
  try { return await fn(); } finally { busy.delete(o.id); }
}

async function createPaypalOrder(o) {
  const m = store.merchant(o.merchantId);
  const pp = await paypal.createOrder({
    orderRef: o.id,
    amount: o.amount,
    currency: "USD",
    description: `${o.quantity} x ${o.productName}`,
    merchantEmail: m?.paypalEmail,
    merchantName: m?.name,
  });
  o.paypalOrderId = pp.id;
  o.approveUrl = paypal.approveLink(pp);
  o.status = "AWAITING_APPROVAL";
  store.log("paypal", `PayPal order ${pp.id} created for $${o.amount} (${o.productName})`, { orderId: o.id });
  store.save();
  return o;
}

/**
 * Claim the budget and stock, then create the PayPal order. The claim is taken before the first await, so a
 * parallel checkout sees it. If PayPal fails, the order falls back to `onFailure`, which releases the claim.
 */
async function commit(o, onFailure) {
  o.status = "PENDING";
  o.committedAt = new Date().toISOString();
  try {
    return await createPaypalOrder(o);
  } catch (err) {
    o.status = onFailure;
    store.log("paypal", `Could not create the PayPal order for ${o.productName}: ${err.message}`, { orderId: o.id });
    throw err;
  }
}

/**
 * Turn an agent's checkout into an order. The guard is re-run here: what the agent saw may be stale.
 * Returns the order (null when blocked) and the guard verdict.
 */
export async function placeOrder({ productId, quantity = 1, deadlineDays, reason = "", goal = "", engine, channel = "web agent" }) {
  const found = store.product(productId);
  const verdict = guard.evaluate({ productId, quantity, deadlineDays: deadlineDays || undefined });
  if (verdict.decision === guard.DECISION.BLOCK || !found) {
    if (channel !== "web agent") {
      // The web agent's blocks are logged and counted by its own run, which sees every candidate it tried.
      store.log("guard", `Blocked ${found?.product.name || productId} for ${channel}`, { checks: verdict.checks });
      store.recordMiss(verdict, channel);
    }
    return { order: null, verdict };
  }
  const order = {
    id: store.id("ord"),
    createdAt: new Date().toISOString(),
    goal,
    channel,
    productId: found.product.id,
    productName: found.product.name,
    merchantId: found.merchant.id,
    merchantName: found.merchant.name,
    quantity,
    amount: verdict.amount,
    reason,
    guardDecision: verdict.decision,
    checks: verdict.checks,
    status: verdict.decision === guard.DECISION.ASK ? "NEEDS_USER_OK" : "PENDING",
    engine,
  };
  store.data().orders.unshift(order);
  if (order.status === "PENDING") await commit(order, "FAILED");
  else store.log("guard", `Purchase of ${order.productName} ($${order.amount}) for ${channel} needs your OK`, { orderId: order.id });
  store.save();
  return { order, verdict };
}

/** The owner OKed a waiting order. If the guard now blocks it, it keeps waiting: the owner can change the rules or decline. */
export async function confirm(o) {
  if (o.status !== "NEEDS_USER_OK") throw new OrderStateError(o, "NEEDS_USER_OK");
  const verdict = recheck(o);
  o.checks = verdict.checks;
  if (verdict.decision === guard.DECISION.BLOCK) {
    const rules = blockedRules(verdict);
    store.log("guard", `Blocked your approval of ${o.productName} ($${o.amount}): ${rules}`, { orderId: o.id, checks: verdict.checks });
    store.recordMiss(verdict, o.channel);
    throw new GuardBlockedError(o, rules);
  }
  store.log("user", `You approved ${o.productName} ($${o.amount}) above the auto-approve threshold`, { orderId: o.id });
  return commit(o, "NEEDS_USER_OK");
}

/** Buyer approved at PayPal: place the hold. `via` says who noticed (redirect or webhook). */
export function authorize(o, via) {
  return exclusive(o, async () => {
    if (o.status !== "AWAITING_APPROVAL") return o;
    const verdict = recheck(o);
    if (verdict.decision === guard.DECISION.BLOCK) {
      // Without an authorization PayPal holds nothing, so stopping here means no money moves.
      o.status = "BLOCKED";
      o.checks = verdict.checks;
      store.recordMiss(verdict, o.channel);
      store.log("guard", `Blocked ${o.productName} ($${o.amount}) after the buyer approved it, so no funds were held: ${blockedRules(verdict)}`, { orderId: o.id, checks: verdict.checks });
      return o;
    }
    const pp = await paypal.authorizeOrder(o.paypalOrderId);
    const auth = pp.purchase_units?.[0]?.payments?.authorizations?.[0];
    o.authorizationId = auth?.id;
    o.status = "AUTHORIZED";
    o.committedAt = new Date().toISOString(); // an old link approved today spends today's budget
    o.payer = pp.payer?.email_address || "sandbox buyer";
    const p = store.merchant(o.merchantId)?.products.find((x) => x.id === o.productId);
    if (p) p.stock = Math.max(0, p.stock - o.quantity);
    store.log("paypal", `Funds held: authorization ${auth?.id} for $${o.amount} (seen via ${via}). Merchant can now fulfil.`, { orderId: o.id });
    return o;
  });
}

/** Merchant marked it delivered: capture the hold. */
export function capture(o) {
  return exclusive(o, async () => {
    if (o.status !== "AUTHORIZED") throw new OrderStateError(o, "AUTHORIZED");
    const cap = await paypal.captureAuthorization(o.authorizationId);
    markCaptured(o, cap.id, "AgentReady");
    return o;
  });
}

export function markCaptured(o, captureId, via) {
  o.captureId = captureId;
  o.status = "CAPTURED";
  o.fulfilledAt = new Date().toISOString();
  const m = store.merchant(o.merchantId);
  if (m) m.completedOrders += 1;
  store.log("paypal", `Captured $${o.amount} to ${o.merchantName} (capture ${captureId}, via ${via})`, { orderId: o.id });
}

export function release(o) {
  return exclusive(o, async () => {
    if (o.status !== "AUTHORIZED") throw new OrderStateError(o, "AUTHORIZED");
    await paypal.voidAuthorization(o.authorizationId);
    o.status = "VOIDED";
    store.log("paypal", `Released the hold on $${o.amount} for ${o.productName}`, { orderId: o.id });
    return o;
  });
}

export function refund(o, note) {
  return exclusive(o, async () => {
    if (o.status !== "CAPTURED") throw new OrderStateError(o, "CAPTURED");
    const r = await paypal.refundCapture(o.captureId, o.amount, "USD", note || "Refund from AgentReady");
    o.refundId = r.id;
    o.status = "REFUNDED";
    const m = store.merchant(o.merchantId);
    if (m) m.disputes += 1;
    store.log("paypal", `Refunded $${o.amount} for ${o.productName} (refund ${r.id})`, { orderId: o.id });
    return o;
  });
}
