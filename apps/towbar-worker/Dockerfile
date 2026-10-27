# syntax=docker/dockerfile:1.7
FROM golang:1.27.3-bookworm@sha256:972b4110ba0f47539a975c31e52c64765e1ff19f2d74469ae4a595c6676e80a5 AS monitoring-builder
WORKDIR /agent
COPY apps/towbar-monitoring-agent/ ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -buildvcs=false -trimpath -ldflags="-s -w" -o /out/towbar-monitoring-linux-amd64 . \
  && CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -buildvcs=false -trimpath -ldflags="-s -w" -o /out/towbar-monitoring-linux-arm64 .

FROM node:26.12.1-trixie-slim@sha256:36793bcbb160a6a16cede1e62b93f84e26b78a972a8a4c0b879c1c12f22761ec AS base

FROM base AS pruner
ARG TURBO_VERSION=2.11.7
WORKDIR /repo
RUN npm install --global turbo@${TURBO_VERSION}
COPY . .
RUN turbo prune towbar-worker --docker

FROM base AS installer
WORKDIR /repo
RUN corepack enable pnpm
COPY --from=pruner /repo/out/json/ ./
COPY --from=pruner /repo/.npmrc ./.npmrc
RUN --mount=type=cache,id=towbar-pnpm-store,target=/pnpm/store,sharing=locked \
  pnpm install --store-dir /pnpm/store --frozen-lockfile

FROM installer AS builder
COPY --from=pruner /repo/out/full/ ./
RUN pnpm exec turbo run build --filter=towbar-worker
RUN --mount=type=cache,id=towbar-pnpm-store,target=/pnpm/store,sharing=locked \
  pnpm --filter towbar-worker --prod --ignore-scripts \
    deploy --legacy --prefer-offline \
    --store-dir /pnpm/store /prod/towbar-worker

FROM cgr.dev/chainguard/wolfi-base@sha256:0feab531471d2edfcca55f18883441cb7df598e724fa2dedf9985273f532eed7 AS runner
WORKDIR /app
ENV NODE_ENV=production WORKER_HEALTH_PORT=4030
RUN apk add --no-cache \
  ca-certificates=20261020-r0 \
  curl=8.23.0-r2 \
  nodejs-24-minimal=24.22.1-r2 \
  nodejs-24-minimal-compat=24.22.1-r2 \
  openssh-client=10.6_p1-r0 \
  openssh-keygen=10.6_p1-r0 \
  openssh-keyscan=10.6_p1-r0 \
  && command -v ssh >/dev/null \
  && command -v ssh-keygen >/dev/null \
  && command -v ssh-keyscan >/dev/null
COPY --from=builder --chown=65532:65532 /prod/towbar-worker ./
COPY --from=builder --chown=65532:65532 /repo/apps/towbar-worker/dist ./dist
COPY --from=monitoring-builder --chown=65532:65532 /out/ /app/monitoring-agent/
ENV TOWBAR_MONITORING_BINARY_DIR=/app/monitoring-agent
USER 65532:65532
EXPOSE 4030
HEALTHCHECK --interval=20s --timeout=5s --start-period=15s --retries=5 \
  CMD curl --fail --silent http://127.0.0.1:${WORKER_HEALTH_PORT}/health >/dev/null || exit 1
CMD ["node", "dist/worker.js"]
