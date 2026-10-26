// Cover images, cached on disk.
//
// Three hard-won rules are encoded here, each from something that actually went
// wrong while building this.
//
// 1. "Failed" and "has no cover" are different facts. A timeout treated like a
//    404 wrote a permanent "no cover" marker, so one slow request while adding a
//    book left it coverless for ever. A marker is now written only when every
//    source gave a clean answer, and markers expire so OL's later additions get
//    picked up.
//
// 2. An ISBN must be verified before any art is trusted. `covers.../b/isbn/<x>`
//    serves a picture even for an ISBN that is not a book (a made-up ISBN got a
//    53KB cover), and the search endpoint returns fuzzy matches. Verification =
//    the record's own ISBN list contains the ISBN we asked about.
//
// 3. A source that answers *everything* is useless. Google Books' and Amazon's
//    image endpoints return a "no image" placeholder that is within a few pixels
//    of a real cover (128x183 vs 128x186), and Google even renders it at 575x821
//    when zoomed - so no size test separates them. Both are out by default: a
//    missing cover beats a confidently wrong one.
import { existsSync, mkdirSync, writeFileSync, statSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isbn13To10 } from './isbn.js';
import { verifiedSearchDoc } from './openlibrary.js';

const MIN_COVER_BYTES = 1500;
const NEGATIVE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // re-check a "no cover" monthly
const ATTEMPTS_PER_URL = 2;

export function coverFile(dataDir, isbn13) {
  return join(dataDir, 'covers', `${isbn13}.jpg`);
}

function missFile(dataDir, isbn13) {
  return join(dataDir, 'covers', `${isbn13}.none`);
}

/** Amazon is opt-in: its placeholder art cannot be told apart from real covers. */
const AMAZON_ENABLED = process.env.COVER_AMAZON === '1';

async function getJson(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch one image.
 * Returns { bytes } on success, { definitive: true } when the source says "no
 * image here", or { definitive: false } when the attempt failed - so the caller
 * must not cache a miss.
 */
async function fetchImage(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'home-library/0.1 (self-hosted book catalogue)' },
    });
    if (res.status === 404 || res.status === 410) return { definitive: true };
    if (!res.ok) return { definitive: false };

    const type = res.headers.get('content-type') ?? '';
    const buf = Buffer.from(await res.arrayBuffer());
    if (!type.startsWith('image/')) return { definitive: true }; // HTML error page
    if (buf.length < MIN_COVER_BYTES) return { definitive: true };
    return { bytes: buf };
  } catch {
    return { definitive: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Candidate image URLs, best first, for a *verified* record.
 * The work's own cover is preferred because it is the same book; the ISBN art is
 * the exact printing when Open Library has it; other editions are the last
 * resort so a rare printing still gets a recognisable cover.
 */
async function candidateUrls({ isbn13 }, doc) {
  const urls = [];
  if (doc?.cover_i) urls.push(`https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg`);
  urls.push(`https://covers.openlibrary.org/b/isbn/${isbn13}-L.jpg`);

  if (doc?.key) {
    const editions = await getJson(`https://openlibrary.org${doc.key}/editions.json?limit=25`);
    for (const entry of editions?.entries ?? []) {
      const id = (entry.covers ?? []).find((c) => c > 0);
      if (id) {
        urls.push(`https://covers.openlibrary.org/b/id/${id}-L.jpg`);
        break;
      }
    }
  }

  if (AMAZON_ENABLED) {
    const isbn10 = isbn13To10(isbn13);
    if (isbn10) urls.push(`https://m.media-amazon.com/images/P/${isbn10}.01._SCLZZZZZZZ_.jpg`);
  }
  return urls;
}

/** Marker exists and is still fresh? Legacy (pre-JSON) markers count as expired. */
function missIsFresh(dataDir, isbn13) {
  const path = missFile(dataDir, isbn13);
  if (!existsSync(path)) return false;
  try {
    const raw = readFileSync(path, 'utf8').trim();
    const at = raw.startsWith('{') ? JSON.parse(raw).at : null;
    if (!at) {
      rmSync(path, { force: true });
      return false;
    }
    if (Date.now() - Date.parse(at) < NEGATIVE_TTL_MS) return true;
    rmSync(path, { force: true });
    return false;
  } catch {
    rmSync(path, { force: true });
    return false;
  }
}

function writeMiss(dataDir, isbn13, reason) {
  writeFileSync(missFile(dataDir, isbn13), JSON.stringify({ at: new Date().toISOString(), reason }));
}

/**
 * Ensure a cover exists on disk for this ISBN. Returns a local path or null.
 * `force` ignores an existing negative marker (used by "reload missing covers").
 */
export async function ensureCover(dataDir, book, { timeoutMs = 8000, force = false } = {}) {
  const { isbn13 } = book;
  if (!isbn13) return null;
  mkdirSync(join(dataDir, 'covers'), { recursive: true });

  const file = coverFile(dataDir, isbn13);
  if (existsSync(file) && statSync(file).size >= MIN_COVER_BYTES) return file;
  if (force) rmSync(missFile(dataDir, isbn13), { force: true });
  if (!force && missIsFresh(dataDir, isbn13)) return null;

  // Step 1: does Open Library actually know this ISBN? Without this, both the
  // search and the cover endpoints invent answers.
  //
  // A book rescued from Google Books has no Open Library record at all, but it
  // does have a thumbnail URL that Google returned *for that ISBN* - already
  // verified, so it is trusted ahead of anything Open Library would guess.
  const doc = book.coverUrl ? null : await verifiedSearchDoc(isbn13, { timeoutMs });
  if (!doc && !book.coverUrl) {
    writeMiss(dataDir, isbn13, 'isbn-unknown');
    return null;
  }

  // Step 2: try the artwork for that verified record.
  const urls = book.coverUrl ? [book.coverUrl] : [];
  if (doc) urls.push(...(await candidateUrls(book, doc)));

  let sawTransientFailure = false;
  for (const url of urls) {
    for (let attempt = 0; attempt < ATTEMPTS_PER_URL; attempt += 1) {
      const result = await fetchImage(url, timeoutMs);
      if (result.bytes) {
        writeFileSync(file, result.bytes);
        rmSync(missFile(dataDir, isbn13), { force: true });
        return file;
      }
      if (result.definitive) break; // this URL has nothing
      sawTransientFailure = true;
    }
  }

  // Cache the miss only when nothing failed for network reasons.
  if (!sawTransientFailure) writeMiss(dataDir, isbn13, 'no-image');
  return null;
}

/** True when a cover actually exists on disk (used by the refresh counter). */
export function hasCover(dataDir, isbn13) {
  const file = coverFile(dataDir, isbn13);
  return existsSync(file) && statSync(file).size >= MIN_COVER_BYTES;
}

/**
 * True when this ISBN was already tried and definitively has no cover, recently
 * enough to trust. "Reload covers" clears these first so a batch run makes
 * progress instead of retrying the same books forever.
 */
export function coverMissPending(dataDir, isbn13) {
  return missIsFresh(dataDir, isbn13);
}

export function clearCoverMiss(dataDir, isbn13) {
  rmSync(missFile(dataDir, isbn13), { force: true });
}

/**
 * Forget every "no cover" marker so the next request retries all sources.
 * Covers already on disk are kept - only the negative cache is cleared.
 */
export function clearAllCoverMisses(dataDir) {
  const dir = join(dataDir, 'covers');
  if (!existsSync(dir)) return 0;
  let cleared = 0;
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.none')) continue;
    rmSync(join(dir, entry), { force: true });
    cleared += 1;
  }
  return cleared;
}
