// A cover the person chose, instead of one fetched from a catalogue.
//
// The browser is asked to hand over a JPEG (it re-encodes the file in a canvas,
// which also caps the size and flattens transparency), but the server does not
// take that on trust: the bytes themselves are sniffed, so whatever arrives is
// stored under a name and served with a type that match its real contents. A
// file that is not an image is refused before anything touches the disk.
import { writeFileSync, renameSync, rmSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { coverFile, clearCoverMiss } from './covers.js';

const MAX_BYTES = 5 * 1024 * 1024;
const MIN_BYTES = 1024; // smaller than any real cover; almost certainly a blank canvas

/**
 * Read a `data:` URL or bare base64 string.
 * Returns { bytes, mime } or { error }.
 */
export function decodeCoverImage(input) {
  const text = String(input ?? '').trim();
  if (!text) return { error: 'empty' };

  let base64 = text;
  const dataUrl = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,(.*)$/is.exec(text);
  if (dataUrl) {
    if (!dataUrl[1].toLowerCase().startsWith('image/')) return { error: 'not_an_image' };
    base64 = dataUrl[2];
  }
  // Anything that is not base64 is a client bug, not a server problem - say so
  // instead of writing a corrupt file that every later request has to decode.
  if (!/^[A-Za-z0-9+/=\s]+$/.test(base64)) return { error: 'not_base64' };

  let bytes;
  try {
    bytes = Buffer.from(base64.replace(/\s+/g, ''), 'base64');
  } catch {
    return { error: 'not_base64' };
  }
  if (!bytes.length) return { error: 'empty' };
  if (bytes.length > MAX_BYTES) return { error: 'too_large' };
  if (bytes.length < MIN_BYTES) return { error: 'too_small' };

  const mime = sniff(bytes);
  if (!mime) return { error: 'not_an_image' };
  return { bytes, mime };
}

/** What the bytes really are - the client's content-type claim is not evidence. */
export function sniff(bytes) {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a
  ) {
    return 'image/png';
  }
  if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

/**
 * Store an uploaded cover where the cover route already looks.
 *
 * Written to a temporary name and renamed: writeFileSync truncates first, and a
 * phone asking for the cover mid-write would receive a partial image.
 */
export function saveCoverBytes(dataDir, isbn13, bytes) {
  const target = coverFile(dataDir, isbn13);
  // The covers folder only exists once something has been fetched; an upload on
  // a brand new library must not depend on that having happened first.
  mkdirSync(dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.upload.tmp`;
  writeFileSync(temp, bytes);
  renameSync(temp, target);
  // An old "this book has no cover" marker would keep a later refetch away, and
  // it is now wrong by definition.
  clearCoverMiss(dataDir, isbn13);
  return target;
}

export function removeCover(dataDir, isbn13) {
  rmSync(coverFile(dataDir, isbn13), { force: true });
  clearCoverMiss(dataDir, isbn13);
}
