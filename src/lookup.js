// Book metadata lookup, Open Library only.
//
// Why not Google Books: without an API key it answers 429 RESOURCE_EXHAUSTED
// with a hard per-day quota of zero, so a keyless deployment cannot use it.
//
// Two endpoints, both needed and both slow (measured 1.3s - 8.8s from one host):
//   jscmd=data   - the rich edition record. The only source of `subtitle`, and
//                  the subtitle is where "#17" lives, so it is the only source
//                  of series volume numbers.
//   search.json  - work key (needed for ratings), cover id, and it still finds
//                  books whose edition record is missing.
// They run in parallel and the caller caches the merged result in SQLite.
//
// Nothing here blocks a scan. The owned/not-owned verdict comes from the local
// database; this module only decorates an answer that has already been given.
import { fetchJson } from './util.js';
import { parseSeries, seriesFromSubjects, seriesKey } from './series.js';
import { authorKey } from './authors.js';
import { verifiedSearchDoc } from './openlibrary.js';

const OL_BOOKS = 'https://openlibrary.org/api/books';
const OL_SEARCH = 'https://openlibrary.org/search.json';
const OL_WORKS = 'https://openlibrary.org';

const DEFAULT_TIMEOUT_MS = 12000;

function str(value) {
  const s = typeof value === 'string' ? value.trim() : '';
  return s || null;
}

/** Year out of "1998", "March 1998", "1998-05-01" or [1998]. */
function yearOf(value) {
  if (Array.isArray(value)) return yearOf(value[0]);
  if (typeof value === 'number') return String(value);
  const match = /(\d{4})/.exec(String(value ?? ''));
  return match ? match[1] : null;
}

/** One retry: Open Library drops connections under light load often enough. */
async function attempt(fn, tries = 2) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {
      // fall through to the retry
    }
  }
  return null;
}

async function fetchEdition(isbn13, timeoutMs) {
  const url = `${OL_BOOKS}?bibkeys=ISBN:${isbn13}&format=json&jscmd=data`;
  const res = await fetchJson(url, { timeoutMs });
  if (!res.ok || !res.data) return null;
  return res.data[`ISBN:${isbn13}`] ?? null;
}

/**
 * Search is a *search*: `q=isbn:<unknown>` returns fuzzy matches, so the first
 * document is not necessarily this book. Use the verified lookup, otherwise a
 * scan of an obscure ISBN could adopt another book's title and author.
 */
async function fetchSearch(isbn13, timeoutMs) {
  return verifiedSearchDoc(isbn13, { timeoutMs });
}

/** Community rating lives on the work, not the edition, and needs its own call. */
export async function fetchRating(workKey, { timeoutMs = 6000 } = {}) {
  if (!workKey) return null;
  const res = await fetchJson(`${OL_WORKS}${workKey}/ratings.json`, { timeoutMs });
  const summary = res.ok ? res.data?.summary : null;
  if (!summary || !summary.count) return null;
  return { average: Number(summary.average?.toFixed(2)) || null, count: summary.count };
}

/**
 * Merge an edition record and a search record into the shape db.saveBook wants.
 * Edition data wins where both exist (it describes the actual ISBN in your hand);
 * search fills the gaps (work key, cover id).
 */
export function normalise(isbn13, edition, search) {
  if (!edition && !search) return null;

  const title = str(edition?.title) ?? str(search?.title) ?? 'Untitled';
  const subtitle = str(edition?.subtitle) ?? str(search?.subtitle);

  const authorNames = [
    ...(edition?.authors ?? []).map((a) => str(a?.name)),
    ...(search?.author_name ?? []).map(str),
    // "by_statement" is a free-text fallback: "R.L. Stine." -> "R.L. Stine"
    edition?.by_statement ? str(String(edition.by_statement).replace(/\.$/, '')) : null,
  ].filter(Boolean);

  // De-duplicate by author key, not by string: the edition record says
  // "Robert Lawrence Stine" while the search record says "R.L. Stine", and one
  // author must not appear twice on the book.
  const authors = [];
  const seenKeys = new Set();
  for (const name of authorNames) {
    const key = authorKey(name) ?? name.toLowerCase();
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    authors.push(name);
  }

  // Series: parse the text first (it carries the volume number), fall back to
  // the subject tag (name only), then to any series field on the record.
  const parsed = parseSeries({ title, subtitle });
  let series = parsed.series;
  const volume = parsed.volume;
  if (!series) series = seriesFromSubjects(edition?.subjects ?? []) ?? str(search?.series?.[0]);

  return {
    title,
    subtitle,
    authors,
    authorKey: authorKey(authors[0]),
    series: series ?? null,
    seriesKey: seriesKey(series),
    volume: volume ?? null,
    publisher: str(edition?.publishers?.[0]?.name) ?? str(search?.publisher?.[0]),
    published: yearOf(edition?.publish_date) ?? yearOf(search?.first_publish_year),
    pages: Number(edition?.number_of_pages) || Number(search?.number_of_pages_median) || null,
    workKey: str(search?.key) ?? null,
    coverId: search?.cover_i ? String(search.cover_i) : null,
    subjects: (edition?.subjects ?? [])
      .map((s) => str(typeof s === 'string' ? s : s?.name))
      .filter(Boolean)
      .slice(0, 25),
    rating: null,
    ratingsCount: null,
  };
}

/**
 * Resolve an ISBN to book metadata. Returns { found, work }.
 * Never throws: the worst case is found:false, which the UI turns into a manual
 * entry form rather than an error.
 */
export async function lookupIsbn(isbn13, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const [edition, search] = await Promise.all([
    attempt(() => fetchEdition(isbn13, timeoutMs)),
    attempt(() => fetchSearch(isbn13, timeoutMs)),
  ]);

  const work = normalise(isbn13, edition, search);
  if (!work) return { found: false, work: null, isbn13 };
  return { found: true, work, isbn13 };
}
