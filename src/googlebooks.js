// Google Books metadata, used only when an API key is configured.
//
// Keyless use is not possible: the API answers 429 RESOURCE_EXHAUSTED with a
// daily quota of zero when no key is sent, which is why this app started out with
// Open Library only.
//
// What a key buys us, stated plainly: community ratings and a description, plus
// its own title/subtitle text (which can carry a series marker for our parser).
// It does NOT bring series data - the Volume schema has no series field - so
// Wikidata is the source used for that.
//
// Free tier is 1,000 requests/day by default, which for one household is far more
// than enough: results are cached in SQLite, so a book is only ever looked up once.
import { fetchJson } from './util.js';

const ENDPOINT = 'https://www.googleapis.com/books/v1/volumes';

export function googleBooksKey() {
  const key = String(process.env.GOOGLE_BOOKS_KEY ?? '').trim();
  return key || null;
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
  if (!info) return null;

  // Guard against the API returning a different book for a fuzzy ISBN query.
  const identifiers = (info.industryIdentifiers ?? []).map((i) => String(i.identifier ?? ''));
  const matches = identifiers.some((id) => id.replace(/[^0-9Xx]/g, '') === isbn13);
  if (!matches) return null;

  return {
    title: info.title ?? null,
    subtitle: info.subtitle ?? null,
    pages: Number(info.pageCount) || null,
    description: info.description ?? null,
    categories: info.categories ?? [],
    rating: Number.isFinite(info.averageRating) ? info.averageRating : null,
    ratingsCount: Number.isFinite(info.ratingsCount) ? info.ratingsCount : null,
  };
}
