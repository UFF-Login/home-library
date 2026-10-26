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
  cover_url       TEXT,          -- provider thumbnail URL (Google-only records)
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

-- People who can own a book. Entered once, then chosen from a drop-down instead
-- of being retyped for every add (which is how "Me", "me" and "Mum" all appeared).
CREATE TABLE IF NOT EXISTS owners (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  is_default  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);

-- What a whole series contains, fetched from Wikidata and kept for a month.
CREATE TABLE IF NOT EXISTS series_cache (
  series_key  TEXT PRIMARY KEY,
  payload     TEXT NOT NULL,
  fetched_at  TEXT NOT NULL
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

  // Existing databases predate Google-only records, which carry their own
  // thumbnail URL because there is no Open Library cover id to look up.
  const owners = db.prepare('SELECT COUNT(*) AS n FROM owners').get().n;
  if (owners === 0) {
    db.prepare('INSERT INTO owners (name, is_default, created_at) VALUES (?, 1, ?)').run(
      'Me',
      new Date().toISOString(),
    );
  }

  const workColumns = db.prepare('PRAGMA table_info(works)').all().map((c) => c.name);
  if (!workColumns.includes('cover_url')) db.exec('ALTER TABLE works ADD COLUMN cover_url TEXT');
}

/** Used by tests and by the rebuild action to prove a migration ran. */
export function columnsOf(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
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
              w.ratings_count, w.cover_id, w.cover_url
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
           cover_url = COALESCE(cover_url, ?),
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
        work?.coverUrl ?? null,
        at,
        workId,
      );
    } else {
      const info = db
        .prepare(
          `INSERT INTO works (title, subtitle, authors, author_key, series, series_key,
                              volume, publisher, published, pages, description, rating,
                              ratings_count, work_key, cover_id, cover_url, subjects, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
          work?.coverUrl ?? null,
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
        // A book you own belongs to you unless told otherwise; a wishlist entry
        // has no owner yet.
        fields.owner ?? (state === 'owned' ? defaultOwnerName(db) : null),
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
    coverUrl: row.cover_url ?? null,
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
      `SELECT w.series, w.volume, w.title, w.work_key, w.authors, b.isbn13, b.state
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
    items: rows.map((r) => ({
      isbn13: r.isbn13,
      title: r.title,
      volume: r.volume,
      state: r.state,
      // Needed to ask Wikidata what the rest of the series contains.
      workKey: r.work_key ?? null,
      // Needed by the Google fallback: an author's other books reveal the series.
      authors: (() => {
        try {
          const parsed = JSON.parse(r.authors ?? '[]');
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      })(),
    })),
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
  // Newer entries store { work, sources }: `sources` records which enrichment
  // providers were usable at fetch time, so a key added later can be noticed and
  // the entry refreshed. Older entries are the bare work object.
  const isRecord = payload && typeof payload === 'object' && 'work' in payload;
  return {
    found: Boolean(row.found),
    work: isRecord ? payload.work : payload,
    sources: isRecord ? (payload.sources ?? {}) : {},
    legacy: !isRecord,
    fetchedAt: row.fetched_at,
  };
}

export function setLookupCache(db, isbn13, { found, work, sources = {} }) {
  db.prepare(
    `INSERT INTO lookup_cache (isbn13, found, payload, fetched_at) VALUES (?,?,?,?)
     ON CONFLICT(isbn13) DO UPDATE SET found = excluded.found, payload = excluded.payload,
                                       fetched_at = excluded.fetched_at`,
  ).run(isbn13, found ? 1 : 0, JSON.stringify({ work, sources }), nowIso());
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

/**
 * Drop every cached metadata lookup. Used by "rebuild book data": after adding an
 * API key, or when enrichment looks wrong, this makes the next scan fetch fresh
 * while leaving the catalogue itself untouched.
 */
export function clearLookupCache(db) {
  return db.prepare('DELETE FROM lookup_cache').run().changes;
}


/**
 * People who can own a book.
 *
 * This exists so ownership is chosen from a list rather than typed every time -
 * free text had already produced "Me" and "me" as different owners.
 */
export function listOwners(db) {
  return db
    .prepare('SELECT id, name, is_default FROM owners ORDER BY is_default DESC, name COLLATE NOCASE')
    .all()
    .map((row) => ({ id: row.id, name: row.name, isDefault: Boolean(row.is_default) }));
}

export function defaultOwnerName(db) {
  const row = db
    .prepare('SELECT name FROM owners ORDER BY is_default DESC, id LIMIT 1')
    .get();
  return row?.name ?? null;
}

/** Add an owner. Returns the stored row; the first owner added becomes default. */
export function addOwner(db, name) {
  const clean = String(name ?? '').trim();
  if (!clean) throw new Error('owner_name_required');
  if (clean.length > 60) throw new Error('owner_name_too_long');

  const existing = db.prepare('SELECT id FROM owners WHERE name = ? COLLATE NOCASE').get(clean);
  if (existing) throw new Error('owner_exists');

  const isFirst = db.prepare('SELECT COUNT(*) AS n FROM owners').get().n === 0;
  const info = db
    .prepare('INSERT INTO owners (name, is_default, created_at) VALUES (?, ?, ?)')
    .run(clean, isFirst ? 1 : 0, new Date().toISOString());
  return { id: Number(info.lastInsertRowid), name: clean, isDefault: isFirst };
}

/** Exactly one owner is the default: the one applied when a book is added. */
export function setDefaultOwner(db, id) {
  const row = db.prepare('SELECT id FROM owners WHERE id = ?').get(id);
  if (!row) return false;
  db.prepare('UPDATE owners SET is_default = 0').run();
  db.prepare('UPDATE owners SET is_default = 1 WHERE id = ?').run(id);
  return true;
}

/** Rename in place, so books already attributed to that person follow along. */
export function renameOwner(db, id, name) {
  const clean = String(name ?? '').trim();
  if (!clean) throw new Error('owner_name_required');
  const current = db.prepare('SELECT name FROM owners WHERE id = ?').get(id);
  if (!current) return false;
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE owners SET name = ? WHERE id = ?').run(clean, id);
    db.prepare('UPDATE books SET owner = ? WHERE owner = ?').run(clean, current.name);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return true;
}

/**
 * Remove an owner from the list. Books keep the name they were given - deleting a
 * person from a drop-down must never silently un-own their books.
 */
export function deleteOwner(db, id) {
  const row = db.prepare('SELECT id, is_default FROM owners WHERE id = ?').get(id);
  if (!row) return false;
  db.prepare('DELETE FROM owners WHERE id = ?').run(id);
  if (row.is_default) {
    const next = db.prepare('SELECT id FROM owners ORDER BY id LIMIT 1').get();
    if (next) db.prepare('UPDATE owners SET is_default = 1 WHERE id = ?').run(next.id);
  }
  return true;
}


/**
 * Books registered before any provider could identify them. Their ISBN is on the
 * shelf but the title is blank, which is what "rebuild book data" retries - so a
 * key added later still rescues the books you scanned weeks ago.
 */
export function listPendingEnrichment(db) {
  return db
    .prepare(
      `SELECT b.isbn13
         FROM books b JOIN works w ON w.id = b.work_id
        WHERE w.title IS NULL OR w.title = ''
        ORDER BY b.added_at`,
    )
    .all()
    .map((row) => row.isbn13);
}

/**
 * Delete every book, work, scan record, cached lookup and owner.
 *
 * Deliberately blunt: this exists so a fresh start can be tested honestly, not to
 * offer partial "tidying". The caller is expected to have written a backup first
 * and to have obtained an explicit human confirmation.
 */
export function wipeDatabase(db) {
  const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  const before = {
    books: count('books'),
    works: count('works'),
    scans: count('scans'),
    lookups: count('lookup_cache'),
    owners: count('owners'),
  };

  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM books');
    db.exec('DELETE FROM works');
    db.exec('DELETE FROM scans');
    db.exec('DELETE FROM lookup_cache');
    db.exec('DELETE FROM owners');
    // A library always has someone to attribute a book to; leaving the list empty
    // would make the next add fail for a reason nobody could see.
    db.prepare('INSERT INTO owners (name, is_default, created_at) VALUES (?, 1, ?)').run(
      'Me',
      new Date().toISOString(),
    );
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return before;
}


/**
 * Rewrite blurbs that still contain provider markup.
 *
 * Google and Open Library send descriptions as HTML fragments. They were stored
 * verbatim and the UI escapes text, so "<p>" and "<br>" appeared on screen. The
 * cleaner is injected so this file stays independent of the HTML rules.
 */
export function cleanDescriptions(db, clean) {
  const rows = db
    .prepare('SELECT id, description FROM works WHERE description IS NOT NULL')
    .all();
  const update = db.prepare('UPDATE works SET description = ? WHERE id = ?');
  let changed = 0;
  for (const row of rows) {
    const cleaned = clean(row.description);
    if (cleaned !== row.description) {
      update.run(cleaned, row.id);
      changed += 1;
    }
  }
  return changed;
}


/**
 * A counter embedded in cover URLs.
 *
 * Covers are cached by the phone for a year, so a URL that never changes means a
 * deleted library still shows yesterday's pictures - the "I wiped the database but
 * the images came straight back" report. Bumping this makes every cover URL new.
 */
export function bumpCoverEpoch(db) {
  const next = Number(getMeta(db, 'coverEpoch') ?? 0) + 1;
  setMeta(db, 'coverEpoch', next);
  return next;
}

export function coverEpoch(db) {
  return Number(getMeta(db, 'coverEpoch') ?? 0);
}


/** Cached list of everything a series contains, or null if absent/too old. */
export function getSeriesCache(db, seriesKeyValue, maxAgeDays = 30) {
  const row = db
    .prepare('SELECT payload, fetched_at FROM series_cache WHERE series_key = ?')
    .get(seriesKeyValue);
  if (!row) return null;
  const age = Date.now() - Date.parse(row.fetched_at);
  if (Number.isFinite(age) && age > maxAgeDays * 24 * 60 * 60 * 1000) return null;
  try {
    return JSON.parse(row.payload);
  } catch {
    return null;
  }
}

export function setSeriesCache(db, seriesKeyValue, payload) {
  db.prepare(
    `INSERT INTO series_cache (series_key, payload, fetched_at) VALUES (?, ?, ?)
     ON CONFLICT(series_key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at`,
  ).run(seriesKeyValue, JSON.stringify(payload), new Date().toISOString());
}
