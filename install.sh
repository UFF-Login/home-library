#!/usr/bin/env sh
# One-shot install/update for the server. Run it from the folder that should
# hold the data: it writes docker-compose.yml there if it is missing.
#
#   curl -fsSL https://raw.githubusercontent.com/UFF-Login/bookshelf/main/install.sh | sh
#
# Nothing here needs Node, git, or a compiler - only Docker.
set -eu

IMAGE="${IMAGE:-ghcr.io/UFF-Login/bookshelf:latest}"
PIN="${BOOKSHELF_PIN:-}"
PORT="${PORT:-8080}"

command -v docker >/dev/null 2>&1 || { echo "Docker is not installed."; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "The docker compose plugin is missing."; exit 1; }

if [ ! -f docker-compose.yml ]; then
  echo "Writing docker-compose.yml (image: $IMAGE, port: $PORT)"
  cat > docker-compose.yml <<EOF
services:
  bookshelf:
    image: ${IMAGE}
    container_name: bookshelf
    restart: unless-stopped
    ports:
      - "${PORT}:8080"
    environment:
      BOOKSHELF_PIN: "${PIN}"
      TZ: Australia/Sydney
    volumes:
      - ./data:/data
    healthcheck:
      test: ["CMD", "wget", "-q", "-O-", "http://127.0.0.1:8080/healthz"]
      interval: 30s
      timeout: 5s
      retries: 3
    security_opt:
      - no-new-privileges:true
EOF
fi

mkdir -p data
docker compose pull
docker compose up -d

echo
echo "Waiting for the container to report healthy..."
i=0
while [ $i -lt 30 ]; do
  if docker compose ps --format json 2>/dev/null | grep -q '"Health":"healthy"'; then
    echo "Healthy. Open http://<server-ip>:${PORT} through your reverse proxy over HTTPS."
    exit 0
  fi
  i=$((i + 1))
  sleep 2
done

echo "Not healthy yet - check:  docker compose logs --tail=50"
exit 1
