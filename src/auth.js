// Username + password accounts.
//
// What is stored and what is not:
//   - the password itself is NEVER stored. scrypt (N=16384, r=8, p=1) with a
//     fresh 16-byte random salt per user, so two people with the same password
//     get different hashes and a stolen database file cannot be replayed.
//   - the session cookie is an HMAC-signed stamp of "user id + expiry", so
//     sessions survive a container restart without a session table, and a
//     tampered cookie cannot be turned into a login.
//
// Two ways the first account comes into being:
//   1. BOOKSHELF_USERNAME + BOOKSHELF_PASSWORD in the environment (docker
//      compose, or .env next to it). This also wins on every start, which is
//      the documented recovery path when a password is forgotten.
//   2. The first-run setup screen, unlocked by a one-time code printed in the
//      server log. That code exists because this app is reachable through a
//      tunnel: without it, whoever loaded the page first would own the library.
import crypto from 'node:crypto';

import {
  getMeta,
  setMeta,
  countUsers,
  createUser,
  getUserByName,
  getUserById,
  setUserPassword,
} from './db.js';

const COOKIE = 'bs_session';
const SESSION_DAYS = 30;
const MAX_FAILURES = 6;
const FAILURE_WINDOW_MS = 10 * 60 * 1000;

// scrypt cost. Node's defaults are these numbers; they are written down because
// they are stored inside each hash, so changing them must not invalidate old
// passwords (verifyPassword reads the parameters from the stored string).
const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEY_BYTES = 64;

export const MIN_PASSWORD = 8;
/** The floor for a password that comes from the environment (see validateAccount). */
export const ENV_MIN_PASSWORD = 4;
const MAX_PASSWORD = 200;
const MAX_USERNAME = 64;

/** scrypt with a per-user salt, serialised with its own parameters. */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(password), salt, KEY_BYTES, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('hex')}$${key.toString('hex')}`;
}

/** Constant-time check of a password against a stored hash. */
export function verifyPassword(password, stored) {
  const parts = String(stored ?? '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltHex, keyHex] = parts;
  const expected = Buffer.from(keyHex, 'hex');
  if (expected.length === 0) return false;
  let actual;
  try {
    actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    });
  } catch {
    return false;
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/**
 * A hash of a random value, so a login for an unknown username costs the same
 * work as a wrong password. Without it, "no such user" answers in a microsecond
 * and "wrong password" takes ~50ms - a free list of valid usernames.
 */
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

/** Constant-time compare for HMAC strings. */
function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/**
 * Returns { ok, username, password } or { ok: false, reason } - never throws.
 *
 * `minPassword` exists because the two paths have different owners. A password
 * typed into the app is held to MIN_PASSWORD. A password set in the
 * environment was chosen deliberately by whoever runs the server, and refusing
 * it meant the server quietly kept an older password while the operator kept
 * typing the new one - reported as "wrong username or password", which points
 * at the wrong thing entirely. The environment is therefore only rejected for a
 * password that cannot work at all (blank, or shorter than 4).
 */
export function validateAccount({ username, password }, { minPassword = MIN_PASSWORD } = {}) {
  const name = String(username ?? '').trim();
  if (!name) return { ok: false, reason: 'username_required' };
  if (name.length > MAX_USERNAME) return { ok: false, reason: 'username_too_long' };
  // Control characters would break the login form and any log line it touches.
  if (/[\u0000-\u001f\u007f]/.test(name)) return { ok: false, reason: 'username_invalid' };

  const secret = String(password ?? '');
  if (secret.trim().length === 0) return { ok: false, reason: 'password_required' };
  if (secret.length < minPassword) return { ok: false, reason: 'password_too_short' };
  if (secret.length > MAX_PASSWORD) return { ok: false, reason: 'password_too_long' };
  return { ok: true, username: name, password: secret };
}

/**
 * Apply BOOKSHELF_USERNAME / BOOKSHELF_PASSWORD, if set.
 *
 * Existing account -> the environment password is written over it, every start.
 * That is the recovery path ("forgot the password, set it in .env, restart"), and
 * it is why the UI says the password is managed by the server when this is on:
 * a password changed in the app would otherwise silently revert on the next
 * restart.
 */
export function ensureEnvAccount(db) {
  const username = String(process.env.BOOKSHELF_USERNAME ?? '').trim();
  const password = String(process.env.BOOKSHELF_PASSWORD ?? '');
  if (!username || !password) return { configured: false, username: null, problem: null };

  // The environment only needs a password that can exist at all: 4 characters.
  // A shorter-than-ideal one is still applied, and reported as weak, because the
  // alternative is the server ignoring the password the operator set and them
  // typing it forever.
  const checked = validateAccount({ username, password }, { minPassword: ENV_MIN_PASSWORD });
  if (!checked.ok) return { configured: true, username: null, problem: checked.reason };

  const weak = password.length < MIN_PASSWORD;
  // Reported (never the value) so a stale container can be told apart from a
  // wrong password by comparing this number with the one being typed.
  const passwordLength = password.length;

  const existing = getUserByName(db, username);
  if (!existing) {
    createUser(db, { username: checked.username, passwordHash: hashPassword(password) });
    return { configured: true, username: checked.username, problem: null, created: true, weak, passwordLength };
  }
  if (!verifyPassword(password, existing.password_hash)) {
    setUserPassword(db, existing.id, hashPassword(password));
    return { configured: true, username: checked.username, problem: null, updated: true, weak, passwordLength };
  }
  return { configured: true, username: checked.username, problem: null, matches: true, weak, passwordLength };
}

/** True when the account password is dictated by the environment. */
export function passwordManagedByEnv() {
  return Boolean(
    String(process.env.BOOKSHELF_USERNAME ?? '').trim() && String(process.env.BOOKSHELF_PASSWORD ?? ''),
  );
}

/**
 * The one-time setup code, printed while nobody has an account yet.
 *
 * Kept in meta so it survives a restart (the log line is reprinted), and
 * deleted the moment the first account exists.
 */
export function ensureSetupCode(db) {
  if (countUsers(db) > 0) {
    db.prepare("DELETE FROM meta WHERE key = 'setup_code'").run();
    return null;
  }
  const existing = getMeta(db, 'setup_code');
  if (existing) return existing;
  const code = crypto.randomBytes(3).toString('hex').toUpperCase();
  setMeta(db, 'setup_code', code);
  return code;
}

/**
 * The key every session cookie is signed with. Created on first use so a brand
 * new database (or a test's in-memory one) works without a boot ceremony;
 * changing it is how "sign out everywhere" is implemented.
 */
export function ensureSessionSecret(db) {
  const existing = getMeta(db, 'session_secret');
  if (existing) return existing;
  const secret = crypto.randomBytes(32).toString('hex');
  setMeta(db, 'session_secret', secret);
  return secret;
}

export function createAuth(db) {
  const secret = () => ensureSessionSecret(db);
  const failures = new Map(); // ip -> [timestamp, ...]

  function rotateSecret() {
    setMeta(db, 'session_secret', crypto.randomBytes(32).toString('hex'));
  }

  function sign(userId, expires) {
    const mac = crypto.createHmac('sha256', secret()).update(`${userId}.${expires}`).digest('hex');
    return `${userId}.${expires}.${mac}`;
  }

  function verifyToken(token) {
    const parts = String(token ?? '').split('.');
    if (parts.length !== 3) return null;
    const [userId, expires, mac] = parts;
    if (!/^\d+$/.test(userId) || !/^\d+$/.test(expires)) return null;
    if (Number(expires) < Date.now()) return null;
    if (!safeEqual(mac, sign(userId, expires).split('.')[2])) return null;
    // A deleted account must not keep a working session: the row is the authority.
    const user = getUserById(db, userId);
    return user ? { userId: Number(userId), username: user.username } : null;
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

  function issue(user, ip) {
    failures.delete(ip);
    const expires = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
    return {
      ok: true,
      cookie: `${COOKIE}=${sign(user.id, expires)}`,
      username: user.username,
      userId: user.id,
    };
  }

  /** Returns { ok, cookie?, username?, reason?, retryAfterMs? }. */
  function login(username, password, ip) {
    if (lockedOut(ip)) return { ok: false, reason: 'too_many_attempts', retryAfterMs: FAILURE_WINDOW_MS };

    const user = getUserByName(db, username);
    const matches = verifyPassword(password ?? '', user?.password_hash ?? DUMMY_HASH);
    // One reason for both cases: "wrong username" would tell an attacker which
    // half of the pair to keep guessing.
    if (!user || !matches) {
      recordFailure(ip);
      return { ok: false, reason: 'bad_credentials' };
    }
    return issue(user, ip);
  }

  /**
   * Create the first account. Only possible while the table is empty, so this
   * endpoint can never be used to add a second way in.
   */
  function setup({ username, password, code }, ip) {
    if (countUsers(db) > 0) return { ok: false, reason: 'already_setup' };
    const expected = getMeta(db, 'setup_code');
    if (expected && String(code ?? '').trim().toUpperCase() !== expected) {
      recordFailure(ip);
      return { ok: false, reason: 'bad_setup_code' };
    }
    const checked = validateAccount({ username, password });
    if (!checked.ok) return { ok: false, reason: checked.reason };

    const user = createUser(db, {
      username: checked.username,
      passwordHash: hashPassword(checked.password),
    });
    // The code is single-use: no second account, no replay.
    db.prepare("DELETE FROM meta WHERE key = 'setup_code'").run();
    rotateSecret();
    return issue(user, ip);
  }

  /**
   * Change your own password. Every other session is signed out: rotating the
   * session secret invalidates all existing cookies, then this device gets a
   * fresh one so the change does not log the person out of the tab they are in.
   */
  function changePassword({ userId, current, next }) {
    const user = getUserById(db, userId);
    if (!user) return { ok: false, reason: 'not_authenticated' };
    if (passwordManagedByEnv()) return { ok: false, reason: 'managed_by_env' };
    if (!verifyPassword(current ?? '', user.password_hash)) {
      return { ok: false, reason: 'wrong_password' };
    }
    const checked = validateAccount({ username: user.username, password: next });
    if (!checked.ok) return { ok: false, reason: checked.reason };

    setUserPassword(db, user.id, hashPassword(checked.password));
    rotateSecret();
    return issue(user, 'self');
  }

  /** { userId, username } when the cookie is valid, otherwise null. */
  function isAuthed(cookies) {
    return verifyToken(cookies?.[COOKIE]);
  }

  function clearCookie() {
    return `${COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`;
  }

  return {
    login,
    setup,
    changePassword,
    isAuthed,
    clearCookie,
    COOKIE,
    hasUsers: () => countUsers(db) > 0,
    needsSetup: () => countUsers(db) === 0,
  };
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
