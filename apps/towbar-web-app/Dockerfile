# syntax=docker/dockerfile:1.7
FROM node:24.22.1-alpine3.24@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS base
FROM base AS pruner
ARG TURBO_VERSION=2.11.7
WORKDIR /repo
RUN npm install --global turbo@${TURBO_VERSION}
COPY . .
RUN turbo prune towbar-web-app --docker
FROM base AS installer
WORKDIR /repo
RUN apk add --no-cache libc6-compat && corepack enable pnpm
COPY --from=pruner /repo/out/json/ ./
COPY --from=pruner /repo/.npmrc ./.npmrc
RUN --mount=type=cache,id=towbar-pnpm-store,target=/pnpm/store,sharing=locked \
  pnpm install --store-dir /pnpm/store --frozen-lockfile
FROM installer AS builder
ARG SOURCE_COMMIT=development
ENV NEXT_TELEMETRY_DISABLED=1 \
  SOURCE_COMMIT=${SOURCE_COMMIT}
COPY --from=pruner /repo/out/full/ ./
RUN mkdir -p apps/towbar-web-app/public \
  && pnpm exec turbo run build --filter=towbar-web-app
FROM installer AS demo-builder
ARG SOURCE_COMMIT=development
ENV NEXT_TELEMETRY_DISABLED=1 \
  SOURCE_COMMIT=${SOURCE_COMMIT} NEXT_PUBLIC_TOWBAR_PUBLIC_DEMO=true
COPY --from=pruner /repo/out/full/ ./
RUN pnpm exec turbo run build --filter=towbar-web-app \
  && pnpm --filter towbar-web-app build:demo
FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=4021
RUN apk upgrade --no-cache \
  && apk add --no-cache ca-certificates curl \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg \
  && addgroup --system --gid 1001 towbar \
  && adduser --system --uid 1001 --ingroup towbar towbar
FROM runtime AS demo
COPY --from=demo-builder --chown=towbar:towbar /repo/apps/towbar-web-app/.next/standalone ./
COPY --from=demo-builder --chown=towbar:towbar /repo/apps/towbar-web-app/.next/static ./apps/towbar-web-app/.next/static
COPY --from=demo-builder --chown=towbar:towbar /repo/apps/towbar-web-app/public ./apps/towbar-web-app/public
COPY --from=demo-builder --chown=towbar:towbar /repo/apps/towbar-web-app/dist/public-demo ./public-demo
USER towbar
EXPOSE 8080
HEALTHCHECK --interval=20s --timeout=5s --start-period=30s --retries=3 \
  CMD curl --fail --silent http://127.0.0.1:8080/health >/dev/null || exit 1
CMD ["node", "public-demo/start.mjs"]

FROM runtime AS runner
COPY --from=builder --chown=towbar:towbar /repo/apps/towbar-web-app/.next/standalone ./
COPY --from=builder --chown=towbar:towbar /repo/apps/towbar-web-app/.next/static ./apps/towbar-web-app/.next/static
COPY --from=builder --chown=towbar:towbar /repo/apps/towbar-web-app/public ./apps/towbar-web-app/public
USER towbar
EXPOSE 4021
HEALTHCHECK --interval=20s --timeout=5s --start-period=15s --retries=5 \
  CMD curl --fail --silent http://127.0.0.1:${PORT}/health >/dev/null || exit 1
CMD ["node", "apps/towbar-web-app/server.js"]
