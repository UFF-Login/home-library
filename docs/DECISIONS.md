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
