# One stage, no dependencies to install, no native build.
# The app uses node:sqlite (built into Node 22), so there is nothing to compile
# and the image works the same on amd64 and arm64 - which is what makes it safe
# to pull onto an unknown NAS.
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data

WORKDIR /app

# Only these three paths are the app. Everything else in the repo (tests, CI,
# tools) stays out of the runtime image.
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public

# The SQLite database and cached covers live here; mount a volume on /data or
# the catalogue is lost with the container.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

USER node
EXPOSE 8080

# node:sqlite prints an ExperimentalWarning on Node 22. Disable precisely that
# warning so real warnings still show in the log.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O- http://127.0.0.1:8080/healthz || exit 1

CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
