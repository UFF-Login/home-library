// The Google Books rescue path: an ISBN Open Library does not know must still
// produce a usable record. These tests cover the mapping only - the network call
// needs a key, so it is exercised by the operator, not by CI.
import test from 'node:test';
import assert from 'node:assert/strict';

import { volumeToRecord } from '../src/googlebooks.js';

// Shaped like a real response for a Matthew Reilly paperback, trimmed.
const volumeInfo = {
  title: 'Ice Station',
  subtitle: null,
  authors: ['Matthew Reilly'],
  publisher: 'Pan Macmillan',
  publishedDate: '1998-11-01',
  pageCount: 611,
  description: 'A secret military base in Antarctica goes silent.',
  industryIdentifiers: [
    { type: 'ISBN_10', identifier: '0330360892' },
    { type: 'ISBN_13', identifier: '9780330360890' },
  ],
  averageRating: 4.1,
  ratingsCount: 1885,
  categories: ['Fiction', 'Thriller'],
  language: 'en',
  imageLinks: {
    smallThumbnail: 'http://books.google.com/books/content?id=abc&printsec=frontcover&img=1&zoom=5&edge=curl&source=gbs_api',
    thumbnail: 'http://books.google.com/books/content?id=abc&printsec=frontcover&img=1&zoom=1&edge=curl&source=gbs_api',
  },
};

test('a Google volume becomes a full record when Open Library has nothing', () => {
  const record = volumeToRecord(volumeInfo, '9780330360890');
  assert.ok(record, 'should map');
  assert.equal(record.title, 'Ice Station');
  assert.deepEqual(record.authors, ['Matthew Reilly']);
  assert.equal(record.publisher, 'Pan Macmillan');
  assert.equal(record.published, '1998', 'publishedDate is a string; we keep the year');
  assert.equal(record.pages, 611);
  assert.equal(record.rating, 4.1);
  assert.equal(record.ratingsCount, 1885);
  assert.deepEqual(record.categories, ['Fiction', 'Thriller']);
  assert.match(record.description, /Antarctica/);
});

test('the ISBN must match, or the API has attached the wrong book', () => {
  // Google's ISBN query is fuzzy; a different book must never be trusted.
  assert.equal(volumeToRecord(volumeInfo, '9780590453660'), null);
});

test('cover art is upgraded to https without the page-curl effect', () => {
  const record = volumeToRecord(volumeInfo, '9780330360890');
  assert.ok(record.coverUrl.startsWith('https://'), 'http would be blocked on an https page');
  assert.ok(!record.coverUrl.includes('edge=curl'), 'curl shows a fake page bend');
  assert.ok(record.coverUrl.includes('zoom=1'), 'prefers the largest thumbnail offered');
});

test('a volume missing optional fields still maps', () => {
  // Many volumes carry no rating, no page count and no artwork at all.
  const record = volumeToRecord(
    {
      title: 'Unknown Pamphlet',
      industryIdentifiers: [{ type: 'ISBN_13', identifier: '9780330360890' }],
    },
    '9780330360890',
  );
  assert.ok(record);
  assert.equal(record.title, 'Unknown Pamphlet');
  assert.deepEqual(record.authors, []);
  assert.equal(record.pages, null);
  assert.equal(record.rating, null);
  assert.equal(record.coverUrl, null);
  assert.equal(record.published, null);
});

test('no volume at all maps to null rather than an empty record', () => {
  assert.equal(volumeToRecord(undefined, '9780330360890'), null);
});
