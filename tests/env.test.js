// `.env` parsing.
//
// This file exists because of a real failure: the login was typed into `.env`
// with the leading `#` left on, the app therefore saw no account, and the only
// symptom was "wrong username or password" on a password that was correct. A
// commented-out line MUST be ignored, and an uncommented one MUST be applied.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseEnv, loadEnvFile } from '../src/env.js';

test('a commented-out setting is ignored, an uncommented one is applied', () => {
  const text = ['# BOOKSHELF_PASSWORD=hidden', 'BOOKSHELF_USERNAME=admin'].join('\n');
  const parsed = parseEnv(text);
  assert.equal(parsed.BOOKSHELF_USERNAME, 'admin');
  assert.equal('BOOKSHELF_PASSWORD' in parsed, false, 'a # line must not define anything');
});

test('values keep their shape: quotes stripped, inner spaces kept, # not a comment', () => {
  const parsed = parseEnv(
    [
      'A="quoted value"',
      "B='single quoted'",
      'C=a long password with spaces',
      'D=',
      'export E=exported',
      'F=value#hashed',
      'G = spaced = still one value',
      'not a setting',
      '#ANOTHER=ignored',
    ].join('\n'),
  );
  assert.equal(parsed.A, 'quoted value');
  assert.equal(parsed.B, 'single quoted');
  assert.equal(parsed.C, 'a long password with spaces');
  assert.equal(parsed.D, '', 'blank is set-but-empty, not absent');
  assert.equal(parsed.E, 'exported');
  assert.equal(parsed.F, 'value#hashed');
  assert.equal(parsed.G, 'spaced = still one value');
  assert.equal('not a setting' in parsed, false);
  assert.equal('ANOTHER' in parsed, false);
});

test('loading a file never overrides the real environment', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bookshelf-env-'));
  const file = join(dir, '.env');
  writeFileSync(file, 'BOOKSHELF_USERNAME=from-file\nBOOKSHELF_PASSWORD=file-password\n');

  const env = { BOOKSHELF_USERNAME: 'from-shell' };
  const result = loadEnvFile(file, env);

  assert.equal(env.BOOKSHELF_USERNAME, 'from-shell', 'the shell wins');
  assert.equal(env.BOOKSHELF_PASSWORD, 'file-password', 'the missing one is filled in');
  assert.deepEqual(result.applied, ['BOOKSHELF_PASSWORD']);
  assert.deepEqual(result.skipped, ['BOOKSHELF_USERNAME']);
});

test('a missing file is not an error', () => {
  const env = {};
  const result = loadEnvFile(join(tmpdir(), 'definitely-not-here', '.env'), env);
  assert.deepEqual(result.applied, []);
  assert.deepEqual(env, {});
});
