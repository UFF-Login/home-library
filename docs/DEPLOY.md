# Deploying on the home server

Everything here happens on the server. Nothing is built there — the image comes
from GitHub.

---

## 1. Pick a home for the data

The `data` folder sits next to the compose file and holds the whole catalogue:

```bash
mkdir -p ~/docker/home-library && cd ~/docker/home-library
```

## 2. Get `docker-compose.yml`

Download the shipped file rather than retyping it — it is the one CI builds
against:

```bash
curl -fsSL -o docker-compose.yml \
  https://raw.githubusercontent.com/UFF-Login/home-library/main/docker-compose.yml
```

Then open it and set your PIN, either by editing `BOOKSHELF_PIN` or by exporting
it before `up`:

```bash
export BOOKSHELF_PIN=482913     # or edit the file
```

Leave it empty and the app generates a PIN and prints it once:
`docker compose logs | grep -i pin`.

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
your server, behind the PIN.

## 4. Start

```bash
docker compose up -d
docker compose ps          # wait for (healthy)
docker compose logs --tail=20
```

If `BOOKSHELF_PIN` is unset, the log prints a generated PIN once.

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
2. PIN in. Scan tab should ask for camera permission.
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
| Camera never starts, black video | page served over `http://` | use `https://`, check the padlock |
| `502 Bad Gateway` in NPM | wrong forward port/host | port `8080`, host = reachable IP |
| Container `unhealthy` | healthcheck cannot reach the app | `docker compose logs`; check `PORT` is still 8080 inside |
| `denied` on pull | private package, no login | step 3 |
| Forgot the PIN | PIN hash is in the DB | set `BOOKSHELF_PIN` in compose, `docker compose up -d` |
| Book found twice | different ISBNs for the same book (different editions) | that is real; each ISBN is a separate edition. Delete the duplicate. |
