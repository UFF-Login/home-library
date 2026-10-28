# Decisions taken without asking

Provisional calls made while building v0.1, each with the reason and what would
change it. Anything here can be overridden.

## 1. Open Library only; Google Books dropped

Google Books returns `429 RESOURCE_EXHAUSTED` with `quota_limit_value: 0` when
called without an API key — verified by direct request during the build. It is
not a rate limit that waiting fixes; keyless use is simply not permitted.

*Change if:* a free Google Cloud API key is supplied, or a Hardcover token is
added. Both are additive: the lookup layer merges sources, it does not assume
just one.

## 2. No Goodreads ratings

The Goodreads public API was retired in Dec 2020 and has no replacement. The
rating shown on a book is Open Library's community average, fetched once when the
book is added, and is missing for most books.

*Ask for:* if a Goodreads *export CSV* import would be useful (your own
read/rated shelf, not the world's ratings), that is a separate, cheap feature.

## 3. `node:sqlite` instead of `better-sqlite3`

`better-sqlite3` publishes prebuilt binaries per Node ABI version, and none
existed for the Node 22.23 runtime on this machine — installation failed and the
server would not start. Building from source would have required a compiler in
the image and on any arm64 NAS.

`node:sqlite` is built into Node 22: zero runtime dependencies, no compile step,
identical image on amd64 and arm64. It is flagged experimental in Node 22, which
is why the base image is pinned and the specific warning is suppressed with
`--disable-warning=ExperimentalWarning`.

*Change if:* Node's SQLite API changes under us (pin the major) or a feature is
needed that it lacks (it has none of better-sqlite3's extensions).

## 4. Wishlist is a state on the book, not a separate table

Makes the shop flow one write: scan → `wishlist` → bought → flip to `owned`,
keeping the same §work row and the same series position.

## 5. Author deduplication by surname + first initial

`R.L. Stine`, `R. L. Stine`, `Robert Lawrence Stine` and `Stine, R. L.` all become
`stine:r`. Consequence: two genuinely different authors sharing a surname and
first initial would merge (not observed in practice at this scale). The display
name is the longest spelling seen.

## 6. Series gaps are computed only up to the highest volume owned

"No gaps" means "nothing missing below the highest number you own", not "you own
the complete series" — the app has no reliable total-volume count to compare
against. The UI says this in words rather than implying completeness.

## 7. Sessions are HMAC-signed cookies, not a session table

Survives container restarts without a database write per login. Revoking all
sessions means changing `session_secret` in the `meta` table (or re-creating the
volume), which is acceptable for a single-user app.

## 8. Reverse proxy terminates TLS

The container speaks plain HTTP on 8080 and trusts `X-Forwarded-Proto` for the
cookie `Secure` flag. This matches the existing Nginx Proxy Manager / Traefik
setup on the server.

## 9. Accounts are username + password with scrypt, not a shared PIN

A 6-digit PIN is 10^6 guesses; with no per-account identity it also cannot be
attributed, cannot be changed per person, and cannot be revoked for one device.

- Passwords are hashed with scrypt (N=16384, r=8, p=1) and a 16-byte random salt
  per user, stored as `scrypt$N$r$p$salt$hash` so the parameters travel with the
  hash and can be raised later without invalidating old passwords.
- A login for an unknown username runs the same scrypt work as a wrong password
  (against a dummy hash) and reports the same reason, so response time and text
  cannot be used to enumerate usernames.
- The session cookie is `userId.expiry.HMAC`, signed with a secret in `meta`.
  Rotating that secret (what "change password" does) signs every device out at
  once - the one thing a PIN-only scheme could not do.

*Change if:* multi-user support is wanted (the `users` table already allows it;
only the UI and per-user data scoping are missing).

## 10. The first account is claimed with a one-time setup code

The app is reachable through a tunnel, so "first visitor becomes admin" would hand
the library to whoever loads the page first. While the `users` table is empty the
server prints a 6-character code in its log and `/api/setup` refuses without it;
the code is deleted once the account exists, and setup is refused entirely after
that.

Setting `BOOKSHELF_USERNAME`/`BOOKSHELF_PASSWORD` skips the code: the operator
already has shell access to the server, which is stronger proof than a code.

*Change if:* a second account is needed (then invite codes, not this path).

## 11. Hand edits are a plain overwrite; enrichment still only fills blanks

`updateWork()` writes exactly the columns a person typed, including
`author_key`/`series_key`, which are recomputed so grouping and gap maths follow
the correction immediately. `saveBook()` (the enrichment and re-add path) still
only fills empty columns, so a later metadata refresh cannot undo an edit.

Editable columns are a whitelist in `db.js`; the key is used as a column name in
the UPDATE, so anything outside the list never reaches the SQL.

## 12. Uploaded covers are re-encoded in the browser, sniffed on the server

The chosen file is drawn to a canvas (longest edge 1200px, white background) and
sent as a base64 JPEG. This keeps the zero-dependency promise: no image library,
no multipart parser, and a 12MB phone photo arrives as ~150KB.

The server does not trust that claim - `sniff()` reads the magic bytes and stores
the file with a content type derived from the bytes, so a PNG or WebP uploaded by
another client is served as what it actually is. Uploads land at the same path the
cover route already serves, and the cover epoch is bumped so year-long phone
caches fetch the new picture.

*Change if:* a real image pipeline is ever needed (thumbnails, EXIF rotation).

## 13. One fluid layout, capped tracks, no page-width ceiling

The desktop layout used to stop at 1500px of content, which on a 3440px monitor
left a third of the screen empty. There is now no ceiling: the shelf fills the
window, and the *tracks* carry the limit instead (`minmax(176px, 232px)`), so
covers stay a consistent size whether there are 6 books or 600. Controls that
gain nothing from width - the search field, a scan result - keep a readable
measure rather than stretching.

Breakpoints: <700px phone (bottom tabs, 620px column), 700-999px tablet (900px
column, bottom tabs, dialog sheets), >=1000px left rail replaces the tab bar and
content uses the full width, >=1600px larger covers and a gutter that grows with
the window.

*Change if:* a dashboard-style multi-pane view is wanted; that is a different
layout, not a wider one.

## 14. `.env` is read by the server too, not only by Compose

Compose applies `.env` itself; `node src/server.js` does not. The difference was
invisible until someone put their login in `.env`, ran the app with node, and got
"wrong username or password" on a correct password.

The server now loads `./.env` (and `$DATA_DIR/.env`, which is the mounted volume
in a container) before it looks at any setting. A real environment variable still
wins, and the parser reports which keys were skipped - the answer to "why is my
`.env` being ignored?". Only the Compose subset is supported: comments, `KEY=value`,
optional quotes, optional `export`.
