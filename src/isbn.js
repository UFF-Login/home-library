// ISBN handling. Barcodes on books are EAN-13 starting 978 or 979.
// Everything in the database is stored as ISBN-13 because that is what the
// barcode actually contains and it removes the "isbn10 vs isbn13" ambiguity
// at the single point where data enters the system.

/**
 * Strip every non-alphanumeric character. Barcode scanners give clean digits,
 * but hand-typed and OCR'd ISBNs arrive with hyphens and spaces.
 */
export function compact(raw) {
  return String(raw ?? '').toUpperCase().replace(/[^0-9X]/g, '');
}

/** ISBN-10 check digit: sum(digit * (10 - index)) % 11 === 0, X counts as 10. */
export function isValidIsbn10(value) {
  const s = compact(value);
  if (s.length !== 10) return false;
  let sum = 0;
  for (let i = 0; i < 10; i += 1) {
    const ch = s[i];
    const digit = ch === 'X' ? 10 : Number(ch);
    if (Number.isNaN(digit)) return false;
    if (ch === 'X' && i !== 9) return false; // X is only legal as the check digit
    sum += digit * (10 - i);
  }
  return sum % 11 === 0;
}

/** EAN-13 check digit: weights alternate 1,3 across the first 12 digits. */
export function isValidIsbn13(value) {
  const s = compact(value);
  if (s.length !== 13) return false;
  let sum = 0;
  for (let i = 0; i < 12; i += 1) {
    const digit = Number(s[i]);
    if (Number.isNaN(digit)) return false;
    sum += digit * (i % 2 === 0 ? 1 : 3);
  }
  const check = (10 - (sum % 10)) % 10;
  return check === Number(s[12]);
}

/** ISBN-10 -> ISBN-13 by prefixing 978 and recomputing the check digit. */
export function isbn10To13(value) {
  const s = compact(value);
  if (!isValidIsbn10(s)) return null;
  const body = `978${s.slice(0, 9)}`;
  let sum = 0;
  for (let i = 0; i < 12; i += 1) sum += Number(body[i]) * (i % 2 === 0 ? 1 : 3);
  const check = (10 - (sum % 10)) % 10;
  return `${body}${check}`;
}

/**
 * Normalise any ISBN-ish input to a canonical { isbn13, isbn10 } pair.
 * Returns null for anything that is not a valid book barcode, so the caller
 * never has to guess whether a scan was a book at all.
 */
export function normaliseIsbn(raw) {
  const s = compact(raw);
  if (!s) return null;

  if (s.length === 13) {
    if (!isValidIsbn13(s)) return null;
    // Only 978/979 are Bookland prefixes - anything else is another product type.
    if (!s.startsWith('978') && !s.startsWith('979')) return null;
    return { isbn13: s, isbn10: isbn13To10(s) };
  }

  if (s.length === 10) {
    const isbn13 = isbn10To13(s);
    if (!isbn13) return null;
    return { isbn13, isbn10: s };
  }

  return null;
}

/** ISBN-13 -> ISBN-10, only possible for 978-prefixed (not 979) codes. */
export function isbn13To10(value) {
  const s = compact(value);
  if (!s.startsWith('978') || !isValidIsbn13(s)) return null;
  const body = s.slice(3, 12);
  let sum = 0;
  for (let i = 0; i < 9; i += 1) sum += Number(body[i]) * (10 - i);
  const check = (11 - (sum % 11)) % 11;
  return `${body}${check === 10 ? 'X' : check}`;
}
