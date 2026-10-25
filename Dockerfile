# One stage, no dependencies to install, no native build.
# The app uses node:sqlite (built into Node 22), so there is nothing to compile
# and the image works the same on amd64 and arm64 - which is what makes it safe
# to pull onto an unknown NAS.
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data

# APP_VERSION is the human version shown in the UI (v1.0, v1.3, v2.0) and comes
# from package.json. APP_BUILD is the exact artifact (the commit SHA) used to
# stamp asset URLs, so every deploy gets fresh ones even without a version bump.
ARG APP_VERSION=
ARG APP_BUILD=dev
ENV APP_VERSION=${APP_VERSION} \
    APP_BUILD=${APP_BUILD}

WORKDIR /app

# Only these three paths are the app. Everything else in the repo (tests, CI,
# tools) stays out of the runtime image.
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public

# su-exec lets the entrypoint drop from root to uid 1000 after fixing /data.
RUN apk add --no-cache su-exec \
 && mkdir -p /data \
 && chown node:node /data

# A bind-mounted ./data keeps the HOST's ownership (usually root:root 755), which
# uid 1000 cannot write - that is the "unable to open database file" crash loop.
# The entrypoint runs as root only long enough to chown /data, then execs as node.
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# Normalise line endings: a CRLF shebang copied from a Windows checkout would
# fail to execute at all.
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh \
 && chmod +x /usr/local/bin/docker-entrypoint.sh

# The SQLite database and cached covers live here; mount a volume on /data or
# the catalogue is lost with the container.
VOLUME ["/data"]
EXPOSE 8080

# node:sqlite prints an ExperimentalWarning on Node 22. Disable precisely that
# warning so real warnings still show in the log.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O- http://127.0.0.1:8080/healthz || exit 1

# Deliberately no USER directive: the entrypoint needs root to hand /data to
# uid 1000, and drops to "node" itself. Set `user:` in compose to skip that.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
