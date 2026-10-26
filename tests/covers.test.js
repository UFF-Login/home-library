// Covers: what counts as "this book has no cover".
//
// The expensive mistake this guards against: a host that throttles answers 200
// with an EMPTY body. Treating that as a definitive miss writes a 30-day marker,
// so the book stays coverless for a month after a single bad moment. A real
// placeholder is different - that is a legitimate "no art here".
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureCover } from '../src/covers.js';

/** Serve one canned image response on a random port, then shut it down. */
async function withImageServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const dir = mkdtempSync(join(tmpdir(), 'cover-'));
  try {
    return await run(`http://127.0.0.1:${port}/img.jpg`, dir);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
}

const isbn = '9798167284630';
const marker = (dir) => existsSync(join(dir, 'covers', `${isbn}.none`));

test('an empty 200 body is a throttle, not "no cover" - no marker written', async () => {
  await withImageServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      res.end(Buffer.alloc(0));
    },
    async (url, dir) => {
      const file = await ensureCover(dir, { isbn13: isbn, coverUrl: url });
      assert.equal(file, null);
      assert.equal(marker(dir), false, 'a throttle must never be cached as a miss');
    },
  );
});

test('a real image is stored, and clears any previous marker', async () => {
  await withImageServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      res.end(Buffer.alloc(40000, 7));
    },
    async (url, dir) => {
      const file = await ensureCover(dir, { isbn13: isbn, coverUrl: url });
      assert.ok(file, 'cover should be written');
      assert.equal(marker(dir), false);
    },
  );
});

test('a tiny placeholder is a definitive miss', async () => {
  await withImageServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      res.end(Buffer.alloc(900, 1));
    },
    async (url, dir) => {
      const file = await ensureCover(dir, { isbn13: isbn, coverUrl: url });
      assert.equal(file, null);
      assert.equal(marker(dir), true, 'small but non-empty means this book has no art');
    },
  );
});

test('an HTML error page is a definitive miss', async () => {
  await withImageServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>not an image</html>');
    },
    async (url, dir) => {
      await ensureCover(dir, { isbn13: isbn, coverUrl: url });
      assert.equal(marker(dir), true);
    },
  );
});
