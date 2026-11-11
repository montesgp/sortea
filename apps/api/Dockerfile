# syntax=docker/dockerfile:1
# The API (Fastify), compiled to JavaScript, with the operator commands and the
# PostgreSQL 18 client for backups (README, "Deploy"). Build context: the
# repository root.
#
#   docker build -f apps/api/Dockerfile -t sortea-api .
#   start: node dist/main.js    pre-deploy: node dist/predeploy.js
#
# Node 22 on Debian 13, pinned by digest; bump it on purpose.
ARG NODE_IMAGE=node:22.23.4-trixie-slim@sha256:be1e2a3dc2c4fd68cdfadad2a696a280e0d2749098bee509230174d72fb768c6

FROM ${NODE_IMAGE} AS pnpm
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=true
# pnpm at the version of package.json's packageManager.
RUN corepack enable pnpm
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Downloads every package of the lockfile once; the installs below are offline.
RUN pnpm fetch --frozen-lockfile

FROM pnpm AS build
COPY . .
RUN pnpm install --offline --frozen-lockfile
RUN pnpm --filter @sortea/api build

# A directory of its own: `pnpm fetch` filled /app/node_modules with every package, dev ones included.
FROM pnpm AS prod-deps
WORKDIR /prod
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/db/package.json packages/db/
COPY packages/domain/package.json packages/domain/
# Production dependencies of the API only: the bundle imports nothing else (scripts/bundle.mjs).
RUN pnpm install --offline --frozen-lockfile --prod --ignore-scripts --filter @sortea/api

FROM ${NODE_IMAGE} AS runtime
# pg_dump and pg_restore 17 from the PostgreSQL project's repository, whose key Debian's postgresql-common ships.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates postgresql-common \
	&& echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt trixie-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
	&& apt-get update \
	&& apt-get install -y --no-install-recommends postgresql-client-18 \
	&& rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
	PG_BIN_DIR=/usr/lib/postgresql/18/bin \
	GEONAMES_CACHE_DIR=/tmp/geonames
WORKDIR /app
COPY --from=prod-deps /prod ./
COPY --from=build /app/apps/api/dist ./apps/api/dist
USER node
WORKDIR /app/apps/api
EXPOSE 3001
CMD ["node", "dist/main.js"]
