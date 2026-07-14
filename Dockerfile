# roomd server image, used by Railway (and any container host).
#
# Railway auto-detects this Dockerfile. Set the service secrets in the Railway
# dashboard: API_KEYS, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, and
# optionally RATE_LIMIT_PER_MINUTE. PORT is provided by the platform.

FROM oven/bun:1 AS base
WORKDIR /app

FROM base AS install
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM base AS release
COPY --from=install /app/node_modules ./node_modules
COPY . .

ENV NODE_ENV=production
USER bun
EXPOSE 3000
CMD ["bun", "run", "src/index.ts"]
