// Blurbs: provider HTML must never reach the screen.
//
// Google and Open Library send descriptions as HTML fragments. The app escapes
// everything it renders, so "<p>It was a dark night.</p>" was displayed literally
// as "<p>It was a dark night.</p>" - tags and all.
import test from 'node:test';
import assert from 'node:assert/strict';

import { stripHtml } from '../src/util.js';
import { openDb, saveBook, findBook, cleanDescriptions } from '../src/db.js';

test('paragraph tags become blank lines, not visible markup', () => {
  const text = stripHtml('<p>First para.</p><p>Second para.</p>');
  assert.equal(text, 'First para.\n\nSecond para.');
  assert.ok(!text.includes('<'), 'no tags survive');
});

test('a line break stays a single newline', () => {
  assert.equal(stripHtml('Line one<br>Line two<br/>Line three'), 'Line one\nLine two\nLine three');
});

test('inline formatting is dropped but the words stay', () => {
  assert.equal(stripHtml('<p>A <b>bold</b> and <i>italic</i> claim.</p>'), 'A bold and italic claim.');
});

test('entities are decoded, including double-escaped ones', () => {
  assert.equal(stripHtml('Tom &amp; Jerry &quot;quoted&quot; &#39;apos&#39;'), 'Tom & Jerry "quoted" \'apos\'');
  assert.equal(stripHtml('&amp;lt;'), '&lt;', 'decode &amp; last, so it cannot re-create a tag');
  assert.equal(stripHtml('5 &lt; 6'), '5 < 6');
});

test('text with no markup is left alone, and empty input stays empty', () => {
  assert.equal(stripHtml('Plain text, nothing to do.'), 'Plain text, nothing to do.');
  assert.equal(stripHtml(''), null);
  assert.equal(stripHtml(null), null);
});

test('runs of blank lines are squeezed', () => {
  assert.equal(stripHtml('<p>One</p>\n\n\n\n<p>Two</p>'), 'One\n\nTwo');
});

test('stored blurbs containing markup are rewritten once', () => {
  const db = openDb(':memory:');
  saveBook(db, {
    isbn13: '9780330360890',
    work: {
      title: 'Ice Station',
      authors: ['Matthew Reilly'],
      authorKey: 'reilly:m',
      description: '<p>A secret base goes silent.</p><p>Then the bodies turn up.</p>',
    },
  });

  const changed = cleanDescriptions(db, stripHtml);
  assert.equal(changed, 1);

  const book = findBook(db, '9780330360890');
  assert.equal(book.description, 'A secret base goes silent.\n\nThen the bodies turn up.');

  // Running it again is a no-op, which is what makes it safe at every startup.
  assert.equal(cleanDescriptions(db, stripHtml), 0);
});
