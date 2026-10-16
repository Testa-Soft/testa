# Staging collector image: apps/collector/Dockerfile plus the ClickHouse
# migrations, so `src/db/migrate.ts` can run as the Fly release command.
# The production image (apps/collector/Dockerfile) is left untouched.
#
# Build context = repo root.
FROM oven/bun:1-alpine

WORKDIR /app

RUN bun add \
    @clickhouse/client@1.8.1 \
    hono@4.6.10 \
    ioredis@5.4.1 \
    zod@3.23.8

COPY packages/shared-types/package.json ./node_modules/@testa-platform/shared-types/package.json
COPY packages/shared-types/src ./node_modules/@testa-platform/shared-types/src
COPY apps/collector/src ./src
# migrate.ts resolves ../../db/migrations from src/db → /app/db/migrations
COPY apps/collector/db ./db

ENV PORT=8090
ENV CONFIG_DIR=/app/.data/configs
EXPOSE 8090

CMD ["bun", "run", "src/index.ts"]
