#!/bin/sh
# Container entrypoint: make the data volume writable, then drop privileges.
#
# Why this exists: the app runs as uid 1000 ("node"), but a bind-mounted host
# folder (./data:/data) keeps the host's ownership - on a normal Linux server
# that is root:root 755, so SQLite cannot create its database and the container
# crash-loops with "unable to open database file". Making the operator chown a
# folder before first run is a step that is easy to miss and confusing when
# missed.
#
# So: start as root only long enough to hand /data to uid 1000, then exec the
# app as "node". If the container is already running unprivileged (compose
# `user:` override, Kubernetes securityContext), skip straight to exec and let
# the app print a clear explanation if the folder really is unwritable.
set -e

DATA_DIR="${DATA_DIR:-/data}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  # Only chown when needed - avoids touching a large cover cache on every start.
  if [ "$(stat -c %u "$DATA_DIR" 2>/dev/null || echo 0)" != "1000" ]; then
    chown -R node:node "$DATA_DIR" 2>/dev/null || true
  fi
  exec su-exec node "$@"
fi

exec "$@"
