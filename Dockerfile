# Node 24+ includes SQLite (node:sqlite), so there are no native add-ons to compile.
ARG NODE_IMAGE=node:24-alpine

# ---- dependencies (pure JavaScript) ----
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# ---- runtime ----
FROM ${NODE_IMAGE}
ARG GIT_COMMIT=unknown
ARG BUILD_DATE=unknown
ENV GIT_COMMIT=$GIT_COMMIT \
    BUILD_DATE=$BUILD_DATE \
    NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    HTTPS_PORT=3443 \
    DB_PATH=/app/data/checkin.db
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json LICENSE NOTICE ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts

# The database, its WAL files, the generated app secret and any HTTPS certificate live in /app/data.
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
LABEL org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.authors="Chris Tracy"
VOLUME ["/app/data"]
EXPOSE 3000 3443

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
