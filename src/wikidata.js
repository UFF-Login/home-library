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

async function sparql(query, { timeoutMs = 12000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${ENDPOINT}?query=${encodeURIComponent(query)}&format=json`, {
      signal: controller.signal,
      headers: {
        accept: 'application/sparql-results+json',
        'user-agent': 'home-library/1.0 (self-hosted book catalogue)',
      },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Everything a series contains, so the gaps can be named rather than numbered.
 *
 * "#1, #2, #3" tells you how many books you are missing; it does not tell you what
 * to look for in a shop. Wikidata knows the volumes (P179 membership, P1545 order,
 * P577 publication date) for many series, and this maps a work we own onto its
 * series item to fetch them all.
 *
 * Returns null when Wikidata cannot help, which is common for small-press series.
 */
export async function seriesVolumes(workKey, seriesName) {
  let qid = null;
  let matchedBy = null;

  // 1. Through a book we own: its Open Library work id maps to the series item.
  if (isWorkKey(workKey)) {
    const rows = await sparql(
      `SELECT ?series WHERE { ?w wdt:P648 "${workKey}" . ?w wdt:P179 ?series . } LIMIT 1`,
    );
    const uri = rows?.results?.bindings?.[0]?.series?.value;
    const candidate = uri?.split('/').pop();
    if (candidate && /^Q\d+$/.test(candidate)) {
      qid = candidate;
      matchedBy = 'work';
    }
  }

  // 2. By the series NAME, matched against labels and aliases of items that books
  //    actually point at. This is what rescues series whose work ids are not in
  //    Wikidata: "Point Horror" and "Dune Chronicles" both resolve this way, one
  //    of them only through an alias.
  if (!qid && seriesName) {
    // Quotes and backslashes would break out of the SPARQL string literal.
    const safe = String(seriesName)
      .replace(/["\\]/g, ' ')
      .slice(0, 80)
      .trim();
    if (safe) {
      const rows = await sparql(
        `SELECT ?s WHERE {
           ?w wdt:P179 ?s .
           { ?s rdfs:label "${safe}"@en } UNION { ?s skos:altLabel "${safe}"@en }
         } LIMIT 1`,
      );
      const uri = rows?.results?.bindings?.[0]?.s?.value;
      const candidate = uri?.split('/').pop();
      if (candidate && /^Q\d+$/.test(candidate)) {
        qid = candidate;
        matchedBy = 'name';
      }
    }
  }

  if (!qid) return null;

  const data = await sparql(
    `SELECT ?v ?vLabel ?ord ?date ?ol WHERE {
       ?v wdt:P179 wd:${qid} .
       OPTIONAL { ?v wdt:P1545 ?ord }
       OPTIONAL { ?v wdt:P577 ?date }
       OPTIONAL { ?v wdt:P648 ?ol }
       SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
     } LIMIT 300`,
  );
  const rows = data?.results?.bindings ?? [];
  if (!rows.length) return null;

  const seen = new Set();
  const volumes = [];
  for (const row of rows) {
    const title = row.vLabel?.value;
    if (!title || /^Q\d+$/.test(title)) continue; // unlabelled item
    const ordinal = Number.parseInt(row.ord?.value ?? '', 10);
    const entry = {
      title,
      // P1545 is missing for many series; null is honest, and the UI copes.
      volume: Number.isFinite(ordinal) ? ordinal : null,
      year: row.date?.value?.slice(0, 4) ?? null,
      workKey: row.ol?.value ?? null,
    };
    const dedupe = `${title}|${entry.volume ?? ''}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    volumes.push(entry);
  }

  volumes.sort((a, b) => {
    if (a.volume != null && b.volume != null) return a.volume - b.volume;
    if (a.volume != null) return -1;
    if (b.volume != null) return 1;
    // No ordinals on either side (common: Goosebumps): publication order is the
    // most useful ordering left, and reads better than alphabetical.
    if (a.year && b.year && a.year !== b.year) return a.year.localeCompare(b.year);
    return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
  });

  return { seriesQid: qid, matchedBy, volumes };
}
