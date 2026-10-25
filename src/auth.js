// Single-user PIN auth.
//
// The app is reachable from the open internet through a tunnel, so it is not
// enough to hide behind an obscure URL. The PIN is stored only as a SHA-256
// hash; the session cookie is an HMAC-signed expiry stamp, which means sessions
// survive a container restart without needing a session table.
import crypto from 'node:crypto';
import { getMeta, setMeta } from './db.js';

const COOKIE = 'bs_session';
const SESSION_DAYS = 30;
const MAX_FAILURES = 6;
const FAILURE_WINDOW_MS = 10 * 60 * 1000;

const hash = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

/** Constant-time compare so PIN length/hash prefix cannot be probed by timing. */
function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/**
 * Resolve the PIN: environment wins (docker-compose), else a previously stored
 * one, else generate a 6-digit PIN and store it so restarts do not lock you out.
 * Returns { pin, generated } - generated is only non-null the first time, and the
 * caller prints it to the container log exactly once.
 */
export function ensurePin(db) {
  const secret = getMeta(db, 'session_secret') ?? crypto.randomBytes(32).toString('hex');
  setMeta(db, 'session_secret', secret);

  if (process.env.BOOKSHELF_PIN) {
    if (!getMeta(db, 'pin_hash')) setMeta(db, 'pin_hash', hash(process.env.BOOKSHELF_PIN));
    return { pin: null, generated: null };
  }

  const stored = getMeta(db, 'pin_hash');
  if (stored) return { pin: null, generated: null };

  const pin = String(crypto.randomInt(100000, 999999));
  setMeta(db, 'pin_hash', hash(pin));
  return { pin, generated: pin };
}

export function createAuth(db) {
  const secret = () => getMeta(db, 'session_secret');
  const failures = new Map(); // ip -> [timestamp, ...]

  function sign(expires) {
    const mac = crypto.createHmac('sha256', secret()).update(String(expires)).digest('hex');
    return `${expires}.${mac}`;
  }

  function verifyToken(token) {
    if (!token || !token.includes('.')) return false;
    const [expires, mac] = token.split('.');
    if (!/^\d+$/.test(expires)) return false;
    if (Number(expires) < Date.now()) return false;
    return safeEqual(mac, sign(expires).split('.')[1]);
  }

  function lockedOut(ip) {
    const list = (failures.get(ip) ?? []).filter((t) => Date.now() - t < FAILURE_WINDOW_MS);
    failures.set(ip, list);
    return list.length >= MAX_FAILURES;
  }

  function recordFailure(ip) {
    const list = failures.get(ip) ?? [];
    list.push(Date.now());
    failures.set(ip, list);
  }

  /** Returns { ok, cookie?, retryAfterMs?, reason? }. */
  function login(pin, ip) {
    if (lockedOut(ip)) {
      return { ok: false, reason: 'too_many_attempts', retryAfterMs: FAILURE_WINDOW_MS };
    }
    const stored = getMeta(db, 'pin_hash');
    if (!stored) return { ok: false, reason: 'no_pin_configured' };
    if (!safeEqual(hash(String(pin ?? '').trim()), stored)) {
      recordFailure(ip);
      return { ok: false, reason: 'wrong_pin' };
    }
    failures.delete(ip);
    const expires = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
    return { ok: true, cookie: `${COOKIE}=${sign(expires)}` };
  }

  function isAuthed(cookies) {
    return verifyToken(cookies?.[COOKIE]);
  }

  function clearCookie() {
    return `${COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`;
  }

  return { login, isAuthed, clearCookie, COOKIE };
}

/** Minimal cookie header parser - one header, no dependency needed. */
export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}
