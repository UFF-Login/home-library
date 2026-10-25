// SQLite persistence. One file, WAL mode, no ORM - the whole catalogue for
// 2,000 books is a few MB, so plain SQL stays readable and fast.
//
// Two tables carry the meaning:
//   works = a book as a concept (title, author, series, volume)
//   books = a physical thing you own or want, one row per ISBN
// Keeping them separate means a wishlist entry can become owned by flipping one
// column, and a series gap can be computed without inventing placeholder rows.
// node:sqlite is built into Node 22+, so the app has ZERO native dependencies.
// That matters for deployment: no compiler, no node-gyp, no prebuilt binary that
// has to match the host (a NAS on arm64 is exactly where better-sqlite3 hurts).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { nowIso } from './util.js';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS works (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  title           TEXT NOT NULL,
  subtitle        TEXT,
  authors         TEXT,          -- JSON array of display names
  author_key      TEXT,          -- grouping key for the primary author
  series          TEXT,
  series_key      TEXT,
  volume          REAL,
  publisher       TEXT,
  published       TEXT,
  pages           INTEGER,
  description     TEXT,
  rating          REAL,          -- community average from the API, 0-5
  ratings_count   INTEGER,
  work_key        TEXT,          -- Open Library work key, needed for ratings
  cover_id        TEXT,          -- Open Library cover id, fallback for covers
  subjects        TEXT,          -- JSON array, kept for future tags
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS books (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  isbn13      TEXT NOT NULL UNIQUE,
  work_id     INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  state       TEXT NOT NULL DEFAULT 'owned' CHECK (state IN ('owned','wishlist')),
  read_state  TEXT NOT NULL DEFAULT 'unread' CHECK (read_state IN ('unread','reading','read')),
  my_rating   INTEGER CHECK (my_rating IS NULL OR (my_rating BETWEEN 1 AND 5)),
  notes       TEXT,
  location    TEXT,          -- "Study, shelf 3" - free text on purpose
  loaned_to   TEXT,          -- who currently has it; null when on the shelf
  loaned_at   TEXT,
  added_at    TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS books_state_idx ON books(state);
CREATE INDEX IF NOT EXISTS books_work_idx ON books(work_id);
CREATE INDEX IF NOT EXISTS works_series_idx ON works(series_key);

-- Every scan is kept: it makes "recently scanned" work and shows what the
-- phone actually read, which is the first thing to check if a barcode fails.
CREATE TABLE IF NOT EXISTS scans (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  isbn13  TEXT,
  verdict TEXT NOT NULL,      -- owned | wishlist | missing | unknown | invalid
  at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Metadata fetched from Open Library, including "nothing found". Cached so a
-- shop scan of the same book twice, or a rescan after adding it, costs nothing;
-- and so a miss is not re-queried every time the phone looks at it.
CREATE TABLE IF NOT EXISTS lookup_cache (
  isbn13     TEXT PRIMARY KEY,
  found      INTEGER NOT NULL,
  payload    TEXT,
  fetched_at TEXT NOT NULL
);
`;

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/**
 * Additive migrations. Kept separate from SCHEMA so an existing catalogue picks
 * up new columns without a wipe.
 */
function migrate(db) {
  const columns = db.prepare('PRAGMA table_info(books)').all().map((c) => c.name);
  // "Who owns it" replaced "where is it": the shelf location was never the
  // interesting fact, ownership is.
  if (!columns.includes('owner')) db.exec('ALTER TABLE books ADD COLUMN owner TEXT');
}

export function getMeta(db, key) {
  return db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
}

export function setMeta(db, key, value) {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, String(value));
}

/** Find a book (owned or wishlisted) by barcode. Local lookup, no network. */
export function findBook(db, isbn13) {
  const row = db
    .prepare(
      `SELECT b.*, w.title, w.subtitle, w.authors, w.author_key, w.series, w.series_key,
              w.volume, w.publisher, w.published, w.pages, w.description, w.rating,
              w.ratings_count, w.cover_id
         FROM books b JOIN works w ON w.id = b.work_id
        WHERE b.isbn13 = ?`,
    )
    .get(isbn13);
  return row ? rowToBook(row) : null;
}

/**
 * Insert or update a book. `work` comes from the lookup layer, `fields` are the
 * user's own columns. Re-adding an ISBN you already have updates it rather than
 * failing, because a second-hand copy of something you own should just be a
 * correction, not an error the phone has to explain.
 */
export function saveBook(db, { isbn13, work, state = 'owned', fields = {} }) {
  const at = nowIso();
  let workId;
  // node:sqlite has no transaction helper, so the transaction is explicit:
  // BEGIN IMMEDIATE takes the write lock up front and cannot deadlock mid-way.
  db.exec('BEGIN IMMEDIATE');
  try {
    const existingWork = db
      .prepare(
        `SELECT w.id FROM works w JOIN books b ON b.work_id = w.id WHERE b.isbn13 = ?`,
      )
      .get(isbn13);

    workId = existingWork?.id;
    if (workId) {
      // Only fill blanks: never overwrite a manual edit with API data.
      db.prepare(
        `UPDATE works SET
           title = CASE WHEN title = '' THEN ? ELSE title END,
           subtitle = COALESCE(subtitle, ?),
           authors = COALESCE(authors, ?),
           author_key = COALESCE(author_key, ?),
           series = COALESCE(series, ?),
           series_key = COALESCE(series_key, ?),
           volume = COALESCE(volume, ?),
           publisher = COALESCE(publisher, ?),
           published = COALESCE(published, ?),
           pages = COALESCE(pages, ?),
           description = COALESCE(description, ?),
           rating = COALESCE(rating, ?),
           ratings_count = COALESCE(ratings_count, ?),
           work_key = COALESCE(work_key, ?),
           cover_id = COALESCE(cover_id, ?),
           updated_at = ?
         WHERE id = ?`,
      ).run(
        work?.title ?? '',
        work?.subtitle ?? null,
        work?.authors?.length ? JSON.stringify(work.authors) : null,
        work?.authorKey ?? null,
        work?.series ?? null,
        work?.seriesKey ?? null,
        work?.volume ?? null,
        work?.publisher ?? null,
        work?.published ?? null,
        work?.pages ?? null,
        work?.description ?? null,
        work?.rating ?? null,
        work?.ratingsCount ?? null,
        work?.workKey ?? null,
        work?.coverId ?? null,
        at,
        workId,
      );
    } else {
      const info = db
        .prepare(
          `INSERT INTO works (title, subtitle, authors, author_key, series, series_key,
                              volume, publisher, published, pages, description, rating,
                              ratings_count, work_key, cover_id, subjects, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          work?.title ?? 'Untitled',
          work?.subtitle ?? null,
          work?.authors?.length ? JSON.stringify(work.authors) : null,
          work?.authorKey ?? null,
          work?.series ?? null,
          work?.seriesKey ?? null,
          work?.volume ?? null,
          work?.publisher ?? null,
          work?.published ?? null,
          work?.pages ?? null,
          work?.description ?? null,
          work?.rating ?? null,
          work?.ratingsCount ?? null,
          work?.workKey ?? null,
          work?.coverId ?? null,
          work?.subjects?.length ? JSON.stringify(work.subjects) : null,
          at,
        );
      workId = Number(info.lastInsertRowid);
    }

    const existingBook = db.prepare('SELECT id FROM books WHERE isbn13 = ?').get(isbn13);
    if (existingBook) {
      db.prepare(
        `UPDATE books SET
           state = ?, read_state = COALESCE(?, read_state),
           my_rating = COALESCE(?, my_rating), notes = COALESCE(?, notes),
           location = COALESCE(?, location), owner = COALESCE(?, owner),
           loaned_to = COALESCE(?, loaned_to),
           loaned_at = COALESCE(?, loaned_at), updated_at = ?
         WHERE id = ?`,
      ).run(
        state,
        fields.read_state ?? null,
        fields.my_rating ?? null,
        fields.notes ?? null,
        fields.location ?? null,
        fields.owner ?? null,
        fields.loaned_to ?? null,
        fields.loaned_at ?? null,
        at,
        existingBook.id,
      );
    } else {
      db.prepare(
        `INSERT INTO books (isbn13, work_id, state, read_state, my_rating, notes, location,
                            owner, loaned_to, loaned_at, added_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        isbn13,
        workId,
        state,
        fields.read_state ?? 'unread',
        fields.my_rating ?? null,
        fields.notes ?? null,
        fields.location ?? null,
        fields.owner ?? null,
        fields.loaned_to ?? null,
        fields.loaned_at ?? null,
        at,
        at,
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return findBook(db, isbn13);
}

function rowToBook(row) {
  if (!row) return null;
  let authors = [];
  try {
    authors = row.authors ? JSON.parse(row.authors) : [];
  } catch {
    authors = row.authors ? [String(row.authors)] : [];
  }
  return {
    isbn13: row.isbn13,
    workId: row.work_id,
    state: row.state,
    readState: row.read_state,
    myRating: row.my_rating,
    notes: row.notes,
    location: row.location,
    owner: row.owner ?? null,
    loanedTo: row.loaned_to,
    loanedAt: row.loaned_at,
    addedAt: row.added_at,
    title: row.title,
    subtitle: row.subtitle,
    authors,
    author: authors[0] ?? null,
    authorKey: row.author_key,
    series: row.series,
    seriesKey: row.series_key,
    volume: row.volume,
    publisher: row.publisher,
    published: row.published,
    pages: row.pages,
    description: row.description,
    rating: row.rating,
    ratingsCount: row.ratings_count,
    coverId: row.cover_id ?? null,
    cover: `/cover/${row.isbn13}.jpg`,
  };
}

/** Library listing with optional text search and state filter. */
export function listBooks(db, { q = '', state = '', sort = 'added', limit = 2000 } = {}) {
  const where = [];
  const params = {};
  if (state === 'owned' || state === 'wishlist') {
    where.push('b.state = @state');
    params.state = state;
  }
  if (q) {
    where.push('(w.title LIKE @q OR w.authors LIKE @q OR w.series LIKE @q OR b.isbn13 LIKE @q)');
    params.q = `%${q}%`;
  }
  const order =
    sort === 'title'
      ? 'w.title COLLATE NOCASE ASC'
      : sort === 'author'
        ? 'w.author_key ASC, w.series ASC, w.volume ASC'
        : sort === 'series'
          ? 'w.series COLLATE NOCASE ASC, w.volume ASC'
          : 'b.added_at DESC';

  const sql = `SELECT b.*, w.title, w.subtitle, w.authors, w.author_key, w.series, w.series_key,
                      w.volume, w.publisher, w.published, w.pages, w.description, w.rating,
                      w.ratings_count
                 FROM books b JOIN works w ON w.id = b.work_id
                ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                ORDER BY ${order} LIMIT @limit`;
  params.limit = limit;
  return db.prepare(sql).all(params).map(rowToBook);
}

/**
 * Series overview: every series you own at least one volume of, with the gaps
 * up to the highest volume you own. This is the "you're missing 2, 5 and 13-17"
 * feature, computed from real data rather than a hardcoded catalogue.
 */
export function listSeries(db) {
  const rows = db
    .prepare(
      `SELECT w.series, w.series_key, w.volume, w.title, b.isbn13, b.state
         FROM books b JOIN works w ON w.id = b.work_id
        WHERE w.series_key IS NOT NULL
        ORDER BY w.series_key, w.volume`,
    )
    .all();

  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.series_key)) {
      grouped.set(row.series_key, { key: row.series_key, name: row.series, items: [] });
    }
    grouped.get(row.series_key).items.push({
      isbn13: row.isbn13,
      title: row.title,
      volume: row.volume,
      state: row.state,
    });
  }

  return [...grouped.values()]
    .map((series) => {
      const ownedVolumes = series.items.filter((i) => i.state === 'owned' && i.volume).map((i) => i.volume);
      return {
        ...series,
        name: series.name ?? series.key,
        ownedCount: series.items.filter((i) => i.state === 'owned').length,
        ownedVolumes,
      };
    })
    .sort((a, b) => b.ownedCount - a.ownedCount || a.name.localeCompare(b.name));
}

export function stats(db) {
  const one = (sql) => db.prepare(sql).get();
  return {
    owned: one("SELECT COUNT(*) AS n FROM books WHERE state = 'owned'").n,
    wishlist: one("SELECT COUNT(*) AS n FROM books WHERE state = 'wishlist'").n,
    read: one("SELECT COUNT(*) AS n FROM books WHERE read_state = 'read'").n,
    loaned: one("SELECT COUNT(*) AS n FROM books WHERE loaned_to IS NOT NULL AND loaned_to != ''").n,
    series: one('SELECT COUNT(DISTINCT series_key) AS n FROM works WHERE series_key IS NOT NULL').n,
    authors: one('SELECT COUNT(DISTINCT author_key) AS n FROM works WHERE author_key IS NOT NULL').n,
  };
}

/**
 * One series, with the gap maths applied. Used by the scan result so that
 * scanning volume 17 of something can immediately say what else is missing.
 */
export function seriesSummary(db, seriesKeyValue) {
  if (!seriesKeyValue) return null;
  const rows = db
    .prepare(
      `SELECT w.series, w.volume, w.title, b.isbn13, b.state
         FROM books b JOIN works w ON w.id = b.work_id
        WHERE w.series_key = ? ORDER BY w.volume`,
    )
    .all(seriesKeyValue);
  if (rows.length === 0) return null;
  const ownedVolumes = rows
    .filter((r) => r.state === 'owned' && r.volume)
    .map((r) => Math.trunc(r.volume));
  return {
    key: seriesKeyValue,
    name: rows.find((r) => r.series)?.series ?? seriesKeyValue,
    ownedVolumes,
    ownedCount: rows.filter((r) => r.state === 'owned').length,
    items: rows,
  };
}

export function getLookupCache(db, isbn13) {
  const row = db
    .prepare('SELECT found, payload, fetched_at FROM lookup_cache WHERE isbn13 = ?')
    .get(isbn13);
  if (!row) return null;
  let payload = null;
  try {
    payload = row.payload ? JSON.parse(row.payload) : null;
  } catch {
    payload = null;
  }
  return { found: Boolean(row.found), work: payload, fetchedAt: row.fetched_at };
}

export function setLookupCache(db, isbn13, { found, work }) {
  db.prepare(
    `INSERT INTO lookup_cache (isbn13, found, payload, fetched_at) VALUES (?,?,?,?)
     ON CONFLICT(isbn13) DO UPDATE SET found = excluded.found, payload = excluded.payload,
                                       fetched_at = excluded.fetched_at`,
  ).run(isbn13, found ? 1 : 0, work ? JSON.stringify(work) : null, nowIso());
}

export function recordScan(db, isbn13, verdict) {
  db.prepare('INSERT INTO scans (isbn13, verdict, at) VALUES (?,?,?)').run(isbn13 ?? null, verdict, nowIso());
}

export function recentScans(db, limit = 50) {
  return db
    .prepare(
      `SELECT s.isbn13, s.verdict, s.at, w.title, w.authors
         FROM scans s LEFT JOIN works w ON w.id = (SELECT work_id FROM books WHERE isbn13 = s.isbn13)
        ORDER BY s.id DESC LIMIT ?`,
    )
    .all(limit);
}

export function deleteBook(db, isbn13) {
  return db.prepare('DELETE FROM books WHERE isbn13 = ?').run(isbn13).changes > 0;
}

/** Whole-catalogue JSON dump: the backup format, and the restore format. */
export function exportAll(db) {
  return {
    app: 'bookshelf',
    version: 1,
    exportedAt: nowIso(),
    books: db
      .prepare(
        `SELECT b.isbn13, b.state, b.read_state, b.my_rating, b.notes, b.location, b.owner, b.loaned_to,
                b.loaned_at, b.added_at, w.title, w.subtitle, w.authors, w.series, w.volume,
                w.publisher, w.published, w.pages, w.description, w.rating, w.ratings_count
           FROM books b JOIN works w ON w.id = b.work_id`,
      )
      .all(),
  };
}
