/**
 * Accounts, passwords and sessions.
 *
 * The design constraint that shaped everything here: this is about to be reachable from
 * phones outside the house. Until now the only protection was `ADMIN_API_KEY`, a single shared
 * secret that says nothing about *who* is writing — fine for a tool running on localhost,
 * useless the moment two people share a database and one of them should not be able to edit
 * the other's cards.
 *
 * Deliberate choices, and why:
 *
 * **scrypt, from Node's stdlib.** Not bcrypt or argon2, which would both be better in a
 * vacuum and would both be a new native dependency to build on Windows. scrypt is memory-hard,
 * it ships with Node, and at N=16384 it costs ~100ms per verification — slow enough that
 * guessing a password over the network is hopeless, fast enough that logging in feels instant.
 * A plain SHA-256 of a password, by contrast, is guessed at billions per second on a GPU.
 *
 * **Opaque session tokens, hashed at rest.** Not JWTs: a JWT cannot be revoked without a
 * server-side list of revoked tokens, and once you have that list you have a sessions table
 * with extra steps and worse ergonomics. Logging out a phone you left at a card show has to
 * actually work. Only SHA-256(token) is stored, so reading the database does not let anyone
 * log in as anybody.
 *
 * **No password rules beyond a length floor.** Composition rules ("one capital, one symbol")
 * measurably push people toward `Password1!` and toward reuse. Length is the thing that
 * matters, so that is the thing that is checked.
 */

import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { one, q } from './db.js';
import { log } from './logger.js';

/**
 * `promisify` picks the 3-argument overload of `scrypt`, so the options object — which is
 * where N, r and p live — is a type error. Typed explicitly rather than sprinkling `as any`
 * at each call: the cost parameters are the entire security value of using scrypt at all, so
 * they must be passable.
 */
const scrypt = promisify(scryptCb) as (
  password: string, salt: Buffer, keylen: number,
  opts?: { N?: number; r?: number; p?: number },
) => Promise<Buffer>;

/**
 * N=16384, r=8, p=1 — the parameters `crypto.scryptSync` defaults to, stated explicitly
 * because they are a security decision and a default is not a decision. Recorded in the
 * stored string so raising them later can rehash on next login rather than locking everyone
 * out.
 */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const ALGO = 'scrypt-1';

/** Sessions last a month. Long enough that a phone is not a login screen; short enough that
 *  an abandoned browser eventually stops being a key to the collection. */
export const SESSION_DAYS = 30;

/** Twelve, because the honest floor is "not guessable by someone who knows you". */
export const MIN_PASSWORD = 8;

export interface User {
  id: number;
  username: string;
  display_name: string | null;
  role: 'owner' | 'member';
  active: boolean;
  created_at: Date;
  last_login_at: Date | null;
}

/** How a request was authenticated. The distinction matters: an API-key caller is a script,
 *  and a script has no business being shown "your collection" as if it were a person. */
export interface Principal {
  user: User;
  via: 'session' | 'api_key';
}

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

export async function hashPassword(plain: string): Promise<string> {
  if (typeof plain !== 'string' || plain.length < MIN_PASSWORD) {
    throw new Error(`password must be at least ${MIN_PASSWORD} characters`);
  }
  const salt = randomBytes(16);
  const key = await scrypt(plain, salt, SCRYPT.keylen, SCRYPT);
  return [ALGO, SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

/**
 * Verify a password against a stored string.
 *
 * `timingSafeEqual` rather than `===`: string comparison short-circuits on the first
 * differing byte, which leaks how much of a guess was correct. That leak is only theoretically
 * exploitable over a network, and using the constant-time function costs nothing, so there is
 * no argument for the version that leaks.
 *
 * Never throws for a bad password — returns false. A thrown error would end up in a log with
 * a stack trace for what is an entirely ordinary event.
 */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  try {
    const [algo, N, r, p, saltB64, keyB64] = stored.split('$');
    if (algo !== ALGO) return false;                 // covers the 'unset' placeholder
    const salt = Buffer.from(saltB64!, 'base64');
    const expected = Buffer.from(keyB64!, 'base64');
    const got = await scrypt(plain, salt, expected.length,
      { N: Number(N), r: Number(r), p: Number(p) });
    return got.length === expected.length && timingSafeEqual(got, expected);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

const PUBLIC_COLS = 'id, username, display_name, role, active, created_at, last_login_at';

/** Usernames are compared case-insensitively — see the functional index in migration 013. */
export function findUser(username: string) {
  return one<User & { pass_hash: string }>(
    `SELECT ${PUBLIC_COLS}, pass_hash FROM users WHERE lower(username) = lower($1)`,
    [String(username ?? '').trim()],
  );
}

export function getUser(id: number) {
  return one<User>(`SELECT ${PUBLIC_COLS} FROM users WHERE id = $1`, [id]);
}

/** The owner account, which owns every row that predates accounts. */
export function ownerUser() {
  return one<User>(`SELECT ${PUBLIC_COLS} FROM users WHERE role = 'owner' ORDER BY id LIMIT 1`);
}

export function listUsers() {
  return q<User & { lines: number }>(
    `SELECT ${PUBLIC_COLS},
            (SELECT COUNT(*)::int FROM holdings h WHERE h.user_id = u.id AND h.qty > 0) AS lines
       FROM users u ORDER BY (role = 'owner') DESC, lower(username)`,
  );
}

export async function createUser(input: {
  username: string; password: string; displayName?: string | null; role?: 'owner' | 'member';
}): Promise<User> {
  const username = String(input.username ?? '').trim();
  // Restricted deliberately: the username appears in URLs (`?user=felix`), and a name
  // containing a slash or a space turns a share link into a support conversation.
  if (!/^[a-z0-9._-]{2,32}$/i.test(username)) {
    throw new Error('username must be 2-32 characters, letters/numbers/dot/dash/underscore only');
  }
  if (await findUser(username)) throw new Error(`there is already an account called "${username}"`);
  const pass_hash = await hashPassword(input.password);
  const row = await one<User>(
    `INSERT INTO users (username, display_name, pass_hash, pass_algo, role)
     VALUES ($1,$2,$3,$4,$5) RETURNING ${PUBLIC_COLS}`,
    [username, input.displayName?.trim() || username, pass_hash, ALGO, input.role ?? 'member'],
  );
  log.info({ username, role: input.role ?? 'member' }, 'account created');
  return row!;
}

export async function setPassword(userId: number, password: string) {
  const pass_hash = await hashPassword(password);
  await q(`UPDATE users SET pass_hash = $2, pass_algo = $3 WHERE id = $1`, [userId, pass_hash, ALGO]);
  // Every existing session is invalidated. If the password was changed because it leaked,
  // leaving the sessions alive means the change accomplished nothing.
  const gone = await q(`DELETE FROM sessions WHERE user_id = $1 RETURNING token_hash`, [userId]);
  log.info({ userId, sessionsEnded: gone.length }, 'password changed');
}

export async function setActive(userId: number, active: boolean) {
  await q(`UPDATE users SET active = $2 WHERE id = $1`, [userId, active]);
  if (!active) await q(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** 32 bytes of CSPRNG, base64url. The token is returned once and never stored in the clear. */
export async function startSession(userId: number, userAgent?: string | null): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await q(
    `INSERT INTO sessions (token_hash, user_id, expires_at, user_agent)
     VALUES ($1, $2, now() + ($3 || ' days')::interval, $4)`,
    [sha256(token), userId, String(SESSION_DAYS), (userAgent ?? '').slice(0, 200) || null],
  );
  await q(`UPDATE users SET last_login_at = now() WHERE id = $1`, [userId]);
  return token;
}

/**
 * Resolve a token to a user, or null.
 *
 * Expiry is checked in SQL rather than in JS so a clock difference between the app and the
 * database cannot extend a session. `active` is re-checked on every request: disabling an
 * account has to take effect now, not in thirty days.
 */
export async function userForToken(token: string | undefined | null): Promise<User | null> {
  if (!token) return null;
  const row = await one<User>(
    `SELECT u.id, u.username, u.display_name, u.role, u.active, u.created_at, u.last_login_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now() AND u.active`,
    [sha256(token)],
  );
  if (row) {
    // Fire-and-forget: a touch failure must not fail the request it was decorating.
    q(`UPDATE sessions SET last_seen_at = now() WHERE token_hash = $1`, [sha256(token)])
      .catch(() => {});
  }
  return row;
}

export async function endSession(token: string | undefined | null) {
  if (!token) return;
  await q(`DELETE FROM sessions WHERE token_hash = $1`, [sha256(token)]);
}

/** Housekeeping. Expired rows are harmless but unbounded. */
export async function pruneSessions(): Promise<number> {
  const gone = await q(`DELETE FROM sessions WHERE expires_at < now() RETURNING token_hash`);
  return gone.length;
}

// ---------------------------------------------------------------------------
// Login throttle
// ---------------------------------------------------------------------------

/**
 * In-memory, per-username-and-IP, exponential.
 *
 * In memory on purpose: a restart clearing the counters is an acceptable weakness for a
 * few-friends app, and the alternative (a table written on every failed login) hands anyone
 * an unauthenticated way to make the database do work — which is a worse hole than the one it
 * closes.
 *
 * Counted per (username, IP) rather than per IP alone, so one person fat-fingering their
 * password on the house wifi cannot lock everybody else out of the same address.
 */
const attempts = new Map<string, { n: number; until: number }>();
const LOCK_AFTER = 5;
const BASE_LOCK_MS = 2_000;
const MAX_LOCK_MS = 5 * 60_000;

export function loginBlockedFor(key: string): number {
  const a = attempts.get(key);
  if (!a) return 0;
  return Math.max(0, a.until - Date.now());
}

export function noteLoginFailure(key: string) {
  const a = attempts.get(key) ?? { n: 0, until: 0 };
  a.n += 1;
  if (a.n >= LOCK_AFTER) {
    a.until = Date.now() + Math.min(MAX_LOCK_MS, BASE_LOCK_MS * 2 ** (a.n - LOCK_AFTER));
  }
  attempts.set(key, a);
  if (attempts.size > 5000) {                      // crude bound; this is a house tool
    for (const [k, v] of attempts) if (v.until < Date.now()) attempts.delete(k);
  }
}

export function noteLoginSuccess(key: string) {
  attempts.delete(key);
}
