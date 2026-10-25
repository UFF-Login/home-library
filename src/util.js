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
