// Login behaviour, tested against a real database rather than mocks: the things
// that break here (hashing, cookie signing, the setup-code gate) only break when
// the real SQLite file and the real crypto are exercised.
import test from 'node:test';
import assert from 'node:assert/strict';

import { openDb, countUsers, getUserByName } from '../src/db.js';
import {
  createAuth,
  ensureEnvAccount,
  ensureSetupCode,
  hashPassword,
  verifyPassword,
  validateAccount,
  MIN_PASSWORD,
} from '../src/auth.js';

function withEnv(env, fn) {
  const before = {
    user: process.env.BOOKSHELF_USERNAME,
    pass: process.env.BOOKSHELF_PASSWORD,
  };
  for (const key of Object.keys(env)) {
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of [
      ['BOOKSHELF_USERNAME', before.user],
      ['BOOKSHELF_PASSWORD', before.pass],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** A database with one account, no environment involvement. */
function dbWithUser(username = 'sam', password = 'correct horse') {
  const db = openDb(':memory:');
  const auth = createAuth(db);
  const result = withEnv({ BOOKSHELF_USERNAME: undefined, BOOKSHELF_PASSWORD: undefined }, () =>
    auth.setup({ username, password, code: ensureSetupCode(db) }, '1.2.3.4'),
  );
  assert.equal(result.ok, true, 'setup should create the first account');
  return { db, auth };
}

test('passwords are hashed with a per-user salt and never stored in the clear', () => {
  const one = hashPassword('same password');
  const two = hashPassword('same password');
  assert.notEqual(one, two, 'two hashes of the same password must differ (own salt)');
  assert.equal(one.includes('same password'), false);
  assert.equal(verifyPassword('same password', one), true);
  assert.equal(verifyPassword('same password', two), true);
  assert.equal(verifyPassword('wrong password', one), false);
  // A hash from a broken/empty source must not authenticate anything.
  assert.equal(verifyPassword('', ''), false);
  assert.equal(verifyPassword('x', 'scrypt$1$2$3$4'), false);
});

test('account validation rejects weak or malformed credentials', () => {
  assert.equal(validateAccount({ username: 'sam', password: 'x'.repeat(MIN_PASSWORD) }).ok, true);
  assert.equal(validateAccount({ username: '  ', password: 'longenough' }).reason, 'username_required');
  assert.equal(validateAccount({ username: 'sam', password: 'short' }).reason, 'password_too_short');
  assert.equal(validateAccount({ username: 'a'.repeat(65), password: 'longenough' }).reason, 'username_too_long');
  assert.equal(validateAccount({ username: 'a\u0000b', password: 'longenough' }).reason, 'username_invalid');
});

test('first run: nobody can set up without the code printed in the log', () => {
  const db = openDb(':memory:');
  const code = ensureSetupCode(db);
  assert.match(code ?? '', /^[0-9A-F]{6}$/);

  const auth = createAuth(db);
  const bad = withEnv({ BOOKSHELF_USERNAME: undefined, BOOKSHELF_PASSWORD: undefined }, () =>
    auth.setup({ username: 'sam', password: 'a long password', code: 'ZZZZZZ' }, 'ip'),
  );
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'bad_setup_code');
  assert.equal(countUsers(db), 0, 'a wrong code must not create an account');

  const good = withEnv({ BOOKSHELF_USERNAME: undefined, BOOKSHELF_PASSWORD: undefined }, () =>
    auth.setup({ username: 'sam', password: 'a long password', code }, 'ip'),
  );
  assert.equal(good.ok, true);
  assert.equal(countUsers(db), 1);
  // The code is single use, and a second account cannot be added afterwards.
  const again = withEnv({ BOOKSHELF_USERNAME: undefined, BOOKSHELF_PASSWORD: undefined }, () =>
    auth.setup({ username: 'eve', password: 'another password', code }, 'ip'),
  );
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'already_setup');
  assert.equal(countUsers(db), 1);
});

test('username + password login works, wrong pairs do not', () => {
  const { db, auth } = dbWithUser('Sam', 'a long password');
  const stored = getUserByName(db, 'sam');
  assert.ok(stored, 'usernames are case-insensitive');

  // Case-insensitive username, exact password.
  assert.equal(auth.login('sam', 'a long password', 'ip1').ok, true);
  assert.equal(auth.login('SAM', 'a long password', 'ip2').ok, true);
  assert.equal(auth.login('sam', 'wrong password', 'ip3').ok, false);
  assert.equal(auth.login('nobody', 'a long password', 'ip4').ok, false);
  // Both failures report the same reason: no username oracle.
  assert.equal(auth.login('sam', 'nope', 'ip5').reason, 'bad_credentials');
  assert.equal(auth.login('nobody', 'a long password', 'ip6').reason, 'bad_credentials');
});

test('rate limiting blocks an address but not everyone', () => {
  const { auth } = dbWithUser('sam', 'a long password');
  for (let i = 0; i < 6; i += 1) assert.equal(auth.login('sam', 'nope', 'ip1').ok, false);

  const blocked = auth.login('sam', 'a long password', 'ip1');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'too_many_attempts');
  assert.equal(auth.login('sam', 'a long password', 'ip2').ok, true, 'another client is unaffected');
});

test('a session cookie verifies, and cannot be forged by editing the expiry or user', () => {
  const { auth } = dbWithUser('sam', 'a long password');
  const { cookie } = auth.login('sam', 'a long password', 'ip');
  const value = cookie.split('=')[1];
  const [userId, expires, mac] = value.split('.');

  assert.deepEqual(auth.isAuthed({ bs_session: value }), { userId: Number(userId), username: 'sam' });

  // Push the expiry far into the future while keeping the old signature.
  assert.equal(auth.isAuthed({ bs_session: `${userId}.${Number(expires) + 10_000_000}.${mac}` }), null);
  // Point the same signature at another user id.
  assert.equal(auth.isAuthed({ bs_session: `${Number(userId) + 1}.${expires}.${mac}` }), null);
  assert.equal(auth.isAuthed({ bs_session: 'nonsense' }), null);
  assert.equal(auth.isAuthed({}), null);
});

test('changing the password signs other devices out and keeps this one in', () => {
  const { auth } = dbWithUser('sam', 'a long password');
  const other = auth.login('sam', 'a long password', 'laptop').cookie.split('=')[1];
  const mine = auth.login('sam', 'a long password', 'phone').cookie.split('=')[1];
  const { userId } = auth.isAuthed({ bs_session: mine });

  assert.equal(
    auth.changePassword({ userId, current: 'wrong', next: 'another long password' }).reason,
    'wrong_password',
  );

  const changed = auth.changePassword({ userId, current: 'a long password', next: 'another long password' });
  assert.equal(changed.ok, true);

  assert.equal(auth.isAuthed({ bs_session: other }), null, 'the other device is signed out');
  assert.equal(auth.isAuthed({ bs_session: mine }), null, 'the old cookie is signed out too');
  assert.ok(auth.isAuthed({ bs_session: changed.cookie.split('=')[1] }), 'the fresh cookie works');
  assert.equal(auth.login('sam', 'another long password', 'ip9').ok, true);
});

test('environment credentials create the account, and always win on restart', () => {
  const db = openDb(':memory:');
  const created = withEnv(
    { BOOKSHELF_USERNAME: 'operator', BOOKSHELF_PASSWORD: 'first password' },
    () => ensureEnvAccount(db),
  );
  assert.equal(created.created, true);
  assert.equal(countUsers(db), 1);

  const auth = createAuth(db);
  assert.equal(auth.login('operator', 'first password', 'ip').ok, true);

  // Operator changes it in .env and restarts - the documented recovery path.
  const updated = withEnv(
    { BOOKSHELF_USERNAME: 'operator', BOOKSHELF_PASSWORD: 'second password' },
    () => ensureEnvAccount(db),
  );
  assert.equal(updated.updated, true);
  assert.equal(auth.login('operator', 'second password', 'ip2').ok, true);
  assert.equal(auth.login('operator', 'first password', 'ip3').ok, false);

  // A plain restart with the same values changes nothing.
  const steady = withEnv(
    { BOOKSHELF_USERNAME: 'operator', BOOKSHELF_PASSWORD: 'second password' },
    () => ensureEnvAccount(db),
  );
  assert.equal(steady.created, undefined);
  assert.equal(steady.updated, undefined);
});

test('the environment may choose a short password, but not an empty one', () => {
  // An operator who sets a 5-character password gets that password. Refusing it
  // was the bug: the server kept an older password while they typed the new one,
  // and the app said "wrong username or password".
  const db = openDb(':memory:');
  const short = withEnv(
    { BOOKSHELF_USERNAME: 'operator', BOOKSHELF_PASSWORD: 'short' },
    () => ensureEnvAccount(db),
  );
  assert.equal(short.problem, null);
  assert.equal(short.weak, true, 'still reported as weaker than the 8-character floor');
  assert.equal(createAuth(db).login('operator', 'short', 'ip').ok, true);

  // Blank, or shorter than 4, cannot be applied at all.
  const blank = withEnv(
    { BOOKSHELF_USERNAME: 'other', BOOKSHELF_PASSWORD: 'abc' },
    () => ensureEnvAccount(db),
  );
  assert.equal(blank.problem, 'password_too_short');
  assert.equal(countUsers(db), 1);
});

test('the in-app password change is refused when the environment owns the password', () => {
  const db = openDb(':memory:');
  withEnv({ BOOKSHELF_USERNAME: 'operator', BOOKSHELF_PASSWORD: 'a long password' }, () =>
    ensureEnvAccount(db),
  );
  const auth = createAuth(db);
  const { userId } = auth.isAuthed({ bs_session: auth.login('operator', 'a long password', 'ip').cookie.split('=')[1] });

  const refused = withEnv(
    { BOOKSHELF_USERNAME: 'operator', BOOKSHELF_PASSWORD: 'a long password' },
    () => auth.changePassword({ userId, current: 'a long password', next: 'another long password' }),
  );
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'managed_by_env');
});
