// The series/rating enrichment sources: guard rails rather than live calls.
// Network behaviour is deliberately not tested here - what must hold is that an
// unconfigured or malformed input is a clean null, never a crash and never a
// wrong book.
import test from 'node:test';
import assert from 'node:assert/strict';

import { isWorkKey, seriesFromWikidata } from '../src/wikidata.js';
import { googleBooksKey, googleBooksByIsbn } from '../src/googlebooks.js';

test('only real Open Library work ids are sent to Wikidata', () => {
  assert.equal(isWorkKey('OL15157288W'), true);
  assert.equal(isWorkKey('OL72428W'), true);
  // Editions (M) and anything else must not be queried as works.
  assert.equal(isWorkKey('OL3283415M'), false);
  assert.equal(isWorkKey(''), false);
  assert.equal(isWorkKey(null), false);
  assert.equal(isWorkKey('9780590453660'), false);
});

test('a non-work key is refused without any network call', async () => {
  assert.equal(await seriesFromWikidata('not-a-work-key'), null);
  assert.equal(await seriesFromWikidata(null), null);
});

test('Google Books is disabled, not broken, without a key', async () => {
  const before = process.env.GOOGLE_BOOKS_KEY;
  delete process.env.GOOGLE_BOOKS_KEY;
  try {
    assert.equal(googleBooksKey(), null);
    // No key means no request at all, and a null result rather than a throw.
    assert.equal(await googleBooksByIsbn('9780590453660'), null);
  } finally {
    if (before !== undefined) process.env.GOOGLE_BOOKS_KEY = before;
  }
});

test('a blank key counts as unconfigured', async () => {
  const before = process.env.GOOGLE_BOOKS_KEY;
  process.env.GOOGLE_BOOKS_KEY = '   ';
  try {
    assert.equal(googleBooksKey(), null);
    assert.equal(await googleBooksByIsbn('9780590453660'), null);
  } finally {
    if (before === undefined) delete process.env.GOOGLE_BOOKS_KEY;
    else process.env.GOOGLE_BOOKS_KEY = before;
  }
});
