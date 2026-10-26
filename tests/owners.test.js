// Owners: entered once, then chosen from a list.
//
// The point of the table is that ownership is picked, not typed. Free text had
// already produced "Me" and "me" as different owners, and adding a book used to
// need a second screen just to say whose it was.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  openDb,
  saveBook,
  findBook,
  listOwners,
  addOwner,
  setDefaultOwner,
  renameOwner,
  deleteOwner,
  defaultOwnerName,
} from '../src/db.js';

const work = (title) => ({ title, authors: ['Someone'], authorKey: 'someone:s' });

test('a fresh database has "Me" as the default owner, so adding never asks', () => {
  const db = openDb(':memory:');
  const owners = listOwners(db);
  assert.equal(owners.length, 1);
  assert.equal(owners[0].name, 'Me');
  assert.equal(owners[0].isDefault, true);
  assert.equal(defaultOwnerName(db), 'Me');
});

test('an added book takes the default owner without being told', () => {
  const db = openDb(':memory:');
  addOwner(db, 'Mum');
  setDefaultOwner(db, listOwners(db).find((o) => o.name === 'Mum').id);

  const book = saveBook(db, { isbn13: '9780330360890', work: work('Ice Station') });
  assert.equal(book.owner, 'Mum', 'the chosen default is applied automatically');
});

test('names are unique regardless of case', () => {
  const db = openDb(':memory:');
  addOwner(db, 'Sarah');
  assert.throws(() => addOwner(db, 'sarah'), /owner_exists/);
  assert.throws(() => addOwner(db, '  '), /owner_name_required/);
});

test('exactly one owner is the default at any time', () => {
  const db = openDb(':memory:');
  const sarah = addOwner(db, 'Sarah');
  setDefaultOwner(db, sarah.id);
  const owners = listOwners(db);
  assert.equal(owners.filter((o) => o.isDefault).length, 1);
  assert.equal(defaultOwnerName(db), 'Sarah');
});

test('renaming an owner follows through to the books already attributed', () => {
  const db = openDb(':memory:');
  const sarah = addOwner(db, 'Sarah');
  setDefaultOwner(db, sarah.id);
  saveBook(db, { isbn13: '9780330360890', work: work('Ice Station') });

  renameOwner(db, sarah.id, 'Sarah B');
  assert.equal(findBook(db, '9780330360890').owner, 'Sarah B');
  assert.equal(defaultOwnerName(db), 'Sarah B');
});

test('removing an owner never un-owns their books', () => {
  const db = openDb(':memory:');
  const sarah = addOwner(db, 'Sarah');
  setDefaultOwner(db, sarah.id);
  saveBook(db, { isbn13: '9780330360890', work: work('Ice Station') });

  deleteOwner(db, sarah.id);
  assert.equal(listOwners(db).some((o) => o.name === 'Sarah'), false, 'gone from the list');
  assert.equal(findBook(db, '9780330360890').owner, 'Sarah', 'the book still says whose it is');
  assert.equal(defaultOwnerName(db), 'Me', 'the default falls back to another owner');
});

test('a placeholder record is filled in by a later save, not left blank', () => {
  // This is the background-enrichment path: a book added with no catalogue data
  // stores an empty title, and the retry must be able to fill it later.
  const db = openDb(':memory:');
  saveBook(db, { isbn13: '9780330360890', work: { title: '', authors: [], authorKey: null } });
  assert.equal(findBook(db, '9780330360890').title, '');

  saveBook(db, { isbn13: '9780330360890', work: work('Ice Station') });
  const filled = findBook(db, '9780330360890');
  assert.equal(filled.title, 'Ice Station');
  assert.equal(filled.owner, 'Me', 'enrichment must not disturb ownership');
});
