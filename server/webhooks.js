// PayPal webhooks: PayPal tells us about money movements we didn't start, or whose redirect never came back
// (the buyer approved and closed the tab, a hold expired, a refund or dispute was opened on paypal.com).
// Events are only trusted after PayPal itself verifies the signature, and each event id is handled once.

import * as store from "./store.js";
import * as guard from "./guard.js";
import * as paypal from "./paypal.js";
import * as orders from "./orders.js";

const WEBHOOK_ID = process.env.PAYPAL_WEBHOOK_ID || "";

/** "verified" (sandbox + webhook id), "off" (sandbox without one) or "simulated" (no PayPal keys). */
export const webhookMode = paypal.paypalMode === "sandbox" ? (WEBHOOK_ID ? "verified" : "off") : "simulated";

/** Express handler for POST /api/webhooks/paypal. Needs req.rawBody (see app.js). */
export async function receive(req, res) {
  if (webhookMode !== "verified") {
    return res.status(503).json({ error: "Webhooks need PayPal sandbox keys and PAYPAL_WEBHOOK_ID; unverified events are refused" });
  }
  const ok = await paypal.verifyWebhookSignature(req.headers, req.rawBody || "", WEBHOOK_ID);
  if (!ok) {
    store.log("webhook", `Rejected a webhook with an invalid PayPal signature (${req.body?.event_type || "unknown type"})`);
    return res.status(400).json({ error: "Invalid signature" });
  }
  res.json(await handleEvent(req.body));
}

const related = (resource) => resource?.supplementary_data?.related_ids || {};
const upLink = (resource) => resource?.links?.find((l) => l.rel === "up")?.href?.split("/").pop();

/** Apply one PayPal event to our orders. Safe to call twice with the same event. */
export async function handleEvent(event, { simulated = false } = {}) {
  const seen = store.data().webhookEvents;
  if (seen.includes(event.id)) return { ok: true, duplicate: true };

  const r = event.resource || {};
  const tag = simulated ? "Simulated PayPal webhook" : "PayPal webhook";
  const note = (o, msg) => store.log("webhook", `${tag} ${event.event_type}: ${msg}`, { orderId: o?.id, eventId: event.id });
  let o;

  switch (event.event_type) {
    case "CHECKOUT.ORDER.APPROVED":
      o = store.order(r.id);
      if (o?.status === "AWAITING_APPROVAL") {
        await orders.authorize(o, "webhook");
        note(o, o.status === "BLOCKED"
          ? `buyer approved ${o.productName}, but the guard now blocks it, so no hold was placed`
          : `buyer approved ${o.productName} without returning to AgentReady, so the hold was placed from here`);
      } else if (o) note(o, `already handled (${o.status})`);
      break;

    case "PAYMENT.AUTHORIZATION.CREATED":
      o = store.order(related(r).order_id || "");
      if (o) note(o, `PayPal confirmed the $${r.amount?.value ?? o.amount} hold`);
      break;

    case "PAYMENT.AUTHORIZATION.VOIDED":
      o = store.findOrder((x) => x.authorizationId === r.id);
      if (o?.status === "AUTHORIZED") {
        o.status = "VOIDED";
        note(o, `the hold for ${o.productName} was voided at PayPal (expired or voided outside AgentReady)`);
      }
      break;

    case "PAYMENT.CAPTURE.COMPLETED":
      o = store.findOrder((x) => x.captureId === r.id || x.authorizationId === related(r).authorization_id || x.paypalOrderId === related(r).order_id);
      if (o?.status === "AUTHORIZED") orders.markCaptured(o, r.id, "webhook");
      if (o) note(o, `PayPal confirmed capture ${r.id}`);
      break;

    case "PAYMENT.CAPTURE.DENIED":
      o = store.findOrder((x) => x.authorizationId === related(r).authorization_id || x.paypalOrderId === related(r).order_id);
      if (o && o.status !== "CAPTURE_DENIED") {
        o.status = "CAPTURE_DENIED";
        note(o, `PayPal denied the capture for ${o.productName}`);
      }
      break;

    case "PAYMENT.CAPTURE.REFUNDED":
    case "PAYMENT.CAPTURE.REVERSED": {
      const captureId = event.event_type === "PAYMENT.CAPTURE.REVERSED" ? r.id : upLink(r);
      o = store.findOrder((x) => x.captureId === captureId);
      if (o?.status === "CAPTURED") {
        o.status = "REFUNDED";
        const m = store.merchant(o.merchantId);
        if (m) {
          m.disputes += 1;
          if (event.event_type === "PAYMENT.CAPTURE.REVERSED") guard.penalize(m, 15, `Chargeback on ${o.productName}`);
        }
        note(o, `money for ${o.productName} went back to the buyer outside AgentReady`);
      }
      break;
    }

    case "CUSTOMER.DISPUTE.CREATED": {
      const captureIds = (r.disputed_transactions || []).map((t) => t.seller_transaction_id);
      o = store.findOrder((x) => captureIds.includes(x.captureId));
      if (o && !o.disputeId) {
        o.disputeId = r.dispute_id;
        const m = store.merchant(o.merchantId);
        if (m) {
          m.disputes += 1;
          guard.penalize(m, 10, `Buyer opened dispute ${r.dispute_id} (${r.reason || "no reason given"})`);
          note(o, `buyer disputed ${o.productName}; ${m.name}'s trust drops to ${m.trust.score}`);
        }
      }
      break;
    }

    default:
      store.log("webhook", `${tag} ${event.event_type}: not used by AgentReady`, { eventId: event.id });
  }
  // Marked as seen only once it has worked: if handling throws, PayPal's retry must not be dropped as a duplicate.
  seen.push(event.id);
  if (seen.length > 1000) seen.splice(0, seen.length - 1000);
  store.save();
  return { ok: true, orderId: o?.id, status: o?.status };
}

/** Simulator only: build the event PayPal would send, and run it through the same handler. */
export async function simulate(o, kind) {
  const id = `WH-SIM-${store.id("evt").slice(4).toUpperCase()}`;
  if (kind === "approved") {
    if (o.status !== "AWAITING_APPROVAL") throw new orders.OrderStateError(o, "AWAITING_APPROVAL");
    paypal.simulateApproval(o.paypalOrderId);
    return handleEvent({ id, event_type: "CHECKOUT.ORDER.APPROVED", resource: { id: o.paypalOrderId, status: "APPROVED" } }, { simulated: true });
  }
  if (kind === "dispute") {
    if (o.status !== "CAPTURED") throw new orders.OrderStateError(o, "CAPTURED");
    return handleEvent({
      id,
      event_type: "CUSTOMER.DISPUTE.CREATED",
      resource: {
        dispute_id: `PP-D-${Math.floor(Math.random() * 1e5)}`,
        reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
        disputed_transactions: [{ seller_transaction_id: o.captureId }],
      },
    }, { simulated: true });
  }
  throw new Error(`Unknown simulated event ${kind}`);
}
