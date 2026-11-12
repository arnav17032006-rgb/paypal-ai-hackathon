// Accounts and sessions. Two roles: a buyer (shops through agents, sets spending rules, approves payments)
// and a shop owner (publishes shops, fulfils and refunds orders, sees why agents didn't buy).
// Passwords are stored as salted scrypt hashes; the session is a random token in an HttpOnly cookie.

import crypto from "node:crypto";
import { promisify } from "node:util";
import * as store from "./store.js";

const scrypt = promisify(crypto.scrypt);
const COOKIE = "ar_session";
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
export const ROLES = ["buyer", "merchant"];
export const roleName = (role) => (role === "merchant" ? "shop owner" : "buyer");

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = (await scrypt(password, salt, 64)).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

export async function verifyPassword(password, stored = "") {
  const [kind, salt, hash] = stored.split(":");
  if (kind !== "scrypt" || !salt || !hash) return false;
  const want = Buffer.from(hash, "hex");
  const got = await scrypt(password, salt, want.length);
  return crypto.timingSafeEqual(want, got);
}

/** What the browser may see about a user. Never the password hash. */
export function publicUser(u) {
  return {
    id: u.id, name: u.name, email: u.email, role: u.role, demo: Boolean(u.demo),
    agentKey: u.role === "buyer" && !u.demo ? u.agentKey : undefined,
  };
}

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return "";
}

export function startSession(req, res, user) {
  const token = crypto.randomBytes(32).toString("hex");
  const now = Date.now();
  const d = store.data();
  d.sessions = d.sessions.filter((s) => Date.parse(s.expiresAt) > now);
  d.sessions.push({ token, userId: user.id, expiresAt: new Date(now + SESSION_MS).toISOString() });
  store.save();
  const secure = req.secure ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MS / 1000}${secure}`);
}

export function endSession(req, res) {
  const token = readCookie(req, COOKIE);
  const d = store.data();
  d.sessions = d.sessions.filter((s) => s.token !== token);
  store.save();
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/** Express middleware: sets req.user from the session cookie, if it is valid. */
export function attachUser(req, _res, next) {
  const token = readCookie(req, COOKIE);
  if (token) {
    const s = store.data().sessions.find((x) => x.token === token);
    if (s && Date.parse(s.expiresAt) > Date.now()) req.user = store.user(s.userId);
  }
  next();
}

export const requireUser = (req, res, next) => (req.user ? next() : res.status(401).json({ error: "Please log in" }));

export const requireRole = (role) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: "Please log in" });
  if (req.user.role !== role) return res.status(403).json({ error: `Only a ${roleName(role)} can do this. You are logged in as a ${roleName(req.user.role)}.` });
  next();
};

// Slow down password guessing: after 10 failed logins for one email from one address in 15 minutes, wait.
const failures = new Map();
const WINDOW_MS = 15 * 60 * 1000;
export function tooManyFailures(key) {
  const f = failures.get(key);
  return Boolean(f && Date.now() - f.first < WINDOW_MS && f.count >= 10);
}
export function noteFailure(key) {
  const f = failures.get(key);
  if (!f || Date.now() - f.first >= WINDOW_MS) failures.set(key, { first: Date.now(), count: 1 });
  else f.count += 1;
}
export const clearFailures = (key) => failures.delete(key);
