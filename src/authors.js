// Author normalisation.
//
// The same human appears as "R.L. Stine", "R. L. Stine" and "Robert Lawrence
// Stine" across editions. Grouping on the literal string splits one author into
// three, which would wreck the author view of the shelf. So every author gets a
// stable key of surname + first initial, and the display name is whichever
// spelling the catalogue has seen most often.

/** Surname plus first initial: "Robert Lawrence Stine" -> "stine:r". */
export function authorKey(name) {
  const raw = String(name ?? '')
    .toLowerCase()
    // Fold accents to their base letters first: stripping "ž" and "ć" outright
    // turned "Jasmin Hodžić" into surname "i", which silently mis-grouped every
    // author whose name is not plain ASCII.
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\(.*?\)/g, ' ') // drop "(Editor)" style qualifiers
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw) return null;

  // "Stine, R. L." is surname-first. The comma must be read before any
  // punctuation stripping, because stripping it loses the ordering information.
  const comma = raw.indexOf(',');
  if (comma > 0) {
    const surname = raw.slice(0, comma).replace(/[^a-z'\- ]/g, '').trim();
    const given = raw.slice(comma + 1).replace(/[^a-z]/g, '');
    if (surname && given) return `${surname}:${given[0]}`;
  }

  const parts = raw.replace(/[^a-z'\- ]/g, ' ').split(' ').filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0]; // mononym, e.g. "Homer"
  return `${parts[parts.length - 1]}:${parts[0][0]}`;
}

/**
 * Pick the display spelling for a set of variants: prefer the longest form
 * ("Robert Lawrence Stine"), because it is the most complete, then the most
 * frequently seen.
 */
export function preferredName(variants = []) {
  const counts = new Map();
  for (const v of variants) {
    const name = String(v ?? '').trim();
    if (!name) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0][0];
}
