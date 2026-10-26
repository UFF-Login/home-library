import { stripHtml } from './util.js';
import { isbn13To10 } from './isbn.js';

// Google Books metadata, used only when an API key is configured.
//
// Keyless use is not possible: the API answers 429 RESOURCE_EXHAUSTED with a
// daily quota of zero when no key is sent, which is why this app started out with
// Open Library only.
//
// Two jobs here:
//   1. enrich a record Open Library already found (better rating pool, blurb);
//   2. rescue an ISBN Open Library does not know at all - which is the case that
//      matters most, because those scans used to come back as "no catalogue
//      record" and could not be added without retyping everything by hand.
//
// It still does NOT bring series data: the Volume schema has no series field.
// That comes from Wikidata.
/**
 * Fetch JSON, keeping the body on error responses too.
 *
 * The shared helper returns data:null whenever the status is not 2xx, which turns
 * Google's "Quota exceeded for quota metric 'Queries'..." into a bare HTTP 429 -
 * exactly the detail needed to tell a quota problem from a restricted key.
 */
async function requestJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'home-library/0.1 (self-hosted book catalogue)' },
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    return { ok: res.ok, status: res.status, data };
  } catch (error) {
    return { ok: false, status: 0, data: null, error: String(error?.message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}

// Overridable only so the rescue path can be exercised end-to-end against a
// stand-in for Google's API; production never sets this.
const ENDPOINT = process.env.GOOGLE_BOOKS_ENDPOINT ?? 'https://www.googleapis.com/books/v1/volumes';

export function googleBooksKey() {
  const key = String(process.env.GOOGLE_BOOKS_KEY ?? '').trim();
  return key || null;
}

/** "1998", "1998-05-01" or "May 1998" -> "1998". */
function yearOf(value) {
  const match = /(\d{4})/.exec(String(value ?? ''));
  return match ? match[1] : null;
}

/**
 * Google's thumbnails are http:// and often carry an `edge=curl` parameter.
 * Upgrade to https (the app is served over TLS) and drop the curl effect.
 */
function bestCoverUrl(imageLinks = {}) {
  const candidate =
    imageLinks.extraLarge ??
    imageLinks.large ??
    imageLinks.medium ??
    imageLinks.small ??
    imageLinks.thumbnail ??
    imageLinks.smallThumbnail ??
    null;
  if (!candidate) return null;
  const upgraded = String(candidate).replace(/^http:/, 'https:');
  // `edge=curl` may be the first parameter or a later one, so handle it as a real
  // query parameter rather than by string surgery.
  try {
    const url = new URL(upgraded);
    url.searchParams.delete('edge');
    return url.toString();
  } catch {
    return upgraded.replace(/[?&]edge=curl/g, '');
  }
}

/**
 * Map a Google `volumeInfo` object onto our record shape.
 *
 * Pure and exported so it can be tested without a key: the API's field names are
 * easy to get subtly wrong (publishedDate is a string, pageCount is absent on
 * many volumes, imageLinks may only carry a thumbnail), and the ISBN guard is the
 * only thing preventing the API's fuzzy search from attaching the wrong book.
 */
export function volumeToRecord(info, isbn13, { trusted = false } = {}) {
  if (!info) return null;

  // `trusted` means the volume id came from an ISBN lookup, so the link is already
  // established even though metadata-only volumes often carry no identifiers.
  const identifiers = (info.industryIdentifiers ?? []).map((i) => String(i.identifier ?? ''));
  const matches = trusted || identifiers.some((id) => id.replace(/[^0-9Xx]/g, '') === isbn13);
  if (!matches) return null;

  return {
    title: info.title ?? null,
    subtitle: info.subtitle ?? null,
    authors: Array.isArray(info.authors) ? info.authors.filter(Boolean) : [],
    publisher: info.publisher ?? null,
    published: yearOf(info.publishedDate),
    pages: Number(info.pageCount) || null,
    // Provider blurbs arrive as HTML fragments; stored text must be plain.
    description: stripHtml(info.description),
    categories: Array.isArray(info.categories) ? info.categories : [],
    language: info.language ?? null,
    rating: Number.isFinite(info.averageRating) ? info.averageRating : null,
    ratingsCount: Number.isFinite(info.ratingsCount) ? info.ratingsCount : null,
    coverUrl: bestCoverUrl(info.imageLinks),
  };
}

/**
 * Parse Google's viewapi response, which is JavaScript rather than JSON:
 *   var _GBSBookInfo = {"ISBN:9781761720024": {...}};
 */
export function parseViewApi(text, key) {
  const start = String(text ?? '').indexOf('{');
  const end = String(text ?? '').lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let data;
  try {
    data = JSON.parse(String(text).slice(start, end + 1));
  } catch {
    return null;
  }
  const entry = data?.[key];
  if (!entry) return null;
  const id = /[?&]id=([A-Za-z0-9_-]+)/.exec(entry.info_url ?? '')?.[1] ?? null;
  if (!id) return null;
  // viewapi offers zoom=5 (a small thumbnail); zoom=1 is the largest image the
  // content endpoint provides, and the size check downstream rejects tiny ones.
  const thumbnailUrl = entry.thumbnail_url
    ? String(entry.thumbnail_url).replace(/zoom=\d+/, 'zoom=1')
    : null;
  return { volumeId: id, thumbnailUrl, preview: entry.preview ?? null };
}

/**
 * Resolve an ISBN to a Google volume id.
 *
 * This is the fix for books the API cannot search: `q=isbn:` misses metadata-only
 * volumes (the "...ACAAJ" ids, no preview), yet the same ISBN resolves perfectly
 * through this endpoint - which needs no key at all.
 */
export async function viewApiLookup(isbn13, { timeoutMs = 8000 } = {}) {
  const base = process.env.GOOGLE_BOOKS_VIEWAPI ?? 'https://books.google.com/books';
  const url = `${base}?jscmd=viewapi&bibkeys=ISBN:${encodeURIComponent(isbn13)}&hl=en`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; home-library/1.0)' },
    });
    if (!res.ok) return null;
    return parseViewApi(await res.text(), `ISBN:${isbn13}`);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Full metadata for a known volume id. Reliable where search is not. */
async function volumeById(volumeId, isbn13, { timeoutMs = 8000, trusted = false } = {}) {
  const key = googleBooksKey();
  if (!key) return null;
  const url = `${ENDPOINT}/${encodeURIComponent(volumeId)}?key=${encodeURIComponent(key)}`;
  const res = await requestJson(url, timeoutMs);
  if (!res.ok) return { error: res };
  const record = volumeToRecord(res.data?.volumeInfo, isbn13, { trusted });
  return record ? { record } : null;
}

/**
 * Look a volume up by ISBN, reporting *why* there is no record.
 *
 * status: 'off'     no key configured
 *         'failed'  every request was rejected (HTTP error, quota, bad key)
 *         'empty'   answered cleanly, and does not have the book
 *         'partial' Google knows the book (it resolved to a volume) but its
 *                   details could not be read - usually a rejected key
 *         'ok'      a record
 *
 * Search is only the first attempt. Google's ISBN search misses metadata-only
 * volumes - books printed without a preview, whose ids end in "ACAAJ" - while the
 * same ISBN resolves through the viewapi endpoint without a key at all. Reading
 * the volume by its id then gives the full record.
 */
export async function googleBooksLookup(isbn13, { timeoutMs = 8000 } = {}) {
  const key = googleBooksKey();
  if (!key) return { status: 'off' };

  let failure = null;

  // Resolve the volume first and read it by id: two requests, and it works for the
  // metadata-only volumes that search cannot see at all.
  const view = await viewApiLookup(isbn13, { timeoutMs });
  if (view) {
    const byId = await volumeById(view.volumeId, isbn13, { timeoutMs, trusted: true });
    if (byId?.record) {
      return {
        status: 'ok',
        record: { ...byId.record, coverUrl: byId.record.coverUrl ?? view.thumbnailUrl },
      };
    }
    if (byId?.error) {
      failure = {
        httpStatus: byId.error.status,
        reason: shortReason(byId.error.data?.error?.message ?? `HTTP ${byId.error.status}`),
      };
    }
  }

  // Search as the fallback, for anything viewapi does not resolve.
  for (const query of searchQueries(isbn13)) {
    const url = `${ENDPOINT}?q=${encodeURIComponent(query)}&key=${encodeURIComponent(key)}`;
    const res = await requestJson(url, timeoutMs);
    if (!res.ok) {
      failure ??= {
        httpStatus: res.status,
        reason: shortReason(res.data?.error?.message ?? res.error ?? `HTTP ${res.status}`),
      };
      break; // a rejected request will be rejected for every query
    }
    const record = volumeToRecord(res.data?.items?.[0]?.volumeInfo, isbn13);
    if (record) return { status: 'ok', record };
  }

  if (view) {
    // Google has the book even though its details could not be read.
    return {
      status: 'partial',
      volumeId: view.volumeId,
      coverUrl: view.thumbnailUrl,
      httpStatus: failure?.httpStatus ?? null,
      reason: failure?.reason ?? null,
    };
  }

  if (failure) return { status: 'failed', httpStatus: failure.httpStatus, reason: failure.reason };
  return { status: 'empty' };
}

/** Search variants, cheapest first. Plain digits catch records isbn: misses. */
function searchQueries(isbn13) {
  const queries = [`isbn:${isbn13}`, isbn13];
  const isbn10 = isbn13To10(isbn13);
  if (isbn10) queries.push(`isbn:${isbn10}`);
  return queries;
}

/** Google's error messages are long; keep the first clause for the phone screen. */
function shortReason(message) {
  return String(message).split('.')[0].slice(0, 160);
}

/**
 * Raw probe for the "test the key" button: returns Google's own words, unedited,
 * so a 403 key restriction is distinguishable from a 429 quota from a dead key.
 */
export async function googleBooksProbe(isbn13 = '9780330360890', { timeoutMs = 8000 } = {}) {
  const key = googleBooksKey();
  if (!key) return { configured: false };

  const url = `${ENDPOINT}?q=isbn:${encodeURIComponent(isbn13)}&key=${encodeURIComponent(key)}`;
  const res = await requestJson(url, timeoutMs);
  return {
    configured: true,
    httpStatus: res.status,
    ok: res.ok,
    items: res.data?.totalItems ?? null,
    sampleTitle: res.data?.items?.[0]?.volumeInfo?.title ?? null,
    error: res.data?.error ?? res.error ?? null,
  };
}

/** Record or null, for callers that do not care why. */
export async function googleBooksByIsbn(isbn13, options) {
  const result = await googleBooksLookup(isbn13, options);
  return result.status === 'ok' ? result.record : null;
}
