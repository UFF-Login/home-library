// HTTP server: zero framework, one process, one SQLite file.
//
// Design rules that matter for a phone-first app:
//  - every scan is answered from SQLite first, so "do I own this" never waits
//    on the internet;
//  - any network failure still produces a JSON answer with a verdict, because a
//    shop with bad signal must not leave the UI hanging;
//  - the frontend is served from here, so the container is the whole app.
import http from 'node:http';
import { createReadStream, existsSync, mkdirSync, accessSync, readFileSync, writeFileSync, rmSync, constants as fsConstants } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, resolve, normalize, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  openDb,
  findBook,
  saveBook,
  listBooks,
  listSeries,
  seriesSummary,
  stats,
  recordScan,
  recentScans,
  deleteBook,
  exportAll,
  getLookupCache,
  setLookupCache,
  clearLookupCache,
  getMeta,
  setMeta,
  listOwners,
  addOwner,
  setDefaultOwner,
  renameOwner,
  deleteOwner,
  defaultOwnerName,
  listPendingEnrichment,
  wipeDatabase,
  cleanDescriptions,
  bumpCoverEpoch,
  coverEpoch,
  getSeriesCache,
  setSeriesCache,
} from './db.js';
import { normaliseIsbn } from './isbn.js';
import { missingVolumes, describeMissing, seriesKey, parseSeries } from './series.js';
import { seriesFromWikidata, seriesVolumes } from './wikidata.js';
import { googleBooksLookup, googleBooksProbe, googleBooksKey, googleBooksSearch } from './googlebooks.js';
import { authorKey } from './authors.js';
import { lookupIsbn, fetchRating } from './lookup.js';
import { ensurePin, createAuth, parseCookies } from './auth.js';
import { stripHtml } from './util.js';
import { ensureCover, coverFile, hasCover, coverMissPending, clearCoverMiss, clearAllCoverMisses, COVER_PIPELINE_VERSION } from './covers.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(HERE, '..', 'public');

/**
 * Two identities, on purpose:
 *
 *   VERSION - the human one, what the user sees: v1.0, v1.3, v2.0. Taken from
 *             package.json (1.0.0 -> v1.0), overridable with APP_VERSION.
 *   BUILD   - the exact artifact, used to stamp asset URLs so caches cannot mix
 *             builds. This must change on every deploy, including deploys that
 *             keep the same human version, so CI passes the commit SHA.
 */
const VERSION = (() => {
  // A blank APP_VERSION must not win: the Dockerfile declares the ARG so the env
  // var exists but is empty, and `??` would happily accept "" and print "dev".
  const fromEnv = String(process.env.APP_VERSION ?? '').trim();
  if (fromEnv) return formatVersion(fromEnv);
  try {
    return formatVersion(JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8')).version);
  } catch {
    return 'dev';
  }
})();

/** "1.3.0" -> "v1.3"; "2.0" -> "v2.0"; anything unexpected passes through. */
function formatVersion(raw) {
  const value = String(raw ?? '').trim();
  const match = /^v?(\d+)\.(\d+)/.exec(value);
  if (!match) return value || 'dev';
  return `v${match[1]}.${match[2]}`;
}

const BUILD = process.env.APP_BUILD || process.env.APP_VERSION || VERSION;
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

// "No cover" markers are cached for 30 days. When the way covers are fetched
// changes, every marker written by the old rules is suspect - a throttled host
// answering 200 with an empty body used to look like "this book has no cover".
// Blurbs stored before the HTML was stripped still contain markup. Run once, and
// drop the lookup cache in the same pass because it holds the raw payloads.
{
  if (getMeta(db, 'descriptionCleaned') !== '1') {
    const changed = cleanDescriptions(db, stripHtml);
    clearLookupCache(db);
    setMeta(db, 'descriptionCleaned', '1');
    if (changed) console.log(`[meta] cleaned markup out of ${changed} description(s)`);
  }
}

{
  const pipeline = String(COVER_PIPELINE_VERSION);
  if (getMeta(db, 'coverPipelineVersion') !== pipeline) {
    const cleared = clearAllCoverMisses(DATA_DIR);
    setMeta(db, 'coverPipelineVersion', pipeline);
    if (cleared) console.log(`[covers] cleared ${cleared} stale "no cover" marker(s)`);
  }
}
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
/**
 * Build a work record from a Google Books volume alone.
 *
 * This is the rescue path: Open Library has no record for the ISBN, so without it
 * the scan ended at "no catalogue record" and the book could only be added by
 * typing title and author by hand. Series still cannot come from Google - the
 * Volume schema has no such field - so it is parsed from the title, which catches
 * the common "<Title> (Series, Book 3)" convention.
 */
function workFromGoogle(gb, isbn13) {
  const authors = gb.authors ?? [];
  const parsed = parseSeries({ title: gb.title, subtitle: gb.subtitle });
  return {
    title: gb.title ?? 'Untitled',
    subtitle: gb.subtitle ?? null,
    authors,
    authorKey: authors[0] ? authorKey(authors[0]) : null,
    series: parsed.series ?? null,
    seriesKey: parsed.series ? seriesKey(parsed.series) : null,
    volume: parsed.volume ?? null,
    publisher: gb.publisher ?? null,
    published: gb.published ?? null,
    pages: gb.pages ?? null,
    description: gb.description ?? null,
    subjects: gb.categories ?? [],
    rating: gb.rating ?? null,
    ratingsCount: gb.ratingsCount ?? null,
    // No Open Library identifiers exist for this book; the cover comes from
    // Google's own thumbnail instead.
    workKey: null,
    coverId: null,
    coverUrl: gb.coverUrl ?? null,
    isbn13,
  };
}

/**
 * Try again for a book that was added with no catalogue record.
 *
 * The scan flow is three taps and done, so a book with no metadata is still
 * registered immediately. This runs afterwards, off the request path, and fills
 * the record in if a provider answers later (Open Library adds records, or the
 * Google key was only just wired up).
 */
const enrichQueue = new Set();

function scheduleBackgroundEnrich(isbn13) {
  if (enrichQueue.has(isbn13)) return;
  enrichQueue.add(isbn13);

  const timer = setTimeout(async () => {
    try {
      const meta = await metaFor(isbn13, { force: true });
      const current = findBook(db, isbn13);
      if (!meta.found || !current || !meta.work) return;
      // Preserve everything the user owns: their state, owner and notes.
      saveBook(db, {
        isbn13,
        work: meta.work,
        state: current.state,
        fields: { owner: current.owner ?? null, notes: current.notes ?? null },
      });
      console.log('[enrich] filled in', isbn13, '-', meta.work.title);
    } catch (error) {
      console.warn('[enrich] failed', isbn13, error?.message ?? error);
    } finally {
      enrichQueue.delete(isbn13);
    }
  }, 1500);
  // Never hold the process open for a retry.
  timer.unref?.();
}

async function metaFor(isbn13, { force = false } = {}) {
  const started = Date.now();
  const cached = getLookupCache(db, isbn13);
  const googleAvailable = Boolean(googleBooksKey());

  /**
   * Re-fetch instead of trusting the cache when the enrichment setup changed.
   * Adding a Google Books key weeks later must not leave every already-scanned
   * book stuck with the thinner data it got before the key existed - that is
   * exactly what "I added the key but see nothing new" looked like.
   */
  // 'off' means it was never attempted (no key at the time); 'failed' means it was
  // tried and gave nothing, and must not be retried on every single scan.
  const googleNeverTried =
    cached?.sources?.googleBooks === undefined || cached.sources.googleBooks === 'off';
  const stale = cached && (cached.legacy || (googleAvailable && googleNeverTried));

  if (cached && !stale && !force) return { ...cached, cached: true };

  /**
   * Open Library and Google are asked at the same time, not one after the other.
   * A scan used to wait for Open Library to fail before Google was even contacted,
   * which is where the "40 seconds for one book" came from. Both answers are used
   * either way - Open Library for the record, Google for the rating and blurb.
   */
  let olMs = 0;
  let gbMs = 0;

  const olStarted = Date.now();
  const olPromise = cached?.work
    ? Promise.resolve({ found: true, work: { ...cached.work }, isbn13 })
    : lookupIsbn(isbn13)
        .catch(() => ({ found: false, work: null, isbn13 }))
        .finally(() => {
          olMs = Date.now() - olStarted;
        });

  const gbStarted = Date.now();
  const gbPromise = googleAvailable
    ? googleBooksLookup(isbn13)
        .catch(() => ({ status: 'failed' }))
        .finally(() => {
          gbMs = Date.now() - gbStarted;
        })
    : null;

  const result = await olPromise;

  const sources = {
    ...(cached?.sources ?? {}),
    // Keep settled states; reset only the never-attempted case so it is retried.
    googleBooks: ['ok', 'failed', 'skipped', 'empty', 'partial'].includes(cached?.sources?.googleBooks)
      ? cached.sources.googleBooks
      : 'off',
  };

  const looked = gbPromise ? await gbPromise : null;
  if (looked) {
    sources.googleBooks = looked.status;
    if (looked.reason) sources.googleReason = looked.reason;
    if (looked.status === 'partial' && looked.volumeId) sources.googleVolumeId = looked.volumeId;
  }

  // Nothing in Open Library: Google's record becomes the record.
  if (!result.found && looked?.status === 'ok') {
    result.found = true;
    result.work = workFromGoogle(looked.record, isbn13);
  }

  if (result.found && result.work) {
    const work = result.work;

    // Open Library's community rating, when the work is known there.
    if (work.workKey && work.rating == null) {
      const rating = await fetchRating(work.workKey).catch(() => null);
      if (rating) {
        work.rating = rating.average;
        work.ratingsCount = rating.count;
      }
    }

    // Google's rating and blurb. Its rating wins when it has more votes, which is
    // usually the case (Open Library often has one or two, Google has thousands).
    const gb = looked?.status === 'ok' ? looked.record : null;
    if (gb) {
      if (gb.rating != null && (work.rating == null || (gb.ratingsCount ?? 0) > (work.ratingsCount ?? 0))) {
        work.rating = gb.rating;
        work.ratingsCount = gb.ratingsCount;
      }
      work.description ??= gb.description;
      if (!work.pages && gb.pages) work.pages = gb.pages;
      if (!work.coverUrl && gb.coverUrl) work.coverUrl = gb.coverUrl;
      // Google's title text sometimes carries a series marker ours can parse.
      if (!work.series) {
        const parsed = parseSeries({
          title: gb.title ?? work.title,
          subtitle: gb.subtitle ?? work.subtitle,
        });
        if (parsed.series) {
          work.series = parsed.series;
          work.seriesKey = seriesKey(parsed.series);
          work.volume = parsed.volume ?? work.volume;
        }
      }
    }

    // Series: structured data lives in Wikidata (P179 + P1545), joined by the
    // Open Library work id. Neither Open Library subjects nor Google Books model
    // series and volume properly.
    if (!work.series && work.workKey) {
      const wiki = await seriesFromWikidata(work.workKey).catch(() => null);
      if (wiki?.series) {
        work.series = wiki.series;
        work.seriesKey = seriesKey(wiki.series);
        work.volume = work.volume ?? wiki.volume;
      }
    }
  }

  // A key that exists but had nothing to add still counts as settled, otherwise
  // this entry would be re-enriched on every single scan.
  if (googleAvailable && sources.googleBooks === 'off') sources.googleBooks = 'skipped';

  const lookupMs = Date.now() - started;
  // A slow scan is worth knowing about, with enough detail to blame a provider.
  if (lookupMs > 5000) {
    console.warn(
      `[lookup] ${isbn13} took ${lookupMs}ms (openLibrary ${olMs}ms, google ${gbMs}ms, google=${sources.googleBooks})`,
    );
  }

  setLookupCache(db, isbn13, { ...result, sources });
  // Reported so the phone can show how long the details took, rather than only
  // the millisecond verdict time.
  return {
    ...result,
    sources,
    cached: false,
    lookupMs,
    // Which provider was slow, if any - a 13-second scan needs an answer.
    timings: { openLibraryMs: olMs, googleMs: gbMs },
  };
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
  for (const key of ['read_state', 'my_rating', 'notes', 'location', 'owner', 'loaned_to', 'loaned_at']) {
    if (body[key] !== undefined) fields[key] = body[key];
  }
  return fields;
}

async function serveStatic(req, res, pathname) {
  // Path-based asset versioning: /v/<build>/app.js serves public/app.js.
  // A query string (?v=) was the first attempt, but a reverse proxy in front of
  // the app refused those URLs and the page rendered blank, so the build id goes
  // in the path instead - every proxy handles paths.
  const unversioned = pathname.replace(/^\/v\/[^/]+\//, '/');
  const rel = unversioned === '/' ? 'index.html' : unversioned.replace(/^\/+/, '');
  const target = normalize(join(PUBLIC_DIR, rel));
  // Path traversal guard: the resolved path must stay inside public/.
  if (!target.startsWith(PUBLIC_DIR)) return json(res, 403, { error: 'forbidden' });
  if (!existsSync(target)) return json(res, 404, { error: 'not found' });

  const info = await stat(target);
  const ext = extname(target);

  // HTML is templated so every asset URL carries the build id. A stale service
  // worker can then never hand back yesterday's app.js under today's page - the
  // cache key itself changes with the build.
  if (ext === '.html') {
    const template = await readFile(target, 'utf8');
    // Asset URLs carry the BUILD id (changes every deploy), while the UI shows
    // the human VERSION (v1.0).
    const html = template.split('__VERSION__').join(encodeURIComponent(BUILD));
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(html),
      'cache-control': 'no-cache',
    });
    return res.end(html);
  }

  const type = MIME[ext] ?? 'application/octet-stream';
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

/** Lowercase, strip punctuation: "Andromache Between Worlds (Andromache, #1)" -> words. */
function normaliseTitle(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

async function serveCover(req, res, isbn13) {
  if (!/^\d{13}$/.test(isbn13)) return json(res, 400, { error: 'bad isbn' });
  const row = db
    .prepare(
      `SELECT b.isbn13, w.cover_id, w.cover_url FROM books b JOIN works w ON w.id = b.work_id WHERE b.isbn13 = ?`,
    )
    .get(isbn13);
  // No catalogue row yet: this is a scan preview. Ask for art, but do not record a
  // miss - the book may well be added a second later with a cover URL attached.
  const file = await ensureCover(DATA_DIR, {
    isbn13,
    coverId: row?.cover_id,
    coverUrl: row?.cover_url,
  }, { allowMissMarker: Boolean(row) });
  if (!file) {
    // Short cache: a cover can appear later (OL adds them, or the fallback
    // sources were briefly unreachable), and a phone should pick it up quickly
    // rather than an hour later.
    res.writeHead(404, { 'cache-control': 'public, max-age=60' });
    return res.end();
  }
  const info = await stat(coverFile(DATA_DIR, isbn13));
  res.writeHead(200, {
    'content-type': 'image/jpeg',
    'content-length': info.size,
    // A catalogue book's cover is final (and the epoch in the URL covers refetches).
    // A preview for a book that is not in the library is not: it may vanish with
    // the next wipe, so it gets a short life instead of a year.
    'cache-control': row
      ? 'public, max-age=31536000, immutable'
      : 'public, max-age=300',
  });
  createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);
  const method = req.method ?? 'GET';

  try {
    if (pathname === '/healthz') {
      // version + book count here make a deployment check a single curl, and
      // expose no personal data.
      // `sources` here is what makes "is my API key actually wired up?" a single
      // curl rather than a guess.
      return json(res, 200, {
        ok: true,
        version: VERSION,
        build: BUILD,
        books: stats(db).owned,
        sources: { googleBooks: Boolean(googleBooksKey()) },
      });
    }

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
    if (pathname === '/api/me') {
      return json(res, 200, {
        authed,
        version: VERSION,
        build: BUILD,
        // Used to build cover URLs: when this changes, the phone refetches them.
        coverEpoch: coverEpoch(db),
      });
    }

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
        // The ISBN belongs to the work handed back to the client: without it the
        // scan card cannot build a cover URL and asks for /cover/undefined.jpg.
        work: meta.work ? { ...meta.work, isbn13: lookupMatch[1] } : null,
        series,
        cached: meta.cached,
        // Which enrichment providers have answered for this ISBN: 'ok', 'failed'
        // (tried, nothing) or 'off' (no key configured).
        sources: meta.sources ?? {},
        lookupMs: meta.lookupMs ?? null,
        timings: meta.timings ?? null,
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
      // No metadata anywhere: register the book anyway. The scan flow promises
      // that "I own it" works in one tap, so a book with no catalogue record must
      // still land on the shelf - it is filled in by a background retry below.
      const pendingLookup = !work && !body.title;

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
        // Empty, not 'Untitled': the works update only fills a blank title, and
        // this record is expected to be filled in by the background retry.
        work = { title: '', authors: [], authorKey: null, series: null, volume: null };
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
      // Warm the cover cache so the shelf view is instant afterwards. Any marker
      // from a scan preview is dropped first: we now know more than we did then.
      clearCoverMiss(DATA_DIR, normalised.isbn13);
      await ensureCover(DATA_DIR, {
        isbn13: normalised.isbn13,
        coverId: saved?.coverId,
        coverUrl: saved?.coverUrl,
      }).catch(() => null);
      recordScan(db, normalised.isbn13, state);

      // Fill in a placeholder record later. Deliberately not awaited: the phone
      // has its answer already, and a slow provider must not hold up the add.
      if (pendingLookup) scheduleBackgroundEnrich(normalised.isbn13);

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

    /**
     * Rebuild derived data: forget cached lookups and "no cover" markers so the
     * next scan fetches fresh metadata. The catalogue itself is untouched - this
     * is the reset you want after adding an API key, not a wipe.
     */
    if (pathname === '/api/cache/reset' && method === 'POST') {
      const lookups = clearLookupCache(db);
      const coverMisses = clearAllCoverMisses(DATA_DIR);

      // Books that were registered before any provider could name them get another
      // attempt, in the background - which is what makes a later key useful for
      // books already on the shelf.
      const pending = listPendingEnrichment(db);
      for (const isbn13 of pending.slice(0, 50)) scheduleBackgroundEnrich(isbn13);

      return json(res, 200, {
        lookups,
        coverMisses,
        pending: pending.length,
        books: stats(db).owned,
      });
    }

    /**
     * Owners are entered once and then picked from a list, so adding a book never
     * needs a second screen or a typed name.
     */
    if (pathname === '/api/owners' && method === 'GET') {
      return json(res, 200, { owners: listOwners(db), defaultOwner: defaultOwnerName(db) });
    }

    if (pathname === '/api/owners' && method === 'POST') {
      const body = await readBody(req);
      try {
        return json(res, 201, { owner: addOwner(db, body.name) });
      } catch (error) {
        const code = error?.message ?? 'bad_request';
        return json(res, code === 'owner_exists' ? 409 : 400, { error: code });
      }
    }

    const ownerMatch = /^\/api\/owners\/(\d+)$/.exec(pathname);
    if (ownerMatch) {
      const id = Number(ownerMatch[1]);
      if (method === 'PATCH') {
        const body = await readBody(req);
        if (body.isDefault) setDefaultOwner(db, id);
        if (body.name) {
          try {
            renameOwner(db, id, body.name);
          } catch (error) {
            return json(res, 400, { error: error?.message ?? 'bad_request' });
          }
        }
        return json(res, 200, { owners: listOwners(db), defaultOwner: defaultOwnerName(db) });
      }
      if (method === 'DELETE') {
        deleteOwner(db, id);
        return json(res, 200, { owners: listOwners(db), defaultOwner: defaultOwnerName(db) });
      }
    }

    /**
     * "Is my Google key actually working?" - answered with Google's own words.
     * A 403 (key restricted to referrers) looks nothing like a 429 (quota) or a
     * 400 (dead key), and guessing between them wastes the operator's evening.
     */
    if (pathname === '/api/diagnostics/google' && method === 'GET') {
      const probe = await googleBooksProbe();
      return json(res, 200, probe);
    }

    /**
     * Delete everything. Guarded by an explicit confirmation string AND a backup
     * written first: this is the one endpoint where a mistake is unrecoverable,
     * so it must be impossible to trigger by a stray tap or a refresh.
     */
    if (pathname === '/api/admin/wipe' && method === 'POST') {
      const body = await readBody(req);
      if (body?.confirm !== 'DELETE_ALL') return json(res, 400, { error: 'confirm_required' });

      const backupDir = join(DATA_DIR, 'backups');
      mkdirSync(backupDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = join(backupDir, `pre-wipe-${stamp}.json`);
      writeFileSync(backupPath, JSON.stringify(exportAll(db), null, 2));

      const wiped = wipeDatabase(db);
      // Covers are derived data belonging to books that no longer exist.
      rmSync(join(DATA_DIR, 'covers'), { recursive: true, force: true });
      mkdirSync(join(DATA_DIR, 'covers'), { recursive: true });

      // The phone caches covers for a year; a new epoch makes those URLs dead.
      const epoch = bumpCoverEpoch(db);
      console.log('[wipe] database cleared', wiped, 'covers invalidated (epoch ' + epoch + ')');
      return json(res, 200, { wiped, backup: basename(backupPath) });
    }

    /**
     * What else is in this series? Answers the question a shelf raises but cannot
     * settle: "I have 2, 3 and 7 - what am I looking for?" Titles come from
     * Wikidata, cached for a month because a series rarely changes.
     */
    const seriesVolumesMatch = /^\/api\/series\/([a-z0-9-]+)\/volumes$/.exec(pathname);
    if (seriesVolumesMatch && method === 'GET') {
      const seriesKeyValue = seriesVolumesMatch[1];
      const summary = seriesSummary(db, seriesKeyValue);
      if (!summary) return json(res, 404, { error: 'unknown_series' });

      // The key carries a version: answers cached by an older, narrower lookup must
      // not outlive the fix that widened it.
      const cacheKey = `v3:${seriesKeyValue}`;
      // Every route that was tried, and what it said. Without this a failure is
      // indistinguishable from an empty answer, which is exactly what made "no
      // record" impossible to act on.
      const tried = [];
      let cached = getSeriesCache(db, cacheKey);
      if (!cached) {
        const workKey = summary.items.find((item) => item.workKey)?.workKey ?? null;
        const fromWiki = await seriesVolumes(workKey, summary.name).catch(() => null);
        tried.push({
          source: 'wikidata',
          workKey: workKey ?? null,
          ok: Boolean(fromWiki),
          volumes: fromWiki?.volumes?.length ?? 0,
          matchedBy: fromWiki?.matchedBy ?? null,
        });
        cached = fromWiki ?? { seriesQid: null, volumes: [] };

        /**
         * Last resort: the author's other books.
         *
         * Series that neither Wikidata nor Open Library models still betray
         * themselves in titles - "Andromache Between Worlds" and "Andromache in the
         * Dark" share a name. Asking Google for the author's books and keeping the
         * ones whose title contains the series name is the only route left, and it
         * is why a Google key makes this feature work at all for small presses.
         */
        /**
         * Last resort: search Google for the series name in titles.
         *
         * Searched by author first, which is unreliable: the metadata-only volumes
         * this app exists to rescue frequently have NO author indexed at all, so
         * inauthor:"..." returns nothing even though the books are there. Titles,
         * however, are indexed - they are what the volume page is built from. So
         * title queries come first and the author query is only a fallback.
         */
        if (!(cached.volumes?.length) && googleBooksKey()) {
          const author = summary.items.find((item) => item.authors?.length)?.authors?.[0];
          const queries = [];
          if (summary.name) queries.push(`intitle:"${summary.name}"`);
          if (summary.name) queries.push(`"${summary.name}"`);
          if (author) queries.push(`inauthor:"${author}"`);

          for (const query of queries) {
            const found = await googleBooksSearch(query).catch(() => null);
            const name = normaliseTitle(summary.name);
            const volumes = [];
            const seenTitles = new Set();
            for (const volume of found ?? []) {
              const titleKey = normaliseTitle(volume.title);
              if (!name || !titleKey.includes(name)) continue;
              if (seenTitles.has(titleKey)) continue;
              seenTitles.add(titleKey);
              const parsed = parseSeries({ title: volume.title, subtitle: volume.subtitle });
              volumes.push({
                title: volume.title,
                volume: parsed.volume != null ? Math.trunc(parsed.volume) : null,
                year: volume.year,
                isbn13: volume.isbn13,
              });
            }
            tried.push({
              source: 'google',
              query,
              ok: Boolean(found),
              results: found?.length ?? 0,
              matched: volumes.length,
            });
            if (volumes.length) {
              cached = { seriesQid: cached.seriesQid ?? null, matchedBy: 'google', volumes };
              break;
            }
          }

          if (!queries.length) {
            tried.push({ source: 'google', ok: false, reason: 'nothing to search for' });
          }
        } else if (!googleBooksKey()) {
          // Distinguish "no key" from "key rejected": they need different fixes.
          tried.push({ source: 'google', ok: false, reason: 'no Google Books key configured' });
        }

        // Only cache a real answer. Caching "nothing" because no book in the series
        // had an Open Library work key would hide the titles for a month after a
        // single book was added by ISBN alone.
        if (cached.volumes?.length) setSeriesCache(db, cacheKey, cached);
      }

      const normalise = (value) =>
        String(value ?? '')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, ' ')
          .trim();

      const owned = summary.items.filter((item) => item.state === 'owned');
      const ownedTitles = new Set(owned.map((item) => normalise(item.title)));
      const ownedVolumes = new Set(
        owned.map((item) => (item.volume ? Math.trunc(item.volume) : null)).filter((v) => v !== null),
      );

      const missing = (cached.volumes ?? []).filter((volume) => {
        if (volume.volume != null && ownedVolumes.has(volume.volume)) return false;
        if (ownedTitles.has(normalise(volume.title))) return false;
        return true;
      });

      return json(res, 200, {
        seriesQid: cached.seriesQid ?? null,
        // 'work' (found through a book we own) or 'name' (matched a label/alias)
        matchedBy: cached.matchedBy ?? null,
        total: (cached.volumes ?? []).length,
        missing,
        series: summary.name,
        // What was attempted, for when the answer is "nothing".
        tried,
      });
    }

    if (pathname === '/api/stats' && method === 'GET') return json(res, 200, stats(db));

    /**
     * Re-fetch covers that are missing. Capped per call so the request cannot
     * hang for minutes on a large catalogue; the UI loops until remaining is 0.
     */
    if (pathname === '/api/covers/refresh' && method === 'POST') {
      const CAP = 25;
      const body = await readBody(req).catch(() => ({}));
      const rows = db
        .prepare(
          `SELECT b.isbn13, w.cover_id FROM books b JOIN works w ON w.id = b.work_id
            ORDER BY b.added_at DESC`,
        )
        .all();

      // A batch run must not retry the same unsolvable books on every call, so
      // the first call clears the existing "no cover" markers and later calls
      // skip anything already tried in this run.
      if (body.reset) {
        for (const row of rows) {
          if (!hasCover(DATA_DIR, row.isbn13)) clearCoverMiss(DATA_DIR, row.isbn13);
        }
      }

      const missing = rows.filter(
        (r) => !hasCover(DATA_DIR, r.isbn13) && !coverMissPending(DATA_DIR, r.isbn13),
      );
      const batch = missing.slice(0, CAP);

      // Three at a time: polite to Open Library, and still ~1s per cover.
      let found = 0;
      let cursor = 0;
      const workers = Array.from({ length: 3 }, async () => {
        while (cursor < batch.length) {
          const row = batch[cursor];
          cursor += 1;
          const file = await ensureCover(
            DATA_DIR,
            { isbn13: row.isbn13, coverId: row.cover_id, coverUrl: row.cover_url },
            { force: true, timeoutMs: 6000 },
          ).catch(() => null);
          if (file) found += 1;
        }
      });
      await Promise.all(workers);

      bumpCoverEpoch(db);
      return json(res, 200, {
        checked: batch.length,
        found,
        remaining: Math.max(0, missing.length - batch.length),
        total: rows.length,
      });
    }
    if (pathname === '/api/scans' && method === 'GET') return json(res, 200, { scans: recentScans(db) });
    if (pathname === '/api/export' && method === 'GET') {
      res.setHeader('content-disposition', `attachment; filename="bookshelf-${Date.now()}.json"`);
      return json(res, 200, exportAll(db));
    }

    if (pathname === '/api/settings' && method === 'GET') {
      return json(res, 200, {
        dataDir: DATA_DIR,
        hasPinFromEnv: Boolean(process.env.BOOKSHELF_PIN),
        version: VERSION,
        build: BUILD,
        // Tells the operator whether the optional Google Books key is wired up.
        googleBooks: Boolean(googleBooksKey()),
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
