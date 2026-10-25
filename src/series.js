// Series + volume extraction.
//
// This is the weakest data in every free book API: Google Books has no series
// field at all and Open Library only carries it inconsistently. But the volume
// number is almost always present *in the text* - "Goosebumps #17",
// "Discworld, Book 12", "(Animorphs, #4)" - so parsing the title and subtitle
// beats trusting the API. When parsing fails we fall back to Open Library's
// "series:Name" subject tags, which give a series name but no volume.

const NUM = '(\\d{1,3}(?:\\.\\d)?)';
const MARK = '(?:#|\\bbook\\b|\\bvol(?:ume)?\\.?|\\bpart\\b)';

// Ordered most-specific first. The parenthetical form runs first because the
// series name sits inside the brackets and is unambiguous - without it,
// "The Haunted Mask (Goosebumps, #11)" would parse the whole title as the name.
const PATTERNS = [
  {
    re: new RegExp(`\\(\\s*([^()]+?)[\\s,]*${MARK}\\s*\\.?\\s*${NUM}[^()]*\\)`, 'i'),
  },
  { re: new RegExp(`^([^#]*?)[\\s,:-]*${MARK}\\s*\\.?\\s*${NUM}\\b`, 'i') },
];

function cleanName(value) {
  return String(value ?? '')
    .replace(/[\s,:;(\-–]+$/g, '')
    .replace(/^[\s,:;(\-–]+/g, '')
    .trim();
}

/**
 * Underscored subject slugs arrive lowercase ("harry potter" -> "Harry Potter"),
 * but a properly-cased title must be left alone or "The Eye of the World"
 * becomes "The Eye Of The World".
 */
export function titleCaseSeries(value) {
  const text = String(value ?? '').replace(/_/g, ' ').trim().replace(/\s+/g, ' ');
  const isAllLower = text === text.toLowerCase();
  return isAllLower ? text.replace(/\b([a-z])/g, (m) => m.toUpperCase()) : text;
}

/**
 * Parse a series name and volume out of an edition's title/subtitle.
 * Either field may come back null: a bare "#11" yields a volume with no name,
 * which the caller combines with Open Library's subject-derived series name.
 */
export function parseSeries({ title, subtitle } = {}) {
  // Subtitle first: it carries the series marker most often ("Goosebumps #2"),
  // and a subtitle is far less likely to contain misleading text than a title.
  for (const text of [subtitle, title]) {
    const raw = String(text ?? '').trim();
    if (!raw) continue;
    for (const pattern of PATTERNS) {
      const match = raw.match(pattern.re);
      if (!match) continue;
      const volume = Number(match[2]);
      if (!Number.isFinite(volume) || volume <= 0) continue;
      const series = cleanName(match[1]);
      // A name that is only digits or absurdly long is a false positive.
      if (series && (series.length > 60 || /^\d+$/.test(series))) continue;
      return { series: series ? titleCaseSeries(series) : null, volume };
    }
  }
  return { series: null, volume: null };
}

/**
 * Open Library exposes series as subject tags shaped like "series:Harry_Potter".
 * Returns a display-ready name, or null. Subjects never carry a volume number.
 */
export function seriesFromSubjects(subjects = []) {
  for (const subject of subjects) {
    const name = typeof subject === 'string' ? subject : subject?.name;
    if (!name) continue;
    const match = /^series:\s*(.+)$/i.exec(name);
    if (match) return titleCaseSeries(match[1]);
  }
  return null;
}

/**
 * Stable key for grouping. Case, punctuation and a leading "The" must not
 * create a second series ("The Wheel of Time" == "Wheel of Time").
 */
export function seriesKey(name) {
  if (!name) return null;
  return String(name)
    .toLowerCase()
    .replace(/^the\s+/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Given the volumes owned in one series, list the gaps up to the highest number
 * owned (and optionally beyond). Compressed into ranges so the UI can say
 * "missing 2, 5 and 13-17" instead of listing every number.
 */
export function missingVolumes(ownedVolumes, { upTo } = {}) {
  const owned = new Set(
    ownedVolumes.map(Number).filter((v) => Number.isFinite(v) && v > 0).map((v) => Math.trunc(v)),
  );
  if (owned.size === 0) return { missing: [], ranges: [], highestOwned: 0 };
  const highestOwned = Math.max(...owned);
  const limit = Math.max(highestOwned, Number(upTo) || 0);
  const missing = [];
  for (let v = 1; v <= limit; v += 1) if (!owned.has(v)) missing.push(v);
  return { missing, ranges: toRanges(missing), highestOwned };
}

/** [1,2,3,6,9,10] -> ["1-3", "6", "9-10"] */
export function toRanges(numbers) {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const ranges = [];
  let start = null;
  let prev = null;
  for (const n of sorted) {
    if (start === null) {
      start = n;
      prev = n;
      continue;
    }
    if (n === prev + 1) {
      prev = n;
      continue;
    }
    ranges.push(start === prev ? String(start) : `${start}-${prev}`);
    start = n;
    prev = n;
  }
  if (start !== null) ranges.push(start === prev ? String(start) : `${start}-${prev}`);
  return ranges;
}

/** Human sentence for the scan result: "missing 2, 5 and 13-17". */
export function describeMissing(ranges) {
  if (!ranges || ranges.length === 0) return '';
  if (ranges.length === 1) return `missing ${ranges[0]}`;
  return `missing ${ranges.slice(0, -1).join(', ')} and ${ranges[ranges.length - 1]}`;
}
