# syntax=docker/dockerfile:1
# The web (SvelteKit SSR and BFF, adapter-node), with the client packs'
# static files (README, "Deploy"). Build context: the repository root.
#
#   docker build -f apps/web/Dockerfile --build-arg MEDIA_PUBLIC_ORIGIN=https://<bucket origin> -t sortea-web .
#   start: node build
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
# Origin of the bucket's presigned URLs, written into the CSP at build time
# (ADR 0009). Not a secret; Railway passes the service variable of the same name.
ARG MEDIA_PUBLIC_ORIGIN
COPY . .
RUN pnpm install --offline --frozen-lockfile
RUN MEDIA_PUBLIC_ORIGIN="${MEDIA_PUBLIC_ORIGIN}" pnpm --filter @sortea/web build

# A directory of its own: `pnpm fetch` filled /app/node_modules with every package, dev ones included.
FROM pnpm AS prod-deps
WORKDIR /prod
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/db/package.json packages/db/
COPY packages/domain/package.json packages/domain/
# Production dependencies of the web only: what the server build still imports.
RUN pnpm install --offline --frozen-lockfile --prod --ignore-scripts --filter @sortea/web

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps /prod ./
COPY --from=build /app/apps/web/build ./apps/web/build
USER node
WORKDIR /app/apps/web
EXPOSE 3000
CMD ["node", "build"]
