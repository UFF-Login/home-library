// Auth behaviour that the deployment docs promise: a generated PIN on first run,
// and a PIN set in docker-compose always overriding whatever is stored. The
// second case is the recovery path when the generated PIN is lost, so it is
// worth a real test against a real database.
import test from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../src/db.js';
import { ensurePin, createAuth } from '../src/auth.js';

function withEnv(pin, fn) {
  const before = process.env.BOOKSHELF_PIN;
  if (pin === undefined) delete process.env.BOOKSHELF_PIN;
  else process.env.BOOKSHELF_PIN = pin;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.BOOKSHELF_PIN;
    else process.env.BOOKSHELF_PIN = before;
  }
}

test('first run with no PIN configured generates one and prints it once', () => {
  const db = openDb(':memory:');
  const first = withEnv(undefined, () => ensurePin(db));
  assert.match(first.generated ?? '', /^\d{6}$/);

  // Second start must NOT generate a new PIN - the stored hash wins.
  const second = withEnv(undefined, () => ensurePin(db));
  assert.equal(second.generated, null);

  const auth = createAuth(db);
  const ip = 'test';
  assert.equal(auth.login(first.generated, ip).ok, true);
});

test('an env PIN overrides a previously generated one (the recovery path)', () => {
  const db = openDb(':memory:');
  const generated = withEnv(undefined, () => ensurePin(db)).generated;

  // Operator puts BOOKSHELF_PIN in docker-compose and restarts.
  withEnv('424242', () => ensurePin(db));

  const auth = createAuth(db);
  assert.equal(auth.login('424242', 'test').ok, true, 'new env PIN must work');
  assert.equal(auth.login(generated, 'test').ok, false, 'old generated PIN must stop working');

  // And a plain restart with the env still set keeps it working.
  withEnv('424242', () => ensurePin(db));
  assert.equal(createAuth(db).login('424242', 'test').ok, true);
});

test('wrong PINs and rate limiting behave', () => {
  const db = openDb(':memory:');
  withEnv('123456', () => ensurePin(db));
  const auth = createAuth(db);

  for (let i = 0; i < 6; i += 1) assert.equal(auth.login('000000', 'ip1').ok, false);
  const blocked = auth.login('123456', 'ip1');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'too_many_attempts');
  // A different client is unaffected.
  assert.equal(auth.login('123456', 'ip2').ok, true);
});

test('a session cookie verifies, and cannot be forged by changing the expiry', () => {
  const db = openDb(':memory:');
  withEnv('123456', () => ensurePin(db));
  const auth = createAuth(db);

  const { cookie } = auth.login('123456', 'ip');
  const value = cookie.split('=')[1];
  const [expires, mac] = value.split('.');
  assert.equal(auth.isAuthed({ bs_session: value }), true);

  // Push the expiry far into the future while keeping the old signature.
  const forged = `${Number(expires) + 10_000_000}.${mac}`;
  assert.equal(auth.isAuthed({ bs_session: forged }), false);
  assert.equal(auth.isAuthed({ bs_session: 'nonsense' }), false);
  assert.equal(auth.isAuthed({}), false);
});
