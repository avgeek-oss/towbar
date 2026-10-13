# syntax=docker/dockerfile:1.7
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS base

FROM base AS pruner
ARG TURBO_VERSION=2.11.7
WORKDIR /repo
RUN npm install --global turbo@${TURBO_VERSION}
COPY . .
RUN turbo prune towbar-api --docker

FROM base AS installer
WORKDIR /repo
RUN corepack enable pnpm
COPY --from=pruner /repo/out/json/ ./
COPY --from=pruner /repo/.npmrc ./.npmrc
RUN --mount=type=cache,id=towbar-pnpm-store,target=/pnpm/store,sharing=locked \
  pnpm install --store-dir /pnpm/store --frozen-lockfile

FROM installer AS builder
COPY --from=pruner /repo/out/full/ ./
RUN pnpm exec turbo run build --filter=towbar-api
RUN --mount=type=cache,id=towbar-pnpm-store,target=/pnpm/store,sharing=locked \
  pnpm --filter towbar-api --prod --ignore-scripts \
    deploy --legacy --offline \
    --store-dir /pnpm/store /prod/towbar-api

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production PORT=4020
RUN apk upgrade --no-cache \
  && apk add --no-cache ca-certificates curl \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg \
  && addgroup --system --gid 1001 towbar \
  && adduser --system --uid 1001 --ingroup towbar towbar
COPY --from=builder --chown=towbar:towbar /prod/towbar-api ./
COPY --from=builder --chown=towbar:towbar /repo/apps/towbar-api/dist ./dist
COPY --from=builder --chown=towbar:towbar /repo/packages/towbar-database/drizzle ./packages/towbar-database/drizzle
COPY --from=pruner --chown=towbar:towbar /repo/package.json ./release-package.json
USER towbar
EXPOSE 4020 4023
HEALTHCHECK --interval=20s --timeout=5s --start-period=15s --retries=5 \
  CMD curl --fail --silent http://127.0.0.1:${PORT}/health >/dev/null || exit 1
CMD ["node", "dist/index.js"]
