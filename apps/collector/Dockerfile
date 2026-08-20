# Collector runtime image (Bun).
#
# Bun runs the TypeScript directly — no build/transpile step. The only workspace
# dependency the collector uses is `@testa-platform/shared-types`, and every
# import of it is `import type`, which Bun erases at load time. So the image
# needs NONE of the pnpm workspace — just the real runtime deps below. Small,
# deployable, no workspace plumbing.
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

COPY apps/collector/src ./src

# The config bucket (static {projectId}.json files) lives here; mount a volume.
ENV PORT=8090
ENV CONFIG_DIR=/app/.data/configs
EXPOSE 8090

CMD ["bun", "run", "src/index.ts"]
