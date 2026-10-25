// Database round-trip tests against a real in-memory SQLite database.
//
// These exist because a storage-layer bug is invisible to unit tests of pure
// functions: an author array that survived the write but not the read (the
// server re-parsing JSON it had already parsed) produced books with no authors
// and no error anywhere. Anything written must be read back and asserted.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  openDb,
  saveBook,
  findBook,
  listBooks,
  listSeries,
  seriesSummary,
  stats,
  deleteBook,
  exportAll,
} from '../src/db.js';
import { missingVolumes } from '../src/series.js';

function freshDb() {
  return openDb(':memory:');
}

const goosebumps = (volume, title) => ({
  title,
  subtitle: `Goosebumps #${volume}`,
  authors: ['R.L. Stine'],
  authorKey: 'stine:r',
  series: 'Goosebumps',
  seriesKey: 'goosebumps',
  volume,
  publisher: 'Scholastic',
  published: '1992',
  pages: 120,
  rating: 4.1,
  ratingsCount: 900,
});

test('a saved book reads back with its authors intact', () => {
  const db = freshDb();
  saveBook(db, { isbn13: '9780590453660', work: goosebumps(2, 'Stay Out of the Basement') });

  const book = findBook(db, '9780590453660');
  assert.equal(book.title, 'Stay Out of the Basement');
  assert.deepEqual(book.authors, ['R.L. Stine']);
  assert.equal(book.author, 'R.L. Stine');
  assert.equal(book.series, 'Goosebumps');
  assert.equal(book.volume, 2);
  assert.equal(book.state, 'owned');
  assert.equal(book.readState, 'unread');
});

test('re-adding an ISBN updates it instead of throwing, and keeps the work', () => {
  const db = freshDb();
  saveBook(db, { isbn13: '9780590453660', work: goosebumps(2, 'Stay Out of the Basement') });
  const again = saveBook(db, {
    isbn13: '9780590453660',
    work: null,
    state: 'wishlist',
    fields: { notes: 'borrowed from Dad' },
  });
  assert.equal(again.state, 'wishlist');
  assert.equal(again.notes, 'borrowed from Dad');
  assert.equal(again.title, 'Stay Out of the Basement');
  assert.deepEqual(again.authors, ['R.L. Stine']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM works').get().n, 1);
});

test('a manual edit is never overwritten by later API data', () => {
  const db = freshDb();
  saveBook(db, { isbn13: '9780590453660', work: goosebumps(2, 'Stay Out of the Basement') });
  db.prepare("UPDATE works SET series = 'My Fix', volume = 99").run();

  // Simulate the API being consulted again with different values.
  saveBook(db, { isbn13: '9780590453660', work: goosebumps(2, 'Wrong Title') });
  const book = findBook(db, '9780590453660');
  assert.equal(book.series, 'My Fix');
  assert.equal(book.volume, 99);
});

test('series gaps come out of real owned volumes', () => {
  const db = freshDb();
  const rows = [
    ['9780590453677', 1, 'Welcome to Dead House'],
    ['9780590453660', 2, 'Stay Out of the Basement'],
    ['9780590453691', 3, 'Monster Blood'],
    ['9780590453707', 4, 'Say Cheese and Die'],
  ];
  for (const [isbn, volume, title] of rows) {
    saveBook(db, { isbn13: isbn, work: goosebumps(volume, title) });
  }

  const summary = seriesSummary(db, 'goosebumps');
  assert.deepEqual(summary.ownedVolumes, [1, 2, 3, 4]);
  assert.deepEqual(missingVolumes(summary.ownedVolumes).ranges, []);

  // Losing volume 2 must show up as a gap immediately.
  saveBook(db, { isbn13: '9780590453660', work: null, state: 'wishlist' });
  const after = seriesSummary(db, 'goosebumps');
  assert.deepEqual(after.ownedVolumes, [1, 3, 4]);
  assert.deepEqual(missingVolumes(after.ownedVolumes).ranges, ['2']);
});

test('listSeries groups by series key and counts only owned copies', () => {
  const db = freshDb();
  saveBook(db, { isbn13: '9780590453677', work: goosebumps(1, 'Welcome to Dead House') });
  saveBook(db, { isbn13: '9780590453660', work: goosebumps(2, 'Stay Out of the Basement'), state: 'wishlist' });
  saveBook(db, {
    isbn13: '9780306406157',
    work: { title: 'Solo Book', authors: ['Someone'], authorKey: 'someone:s', series: null, volume: null },
  });

  const series = listSeries(db);
  assert.equal(series.length, 1);
  assert.equal(series[0].key, 'goosebumps');
  assert.equal(series[0].ownedCount, 1);
  assert.deepEqual(series[0].ownedVolumes, [1]);
});

test('stats and the export reflect what is actually stored', () => {
  const db = freshDb();
  saveBook(db, { isbn13: '9780590453677', work: goosebumps(1, 'Welcome to Dead House') });
  saveBook(db, { isbn13: '9780590453660', work: goosebumps(2, 'Stay Out of the Basement'), state: 'wishlist' });
  saveBook(db, {
    isbn13: '9780306406157',
    work: { title: 'Read One', authors: ['A. Writer'], authorKey: 'writer:a', series: null, volume: null },
    fields: { read_state: 'read' },
  });

  const s = stats(db);
  assert.equal(s.owned, 2);
  assert.equal(s.wishlist, 1);
  assert.equal(s.read, 1);
  assert.equal(s.series, 1);

  const dump = exportAll(db);
  assert.equal(dump.books.length, 3);
  assert.ok(dump.books.some((b) => b.isbn13 === '9780590453660' && b.state === 'wishlist'));
});

test('search matches title, author and ISBN', () => {
  const db = freshDb();
  saveBook(db, { isbn13: '9780590453677', work: goosebumps(1, 'Welcome to Dead House') });

  assert.equal(listBooks(db, { q: 'dead' }).length, 1);
  assert.equal(listBooks(db, { q: 'stine' }).length, 1);
  assert.equal(listBooks(db, { q: '9780590453677' }).length, 1);
  assert.equal(listBooks(db, { q: 'pratchett' }).length, 0);
  assert.equal(listBooks(db, { state: 'wishlist' }).length, 0);
});

test('deleting removes the copy and its orphaned work', () => {
  const db = freshDb();
  saveBook(db, { isbn13: '9780590453677', work: goosebumps(1, 'Welcome to Dead House') });
  assert.equal(deleteBook(db, '9780590453677'), true);
  assert.equal(findBook(db, '9780590453677'), null);
  assert.equal(deleteBook(db, '9780590453677'), false);
});
