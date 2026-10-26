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
import { fetchJson } from './util.js';

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
export function volumeToRecord(info, isbn13) {
  if (!info) return null;

  const identifiers = (info.industryIdentifiers ?? []).map((i) => String(i.identifier ?? ''));
  const matches = identifiers.some((id) => id.replace(/[^0-9Xx]/g, '') === isbn13);
  if (!matches) return null;

  return {
    title: info.title ?? null,
    subtitle: info.subtitle ?? null,
    authors: Array.isArray(info.authors) ? info.authors.filter(Boolean) : [],
    publisher: info.publisher ?? null,
    published: yearOf(info.publishedDate),
    pages: Number(info.pageCount) || null,
    description: info.description ?? null,
    categories: Array.isArray(info.categories) ? info.categories : [],
    language: info.language ?? null,
    rating: Number.isFinite(info.averageRating) ? info.averageRating : null,
    ratingsCount: Number.isFinite(info.ratingsCount) ? info.ratingsCount : null,
    coverUrl: bestCoverUrl(info.imageLinks),
  };
}

/**
 * Look a volume up by ISBN. Returns null when unconfigured, rate-limited, or the
 * book is unknown - the caller keeps whatever Open Library already gave it.
 */
export async function googleBooksByIsbn(isbn13, { timeoutMs = 8000 } = {}) {
  const key = googleBooksKey();
  if (!key) return null;

  const url = `${ENDPOINT}?q=isbn:${encodeURIComponent(isbn13)}&key=${encodeURIComponent(key)}`;
  const res = await fetchJson(url, { timeoutMs });
  if (!res.ok || !res.data) return null;

  const info = res.data.items?.[0]?.volumeInfo;
  return volumeToRecord(info, isbn13);
}
