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
  } else {
    reset();
  }
  return db;
}

export function reset() {
  db = JSON.parse(fs.readFileSync(SEED_FILE, "utf8"));
  db.orders = [];
  db.events = [];
  db.webhookEvents = [];
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

/** Spend committed today, optionally leaving out the order being re-checked. */
export function spentToday(excludeOrderId) {
  const today = new Date().toISOString().slice(0, 10);
  return db.orders
    .filter((o) => o.id !== excludeOrderId && committedAt(o).startsWith(today) && COMMITTED.includes(o.status))
    .reduce((s, o) => s + o.amount, 0);
}

/** Units promised to orders the buyer hasn't paid for yet. Held orders have already come off stock. */
export function reservedUnits(productId, excludeOrderId) {
  const cutoff = Date.now() - RESERVATION_MS;
  return db.orders
    .filter((o) => o.productId === productId && o.id !== excludeOrderId && UNPAID.includes(o.status) && Date.parse(committedAt(o)) > cutoff)
    .reduce((s, o) => s + o.quantity, 0);
}
