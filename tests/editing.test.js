// Correcting a book, and replacing its cover.
//
// Two things are being protected here:
//   1. What a person types must survive a later metadata refresh - the whole
//      point of an editable catalogue is that your correction is not undone
//      overnight by an enrichment pass.
//   2. A cover upload must accept only images, and must land where the cover
//      route already looks, or the picture is written and never served.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, saveBook, findBook, updateWork } from '../src/db.js';
import { decodeCoverImage, sniff, saveCoverBytes } from '../src/coverupload.js';
import { hasCover, coverMissPending, coverFile } from '../src/covers.js';

const goosebumps = {
  title: 'Stay Out of the Basement',
  authors: ['R.L. Stine'],
  authorKey: 'stine:r',
  series: 'Goosebumps',
  seriesKey: 'goosebumps',
  volume: 2,
  publisher: 'Scholastic',
  published: '1992',
  pages: 120,
};

function dbWithBook(isbn13 = '9780590453660') {
  const db = openDb(':memory:');
  saveBook(db, { isbn13, work: { ...goosebumps } });
  return db;
}

/** A buffer that starts like a JPEG and is long enough to pass the size floor. */
function jpegBytes(size = 4096) {
  const bytes = Buffer.alloc(size, 0x20);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[2] = 0xff;
  return bytes;
}

test('a correction overwrites provider data, including the grouping keys', () => {
  const db = dbWithBook();
  const book = findBook(db, '9780590453660');

  updateWork(db, book.workId, {
    title: 'Stay Out of the Basement (1992 printing)',
    authors: JSON.stringify(['Robert Lawrence Stine']),
    author_key: 'stine:r',
    publisher: 'Scholastic US',
    published: '1993',
    pages: 132,
    description: 'Corrected by hand.',
    series: 'Goosebumps Original',
    series_key: 'goosebumps original',
    volume: 2,
  });

  const after = findBook(db, '9780590453660');
  assert.equal(after.title, 'Stay Out of the Basement (1992 printing)');
  assert.deepEqual(after.authors, ['Robert Lawrence Stine']);
  assert.equal(after.publisher, 'Scholastic US');
  assert.equal(after.published, '1993');
  assert.equal(after.pages, 132);
  assert.equal(after.description, 'Corrected by hand.');
  assert.equal(after.series, 'Goosebumps Original');
  assert.equal(after.seriesKey, 'goosebumps original');
});

test('a later metadata refresh does not undo the correction', () => {
  const db = dbWithBook();
  const book = findBook(db, '9780590453660');
  updateWork(db, book.workId, { title: 'My title', publisher: 'My publisher', pages: 999 });

  // Exactly what background enrichment calls, with the provider's own (wrong)
  // values. Blanks-only filling must leave the typed values alone.
  saveBook(db, { isbn13: '9780590453660', work: { ...goosebumps }, state: 'owned', fields: {} });

  const after = findBook(db, '9780590453660');
  assert.equal(after.title, 'My title');
  assert.equal(after.publisher, 'My publisher');
  assert.equal(after.pages, 999);
});

test('only whitelisted columns can be written, and unknown keys are ignored', () => {
  const db = dbWithBook();
  const book = findBook(db, '9780590453660');

  // A key that is not a column must be dropped, not turned into SQL.
  assert.equal(
    updateWork(db, book.workId, { title: 'Safe', "id = 1; DROP TABLE books; --": 'x', cover_id: 'nope' }),
    1,
  );
  assert.equal(findBook(db, '9780590453660').title, 'Safe');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM books').get().n, 1);
  assert.equal(updateWork(db, book.workId, {}), 0);
});

test('cover bytes are identified by content, not by the client\'s claim', () => {
  const jpeg = decodeCoverImage(`data:image/jpeg;base64,${jpegBytes().toString('base64')}`);
  assert.equal(jpeg.mime, 'image/jpeg');
  assert.equal(jpeg.bytes.length, 4096);

  // A JPEG labelled as a GIF is still a JPEG: the bytes decide.
  const mislabelled = decodeCoverImage(`data:image/gif;base64,${jpegBytes().toString('base64')}`);
  assert.equal(mislabelled.mime, 'image/jpeg');

  const png = Buffer.alloc(2048, 0);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]).copy(png, 0);
  assert.equal(decodeCoverImage(png.toString('base64')).mime, 'image/png');

  assert.equal(decodeCoverImage('').error, 'empty');
  assert.equal(decodeCoverImage('not base64 at all!!!').error, 'not_base64');
  // Real HTML padded past the size floor is not an image.
  assert.equal(decodeCoverImage(Buffer.alloc(2048, 0x41).toString('base64')).error, 'not_an_image');
  assert.equal(decodeCoverImage(jpegBytes(200).toString('base64')).error, 'too_small');
  assert.equal(sniff(Buffer.alloc(4)), null);
});

test('a saved cover is where the cover route looks, and clears a stale miss', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'bookshelf-covers-'));
  const isbn13 = '9780590453660';

  // Pretend an earlier fetch decided this book has no cover.
  saveCoverBytes(dataDir, isbn13, jpegBytes());
  assert.equal(hasCover(dataDir, isbn13), true);
  assert.equal(existsSync(coverFile(dataDir, isbn13)), true);
  assert.equal(coverMissPending(dataDir, isbn13), false);

  const bytes = readFileSync(coverFile(dataDir, isbn13));
  assert.equal(bytes.length, 4096);
  assert.equal(bytes[0], 0xff);
});
