// HTTP server: zero framework, one process, one SQLite file.
//
// Design rules that matter for a phone-first app:
//  - every scan is answered from SQLite first, so "do I own this" never waits
//    on the internet;
//  - any network failure still produces a JSON answer with a verdict, because a
//    shop with bad signal must not leave the UI hanging;
//  - the frontend is served from here, so the container is the whole app.
import http from 'node:http';
import { createReadStream, existsSync, mkdirSync, accessSync, constants as fsConstants } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, resolve, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDb, findBook, saveBook, listBooks, listSeries, seriesSummary, stats, recordScan, recentScans, deleteBook, exportAll, getLookupCache, setLookupCache } from './db.js';
import { normaliseIsbn } from './isbn.js';
import { missingVolumes, describeMissing, seriesKey } from './series.js';
import { authorKey } from './authors.js';
import { lookupIsbn, fetchRating } from './lookup.js';
import { ensurePin, createAuth, parseCookies } from './auth.js';
import { ensureCover, coverFile } from './covers.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(HERE, '..', 'public');
const DATA_DIR = resolve(process.env.DATA_DIR ?? join(HERE, '..', 'data'));
const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';

/**
 * A bind-mounted data folder keeps the HOST's ownership. If the container is not
 * allowed to fix that (compose `user:`, Kubernetes securityContext), SQLite's
 * failure is the bare string "unable to open database file", which tells an
 * operator nothing. Fail with the actual cause and the actual command instead.
 */
function assertDataDirWritable(dir) {
  const uid = process.getuid?.() ?? 'unknown';
  const dbFile = join(dir, 'bookshelf.db');

  let problem = null;
  try {
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    problem = error;
  }
  if (!problem) {
    try {
      accessSync(dir, fsConstants.W_OK | fsConstants.X_OK);
    } catch {
      problem = new Error('folder is not writable');
    }
  }
  if (!problem && existsSync(dbFile)) {
    try {
      accessSync(dbFile, fsConstants.W_OK);
    } catch {
      problem = new Error('database file is not writable');
    }
  }
  if (!problem) return;

  console.error(
    [
      '',
      '  ==================================================================',
      `   Cannot use the data folder: ${dir}`,
      `   Reason: ${problem.message}`,
      `   This process runs as uid ${uid}.`,
      '',
      '   The mounted folder belongs to a different user, so the database',
      '   cannot be created. On the HOST, give the folder to this container:',
      '',
      `       sudo chown -R ${uid}:${uid} ./data`,
      '',
      '   (or point the volume at a writable path, or use a named volume',
      '   instead of a bind mount)',
      '  ==================================================================',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

assertDataDirWritable(DATA_DIR);

const db = openDb(join(DATA_DIR, 'bookshelf.db'));
const { generated } = ensurePin(db);
const auth = createAuth(db);

if (generated) {
  console.log('');
  console.log('  ==========================================');
  console.log(`   First run. Your PIN is:  ${generated}`);
  console.log('   Set BOOKSHELF_PIN in docker-compose to choose your own.');
  console.log('  ==========================================');
  console.log('');
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function readBody(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('invalid json');
  }
}

const clientIp = (req) =>
  (req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';

const isSecure = (req) =>
  (req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https' || !!req.socket.encrypted;

/**
 * The scan answer. This is the heart of the app: one ISBN in, one verdict out.
 * verdict = owned | wishlist | missing | invalid
 *
 * Deliberately never touches the network. "Not in my catalogue" is a fact the
 * local database can answer in a couple of milliseconds, and waiting 8 seconds
 * on Open Library to decorate that answer would make scanning a bookcase
 * unusable. Metadata is a second, separate request (/api/lookup/:isbn).
 */
async function handleScan(isbnRaw) {
  const started = Date.now();
  const normalised = normaliseIsbn(isbnRaw);

  if (!normalised) {
    recordScan(db, String(isbnRaw ?? '').slice(0, 20), 'invalid');
    return { verdict: 'invalid', isbn13: null, query: String(isbnRaw ?? ''), elapsedMs: Date.now() - started };
  }

  const { isbn13 } = normalised;
  const existing = findBook(db, isbn13);

  if (existing) {
    const series = existing.seriesKey ? seriesSummary(db, existing.seriesKey) : null;
    recordScan(db, isbn13, existing.state);
    return {
      verdict: existing.state === 'owned' ? 'owned' : 'wishlist',
      isbn13,
      book: wrapBook(existing),
      series: decorateSeries(series),
      elapsedMs: Date.now() - started,
    };
  }

  // Free win: if this ISBN was looked up before, the card can be complete now.
  const cached = getLookupCache(db, isbn13);
  recordScan(db, isbn13, 'missing');
  return {
    verdict: 'missing',
    isbn13,
    preview: cached?.found ? cached.work : null,
    metaReady: Boolean(cached),
    series:
      cached?.found && cached.work?.seriesKey
        ? decorateSeries(seriesSummary(db, cached.work.seriesKey), cached.work.volume)
        : null,
    elapsedMs: Date.now() - started,
  };
}

/**
 * Metadata for an ISBN, from cache or Open Library. This is the slow call, kept
 * separate so the verdict above never waits on it.
 */
async function metaFor(isbn13) {
  const cached = getLookupCache(db, isbn13);
  if (cached) return { ...cached, cached: true };
  const result = await lookupIsbn(isbn13).catch(() => ({ found: false, work: null }));
  setLookupCache(db, isbn13, result);
  return { ...result, cached: false };
}

/** Attach the gap maths to a series object for the UI. */
function decorateSeries(series, extraVolume = null) {
  if (!series) return null;
  const owned = [...series.ownedVolumes];
  if (extraVolume && !owned.includes(Math.trunc(extraVolume))) owned.push(Math.trunc(extraVolume));
  const { missing, ranges, highestOwned } = missingVolumes(owned);
  return {
    key: series.key,
    name: series.name,
    ownedVolumes: series.ownedVolumes,
    ownedCount: series.ownedCount,
    highestOwned,
    missing,
    ranges,
    missingSentence: describeMissing(ranges.filter((r) => !isCoveredBy(r, extraVolume))),
  };
}

/** True when a gap range already contains the volume being scanned. */
function isCoveredBy(range, volume) {
  if (!volume) return false;
  const [start, end] = String(range).split('-').map(Number);
  const v = Math.trunc(volume);
  return end ? v >= start && v <= end : v === start;
}

/**
 * db.js already returns camelCase books with `authors` parsed into an array.
 * Do not re-parse here: JSON.parse of an array throws and silently produced an
 * empty author list, which is exactly the bug this comment exists to prevent.
 */
function wrapBook(book) {
  return {
    ...book,
    authors: Array.isArray(book.authors) ? book.authors : [],
    author: Array.isArray(book.authors) ? (book.authors[0] ?? null) : (book.author ?? null),
  };
}

/** Fields a user is allowed to write. Anything else in a PATCH is ignored. */
function pickFields(body = {}) {
  const fields = {};
  for (const key of ['read_state', 'my_rating', 'notes', 'location', 'loaned_to', 'loaned_at']) {
    if (body[key] !== undefined) fields[key] = body[key];
  }
  return fields;
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = normalize(join(PUBLIC_DIR, rel));
  // Path traversal guard: the resolved path must stay inside public/.
  if (!target.startsWith(PUBLIC_DIR)) return json(res, 403, { error: 'forbidden' });
  if (!existsSync(target)) return json(res, 404, { error: 'not found' });

  const info = await stat(target);
  const type = MIME[extname(target)] ?? 'application/octet-stream';
  const ext = extname(target);
  // App shell files must never be served stale, or an update would not reach a
  // phone that has the app installed. Only immutable assets get a long cache.
  const isShell = ['.html', '.js', '.css', '.webmanifest'].includes(ext) || rel === 'sw.js';
  const isImmutable = rel.startsWith('vendor/') || rel.startsWith('icons/');
  res.writeHead(200, {
    'content-type': type,
    'content-length': info.size,
    'cache-control': isShell
      ? 'no-cache'
      : isImmutable
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=3600',
  });
  createReadStream(target).pipe(res);
}

async function serveCover(req, res, isbn13) {
  if (!/^\d{13}$/.test(isbn13)) return json(res, 400, { error: 'bad isbn' });
  const row = db
    .prepare(
      `SELECT b.isbn13, w.cover_id FROM books b JOIN works w ON w.id = b.work_id WHERE b.isbn13 = ?`,
    )
    .get(isbn13);
  const file = await ensureCover(DATA_DIR, { isbn13, coverId: row?.cover_id });
  if (!file) {
    res.writeHead(404, { 'cache-control': 'public, max-age=3600' });
    return res.end();
  }
  const info = await stat(coverFile(DATA_DIR, isbn13));
  res.writeHead(200, {
    'content-type': 'image/jpeg',
    'content-length': info.size,
    // Covers never change for a given ISBN, so a phone can cache them forever.
    'cache-control': 'public, max-age=31536000, immutable',
  });
  createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);
  const method = req.method ?? 'GET';

  try {
    if (pathname === '/healthz') return json(res, 200, { ok: true, books: stats(db).owned });

    const cookies = parseCookies(req.headers.cookie);
    const authed = auth.isAuthed(cookies);

    // ---- auth endpoints (the only unauthenticated API surface) ----
    if (pathname === '/api/login' && method === 'POST') {
      const body = await readBody(req);
      const result = auth.login(body.pin, clientIp(req));
      if (!result.ok) {
        const status = result.reason === 'too_many_attempts' ? 429 : 401;
        return json(res, status, { error: result.reason });
      }
      res.setHeader(
        'set-cookie',
        `${result.cookie}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax${isSecure(req) ? '; Secure' : ''}`,
      );
      return json(res, 200, { ok: true });
    }
    if (pathname === '/api/logout' && method === 'POST') {
      res.setHeader('set-cookie', auth.clearCookie());
      return json(res, 200, { ok: true });
    }
    if (pathname === '/api/me') return json(res, 200, { authed });

    // ---- everything else under /api requires a session ----
    if (pathname.startsWith('/api/') && !authed) return json(res, 401, { error: 'auth_required' });

    if (pathname === '/api/books' && method === 'GET') {
      const rows = listBooks(db, {
        q: url.searchParams.get('q') ?? '',
        state: url.searchParams.get('state') ?? '',
        sort: url.searchParams.get('sort') ?? 'added',
      });
      return json(res, 200, { books: rows.map(wrapBook), count: rows.length });
    }

    if (pathname === '/api/scan' && method === 'POST') {
      const body = await readBody(req);
      const result = await handleScan(body.isbn);
      return json(res, 200, result);
    }

    // Metadata for a book you do not own. Separate from /api/scan on purpose:
    // the verdict is instant, this can take seconds.
    const lookupMatch = /^\/api\/lookup\/(\d{13})$/.exec(pathname);
    if (lookupMatch && method === 'GET') {
      const meta = await metaFor(lookupMatch[1]);
      const series =
        meta.found && meta.work?.seriesKey
          ? decorateSeries(seriesSummary(db, meta.work.seriesKey), meta.work.volume)
          : null;
      return json(res, 200, {
        isbn13: lookupMatch[1],
        found: meta.found,
        work: meta.work,
        series,
        cached: meta.cached,
      });
    }

    if (pathname === '/api/books' && method === 'POST') {
      const body = await readBody(req);
      const normalised = normaliseIsbn(body.isbn);
      if (!normalised) return json(res, 400, { error: 'invalid isbn' });

      const state = body.state === 'wishlist' ? 'wishlist' : 'owned';
      let work = body.work ?? null;

      // Metadata either comes from the phone (already previewed) or is fetched
      // now, using the cache first so a repeat add costs nothing.
      if (!work && !body.title) {
        const meta = await metaFor(normalised.isbn13);
        work = meta.found ? meta.work : null;
      }
      if (!work && !body.title) {
        return json(res, 422, { error: 'not_found', isbn13: normalised.isbn13 });
      }

      // A title sent from the phone means the user chose manual entry, so their
      // text wins over anything the API knows - the lookup may well have been
      // empty when they scanned and only succeeded later. API data still fills
      // the fields they did not type.
      if (body.title) {
        const title = String(body.title).trim() || 'Untitled';
        const authors = body.author ? [String(body.author).trim()] : (work?.authors ?? []);
        work = {
          ...(work ?? {}),
          title,
          authors,
          authorKey: authorKey(authors[0]),
          series: body.series ?? work?.series ?? null,
          seriesKey: seriesKey(body.series ?? work?.series ?? null),
          volume: body.volume ?? work?.volume ?? null,
        };
      } else if (!work) {
        work = { title: 'Untitled', authors: [], authorKey: null, series: null, volume: null };
      }

      // Ratings are a second, optional call: a failure must not block the add.
      if (!work.rating && work.workKey) {
        const rating = await fetchRating(work.workKey).catch(() => null);
        if (rating) {
          work.rating = rating.average;
          work.ratingsCount = rating.count;
        }
      }

      const saved = saveBook(db, {
        isbn13: normalised.isbn13,
        work,
        state,
        fields: pickFields(body),
      });
      // Warm the cover cache so the shelf view is instant afterwards.
      await ensureCover(DATA_DIR, { isbn13: normalised.isbn13, coverId: saved?.coverId }).catch(() => null);
      recordScan(db, normalised.isbn13, state);
      return json(res, 201, { book: wrapBook(saved) });
    }

    const bookMatch = /^\/api\/books\/(\d{13})$/.exec(pathname);
    if (bookMatch) {
      const isbn13 = bookMatch[1];
      if (method === 'PATCH') {
        const body = await readBody(req);
        const current = findBook(db, isbn13);
        if (!current) return json(res, 404, { error: 'not found' });

        // Series/volume edits are allowed here because the API data is often
        // wrong, and a wrong series would corrupt the gap maths.
        if (body.series !== undefined || body.volume !== undefined) {
          const series = body.series === undefined ? current.series : body.series;
          const volume = body.volume === undefined ? current.volume : body.volume;
          db.prepare(
            'UPDATE works SET series = ?, series_key = ?, volume = ?, updated_at = ? WHERE id = ?',
          ).run(
            series || null,
            seriesKey(series),
            volume === null || volume === '' ? null : Number(volume),
            new Date().toISOString(),
            current.workId,
          );
        }

        const fields = pickFields(body);
        const updated = saveBook(db, {
          isbn13,
          work: null,
          state: body.state === 'wishlist' ? 'wishlist' : body.state === 'owned' ? 'owned' : current.state,
          fields,
        });
        return json(res, 200, { book: wrapBook(updated) });
      }
      if (method === 'DELETE') {
        const removed = deleteBook(db, isbn13);
        return json(res, removed ? 200 : 404, { ok: removed });
      }
      if (method === 'GET') {
        const row = findBook(db, isbn13);
        if (!row) return json(res, 404, { error: 'not found' });
        return json(res, 200, { book: wrapBook(row) });
      }
    }

    if (pathname === '/api/series' && method === 'GET') {
      const series = listSeries(db).map((s) => {
        const { missing, ranges, highestOwned } = missingVolumes(s.ownedVolumes);
        return { ...s, missing, ranges, highestOwned, missingSentence: describeMissing(ranges) };
      });
      return json(res, 200, { series });
    }

    if (pathname === '/api/stats' && method === 'GET') return json(res, 200, stats(db));
    if (pathname === '/api/scans' && method === 'GET') return json(res, 200, { scans: recentScans(db) });
    if (pathname === '/api/export' && method === 'GET') {
      res.setHeader('content-disposition', `attachment; filename="bookshelf-${Date.now()}.json"`);
      return json(res, 200, exportAll(db));
    }

    if (pathname === '/api/settings' && method === 'GET') {
      return json(res, 200, {
        dataDir: DATA_DIR,
        hasPinFromEnv: Boolean(process.env.BOOKSHELF_PIN),
        version: process.env.APP_VERSION ?? 'dev',
      });
    }

    const coverMatch = /^\/cover\/(\d{13})\.jpg$/.exec(pathname);
    if (coverMatch && method === 'GET') return serveCover(req, res, coverMatch[1]);

    if (method === 'GET' || method === 'HEAD') return serveStatic(req, res, pathname);

    return json(res, 405, { error: 'method not allowed' });
  } catch (error) {
    console.error('[error]', pathname, error?.message ?? error);
    return json(res, 500, { error: 'server_error', detail: String(error?.message ?? error) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`home-library listening on http://${HOST}:${PORT}  (data: ${DATA_DIR})`);
});

export { server, db };
