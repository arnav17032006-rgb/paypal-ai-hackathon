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
import * as auth from "./auth.js";
import crypto from "node:crypto";

const here = path.dirname(fileURLToPath(import.meta.url));
export const app = express();
app.set("trust proxy", 1); // Render terminates HTTPS in front of us; this makes req.secure true there
app.use(express.json({
  limit: "1mb",
  // Webhook signatures are checked against the exact bytes PayPal sent.
  verify: (req, _res, buf) => { if (req.originalUrl.startsWith("/api/webhooks/")) req.rawBody = buf.toString("utf8"); },
}));
store.load();
app.use(auth.attachUser);

// The app needs a login; the login page is for people who aren't logged in.
app.get(["/", "/index.html"], (req, res, next) => (req.user ? next() : res.redirect("/login.html")));
app.get("/login.html", (req, res, next) => (req.user ? res.redirect("/") : next()));
app.use(express.static(path.join(here, "..", "public")));

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
  if (!err.status) console.error(err);
  res.status(err.status || 500).json({ error: err.message });
});

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// ---------------------------------------------------------------- accounts

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

app.post("/api/auth/signup", wrap(async (req, res) => {
  const name = String(req.body.name || "").trim().slice(0, 60);
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const role = String(req.body.role || "");
  if (!auth.ROLES.includes(role)) return res.status(400).json({ error: "Choose whether you are a buyer or a shop owner" });
  if (!name) return res.status(400).json({ error: "Enter your name" });
  if (!EMAIL_RE.test(email) || email.length > 120) return res.status(400).json({ error: "Enter a valid email address" });
  if (password.length < 8 || password.length > 200) return res.status(400).json({ error: "Use a password of at least 8 characters" });
  if (store.userByEmail(email)) return res.status(409).json({ error: "An account with this email already exists. Log in instead." });
  const u = {
    id: store.id("u"), role, name, email,
    passwordHash: await auth.hashPassword(password),
    createdAt: new Date().toISOString(),
  };
  if (role === "buyer") {
    // Every buyer starts with the default spending rules and their own key for outside agents.
    u.mandate = { ...structuredClone(store.data().mandate), owner: name };
    u.agentKey = crypto.randomBytes(24).toString("hex");
  } else {
    u.merchantIds = [];
  }
  store.data().users.push(u);
  auth.startSession(req, res, u);
  res.status(201).json(auth.publicUser(u));
}));

app.post("/api/auth/login", wrap(async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const role = String(req.body.role || "");
  const key = `${req.ip}|${email}`;
  if (auth.tooManyFailures(key)) return res.status(429).json({ error: "Too many failed attempts. Try again in 15 minutes." });
  const u = store.userByEmail(email);
  if (!u || u.demo || !(await auth.verifyPassword(password, u.passwordHash))) {
    auth.noteFailure(key);
    return res.status(401).json({ error: "Email or password is wrong" });
  }
  if (role && role !== u.role) {
    return res.status(403).json({ error: `This is a ${auth.roleName(u.role)} account. Choose "${u.role === "merchant" ? "Shop owner" : "Buyer"}" to log in.` });
  }
  auth.clearFailures(key);
  auth.startSession(req, res, u);
  res.json(auth.publicUser(u));
}));

// One-click demo accounts, so anyone can try both sides without signing up.
app.post("/api/auth/demo", (req, res) => {
  const u = store.user(req.body.role === "merchant" ? store.DEMO_OWNER : store.DEMO_BUYER);
  auth.startSession(req, res, u);
  res.json(auth.publicUser(u));
});

app.post("/api/auth/logout", (req, res) => {
  auth.endSession(req, res);
  res.json({ ok: true });
});

app.get("/api/auth/me", auth.requireUser, (req, res) => res.json(auth.publicUser(req.user)));

// ---------------------------------------------------------------- state

// Public and cheap: for Render's health check and CI's start-up check. No user data.
app.get("/api/health", (req, res) => res.json({ ok: true, modes: { ai: ai.aiMode, paypal: paypal.paypalMode, webhooks: webhooks.webhookMode } }));

const ownsAsBuyer = (u, o) => u.role === "buyer" && store.buyerOf(o) === u.id;
const ownsAsMerchant = (u, o) => u.role === "merchant" && store.shopsOf(u).includes(o.merchantId);

/**
 * What a buyer's current rules allow: the guard's verdict on one unit of every listed product.
 * It is the same code path as a real checkout, so the screen can never promise more than the guard will do.
 */
function coverageFor(buyerId) {
  return store.data().merchants.flatMap((m) => m.products.map((p) => {
    const v = guard.evaluate({ productId: p.id, quantity: 1, buyerId });
    return {
      productId: p.id, merchantId: m.id, decision: v.decision,
      reasons: v.checks.filter((c) => c.severity !== "pass").map(({ rule, severity, detail }) => ({ rule, severity, detail })),
    };
  }));
}

/** Each person sees only their side: a buyer their own orders and rules, a shop owner their own shops. */
app.get("/api/state", auth.requireUser, (req, res) => {
  const d = store.data();
  const u = req.user;
  const modes = { ai: ai.aiMode, paypal: paypal.paypalMode, webhooks: webhooks.webhookMode, toolkit: toolkit.toolkitReady };
  const orderOf = (e) => (e.orderId ? store.order(e.orderId) : null);
  if (u.role === "buyer") {
    const orders = d.orders.filter((o) => ownsAsBuyer(u, o));
    const events = d.events.filter((e) => e.buyerId === u.id || (orderOf(e) && ownsAsBuyer(u, orderOf(e))));
    return res.json({
      user: auth.publicUser(u), modes, mandate: store.mandateFor(u.id), spentToday: store.spentToday(undefined, u.id),
      merchants: d.merchants, orders, events: events.slice(0, 100), lostSales: [], coverage: coverageFor(u.id),
    });
  }
  const shops = store.shopsOf(u);
  const events = d.events.filter((e) => shops.includes(e.merchantId) || (orderOf(e) && ownsAsMerchant(u, orderOf(e))));
  res.json({
    user: auth.publicUser(u), modes,
    mandate: d.mandate, // the default shopper rules, so an owner can see the minimum trust most buyers start with
    spentToday: 0,
    merchants: d.merchants.filter((m) => shops.includes(m.id)),
    orders: d.orders.filter((o) => ownsAsMerchant(u, o)),
    events: events.slice(0, 100),
    lostSales: store.lostSales().filter((g) => shops.includes(g.merchantId)),
  });
});

app.put("/api/mandate", auth.requireRole("buyer"), (req, res) => {
  const mandate = store.mandateFor(req.user.id);
  const m = req.body;
  for (const k of ["perOrderLimit", "dailyLimit", "askAbove", "minMerchantTrust"]) {
    if (m[k] !== undefined) mandate[k] = Math.max(0, Number(m[k]) || 0);
  }
  if (Array.isArray(m.allowedCategories)) mandate.allowedCategories = m.allowedCategories.map(String);
  if (m.requireRefundPolicy !== undefined) mandate.requireRefundPolicy = Boolean(m.requireRefundPolicy);
  store.log("mandate", "Spending mandate updated", { mandate, buyerId: req.user.id });
  res.json(mandate);
});

// Resetting wipes everyone's orders, so only the shared demo accounts may do it.
app.post("/api/reset", auth.requireUser, (req, res) => {
  if (!req.user.demo) return res.status(403).json({ error: "Only the demo accounts can reset the demo data" });
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

// The landing page's live scanner: anyone can paste shop text and see what the guard's code scan finds.
// It never calls a model and stores nothing, and each address gets a small budget per minute.
const scanHits = new Map();
app.post("/api/public/scan", (req, res) => {
  const now = Date.now();
  const hits = (scanHits.get(req.ip) || []).filter((t) => now - t < 60_000);
  if (hits.length >= 30) return res.status(429).json({ error: "Too many scans. Try again in a minute." });
  scanHits.set(req.ip, [...hits, now]);
  if (scanHits.size > 5000) scanHits.clear();
  const text = String(req.body?.text || "").slice(0, 8000);
  if (!text.trim()) return res.status(400).json({ error: "Paste some shop text to scan" });
  const catalog = ai.extractCatalogRules(text);
  const trust = guard.scoreNewMerchant({ ...catalog, paypalEmail: "", aiRedFlags: [], sourceText: text });
  res.json({
    name: catalog.name,
    products: catalog.products.slice(0, 8).map(({ name, price }) => ({ name, price })),
    score: trust.score, level: trust.level, reasons: trust.reasons, flags: trust.flags,
    minimum: store.data().mandate.minMerchantTrust,
  });
});

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

app.post("/api/merchants/preview", auth.requireRole("merchant"), wrap(async (req, res) => {
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
  drafts.set(draftId, { catalog, sourceText: text, createdAt: Date.now(), ownerId: req.user.id });
  const trust = guard.scoreNewMerchant({ ...catalog, paypalEmail, aiRedFlags: catalog.redFlags || [], sourceText: text });
  res.json({ draftId, catalog, note, trust });
}));

app.post("/api/merchants", auth.requireRole("merchant"), (req, res) => {
  const { draftId, products: edits = [], paypalEmail = "" } = req.body;
  const found = drafts.get(draftId);
  const draft = found?.ownerId === req.user.id ? found : null;
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
    ownerId: req.user.id,
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
  req.user.merchantIds = [...(req.user.merchantIds || []), m.id];
  store.log("merchant", `${m.name} is now agent-ready with ${m.products.length} products (trust ${trust.score})`, { merchantId: m.id });
  toolkit.syncCatalog(m).catch((err) => store.log("paypal", `PayPal catalog sync failed: ${err.message}`, { merchantId: m.id }));
  res.json(m);
});

// ---------------------------------------------------------------- shopper agent + PayPal

app.post("/api/agent/run", auth.requireRole("buyer"), wrap(async (req, res) => {
  const goal = String(req.body.goal || "").trim();
  if (!goal) return res.status(400).json({ error: "Tell the agent what to buy" });
  const buyerId = req.user.id;
  store.log("agent", `Agent goal: ${goal}`, { buyerId });
  const run = await ai.runShopper(goal, { buyerId });
  for (const c of run.checks) {
    if (c.decision !== "block") continue;
    store.log("guard", `Blocked ${c.productName} from ${c.merchantName}`, { checks: c.checks, buyerId, merchantId: store.product(c.productId)?.merchant.id });
    store.recordMiss({ ...c, ...store.product(c.productId) });
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
      buyerId,
    }));
  }
  res.json({ ...run, order });
}));

/** The order in the URL, if it is this person's: a buyer's own order, or an order from one of an owner's shops. */
const findOrder = (req) => {
  const o = store.order(req.params.id);
  const mine = o && (req.user.role === "buyer" ? ownsAsBuyer(req.user, o) : ownsAsMerchant(req.user, o));
  if (!mine) throw Object.assign(new Error("Order not found"), { status: 404 });
  return o;
};
const buyer = auth.requireRole("buyer");
const owner = auth.requireRole("merchant");

app.post("/api/orders/:id/confirm", buyer, wrap(async (req, res) => res.json(await orders.confirm(findOrder(req)))));

app.post("/api/orders/:id/decline", buyer, wrap(async (req, res) => {
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
app.post("/api/orders/:id/fulfil", owner, wrap(async (req, res) => res.json(await orders.capture(findOrder(req)))));
app.post("/api/orders/:id/void", owner, wrap(async (req, res) => res.json(await orders.release(findOrder(req)))));
app.post("/api/orders/:id/refund", owner, wrap(async (req, res) => res.json(await orders.refund(findOrder(req), req.body?.note))));

// A shop owner edits their live catalog in the grid. Agents and the guard read the new values on their next call.
app.patch("/api/products/:id", owner, (req, res) => {
  const found = store.product(req.params.id);
  if (!found || !store.shopsOf(req.user).includes(found.merchant.id)) return res.status(404).json({ error: "Product not found" });
  const p = found.product;
  const changes = [];
  const set = (key, value, ok, label) => {
    if (req.body[key] === undefined) return true;
    if (!Number.isFinite(value) || !ok(value)) return false;
    if (p[key] !== value) { changes.push(`${label} ${p[key]} → ${value}`); p[key] = value; }
    return true;
  };
  const valid =
    set("price", +Number(req.body.price).toFixed(2), (v) => v >= 0.01 && v <= 100_000, "price") &&
    set("stock", Math.trunc(Number(req.body.stock)), (v) => v >= 0 && v <= 100_000, "stock") &&
    set("deliveryDays", Math.trunc(Number(req.body.deliveryDays)), (v) => v >= 0 && v <= 365, "delivery days");
  if (!valid) return res.status(400).json({ error: "Enter a sensible number" });
  if (changes.length) store.log("merchant", `${found.merchant.name} updated ${p.name}: ${changes.join(", ")}`, { merchantId: found.merchant.id });
  res.json(p);
});

// ---------------------------------------------------------------- webhooks + money assistant

app.post("/api/webhooks/paypal", wrap(webhooks.receive));

app.post("/api/assistant", owner, wrap(async (req, res) => {
  const question = String(req.body.question || "").trim().slice(0, 500);
  if (!question) return res.status(400).json({ error: "Ask a question about your money" });
  res.json(await ai.askAboutMoney(question, { merchantIds: store.shopsOf(req.user), paypalReads: req.user.demo }));
}));

// ---------------------------------------------------------------- simulated PayPal (no keys)

app.post("/api/sim/webhook", auth.requireUser, wrap(async (req, res) => {
  if (paypal.paypalMode !== "simulated") return res.status(404).json({ error: "Only available with the PayPal simulator" });
  const found = store.order(String(req.body.orderId || ""));
  const o = found && (ownsAsBuyer(req.user, found) || ownsAsMerchant(req.user, found)) ? found : null;
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
