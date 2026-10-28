# Home Library

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
curl -O https://raw.githubusercontent.com/UFF-Login/home-library/main/docker-compose.yml
docker compose up -d
# then open the app and create your account (see First run below)
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

The app is guarded by a username and password - there is no anonymous access and
no shared PIN.

- **With `BOOKSHELF_USERNAME` and `BOOKSHELF_PASSWORD` set** in `.env`: the
  account is created on first start, and the password follows the file on every
  restart. That is also the recovery path when a password is forgotten.
- **With both unset**: the log prints a one-time setup code
  (`docker compose logs | grep -i "setup code"`). Open the app, enter the code,
  and choose a username and password. The code is only accepted while no account
  exists, and only once - so a stranger who finds the URL before you cannot claim
  the library.

Passwords are stored as scrypt hashes with a per-user salt; the session cookie is
a signed stamp of user id + expiry. Changing the password in the app signs every
other device out.

---

## Updating

```bash
docker compose pull && docker compose up -d
```

Images are published by GitHub Actions to GHCR for both `linux/amd64` and
`linux/arm64` on every push to `main`, tagged `latest` and `sha-<short>`.

The GHCR package is **public**, so the server needs no login and no token:

```bash
docker pull ghcr.io/uff-login/home-library:latest    # works anonymously
```

Public means the *image* is pullable. The catalogue itself never leaves the
server: it lives in `./data` behind the login. If the package is ever made private
again, the server needs `docker login ghcr.io -u UFF-Login --password-stdin`
with a token that has `read:packages`.

---

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `BOOKSHELF_USERNAME` | none | Account name. Set with the password to create the account from the server. |
| `BOOKSHELF_PASSWORD` | none | Password for that account (4+ characters; 8+ recommended). Applied on every start, so it wins over an in-app change. |
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
- **Covers** come from Open Library only, in three steps: the work's own cover,
  then the exact ISBN's art, then any other edition of the same work. The ISBN is
  verified against the record's own ISBN list first, because the search endpoint
  is fuzzy. Books with no art anywhere show a placeholder — deliberately, because
  Google Books' and Amazon's image endpoints answer every ISBN with a "no image"
  graphic that measures within three pixels of a real cover (128x183 vs 128x186),
  so using them means confidently wrong pictures. Amazon is available behind
  `COVER_AMAZON=1` if you accept that trade.
- A cover that could not be fetched because the network failed is **not**
  remembered as "no cover" — only a definitive answer is cached, and those caches
  expire monthly. **More → Reload missing covers** retries everything on demand.

---

## Development

```bash
npm test                 # 79 tests, no network, no Docker
npm run dev              # watch mode on :8080
DATA_DIR=./data npm start   # login read from ./.env, exactly like Compose
npm run icons            # regenerate PWA icons
npm run vendor           # re-copy zxing from node_modules
```

Tests cover ISBN validation, series parsing, author grouping, gap maths, the
database round-trip (including that authors survive a write/read cycle), password
hashing and session signing, hand-edited fields surviving a metadata refresh, and
cover-upload validation.
