// Tiny JSON-file store. Good enough for a hackathon demo; swap for a DB later.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.AGENTREADY_DATA_DIR || path.join(here, "..", "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const SEED_FILE = path.join(here, "seed.json");

let db;

export function load() {
  if (fs.existsSync(DB_FILE)) {
    db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    db.webhookEvents ||= [];
    db.misses ||= [];
    db.users ||= [];
    db.sessions ||= [];
    ensureDemoUsers();
  } else {
    reset();
  }
  return db;
}

/** Back to the seed data. Accounts people created, and their sessions, survive a reset. */
export function reset() {
  const accounts = { users: (db?.users || []).filter((u) => !u.demo), sessions: db?.sessions || [] };
  db = JSON.parse(fs.readFileSync(SEED_FILE, "utf8"));
  db.users = accounts.users;
  db.sessions = accounts.sessions;
  ensureDemoUsers();
  db.orders = [];
  db.events = [];
  db.webhookEvents = [];
  db.misses = [];
  save();
  return db;
}

export function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

export const id = (prefix) => `${prefix}_${crypto.randomBytes(5).toString("hex")}`;

export const data = () => db;

export function merchant(mid) {
  return db.merchants.find((m) => m.id === mid);
}

export function product(pid) {
  for (const m of db.merchants) {
    const p = m.products.find((x) => x.id === pid);
    if (p) return { product: p, merchant: m };
  }
  return null;
}

export function order(oid) {
  return db.orders.find((o) => o.id === oid || o.paypalOrderId === oid);
}

export function findOrder(predicate) {
  return db.orders.find(predicate);
}

// ---------------------------------------------------------------- accounts

// Demo accounts let anyone try both sides with one click. The demo shop owner manages the seed shops,
// and the demo buyer uses the seed spending mandate.
export const DEMO_BUYER = "u_demo_buyer";
export const DEMO_OWNER = "u_demo_owner";

function ensureDemoUsers() {
  const seedShops = db.merchants.filter((m) => m.source === "seed").map((m) => m.id);
  const demo = [
    { id: DEMO_BUYER, role: "buyer", name: "Demo buyer", email: "buyer@demo.agentready", demo: true },
    { id: DEMO_OWNER, role: "merchant", name: "Demo shop owner", email: "owner@demo.agentready", demo: true, merchantIds: seedShops },
  ];
  db.users = [...demo, ...db.users.filter((u) => !u.demo)];
}

export const user = (uid) => db.users.find((u) => u.id === uid);
export const userByEmail = (email) => db.users.find((u) => u.email === email);
export const userByAgentKey = (key) => (key ? db.users.find((u) => u.role === "buyer" && u.agentKey && u.agentKey === key) : undefined);

/** Orders from before accounts existed belong to the demo buyer. */
export const buyerOf = (o) => o.buyerId || DEMO_BUYER;

/** A buyer's spending mandate. The demo buyer uses the seed mandate. */
export function mandateFor(buyerId = DEMO_BUYER) {
  return user(buyerId)?.mandate || db.mandate;
}

/** The shops a shop owner manages (ignoring any removed by a reset). */
export function shopsOf(u) {
  return (u?.merchantIds || []).filter((mid) => merchant(mid));
}

export function log(type, message, extra = {}) {
  const e = { id: id("evt"), at: new Date().toISOString(), type, message, ...extra };
  db.events.unshift(e);
  db.events = db.events.slice(0, 500);
  save();
  return e;
}

// PENDING means the PayPal call is in flight. It counts, so parallel checkouts can't race past a limit.
const COMMITTED = ["PENDING", "AWAITING_APPROVAL", "AUTHORIZED", "CAPTURED"];
const UNPAID = ["PENDING", "AWAITING_APPROVAL"];
// An abandoned PayPal link can't hold stock forever. If it is approved later, the guard re-checks before any hold.
const RESERVATION_MS = 24 * 60 * 60 * 1000;
const committedAt = (o) => o.committedAt || o.createdAt;

/** One buyer's spend committed today, optionally leaving out the order being re-checked. */
export function spentToday(excludeOrderId, buyerId = DEMO_BUYER) {
  const today = new Date().toISOString().slice(0, 10);
  return db.orders
    .filter((o) => buyerOf(o) === buyerId && o.id !== excludeOrderId && committedAt(o).startsWith(today) && COMMITTED.includes(o.status))
    .reduce((s, o) => s + o.amount, 0);
}

/** Units promised to orders the buyer hasn't paid for yet. Held orders have already come off stock. */
export function reservedUnits(productId, excludeOrderId) {
  const cutoff = Date.now() - RESERVATION_MS;
  return db.orders
    .filter((o) => o.productId === productId && o.id !== excludeOrderId && UNPAID.includes(o.status) && Date.parse(committedAt(o)) > cutoff)
    .reduce((s, o) => s + o.quantity, 0);
}

// ---------------------------------------------------------------- lost sales

// What a merchant can do about each rule that stops a sale. Buyer-side rules say so, so nobody chases them.
const MISS_ADVICE = {
  merchant_trust: "Your trust score is below this buyer's minimum. Publish a refund policy, add your PayPal email, remove risky payment wording and avoid disputes.",
  refund_policy: "Add a refund policy to your shop text. This buyer only shops where one is published.",
  scam_signals: "Remove the flagged wording (unprotected payment methods, \"all sales final\", extreme discounts) from your listing and policies.",
  stock: "Agents wanted more than you had in stock. Restock or raise the stock count.",
  per_order_limit: "The price is above this buyer's per-order limit. A smaller size or bundle could fit.",
  category: "This buyer does not allow the product's category. Check the category is the right one.",
  currency: "List prices in USD.",
  daily_limit: "The buyer had reached their daily limit. Nothing to fix on your side.",
};
const MISS_REPEAT_MS = 60 * 1000;

/**
 * Remember that the guard stopped an agent buying this product, one entry per blocking rule.
 * An agent often dry-runs and then tries to check out; the same miss within a minute counts once.
 */
export function recordMiss(verdict, channel = "web agent") {
  if (!verdict.product || !verdict.merchant) return;
  const now = Date.now();
  for (const c of verdict.checks.filter((x) => x.severity === "block")) {
    const repeat = db.misses.find((m) => m.productId === verdict.product.id && m.rule === c.rule && m.channel === channel && now - Date.parse(m.at) < MISS_REPEAT_MS);
    if (repeat) continue;
    db.misses.unshift({
      at: new Date(now).toISOString(), merchantId: verdict.merchant.id, merchantName: verdict.merchant.name,
      productId: verdict.product.id, productName: verdict.product.name, channel, rule: c.rule, detail: c.detail,
    });
  }
  db.misses = db.misses.slice(0, 1000);
  save();
}

/** Lost sales grouped by product and rule, most frequent first, with what the merchant can do. */
export function lostSales() {
  const groups = new Map();
  for (const m of db.misses) {
    const key = m.productId + "|" + m.rule;
    const g = groups.get(key);
    if (g) {
      g.times += 1;
      if (!g.agents.includes(m.channel)) g.agents.push(m.channel);
    } else {
      // Misses are newest first, so the first one seen carries the latest time and detail.
      groups.set(key, {
        merchantId: m.merchantId, merchantName: m.merchantName, productName: m.productName, rule: m.rule,
        times: 1, lastAt: m.at, agents: [m.channel], detail: m.detail,
        advice: MISS_ADVICE[m.rule] || "See the detail for what the guard checked.",
      });
    }
  }
  return [...groups.values()].sort((a, b) => b.times - a.times || b.lastAt.localeCompare(a.lastAt));
}
