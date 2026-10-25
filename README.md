# Bookshelf

Self-hosted library catalogue. Scan a book's barcode with your phone, and the
app tells you whether you already own it — instantly, from your own database,
not from an internet lookup.

Built to run as one Docker container behind your own reverse proxy, reachable on
your phone over HTTPS.

---

## What it does

**Scan** — camera-based, continuous. Scan a shelf without tapping between books.

**Answer** — one of five verdicts, with the reason:

| Verdict | Meaning |
| --- | --- |
| `owned` | In your catalogue. Answered from SQLite in a few ms. |
| `wishlist` | You flagged it, you don't own it. |
| `missing` | Not yours. Metadata fetched so you can add it in one tap. |
| `unknown` | Not yours, and Open Library has no record. Manual entry offered. |
| `invalid` | The barcode is not a book ISBN (EAN not starting 978/979). |

**Series gaps** — scan volume 17 of a series you collect and it answers with what
else is missing: *"You have 12 of Goosebumps. You're missing 2, 5 and 13-17."*
That is computed from your own owned volumes, so it is honest about what it
knows, including after you correct a wrong series or volume by hand.

**Shelf** — cover grid, search across title/author/series/ISBN, owned vs wishlist.

**Book record** — reading state, your rating, where it physically is, who has it
on loan, notes, and a series/volume override.

**Backup** — the whole catalogue as a JSON download. The SQLite file on the
volume is the same data.

---

## Quick start (on the server)

You need Docker with the compose plugin, and an HTTPS hostname pointed at it.

```bash
mkdir -p ~/bookshelf && cd ~/bookshelf
curl -O https://raw.githubusercontent.com/<owner>/bookshelf/main/docker-compose.yml
# edit BOOKSHELF_PIN and the image name in docker-compose.yml
docker compose up -d
```

Then point your reverse proxy (Nginx Proxy Manager / Traefik) at
`http://<server-ip>:8080` and give it a certificate.

### HTTPS is not optional

Browsers only allow camera access in a *secure context*. Over plain `http://` the
scan page will load and then refuse to start the camera — on iPhone Safari it
fails silently behind a black rectangle. So:

- the hostname must be `https://`;
- if your proxy terminates TLS (NPM and Traefik both do), the container does not
  need its own certificate;
- the app reads `X-Forwarded-Proto` and marks its session cookie `Secure` when
  the request arrives over HTTPS.

### First run

- If `BOOKSHELF_PIN` is set, that is the PIN.
- If it is not set, the app generates a 6-digit PIN and prints it **once** in
  `docker compose logs`, then stores only its hash.

---

## Updating

```bash
docker compose pull && docker compose up -d
```

Images are published by GitHub Actions to GHCR for both `linux/amd64` and
`linux/arm64` on every push to `main`, tagged `latest` and `sha-<short>`.

If the package is private, the server needs one login:

```bash
echo <github-pat-with-read:packages> | docker login ghcr.io -u <github-user> --password-stdin
```

Simplest alternative: make the GHCR package public. The app itself is still PIN
protected; public only means the *image* is pullable.

---

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `BOOKSHELF_PIN` | generated | The login PIN. |
| `PORT` | `8080` | Listen port inside the container. |
| `DATA_DIR` | `/data` | SQLite database + cover cache. Mount a volume. |
| `TZ` | system | Only affects log timestamps. |

---

## Backups

Two options, both real:

1. `docker run --rm -v bookshelf_data:/data -v $PWD:/out alpine tar czf /out/bookshelf.tgz -C /data .`
2. In the app: **More → Download catalogue** (JSON, human readable).

Covers are re-fetchable; the database is the irreplaceable part.

---

## How it works

```
phone browser ──HTTPS──> reverse proxy ──> container :8080
                                              │
                                   ┌──────────┴──────────┐
                                   │  SQLite (node:sqlite)│  ← owned books, instant
                                   │  cover cache (disk)  │
                                   └──────────┬──────────┘
                                              │ only for books you don't own
                                     Open Library (keyless)
```

- **Node 22, zero runtime dependencies.** No framework, no bundler, no native
  module — the image is `node:22-alpine` plus the app's own files.
- **SQLite via `node:sqlite`**, which is built into Node 22. That is why nothing
  compiles at build time and why the same image runs on amd64 and arm64.
- **Scanner:** native `BarcodeDetector` on Android Chrome (fast, full-frame);
  bundled zxing as the fallback on iPhone Safari. Same ISBN is ignored for 2.5s
  so a steady hand does not double-fire.
- **Offline:** the phone keeps an ISBN → owned/wishlist index in localStorage, so
  a scan of a book you own is answered before any network call, and still
  answered with no signal at all.

### Known limits, stated plainly

- **Google Books is not used.** Without an API key it returns HTTP 429 with a
  hard daily quota of zero. Adding a free key later is possible; it is not wired
  in today.
- **Goodreads ratings do not exist as an API any more** (retired Dec 2020).
  Community ratings shown are Open Library's, fetched on add, and are sparse.
- **Series data is best-effort.** The series name and volume are parsed from the
  title/subtitle, with Open Library's `series:` subject as fallback. It is right
  for most numbered genre series and wrong sometimes — hence the manual
  series/volume field, which then drives the gap maths.
- **Covers** come from Open Library. When it has no cover for an ISBN (common for
  old paperbacks) you get a placeholder, not an error.

---

## Development

```bash
npm test                 # 23 tests, no network, no Docker
npm run dev              # watch mode on :8080
BOOKSHELF_PIN=1234 DATA_DIR=./data npm start
npm run icons            # regenerate PWA icons
npm run vendor           # re-copy zxing from node_modules
```

Tests cover ISBN validation, series parsing, author grouping, gap maths, and the
database round-trip (including that authors survive a write/read cycle).
