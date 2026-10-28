# Deploying on the home server

Everything here happens on the server. Nothing is built there — the image comes
from GitHub.

---

## 1. Pick a home for the data

The `data` folder sits next to the compose file and holds the whole catalogue:

```bash
mkdir -p ~/docker/home-library && cd ~/docker/home-library
```

## 2. Get the two files

Download the shipped compose file rather than retyping it — it is the one CI
builds against — then create the `.env` file that holds your login:

```bash
curl -fsSL -O https://raw.githubusercontent.com/UFF-Login/home-library/main/docker-compose.yml
curl -fsSL -o .env.example https://raw.githubusercontent.com/UFF-Login/home-library/main/.env.example
cp .env.example .env
```

Edit `.env` and set the account the app should create:

```
BOOKSHELF_USERNAME=admin
BOOKSHELF_PASSWORD=a long password you will remember
```

Both unset is also valid: the log then prints a one-time setup code and the
account is created in the browser instead.

Two files, two jobs:

| File | Committed to git? | Holds |
| --- | --- | --- |
| `docker-compose.yml` | yes | image, port, volume, healthcheck |
| `.env` | **never** | your login |

Why split: the compose file is public on GitHub. Docker Compose reads `.env`
automatically from the folder it runs in, so the secret never needs to be typed
into a file that gets published.

If `.env` is missing entirely, the app prints a one-time setup code on first
start: `docker compose logs | grep -i "setup code"`. Enter it in the browser and
choose a username and password.

The service, container and data folder are all named `home-library`, the port is
`8080`, and the catalogue lives in `./data`.

## 3. Pull credentials: none needed

The GHCR package `ghcr.io/UFF-Login/home-library` is **public**, so `docker compose
pull` works with no login and no token on the server.

Only if it is ever switched back to private: create a token with
`read:packages`, then once on the server:

```bash
echo <TOKEN> | docker login ghcr.io -u UFF-Login --password-stdin
```

A public *image* does not expose your catalogue — that lives only in `./data` on
your server, behind the login.

## 4. Start

```bash
docker compose up -d
docker compose ps          # wait for (healthy)
docker compose logs --tail=20
```

If `BOOKSHELF_USERNAME`/`BOOKSHELF_PASSWORD` are unset, the log prints a one-time setup code.

---

## 5. Reverse proxy

### Nginx Proxy Manager

Add a **Proxy Host**:

| Field | Value |
| --- | --- |
| Domain Names | `books.yourdomain.com` |
| Scheme | `http` |
| Forward Hostname / IP | the server's LAN IP (or the container name if NPM is in the same compose network) |
| Forward Port | `8080` |
| Block Common Exploits | on |
| Websockets Support | not required, harmless |

Then in the **SSL** tab: *Request a new SSL certificate*, **Force SSL** on,
HTTP/2 on, and agree to the Let's Encrypt terms. This is what makes the phone
camera work — browsers refuse camera access on plain `http://`.

### Traefik

```yaml
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.books.rule=Host(`books.yourdomain.com`)"
      - "traefik.http.routers.books.tls.certresolver=letsencrypt"
      - "traefik.http.services.books.loadbalancer.server.port=8080"
```

Traefik passes `X-Forwarded-Proto`, which the app uses to mark the session
cookie `Secure`. Remove the `ports:` block if Traefik shares the network.

---

## 6. Check it from the phone

1. Open `https://books.yourdomain.com` — the padlock must be there.
2. Signed in. Scan tab should ask for camera permission.
3. If the camera area stays black: it is almost always **not HTTPS**, or the
   browser was opened over a cached `http://` URL. Check the padlock first.

---

## 7. Updating

```bash
cd ~/docker/home-library
docker compose pull && docker compose up -d
```

Data is untouched — it lives in `./data`, outside the container. The service
worker is network-first, so a refresh picks up the new version immediately.

## 8. Backup

```bash
docker run --rm -v "$PWD/data:/data" -v "$PWD:/out" alpine tar czf /out/home-library-$(date +%F).tgz -C /data .
```

Also: the app's **More → Download catalogue** button gives the same data as JSON.

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Error: unable to open database file` in a restart loop | the mounted `./data` belongs to root, and the app runs as uid 1000 | current images fix this themselves; if not, `sudo chown -R 1000:1000 ./data` then `docker compose up -d` |
| Camera never starts, black video | page served over `http://` | use `https://`, check the padlock |
| `502 Bad Gateway` in NPM | wrong forward port/host | forward to the **host** port you published (8050, say) — not 8080 |
| Container `unhealthy` | healthcheck cannot reach the app | `docker compose logs`; the healthcheck uses port 8080 *inside* the container, so a changed host port needs no change here |
| `denied` on pull | package is private again | make it public, or `docker login ghcr.io` |
| Forgot the password | scrypt hash is in the DB | set `BOOKSHELF_USERNAME`/`BOOKSHELF_PASSWORD` in `.env`, `docker compose up -d` |
| Book found twice | different ISBNs for the same book (different editions) | that is real; each ISBN is a separate edition. Delete the duplicate. |

### Changing the host port

Only the left-hand side of the mapping changes — the container always listens on
8080 internally:

```yaml
    ports:
      - "8050:8080"     # host 8050 -> container 8080
```

Point the reverse proxy at **8050**. Do not change `PORT`; the healthcheck
depends on 8080 inside the container.

### Why the data folder caused that error

`./data:/data` is a bind mount, so it keeps the *host's* owner — normally
`root:root 755`. The app runs as uid 1000 and cannot create a file there, so
SQLite reports `unable to open database file` and the container restarts in a
loop. The image now fixes the ownership itself at startup (as root, then
immediately drops to uid 1000 before running the app). If you run the container
unprivileged via compose `user:`, that fix cannot happen and the app prints the
exact `chown` command to run instead.
