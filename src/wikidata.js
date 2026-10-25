// Series data from Wikidata.
//
// Why Wikidata: Open Library carries series only as free-text subject tags, and
// Google Books has no series field at all (its Volume schema has title, subtitle,
// authors, categories, ratings - but nothing that says "book 3 of X"). Wikidata
// models it properly: P179 "part of the series" with the qualifier P1545 "series
// ordinal", which is exactly a series name plus a volume number.
//
// The join is by Open Library work id (P648), because we already have that from
// the metadata lookup and ISBN coverage in Wikidata is thin - querying by ISBN
// returned nothing for every edition tested.
//
// No API key, no quota worth worrying about, but coverage is partial: standalone
// novels have no series, and not every series is modelled. A miss is simply null.
import { fetchJson } from './util.js';

const ENDPOINT = 'https://query.wikidata.org/sparql';

/** Open Library work keys look like OL15157288W. Anything else is not ours. */
export function isWorkKey(value) {
  return typeof value === 'string' && /^OL\d+W$/.test(value);
}

const SPARQL = (workKey) => `SELECT ?seriesLabel ?ordinal WHERE {
  ?work wdt:P648 "${workKey}".
  ?work wdt:P179 ?series.
  OPTIONAL { ?work p:P179/pq:P1545 ?ordinal. }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} LIMIT 3`;

/**
 * Look up the series and volume for an Open Library work.
 * Returns { series, volume } or null. Never throws.
 */
export async function seriesFromWikidata(workKey, { timeoutMs = 6000 } = {}) {
  if (!isWorkKey(workKey)) return null;

  const url = `${ENDPOINT}?format=json&query=${encodeURIComponent(SPARQL(workKey))}`;
  const res = await fetchJson(url, {
    timeoutMs,
    headers: { accept: 'application/sparql-results+json' },
  });
  if (!res.ok || !res.data) return null;

  const row = res.data.results?.bindings?.[0];
  if (!row?.seriesLabel?.value) return null;

  const volume = row.ordinal?.value ? Number.parseFloat(row.ordinal.value) : null;
  return {
    series: row.seriesLabel.value,
    volume: Number.isFinite(volume) && volume > 0 ? volume : null,
  };
}
