import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as store from "./store.js";
import * as guard from "./guard.js";
import * as paypal from "./paypal.js";
import * as ai from "./ai.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(here, "..", "public")));

store.load();

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

// ---------------------------------------------------------------- state

app.get("/api/state", (req, res) => {
  const d = store.data();
  res.json({
    modes: { ai: ai.aiMode, paypal: paypal.paypalMode },
    mandate: d.mandate,
    spentToday: store.spentToday(),
    merchants: d.merchants,
    orders: d.orders,
    events: d.events.slice(0, 100),
  });
});

app.put("/api/mandate", (req, res) => {
  const d = store.data();
  const m = req.body;
  for (const k of ["perOrderLimit", "dailyLimit", "askAbove", "minMerchantTrust"]) {
    if (m[k] !== undefined) d.mandate[k] = Math.max(0, Number(m[k]) || 0);
  }
  if (Array.isArray(m.allowedCategories)) d.mandate.allowedCategories = m.allowedCategories.map(String);
  if (m.requireRefundPolicy !== undefined) d.mandate.requireRefundPolicy = Boolean(m.requireRefundPolicy);
  store.log("mandate", "Spending mandate updated", { mandate: d.mandate });
  res.json(d.mandate);
});

app.post("/api/reset", (req, res) => {
  store.reset();
  res.json({ ok: true });
});

// Machine-readable feed that external AI agents can consume.
app.get("/api/agent-feed", (req, res) => {
  res.json({
    protocol: "agentready-feed/1",
    payment: { provider: "paypal", flow: "orders-v2-authorize-capture", currency: "USD" },
    merchants: store.data().merchants.map((m) => ({
      id: m.id, name: m.name, trust: m.trust.score, refundPolicy: m.refundPolicy, deliveryPolicy: m.deliveryPolicy,
      products: m.products.map(({ id, name, price, currency, category, deliveryDays, stock }) => ({ id, name, price, currency, category, deliveryDays, stock })),
    })),
  });
});

// ---------------------------------------------------------------- merchant onboarding

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<(br|p|div|li|h\d|tr)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#8377;|&#x20b9;/gi, "₹")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}

app.post("/api/merchants/preview", wrap(async (req, res) => {
  let { text = "", url = "" } = req.body;
  let note;
  if (url) {
    if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: "URL must start with http:// or https://" });
    const r = await fetch(url, { headers: { "User-Agent": "AgentReady/1.0" }, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return res.status(400).json({ error: `Could not fetch ${url} (${r.status})` });
    text = `${htmlToText(await r.text())}\n${text}`;
  }
  if (!text.trim()) return res.status(400).json({ error: "Paste your shop text or give a URL" });
  const LIMIT = 60_000;
  if (text.length > LIMIT) {
    note = `Your page is long, so only the first ${LIMIT.toLocaleString()} characters were read.`;
    text = text.slice(0, LIMIT);
  }
  const catalog = await ai.extractCatalog(text);
  res.json({ catalog, note });
}));

app.post("/api/merchants", (req, res) => {
  const { catalog, paypalEmail = "" } = req.body;
  if (!catalog?.name || !Array.isArray(catalog.products) || !catalog.products.length) {
    return res.status(400).json({ error: "Catalog needs a name and at least one product" });
  }
  const trust = guard.scoreNewMerchant({ ...catalog, paypalEmail, aiRedFlags: catalog.redFlags || [] });
  const m = {
    id: store.id("m"),
    name: String(catalog.name).slice(0, 80),
    source: catalog.engine || "manual",
    paypalEmail: String(paypalEmail).trim(),
    city: catalog.city || "",
    categories: catalog.categories || [],
    refundPolicy: catalog.refundPolicy || "",
    deliveryPolicy: catalog.deliveryPolicy || "",
    onboardedAt: new Date().toISOString(),
    completedOrders: 0,
    disputes: 0,
    trust,
    products: catalog.products.map((p) => ({
      id: store.id("p"),
      name: String(p.name).slice(0, 120),
      price: Math.max(0.01, +Number(p.price).toFixed(2)),
      currency: "USD",
      category: p.category || "other",
      deliveryDays: Math.max(0, parseInt(p.deliveryDays) || 3),
      stock: Math.max(0, parseInt(p.stock ?? 10) || 10),
      tags: (p.tags || []).map(String),
    })),
  };
  store.data().merchants.push(m);
  store.log("merchant", `${m.name} is now agent-ready with ${m.products.length} products (trust ${trust.score})`, { merchantId: m.id });
  res.json(m);
});

// ---------------------------------------------------------------- shopper agent + PayPal

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

app.post("/api/agent/run", wrap(async (req, res) => {
  const goal = String(req.body.goal || "").trim();
  if (!goal) return res.status(400).json({ error: "Tell the agent what to buy" });
  store.log("agent", `Agent goal: ${goal}`);
  const run = await ai.runShopper(goal);
  for (const c of run.checks) {
    if (c.decision === "block") store.log("guard", `Blocked ${c.productName} from ${c.merchantName}`, { checks: c.checks });
  }
  let order = null;
  if (run.checkout) {
    const found = store.product(run.checkout.product_id);
    // Re-evaluate at commit time: the guard result the model saw could be stale.
    const verdict = guard.evaluate({ productId: run.checkout.product_id, quantity: run.checkout.quantity, deadlineDays: run.checkout.deadline_days || undefined });
    if (verdict.decision !== "block" && found) {
      order = {
        id: store.id("ord"),
        createdAt: new Date().toISOString(),
        goal,
        productId: found.product.id,
        productName: found.product.name,
        merchantId: found.merchant.id,
        merchantName: found.merchant.name,
        quantity: run.checkout.quantity,
        amount: verdict.amount,
        reason: run.checkout.reason,
        guardDecision: verdict.decision,
        checks: verdict.checks,
        status: verdict.decision === "ask" ? "NEEDS_USER_OK" : "PENDING",
        engine: run.engine,
      };
      store.data().orders.unshift(order);
      if (order.status === "PENDING") await createPaypalOrder(order);
      else store.log("guard", `Purchase of ${order.productName} ($${order.amount}) needs your OK`, { orderId: order.id });
      store.save();
    }
  }
  res.json({ ...run, order });
}));

app.post("/api/orders/:id/confirm", wrap(async (req, res) => {
  const o = store.order(req.params.id);
  if (!o) return res.status(404).json({ error: "Order not found" });
  if (o.status !== "NEEDS_USER_OK") return res.status(409).json({ error: `Order is ${o.status}` });
  store.log("user", `You approved ${o.productName} ($${o.amount}) above the auto-approve threshold`, { orderId: o.id });
  res.json(await createPaypalOrder(o));
}));

app.post("/api/orders/:id/decline", (req, res) => {
  const o = store.order(req.params.id);
  if (!o) return res.status(404).json({ error: "Order not found" });
  o.status = "DECLINED";
  store.log("user", `You declined ${o.productName}`, { orderId: o.id });
  res.json(o);
});

// Buyer comes back from PayPal after approving: hold the funds (authorize).
app.get("/paypal/return", wrap(async (req, res) => {
  const o = store.order(String(req.query.token || ""));
  if (!o) return res.redirect("/?msg=unknown-order#orders");
  if (o.status === "AWAITING_APPROVAL") {
    const pp = await paypal.authorizeOrder(o.paypalOrderId);
    const auth = pp.purchase_units?.[0]?.payments?.authorizations?.[0];
    o.authorizationId = auth?.id;
    o.status = "AUTHORIZED";
    o.payer = pp.payer?.email_address || "sandbox buyer";
    store.log("paypal", `Funds held: authorization ${auth?.id} for $${o.amount}. Merchant can now fulfil.`, { orderId: o.id });
    const m = store.merchant(o.merchantId);
    const p = m?.products.find((x) => x.id === o.productId);
    if (p) p.stock = Math.max(0, p.stock - o.quantity);
    store.save();
  }
  res.redirect(`/?paid=${o.id}#orders`);
}));

app.get("/paypal/cancel", (req, res) => {
  const o = store.order(String(req.query.token || ""));
  if (o && o.status === "AWAITING_APPROVAL") {
    o.status = "CANCELLED";
    store.log("paypal", `Buyer cancelled at PayPal for ${o.productName}`, { orderId: o.id });
  }
  res.redirect("/#orders");
});

// Merchant marks delivered -> capture the held funds.
app.post("/api/orders/:id/fulfil", wrap(async (req, res) => {
  const o = store.order(req.params.id);
  if (!o) return res.status(404).json({ error: "Order not found" });
  if (o.status !== "AUTHORIZED") return res.status(409).json({ error: `Order is ${o.status}` });
  const cap = await paypal.captureAuthorization(o.authorizationId);
  o.captureId = cap.id;
  o.status = "CAPTURED";
  o.fulfilledAt = new Date().toISOString();
  const m = store.merchant(o.merchantId);
  if (m) m.completedOrders += 1;
  store.log("paypal", `Captured $${o.amount} to ${o.merchantName} (capture ${cap.id})`, { orderId: o.id });
  res.json(o);
}));

app.post("/api/orders/:id/void", wrap(async (req, res) => {
  const o = store.order(req.params.id);
  if (!o) return res.status(404).json({ error: "Order not found" });
  if (o.status !== "AUTHORIZED") return res.status(409).json({ error: `Order is ${o.status}` });
  await paypal.voidAuthorization(o.authorizationId);
  o.status = "VOIDED";
  store.log("paypal", `Released the hold on $${o.amount} for ${o.productName}`, { orderId: o.id });
  res.json(o);
}));

app.post("/api/orders/:id/refund", wrap(async (req, res) => {
  const o = store.order(req.params.id);
  if (!o) return res.status(404).json({ error: "Order not found" });
  if (o.status !== "CAPTURED") return res.status(409).json({ error: `Order is ${o.status}` });
  const r = await paypal.refundCapture(o.captureId, o.amount, "USD", req.body?.note || "Refund from AgentReady");
  o.refundId = r.id;
  o.status = "REFUNDED";
  const m = store.merchant(o.merchantId);
  if (m) m.disputes += 1;
  store.log("paypal", `Refunded $${o.amount} for ${o.productName} (refund ${r.id})`, { orderId: o.id });
  res.json(o);
}));

// ---------------------------------------------------------------- simulated PayPal approval page

app.get("/sim/approve", (req, res) => {
  const o = store.order(String(req.query.token || ""));
  if (!o) return res.status(404).send("Unknown order");
  res.send(`<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
<title>Simulated PayPal approval</title>
<body style="font-family:system-ui;max-width:420px;margin:60px auto;padding:0 16px;color:#111">
<p style="background:#fff4cc;padding:10px;border-radius:8px;font-size:14px">Simulated PayPal: no PayPal sandbox keys are configured, so this page stands in for the PayPal approval screen. Add keys in <code>.env</code> to use the real sandbox.</p>
<h2>Approve payment</h2><p><b>$${o.amount.toFixed(2)}</b> to ${o.merchantName}<br>${o.quantity} × ${o.productName}</p>
<form method=post action="/sim/approve?token=${o.paypalOrderId}"><button style="background:#0070ba;color:#fff;border:0;padding:12px 24px;border-radius:24px;font-size:16px">Approve with PayPal</button></form>
<p><a href="/paypal/cancel?token=${o.paypalOrderId}">Cancel</a></p></body>`);
});

app.post("/sim/approve", (req, res) => {
  const token = String(req.query.token || "");
  paypal.simulateApproval(token);
  res.redirect(`/paypal/return?token=${encodeURIComponent(token)}`);
});

app.listen(PORT, () => {
  console.log(`AgentReady running at http://localhost:${PORT}  (AI: ${ai.aiMode}, PayPal: ${paypal.paypalMode})`);
});
