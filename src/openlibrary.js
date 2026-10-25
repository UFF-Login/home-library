// Verified Open Library search.
//
// The search endpoint is a *search*, not a lookup: querying `q=isbn:<isbn>` for
// an ISBN that does not exist returns fuzzy matches (a made-up ISBN returned
// numFound:3), and `covers.openlibrary.org/b/isbn/<isbn>` will happily serve
// artwork for something that is not that book at all. Trusting either without
// verification is how a catalogue ends up with the wrong title and the wrong
// cover on a book.
//
// So every result is checked: the returned record's own ISBN list must contain
// the ISBN we asked about.
import { fetchJson } from './util.js';
import { isbn13To10, compact } from './isbn.js';

const FIELDS = [
  'key',
  'title',
  'subtitle',
  'author_name',
  'first_publish_year',
  'cover_i',
  'publisher',
  'number_of_pages_median',
  'series',
  'isbn',
].join(',');

/**
 * Search by ISBN and return only a record that genuinely carries that ISBN.
 * Returns null when there is no such record (including "fuzzy matches only").
 */
export async function verifiedSearchDoc(isbn13, { timeoutMs = 8000 } = {}) {
  const url = `https://openlibrary.org/search.json?q=isbn:${isbn13}&fields=${FIELDS}&limit=3`;
  const res = await fetchJson(url, { timeoutMs });
  if (!res.ok || !res.data) return null;

  const wanted = [compact(isbn13)];
  const isbn10 = isbn13To10(isbn13);
  if (isbn10) wanted.push(compact(isbn10));

  for (const doc of res.data.docs ?? []) {
    const listed = (doc.isbn ?? []).map((value) => compact(value));
    if (wanted.some((value) => listed.includes(value))) return doc;
  }
  return null;
}
