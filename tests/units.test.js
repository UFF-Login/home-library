// Regression tests for the pure logic: ISBN validation, series parsing,
// author grouping, gap maths. No database, no network, no GPU - these must stay
// runnable in seconds so a fix can never break the catalogue maths silently.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normaliseIsbn,
  isValidIsbn10,
  isValidIsbn13,
  isbn10To13,
  isbn13To10,
} from '../src/isbn.js';
import {
  parseSeries,
  seriesFromSubjects,
  seriesKey,
  missingVolumes,
  toRanges,
  describeMissing,
} from '../src/series.js';
import { authorKey, preferredName } from '../src/authors.js';

test('accepts real book barcodes and normalises them', () => {
  const harry = normaliseIsbn('9780590353403');
  assert.equal(harry.isbn13, '9780590353403');
  assert.equal(harry.isbn10, '0590353403');

  // Hyphens and spaces from hand typing must not break validation.
  assert.equal(normaliseIsbn('978-0-590-35340-3').isbn13, '9780590353403');
});

test('upgrades ISBN-10 to ISBN-13 so one barcode form is stored', () => {
  assert.equal(isbn10To13('0306406152'), '9780306406157');
  assert.equal(isbn13To10('9780306406157'), '0306406152');
  const upgraded = normaliseIsbn('0306406152');
  assert.equal(upgraded.isbn13, '9780306406157');
});

test('rejects bad checksums and non-book EAN barcodes', () => {
  assert.equal(isValidIsbn13('9780590353404'), false); // last digit wrong
  assert.equal(normaliseIsbn('4006381333931'), null); // valid EAN, not a book
  assert.equal(normaliseIsbn('12345'), null);
  assert.equal(normaliseIsbn(''), null);
  assert.equal(normaliseIsbn(null), null);
  assert.equal(isValidIsbn10('059035340X'), false); // X legal but checksum wrong
});

test('parses the series marker out of the subtitle, the common case', () => {
  // Real record from Open Library for The Haunted Mask (Goosebumps #11).
  assert.deepEqual(parseSeries({ title: 'Stay Out of the Basement', subtitle: 'Goosebumps #2' }), {
    series: 'Goosebumps',
    volume: 2,
  });
});

test('parses series inside parentheses without swallowing the title', () => {
  assert.deepEqual(parseSeries({ title: 'The Haunted Mask (Goosebumps, #11)' }), {
    series: 'Goosebumps',
    volume: 11,
  });
  assert.deepEqual(parseSeries({ title: 'The Colour of Magic (Discworld, Book 1)' }), {
    series: 'Discworld',
    volume: 1,
  });
});

test('parses "Book N" and "Vol. N" forms', () => {
  assert.deepEqual(parseSeries({ title: 'The Eye of the World: Book 1' }), {
    series: 'The Eye of the World',
    volume: 1,
  });
  assert.deepEqual(parseSeries({ subtitle: 'Animorphs Vol. 4' }), {
    series: 'Animorphs',
    volume: 4,
  });
});

test('a bare volume number yields a volume with no series name', () => {
  assert.deepEqual(parseSeries({ title: 'The Invasion', subtitle: '#1' }), {
    series: null,
    volume: 1,
  });
});

test('does not invent a series for ordinary titles', () => {
  assert.deepEqual(parseSeries({ title: 'Catch-22' }), { series: null, volume: null });
  assert.deepEqual(parseSeries({ title: 'Nineteen Eighty-Four' }), { series: null, volume: null });
  assert.deepEqual(parseSeries({}), { series: null, volume: null });
});

test('reads the series name Open Library hides in subjects', () => {
  const subjects = [
    { name: 'Ghosts', url: 'https://openlibrary.org/subjects/ghosts' },
    { name: 'series:Harry_Potter', url: 'https://openlibrary.org/subjects/series:harry_potter' },
  ];
  assert.equal(seriesFromSubjects(subjects), 'Harry Potter');
  assert.equal(seriesFromSubjects([{ name: 'Ghosts' }]), null);
});

test('series keys ignore case, punctuation and a leading "The"', () => {
  assert.equal(seriesKey('The Wheel of Time'), seriesKey('wheel of time'));
  assert.equal(seriesKey('Goosebumps'), seriesKey('Goosebumps!'));
  assert.notEqual(seriesKey('Goosebumps'), seriesKey('Goosebumps Series 2000'));
});

test('finds the gaps in a series, compressed into ranges', () => {
  const result = missingVolumes([1, 3, 4, 6, 7, 8, 9, 10, 11, 12, 18]);
  assert.deepEqual(result.missing, [2, 5, 13, 14, 15, 16, 17]);
  assert.deepEqual(result.ranges, ['2', '5', '13-17']);
  assert.equal(describeMissing(result.ranges), 'missing 2, 5 and 13-17');
});

test('gap maths handles an empty series and single ranges', () => {
  assert.deepEqual(missingVolumes([]).ranges, []);
  assert.deepEqual(missingVolumes([1, 2, 3]).ranges, []);
  assert.deepEqual(toRanges([5]), ['5']);
  assert.equal(describeMissing(['3']), 'missing 3');
});

test('groups author name variants onto one key', () => {
  const keys = [
    authorKey('R.L. Stine'),
    authorKey('R. L. Stine'),
    authorKey('Robert Lawrence Stine'),
    authorKey('Stine, R. L.'),
    authorKey('Stine, Robert'),
  ];
  assert.equal(new Set(keys).size, 1, `expected one key, got ${JSON.stringify(keys)}`);
  assert.equal(keys[0], 'stine:r');
});

test('keeps different authors apart', () => {
  // Same surname + same initial is treated as one author on purpose: that is
  // the "Stephen King" / "Stephen R. King" variant case, not two people.
  assert.equal(authorKey('Stephen King'), authorKey('Stephen R. King'));
  // Different surnames sharing an initial must not merge.
  assert.notEqual(authorKey('Terry Pratchett'), authorKey('Terry Brooks'));
  assert.notEqual(authorKey('Stephen King'), authorKey('Stephen King-Smith'));
});

test('folds accents instead of deleting the letters', () => {
  // Real record: "Jasmin Hodžić" must key on hodzic, not on the trailing "i"
  // that survives when non-ASCII letters are simply stripped.
  assert.equal(authorKey('Jasmin Hodžić'), 'hodzic:j');
  assert.equal(authorKey('Jasmin Hodzic'), authorKey('Jasmin Hodžić'));
  assert.equal(authorKey('François Mauriac'), 'mauriac:f');
});

test('picks the most complete spelling as the display name', () => {
  assert.equal(
    preferredName(['R.L. Stine', 'R.L. Stine', 'Robert Lawrence Stine']),
    'R.L. Stine',
  );
  assert.equal(preferredName(['Robert Lawrence Stine', 'R.L. Stine']), 'Robert Lawrence Stine');
  assert.equal(preferredName([]), null);
});
