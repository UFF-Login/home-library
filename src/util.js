export const nowIso = () => new Date().toISOString();

/** Fetch JSON with a hard timeout so a slow API can never hang a phone scan. */
export async function fetchJson(url, { timeoutMs = 8000, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'bookshelf/0.1 (self-hosted library catalogue)', ...headers },
    });
    if (!res.ok) return { ok: false, status: res.status, data: null };
    return { ok: true, status: res.status, data: await res.json() };
  } catch (error) {
    return { ok: false, status: 0, data: null, error: String(error?.message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}

/** Decode the handful of entities that actually appear in book blurbs. */
function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–')
    .replace(/&hellip;/gi, '…')
    .replace(/&amp;/gi, '&'); // last: "&amp;lt;" should end up as "&lt;", not "<"
}

/**
 * Turn provider markup into plain text.
 *
 * Google and Open Library blurbs arrive as HTML fragments - "<p>...</p><br>" - and
 * the app escapes everything it renders, so the tags appeared on screen verbatim.
 * Block-level breaks become blank lines so the paragraph structure survives, which
 * the stylesheet then shows with white-space: pre-line.
 */
export function stripHtml(value) {
  if (value == null) return null;
  let text = String(value);

  // A line break is one newline; the end of a block is a paragraph break.
  text = text.replace(/<\s*br\s*\/?\s*>/gi, '\n');
  text = text.replace(/<\s*(?:\/p|\/div|\/li|\/h[1-6])\s*>/gi, '\n\n');
  text = text.replace(/<[^>]*>/g, '');
  text = decodeEntities(text);

  return (
    text
      .replace(/\r\n?/g, '\n')
      // trailing spaces before a newline, then squeeze runs of blank lines
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim() || null
  );
}
