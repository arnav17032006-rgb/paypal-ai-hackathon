import "dotenv/config";
import express from "express";
import dns from "node:dns/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as store from "./store.js";
import * as guard from "./guard.js";
import * as paypal from "./paypal.js";
import * as ai from "./ai.js";
import * as orders from "./orders.js";
import * as webhooks from "./webhooks.js";
import * as toolkit from "./toolkit.js";
import * as mcp from "./mcp.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const app = express();
app.use(express.json({
  limit: "1mb",
  // Webhook signatures are checked against the exact bytes PayPal sent.
  verify: (req, _res, buf) => { if (req.originalUrl.startsWith("/api/webhooks/")) req.rawBody = buf.toString("utf8"); },
}));
app.use(express.static(path.join(here, "..", "public")));

store.load();

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
  if (!err.status) console.error(err);
  res.status(err.status || 500).json({ error: err.message });
});

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// ---------------------------------------------------------------- state

app.get("/api/state", (req, res) => {
  const d = store.data();
  res.json({
    modes: { ai: ai.aiMode, paypal: paypal.paypalMode, webhooks: webhooks.webhookMode, toolkit: toolkit.toolkitReady },
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
    mcp: { transport: "streamable-http", path: "/mcp" },
    payment: { provider: "paypal", flow: "orders-v2-authorize-capture", currency: "USD" },
    merchants: store.data().merchants.map((m) => ({
      id: m.id, name: m.name, trust: m.trust.score, refundPolicy: m.refundPolicy, deliveryPolicy: m.deliveryPolicy,
      products: m.products.map(({ id, name, price, currency, category, deliveryDays, stock }) => ({ id, name, price, currency, category, deliveryDays, stock })),
    })),
  });
});

mcp.mount(app);

// ---------------------------------------------------------------- merchant onboarding

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--([\s\S]*?)-->/g, "\n$1\n") // comments are where hidden agent instructions like to live: keep them for the scan
    .replace(/<(br|p|div|li|h\d|tr)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#8377;|&#x20b9;/gi, "₹")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v6 = ip.toLowerCase();
  return v6 === "::1" || v6 === "::" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80") || (v6.startsWith("::ffff:") && isPrivateAddress(v6.slice(7)));
}

/** Fetch a merchant's public page without letting the URL reach our own network. */
async function fetchPublicPage(url) {
  for (let hop = 0; hop < 4; hop++) {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) throw Object.assign(new Error("URL must start with http:// or https://"), { status: 400 });
    const { address } = await dns.lookup(u.hostname);
    if (isPrivateAddress(address)) throw Object.assign(new Error("That URL points to a private network address"), { status: 400 });
    const r = await fetch(u, { headers: { "User-Agent": "AgentReady/1.0" }, redirect: "manual", signal: AbortSignal.timeout(10_000) });
    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) { url = new URL(r.headers.get("location"), u).href; continue; }
    if (!r.ok) throw Object.assign(new Error(`Could not fetch ${u.href} (${r.status})`), { status: 400 });
    return r.text();
  }
  throw Object.assign(new Error("Too many redirects"), { status: 400 });
}

// Extracted catalogs wait here between preview and publish, so the trust score is computed from what the
// server read, never from a catalog the browser sends back.
const drafts = new Map();
const DRAFT_TTL = 60 * 60 * 1000;

app.post("/api/merchants/preview", wrap(async (req, res) => {
  let { text = "", url = "", paypalEmail = "" } = req.body;
  let note;
  if (url) text = `${htmlToText(await fetchPublicPage(url))}\n${text}`;
  if (!text.trim()) return res.status(400).json({ error: "Paste your shop text or give a URL" });
  const LIMIT = 60_000;
  if (text.length > LIMIT) {
    note = `Your page is long, so only the first ${LIMIT.toLocaleString()} characters were read.`;
    text = text.slice(0, LIMIT);
  }
  const catalog = await ai.extractCatalog(text);
  for (const [k, v] of drafts) if (Date.now() - v.createdAt > DRAFT_TTL) drafts.delete(k);
  const draftId = store.id("draft");
  drafts.set(draftId, { catalog, sourceText: text, createdAt: Date.now() });
  const trust = guard.scoreNewMerchant({ ...catalog, paypalEmail, aiRedFlags: catalog.redFlags || [], sourceText: text });
  res.json({ draftId, catalog, note, trust });
}));

app.post("/api/merchants", (req, res) => {
  const { draftId, products: edits = [], paypalEmail = "" } = req.body;
  const draft = drafts.get(draftId);
  if (!draft) return res.status(400).json({ error: "Extract your catalog first (drafts expire after an hour), then publish" });
  const { catalog, sourceText } = draft;
  // Only names, prices and delivery days are editable; policies and red flags stay as the server read them.
  const products = catalog.products.map((p, i) => {
    const e = edits[i] || {};
    return { ...p, name: e.name ?? p.name, price: e.price ?? p.price, deliveryDays: e.deliveryDays ?? p.deliveryDays };
  }).filter((p) => String(p.name || "").trim());
  if (!catalog.name || !products.length) return res.status(400).json({ error: "Catalog needs a name and at least one product" });
  const trust = guard.scoreNewMerchant({
    ...catalog,
    paypalEmail,
    aiRedFlags: catalog.redFlags || [],
    sourceText: [sourceText, ...products.map((p) => p.name)].join("\n"), // edited names are scanned too
  });
  const m = {
    id: store.id("m"),
    name: String(catalog.name).slice(0, 80),
    source: catalog.engine || "manual",
    paypalEmail: String(paypalEmail).trim(),
    city: catalog.city || "",
    categories: catalog.categories || [],
    refundPolicy: trust.refundGrounded ? catalog.refundPolicy : "",
    deliveryPolicy: catalog.deliveryPolicy || "",
    onboardedAt: new Date().toISOString(),
    completedOrders: 0,
    disputes: 0,
    trust: { score: trust.score, level: trust.level, reasons: trust.reasons },
    flags: trust.flags.map((f) => f.id),
    products: products.map((p) => ({
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
  drafts.delete(draftId);
  store.data().merchants.push(m);
  store.log("merchant", `${m.name} is now agent-ready with ${m.products.length} products (trust ${trust.score})`, { merchantId: m.id });
  toolkit.syncCatalog(m).catch((err) => store.log("paypal", `PayPal catalog sync failed: ${err.message}`, { merchantId: m.id }));
  res.json(m);
});

// ---------------------------------------------------------------- shopper agent + PayPal

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
    ({ order } = await orders.placeOrder({
      productId: run.checkout.product_id,
      quantity: run.checkout.quantity,
      deadlineDays: run.checkout.deadline_days,
      reason: run.checkout.reason,
      goal,
      engine: run.engine,
    }));
  }
  res.json({ ...run, order });
}));

const findOrder = (req) => {
  const o = store.order(req.params.id);
  if (!o) throw Object.assign(new Error("Order not found"), { status: 404 });
  return o;
};

app.post("/api/orders/:id/confirm", wrap(async (req, res) => res.json(await orders.confirm(findOrder(req)))));

app.post("/api/orders/:id/decline", wrap(async (req, res) => {
  const o = findOrder(req);
  if (o.status !== "NEEDS_USER_OK") return res.status(409).json({ error: `Order is ${o.status}` });
  o.status = "DECLINED";
  store.log("user", `You declined ${o.productName}`, { orderId: o.id });
  res.json(o);
}));

// Buyer comes back from PayPal after approving: hold the funds (authorize).
app.get("/paypal/return", wrap(async (req, res) => {
  const o = store.order(String(req.query.token || ""));
  if (!o) return res.redirect("/?msg=unknown-order#orders");
  await orders.authorize(o, "return redirect");
  res.redirect(`/?${o.status === "BLOCKED" ? "blocked" : "paid"}=${o.id}#orders`);
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
app.post("/api/orders/:id/fulfil", wrap(async (req, res) => res.json(await orders.capture(findOrder(req)))));
app.post("/api/orders/:id/void", wrap(async (req, res) => res.json(await orders.release(findOrder(req)))));
app.post("/api/orders/:id/refund", wrap(async (req, res) => res.json(await orders.refund(findOrder(req), req.body?.note))));

// ---------------------------------------------------------------- webhooks + money assistant

app.post("/api/webhooks/paypal", wrap(webhooks.receive));

app.post("/api/assistant", wrap(async (req, res) => {
  const question = String(req.body.question || "").trim().slice(0, 500);
  if (!question) return res.status(400).json({ error: "Ask a question about your money" });
  res.json(await ai.askAboutMoney(question));
}));

// ---------------------------------------------------------------- simulated PayPal (no keys)

app.post("/api/sim/webhook", wrap(async (req, res) => {
  if (paypal.paypalMode !== "simulated") return res.status(404).json({ error: "Only available with the PayPal simulator" });
  const o = store.order(String(req.body.orderId || ""));
  if (!o) return res.status(404).json({ error: "Order not found" });
  res.json(await webhooks.simulate(o, req.body.kind));
}));

app.get("/sim/approve", (req, res) => {
  const o = store.order(String(req.query.token || ""));
  if (!o) return res.status(404).send("Unknown order");
  const token = encodeURIComponent(o.paypalOrderId);
  res.send(`<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
<title>Simulated PayPal approval</title>
<body style="font-family:system-ui;max-width:420px;margin:60px auto;padding:0 16px;color:#111">
<p style="background:#fff4cc;padding:10px;border-radius:8px;font-size:14px">Simulated PayPal: no PayPal sandbox keys are configured, so this page stands in for the PayPal approval screen. Add keys in <code>.env</code> to use the real sandbox.</p>
<h2>Approve payment</h2><p><b>$${o.amount.toFixed(2)}</b> to ${esc(o.merchantName)}<br>${o.quantity} × ${esc(o.productName)}</p>
<form method=post action="/sim/approve?token=${token}"><button style="background:#0070ba;color:#fff;border:0;padding:12px 24px;border-radius:24px;font-size:16px">Approve with PayPal</button></form>
<p><a href="/paypal/cancel?token=${token}">Cancel</a></p></body>`);
});

app.post("/sim/approve", (req, res) => {
  const token = String(req.query.token || "");
  paypal.simulateApproval(token);
  res.redirect(`/paypal/return?token=${encodeURIComponent(token)}`);
});
