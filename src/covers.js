// Cover images, cached on disk.
//
// Open Library answers 200 with a zero-byte body when it has no cover, so a
// cover must be validated by size, not status code. A miss is recorded as a
// `.none` marker so a missing cover is never re-fetched on every page view.
import { existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MIN_COVER_BYTES = 1500;

export function coverFile(dataDir, isbn13) {
  return join(dataDir, 'covers', `${isbn13}.jpg`);
}

function missFile(dataDir, isbn13) {
  return join(dataDir, 'covers', `${isbn13}.none`);
}

async function download(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length >= MIN_COVER_BYTES ? buf : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Return a local path to the cover for this ISBN, fetching it once if needed.
 * Returns null when there is genuinely no cover - callers show a placeholder.
 */
export async function ensureCover(dataDir, { isbn13, coverId }, { timeoutMs = 8000 } = {}) {
  mkdirSync(join(dataDir, 'covers'), { recursive: true });
  const file = coverFile(dataDir, isbn13);
  if (existsSync(file) && statSync(file).size >= MIN_COVER_BYTES) return file;
  if (existsSync(missFile(dataDir, isbn13))) return null;

  // ISBN-specific art is the most faithful to the copy in your hand; the work
  // cover id is the fallback when the edition has no artwork of its own.
  const candidates = [`https://covers.openlibrary.org/b/isbn/${isbn13}-L.jpg`];
  if (coverId) candidates.push(`https://covers.openlibrary.org/b/id/${coverId}-L.jpg`);

  for (const url of candidates) {
    const buf = await download(url, timeoutMs);
    if (buf) {
      writeFileSync(file, buf);
      return file;
    }
  }

  writeFileSync(missFile(dataDir, isbn13), new Date().toISOString());
  return null;
}
