// PayPal Orders v2 + Refunds client (sandbox by default).
// When PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are not set, a local simulator
// with the same response shapes is used so the app still runs end to end.

import crypto from "node:crypto";

const BASE = process.env.PAYPAL_API_BASE || "https://api-m.sandbox.paypal.com";
const CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const SECRET = process.env.PAYPAL_CLIENT_SECRET;
const APP_URL = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;

export const paypalMode = CLIENT_ID && SECRET ? "sandbox" : "simulated";

let cachedToken = null;

async function accessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${CLIENT_ID}:${SECRET}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`PayPal auth failed (${res.status}): ${await res.text()}`);
  const json = await res.json();
  cachedToken = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  return cachedToken.value;
}

async function api(method, path, body, requestId) {
  const headers = {
    Authorization: `Bearer ${await accessToken()}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };
  // Idempotency key: retries of the same agent action never double-charge.
  if (requestId) headers["PayPal-Request-Id"] = requestId;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const detail = json.details?.[0]?.description || json.message || text;
    throw new Error(`PayPal ${method} ${path} failed (${res.status}): ${detail}`);
  }
  return json;
}

// ---------- simulator ----------
const sim = new Map();
const simId = (p) => p + crypto.randomBytes(8).toString("hex").toUpperCase().slice(0, 13);

function simCreate(body) {
  const id = simId("SIM");
  const order = {
    id,
    intent: body.intent,
    status: "CREATED",
    purchase_units: body.purchase_units,
    links: [{ rel: "approve", href: `${APP_URL}/sim/approve?token=${id}`, method: "GET" }],
  };
  sim.set(id, order);
  return structuredClone(order);
}

function simGet(id) {
  const o = sim.get(id);
  if (!o) throw new Error(`Simulated order ${id} not found`);
  return o;
}
// ---------- end simulator ----------

/**
 * Create an order with intent AUTHORIZE: the buyer approves, funds are held,
 * and we only capture after the trust guard and the merchant are both satisfied.
 * Money goes directly to the merchant's PayPal account via `payee`.
 */
export async function createOrder({ orderRef, amount, currency, description, merchantEmail, merchantName }) {
  const body = {
    intent: "AUTHORIZE",
    purchase_units: [
      {
        reference_id: orderRef,
        description: description.slice(0, 127),
        custom_id: orderRef,
        amount: { currency_code: currency, value: amount.toFixed(2) },
        ...(merchantEmail ? { payee: { email_address: merchantEmail } } : {}),
        soft_descriptor: merchantName?.replace(/[^A-Za-z0-9 ]/g, "").slice(0, 22) || undefined,
      },
    ],
    payment_source: {
      paypal: {
        experience_context: {
          brand_name: "AgentReady",
          user_action: "CONTINUE",
          shipping_preference: "NO_SHIPPING",
          return_url: `${APP_URL}/paypal/return`,
          cancel_url: `${APP_URL}/paypal/cancel`,
        },
      },
    },
  };
  if (paypalMode === "simulated") return simCreate(body);
  return api("POST", "/v2/checkout/orders", body, `create-${orderRef}`);
}

export async function getOrder(id) {
  if (paypalMode === "simulated") return structuredClone(simGet(id));
  return api("GET", `/v2/checkout/orders/${id}`);
}

export function approveLink(order) {
  return order.links?.find((l) => l.rel === "approve" || l.rel === "payer-action")?.href;
}

/** After buyer approval: place a hold on the funds. Returns the authorization id. */
export async function authorizeOrder(id) {
  if (paypalMode === "simulated") {
    const o = simGet(id);
    if (o.status !== "APPROVED") throw new Error(`Order ${id} is ${o.status}, not APPROVED`);
    o.status = "COMPLETED";
    const auth = { id: simId("AUTH"), status: "CREATED", amount: o.purchase_units[0].amount };
    o.purchase_units[0].payments = { authorizations: [auth] };
    return structuredClone(o);
  }
  return api("POST", `/v2/checkout/orders/${id}/authorize`, {}, `authorize-${id}`);
}

export async function captureAuthorization(authId) {
  if (paypalMode === "simulated") {
    return { id: simId("CAP"), status: "COMPLETED", authorization_id: authId };
  }
  return api("POST", `/v2/payments/authorizations/${authId}/capture`, { final_capture: true }, `capture-${authId}`);
}

export async function voidAuthorization(authId) {
  if (paypalMode === "simulated") return { id: authId, status: "VOIDED" };
  await api("POST", `/v2/payments/authorizations/${authId}/void`, undefined, `void-${authId}`);
  return { id: authId, status: "VOIDED" };
}

export async function refundCapture(captureId, amount, currency, note) {
  if (paypalMode === "simulated") return { id: simId("REF"), status: "COMPLETED" };
  return api(
    "POST",
    `/v2/payments/captures/${captureId}/refund`,
    { amount: { value: amount.toFixed(2), currency_code: currency }, note_to_payer: note?.slice(0, 255) },
    `refund-${captureId}`,
  );
}

/** Simulator only: what the buyer's "Approve" click does on paypal.com. */
export function simulateApproval(id) {
  const o = simGet(id);
  if (o.status === "CREATED") o.status = "APPROVED";
  return o;
}
