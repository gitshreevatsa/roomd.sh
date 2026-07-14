# Deploying roomd

Two services, two hosts:

| Service | Host | Why |
|---|---|---|
| `roomd` (server) | Railway | Long-lived container, holds no per-request Node concerns. A Dockerfile builds the Bun app. |
| `roomd-web` (dashboard) | Vercel | Next.js runs first-class on Vercel, including the edge middleware. Zero build config. |

Both talk to the same Upstash Redis over its HTTP API. `roomd-web` namespaces its
own data under `app:`, so the two never collide.

Suggested domains:

- `api.roomd.sh` for the server (Railway custom domain)
- `app.roomd.sh` for the dashboard (Vercel custom domain)
- `roomd.sh` for docs and the blog

---

## 1. Redis (shared)

Create one Upstash Redis database. Copy its REST URL and token. Both services
use these two values.

If you would rather self-host Redis, see the note at the bottom.

---

## 2. roomd on Railway

The repo root is a plain directory (not a monorepo tool), so point Railway at
the `roomd/` subdirectory.

1. New project, deploy from your repo.
2. Set the service **Root Directory** to `roomd`.
3. Railway detects `roomd/Dockerfile` and `roomd/railway.json` (which sets the
   `/health` healthcheck).
4. Add service variables:
   - `API_KEYS` = `team-a:<long-random>,team-b:<long-random>` (one pair per team)
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`
   - `RATE_LIMIT_PER_MINUTE` = `60` (optional)
   - Do **not** set `PORT`; Railway provides it and the server reads it.
5. Deploy. Add the custom domain `api.roomd.sh`.

Verify: `curl https://api.roomd.sh/health` returns `{"ok":true,...}`.

---

## 3. roomd-web on Vercel

1. Import the repo.
2. Set the project **Root Directory** to `roomd-web`.
3. Framework preset: Next.js (auto-detected). No build overrides needed.
4. Add environment variables (Production and Preview):
   - `NEXTAUTH_SECRET` = output of `openssl rand -base64 32`
   - `NEXTAUTH_URL` = `https://app.roomd.sh`
   - `AUTH_MODE` = `apikey` (or `both` / `email` later)
   - `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` (same DB as roomd)
   - `ROOMD_URL` = `https://api.roomd.sh`
   - `ROOMD_MASTER_KEY` = one **static** secret from the server's `API_KEYS`.
     This is what provisions a new team for each new user, so it must be a
     static env key, not a dynamic or invite key.
   - OAuth vars only if `AUTH_MODE` is `email` or `both`.
5. Deploy. Add the custom domain `app.roomd.sh`.

`NEXTAUTH_SECRET` also encrypts the stored roomd API keys at rest
(`src/lib/crypto.ts`). Rotating it invalidates every stored key, and users must
sign in with their API key again. Set it once and keep it.

---

## 4. Order and smoke test

Deploy roomd first (roomd-web needs `ROOMD_URL` to point at a live server).

1. `curl https://api.roomd.sh/health` → ok.
2. Open `https://app.roomd.sh` → the landing page.
3. Sign in with a secret from `API_KEYS`.
4. Create a room, open the setup guide, paste the snippet into a Claude Code
   project, and confirm the agent shows up under the room's Agents tab.

---

## Self-hosting Redis instead of Upstash

Both services use the `@upstash/redis` client, which speaks HTTP, not the Redis
wire protocol. To run your own Redis, put an HTTP shim
([serverless-redis-http](https://github.com/hiett/serverless-redis-http)) in
front of it and point `UPSTASH_REDIS_REST_URL` at the shim. The local
`docker-compose.yml` at the repo root does exactly this and can be deployed to
any container host. No application code changes.
