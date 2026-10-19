# syntax=docker/dockerfile:1.7
FROM golang:1.27.2-bookworm@sha256:5cf287a799e6b94384bad13d16b14904c531f51ba65792237e122ce42b392f61 AS monitoring-builder
WORKDIR /agent
COPY apps/towbar-monitoring-agent/ ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -buildvcs=false -trimpath -ldflags="-s -w" -o /out/towbar-monitoring-linux-amd64 . \
  && CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -buildvcs=false -trimpath -ldflags="-s -w" -o /out/towbar-monitoring-linux-arm64 .

FROM node:24-trixie-slim@sha256:7f486cabe892bff8fef04c0f7da8dba84a560be3e4e2740b7a86afc57ebec315 AS base

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

FROM cgr.dev/chainguard/wolfi-base@sha256:c2a4815b6ca49b9bbafd451b4bde690d567a86b2b6b54877faac8082a7bc4296 AS runner
WORKDIR /app
ENV NODE_ENV=production WORKER_HEALTH_PORT=4030
RUN apk add --no-cache \
  ca-certificates=20260611-r1 \
  curl=8.22.0-r2 \
  nodejs-24-minimal=24.21.0-r1 \
  nodejs-24-minimal-compat=24.21.0-r1 \
  openssh-client=10.5_p1-r1 \
  openssh-keygen=10.5_p1-r1 \
  openssh-keyscan=10.5_p1-r1 \
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
