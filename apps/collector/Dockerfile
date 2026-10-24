# Collector runtime image (Bun).
#
# Bun runs the TypeScript directly — no build/transpile step. The only workspace
# dependency is `@testa-platform/shared-types`: TypeScript source with no
# dependencies of its own. PRD-006 code imports runtime constants from it
# (EVENT_PARAM_SPEC, BUILTIN_METRIC_KEYS, DIMENSION_KEYS), so its source is
# copied into node_modules below; the rest of the pnpm workspace isn't needed.
#
# Build context = repo root:  docker build -f apps/collector/Dockerfile .
FROM oven/bun:1-alpine

WORKDIR /app

# Real runtime deps only (pinned to apps/collector/package.json).
RUN bun add \
    @clickhouse/client@1.8.1 \
    hono@4.6.10 \
    ioredis@5.4.1 \
    zod@3.23.8

COPY packages/shared-types/package.json ./node_modules/@testa-platform/shared-types/package.json
COPY packages/shared-types/src ./node_modules/@testa-platform/shared-types/src
COPY apps/collector/src ./src

# The config bucket (static {projectId}.json files) lives here; mount a volume.
ENV PORT=8090
ENV CONFIG_DIR=/app/.data/configs
EXPOSE 8090

CMD ["bun", "run", "src/index.ts"]
