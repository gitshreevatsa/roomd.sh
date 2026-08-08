# Changelog

All notable changes to roomd and roomd-web.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Both packages share a version number.

---

## [Unreleased]

### Added

- **Codex MCP snippets.** `bun run create-room` and `docs/SETUP.md` now include
  Codex TOML (`bearer_token_env_var = "ROOMD_API_KEY"`).

---

## [1.1.0] - 2026-07-16

Polish: CLI, templates, diffs, analytics, and push notify.

### Added

- **`diff_context`.** Diff current context vs a prior history version.
- **`get_room_analytics`.** Completion rate, online agents, events/day.
- **Room templates.** `list_templates` / `create_room_from_template` (blank, web-app, incident).
- **CLI `bun run create-room`.** Claims a room and prints MCP config snippets.
- **SSE session notify.** Open `/rooms/:id/stream` clients get events pushed via
  in-process notify (poll remains fallback). MCP stays stateless HTTP.

---

## [1.0.0] - 2026-07-16

Scale features for live coordination without Redis SUBSCRIBE.

### Added

- **`search`.** Lexical full-text across tasks, context, and recent events;
  optional `semantic:true` via Upstash Vector when configured.
- **SSE stream.** `GET /rooms/:roomId/stream` long-polls new events (REST-safe).
- **`wait_for_events`.** MCP-friendly short block until unread events arrive.
- **Webhooks.** Team HTTPS endpoints with HMAC (`X-Roomd-Signature`) on
  `pushEvent`; Admin UI in roomd-web.

---

## [0.6.0] - 2026-07-16

Ops, history, and compliance for a production deployment.

### Added

- **Structured JSON logging.** `src/log.ts` — one object per line on stdout/stderr.
- **`get_context_history`.** Prior snapshots on `update_context` (capped list).
- **`get_room_info`.** Owner, createdAt, member/task/context/event counts.
- **Auto room create.** `POST /admin/rooms` with optional `roomId` (nanoid if omitted).
- **DATA.md.** What PII lives where; self-service erasure path documented.

---

## [0.5.0] - 2026-07-16

Agent quality-of-life tools for managing rooms, plans, and peer reviews.

### Added

- **`list_rooms` / `leave_room`.** Per-team room index (`team:{teamId}:rooms`);
  leave drops presence and emits `agent_left`.
- **`delete_task` / `delete_context` / `delete_event`.** Scoped single-item deletes
  with matching events.
- **`set_task_priority` / `add_dependency`.** Order and wire tasks after creation.
- **`request_review` / `approve` / `reject` / `list_reviews`.** Lightweight review
  records for task or context targets.

---

## [0.4.0] - 2026-07-16

Go-live product cut. roomd on Railway (`api.roomd.sh`), roomd-web on Vercel
(`roomd.sh` marketing + `app.roomd.sh` dashboard), shared Upstash Redis.
Owner portal can invite orgs, manage waitlist/users, and revoke access.

### Added

- **Owner Users directory.** `/owner/users` lists dashboard users/orgs with
  Disable (revoke keys, keep row) vs Delete (revoke + remove), plus Enable.
- **Disable vs Delete on invites and waitlist.** Distinct from soft-revoke history.
- **Operator list-team-keys.** `GET /admin/teams/:teamId/keys` so revoke-all works
  across an org's dynamic keys.
- **Sign-out → roomd.sh.** Auth.js redirect allowlist for the marketing host;
  optional `MARKETING_URL`.

### Fixed

- **Event cursor delivery.** `get_unread_events` / `get_my_summary` now advance
  the per-agent cursor to the last returned event timestamp (not wall-clock
  `now`), deliver unread events oldest-first, and drain backlogs across limited
  calls instead of dropping older events in the scan window.
- **Whitepaper consistency and diagrams.** Settled five core primitives + minor
  shared vars; documented `change_request` as a context type (events use
  `context_available` / open signal types); separated normative protocol from
  roomd; added auth threat notes, illustrative evaluation trace, and figures for
  message-vs-state, primitives, handoff, architecture, and access control.
  Paper HTML now loads Mermaid from a CDN (~55 KB) and syncs to
  `roomd-web/public`.

### Changed

- **Landing page narrative pass.** Brand-first hero (`roomd` wordmark at hero
  scale), dropped the protocol chip and the empty Supervise block, folded
  "you watch" into How it works step 3, trust strip lists clients not Redis,
  and Connect shows Claude / Cursor / Other MCP tabs via `LandingConnect`.

- **Agent guidance.** `roomd/CLAUDE.md` steers durable peer requests through
  `write_context(type=change_request)` instead of `post_event(type=change_request)`.
- **Architecture docs.** Canonical notes in `roomd/docs/architecture.md`; old
  Excalidraw sketch moved to `docs/roomd-architecture.excalidraw.historical`.

- **Terminal green design system (refined).** Phosphor green as the accent;
  Geist Sans for UI reading, Geist Mono only for code/ids/feeds. Soft glow,
  rounded panels. Phosphor green accent; mono reserved for code and ids.

- **Rebranded to roomd / the Room Protocol.** The product is now `roomd` (the
  server, lowercase), "the Room Protocol" (the spec), and `roomd.sh` (the
  domain). Renamed across the repo:
  - `collab-mcp/` → `roomd/`, `collab-app/` → `roomd-web/`, `thesis/` →
    `protocol/`.
  - `src/lib/collab.ts` → `src/lib/roomd.ts`; matching test and doc filenames.
  - Env vars: `COLLAB_SECRET` → `ROOMD_SECRET`, `COLLAB_MCP_URL` → `ROOMD_URL`,
    `COLLAB_MCP_MASTER_KEY` → `ROOMD_MASTER_KEY`.
  - The MCP server identifies as `roomd`, and the `.claude/settings.json`
    snippet uses the key `"roomd"`.
  - The top-level repo folder is left as-is to avoid moving the working tree out
    from under an active session; rename it to `roomd` when convenient.

### Added

- **Multi-client setup guide.** Room setup UI (`SetupSnippet`) and
  `roomd/docs/SETUP.md` now cover Claude Code, Cursor, and other MCP clients
  side by side (tabs in the dashboard; sections in the docs), not Claude-only.

- **Named API keys.** Every key can carry a label so you remember what it's for.
  Creating a key opens a dialog that asks for a name first, then reveals the key
  and the (now fixed) name once. The keys table shows a Note column. Invite flows
  auto-label their key (teammate invites with the teammate's email, owner/waitlist
  invites and email/OAuth signups with the person's email). Stored on the key
  record in roomd (`DynKey.note`), threaded through `storeDynamicKey`,
  `/admin/keys`, and `/admin/keys/provision`.

- **Two-tier separation: a locked Owner portal vs org-facing admin.** The
  deployment owner (the master-key holder) now has a dedicated `/owner` portal,
  gated server-side (`owner/layout.tsx`); any other signed-in user is redirected
  to their dashboard, so an invited org can never see it. The Owner portal holds
  the waitlist, direct "invite an org by email" (provisions a fresh isolated
  workspace), and the usage view (moved to `/owner/usage`). The org-facing
  `/admin` is now just that: an org's own keys, teammate invites, and room
  invites, no waitlist or usage. An "Owner" nav link shows only for the owner.
  Verified with two separate logins: owner reaches `/owner`; an invited org is
  bounced from `/owner` to `/dashboard`.

- **Email invites (Nodemailer).** Inviting from the waitlist, or inviting a
  teammate into your own org, now sends the person their sign-in key by email
  when SMTP is configured (`SMTP_HOST/PORT/USER/PASS/FROM`). `lib/mail.ts` is a
  graceful no-op when SMTP is unset (the invite still succeeds and shows a
  copyable message), so local dev needs no mail server. New "Invite a teammate by
  email" input in the admin Keys section, and the invite modal now says whether
  it emailed. Covered by `tests/mail.test.ts`.

- **Operator usage page (`/admin/usage`).** A single operator-only view of the
  whole deployment: totals (orgs, rooms, active rooms, tasks, events, context,
  waitlist), a per-org table (rooms, tasks, events, last active), and a per-room
  table (tasks done/total, agents, events, context, last active). Backed by a new
  operator-only `GET /admin/rooms/:roomId/stats` on roomd (static key only, reads
  across tenancy) and global `app:users` / `app:rooms:all` indexes. Verified end
  to end: seed a room with activity, then read it back on the usage page.

- **Full mobile pass.** The app nav (Dashboard/Admin) is now reachable on phones;
  the room header collapses button labels to icons; the task-board kanban was
  already two-column on mobile and now themes correctly in dark; every admin and
  usage table scrolls inside its own container. Measured 0px page overflow on
  landing, /protocol, login, dashboard, admin, and usage at 390px.

- **Waitlist to invite flow for operators.** The `/admin` page now has a Waitlist
  section (visible only to the master-key holder) listing everyone who requested
  access. "Invite & create key" provisions that person an isolated team, mints a
  sign-in key, and shows it once with a ready-to-send message. The waitlist now
  stores per-email status (pending/invited) in Redis, and the team id is derived
  from the email so re-inviting lands the person back in their own workspace.
  New: `/api/admin/waitlist` (GET/POST/DELETE, operator-gated), `isOperator()`
  in `lib/session.ts`, `waitlistTeamId()` in `lib/teams.ts`. Verified end to end
  with browser automation: sign in, see the waitlist, invite, reveal the key.

- **Copy pass for clarity (as a first-time user).** Fixed a stale "My collab room
  ID" in the agent setup prompt (now "roomd room ID", with a note to restart
  Claude Code and use a distinct agentId per engineer). Reworded the waitlist
  page ("Request access... we'll send you a key") and the admin section
  descriptions into plain language.

- **Mobile: verified no horizontal overflow** on the landing, `/protocol`, and
  login (measured with real device emulation). Hid the nav "Sign in" on small
  screens so the header fits a phone, and added an overflow guard.

- **Theme-aware, dark by default.** The whole product (landing and dashboard)
  now switches light/dark. An inline script in the root layout sets the theme
  before first paint (no flash), with precedence: a `?theme=` URL override
  (persisted), then the saved choice, then the OS `prefers-color-scheme`. A
  `ThemeToggle` in the landing nav and the app header flips and persists it. The
  dark tokens already existed in `globals.css`; nothing switched them until now.
  The landing is designed dark-first to match the dev-infra market, and the
  dashboard shares the same tokens so there is no jump at sign-in.

- **Refined the dark palette.** Replaced the saturated navy dark theme (an
  84%-saturation blue where cards were the same color as the background, so it
  looked flat) with a neutral near-black graphite at ~5% saturation, with cards
  and popovers lifted above the background for real elevation. Everything uses
  semantic tokens, so the whole app updated at once.

- **Public marketing landing page at `/`, in the roomd brand.** A full product
  narrative: hero → problem (without/with roomd) → three-step how-it-works →
  one-block connect snippet → what a room holds → supervision → closing CTA. Two
  interactive pieces built without an animation library: a live hero demo where
  three engineers' agents come online, write context, hand off, and move a task
  to done on a loop (`RoomDemo.tsx`), and a clickable five-primitives explorer
  (`PrimitiveExplorer.tsx`). Both collapse to a static state under
  prefers-reduced-motion. Logged-in users still redirect to the dashboard.

- **Deployment path: Railway (server) + Vercel (dashboard).** `roomd/Dockerfile`
  and `roomd/railway.json` build the server on Railway; `roomd-web` deploys to
  Vercel with no build config. Both share one Upstash Redis. Full steps in
  `docs/DEPLOY.md`. Nothing is live yet; the config and docs are in place to
  bring an instance up.

### Fixed

- **A rotated (or mismatched) `NEXTAUTH_SECRET` bricked all logins.** The stored
  API key is encrypted under a key derived from `NEXTAUTH_SECRET`. If that secret
  changed, reading the user record threw an AES-GCM "unable to authenticate data"
  error, which cascaded into a `CallbackRouteError` and showed up as "Invalid API
  key" on every sign-in. Now an undecryptable stored key degrades to empty
  instead of throwing, and an API-key login re-stores the real key under the
  current secret, so login self-heals. Reproduced and fixed by driving a real
  login against a record encrypted under a different secret.

- **The dashboard crashed for any user who had rooms.** `RoomCard` used an
  `onClick` (to stop the copy button from triggering the card link) but was a
  server component, which Next forbids ("Event handlers cannot be passed to
  Client Component props"). It only triggered once a room existed to render, so
  the empty dashboard looked fine. Marked it a client component.

- **Every room-data read against the real server was broken.** roomd's
  streamable-HTTP transport answers as a Server-Sent Events stream
  (`event: message\ndata: {...}`), but the client did `res.json()`, which throws
  on SSE. It surfaced as a 500 on room creation and empty room data everywhere.
  The unit tests mock `fetch`, so it never showed until the app ran against
  roomd. `callTool` now parses SSE or plain JSON, with a regression test.

- **The app crashed at runtime in the edge middleware.** The v0.3 security work
  added `crypto` imports that reached the edge middleware bundle through
  `@/auth` (`lib/crypto`, `lib/password`, `lib/teams`), and the edge runtime
  forbids Node built-ins. `next build` and the unit tests passed, so it went
  unnoticed until the app was actually served. Fixed with the NextAuth v5 split
  config: an edge-safe `src/auth.config.ts` (no providers, no Node crypto) used
  by the middleware, and the full config in `src/auth.ts` for the server.
  Verified by serving the app and loading every route, not just building it.

- **Geist fonts were defined but never applied.** The layout loaded Geist Sans
  and Mono as CSS variables, but `globals.css` set the body to `Arial`, and the
  Tailwind theme had no `fontFamily` mapping. The whole app rendered in Arial.
  Both are wired up now.

### Documentation

- **Made the roomd / Room Protocol distinction explicit.** Added a "roomd vs the
  Room Protocol" section to the README and a Terminology section to the
  whitepaper: the Room Protocol is the design (spec), roomd is the reference
  implementation you run, roomd-web is the dashboard, room is the primitive,
  roomd.sh is the brand. `roomd/CLAUDE.md` and the problem-statement doc now
  point at this.

- **Reworked the whitepaper to read as a whole, not a release snapshot.** Dropped
  version-bound framing (tool counts, test counts, "first production version",
  "an earlier draft listed here / since shipped"); the protocol's operations and
  omissions are now described in the present tense. Also corrected stale facts to
  match the code: room-scoped keys carry a refreshed TTL, secrets are stored as
  digests (and the dashboard's key copy is encrypted at rest), and the
  richer-coordination tools are part of the described protocol rather than future
  work.

- **Gave the whitepaper the shape of a formal technical report.** Added a title
  block (author, affiliation, date, correspondence), numbered and captioned
  figures and tables, formal inline citations `[n]`, a References section citing
  the real prior work (MCP, AutoGen, CrewAI, LangGraph, A2A, FIPA ACL, Hearsay-II,
  blackboard systems, Redis), an Acknowledgements section, and a BibTeX "How to
  cite" entry.

- **Put the whitepaper on the website.** A themed, theme-aware `/protocol` page
  in roomd-web presents the paper (title block, abstract, the roomd-vs-Room-Protocol
  terminology, contributions) with "Read the paper" and "Download PDF" actions;
  the typeset HTML and PDF ship as static assets in `public/`. The landing page's
  "The Room Protocol" badge and footer link now point to `/protocol`. The
  middleware matcher was tightened to leave static files (the paper, favicon,
  images) untouched.

- **Typeset the paper for a published look.** `protocol/build-paper.cjs` renders
  the markdown into a self-contained, academically styled HTML
  (`the-room-protocol.html`: serif body, centered title block, set abstract,
  captioned figures/tables, hanging-indent references, mermaid diagrams rendered
  inline) and a print-ready `the-room-protocol.pdf`. The markdown remains the
  canonical source; the HTML/PDF are regenerated from it. Not tied to any release.

---

## [0.3.0] - 2026-07-10

The release that made the system actually work. Before this, the dashboard
rendered every room as empty, registration was a dead link, and a team-wide API
key was readable by any logged-in browser. All three are fixed, v0.3 of the tool
roadmap is complete, and both packages have test suites.

**Neither service is deployed.** Both run locally. Deployment config that
described a deploy that never happened has been removed.

### Fixed

- **roomd-web rendered every room as empty.** `src/lib/collab.ts` unwrapped MCP
  tool results as `result.plan`, `result.entries`, `result.events`,
  `result.agents`, and `result.entry`. roomd serialises its return value
  directly, so there is no envelope and every one of those was `undefined`.
  Nothing threw, so the UI showed a room nobody had ever used. All five call
  sites now read the value directly.
  Covered by `roomd-web/tests/collab.test.ts`.

- **A failing tool call was treated as data.** `callTool` ignored `isError` on
  the MCP response and returned the error string as though it were a result.
  It now raises, with the `Error: ` prefix stripped.

- **Registration was a dead link.** `/register` posted to
  `/api/auth/register`, which did not exist. The route now exists, provisions an
  isolated roomd team for the new user, and refuses to run at all when
  `AUTH_MODE=apikey`, so an invite-only deployment cannot be signed up for
  through a route the login page hides.

- **Email auth could never have worked.** `emailProvider` compared against a
  `passwordHash` that nothing ever wrote.

- **Broken OAuth account lookup.** `signIn` fell back to
  `getUserById(user.email)`, passing an email where a user id was expected. That
  lookup could never hit. OAuth now links a new provider to an existing account
  matched by email, instead of stranding the user with a second empty team.

- **`update_task` sent an optional status.** The API route allowed a PATCH with
  no `status`, which roomd's `update_task` rejects. It is now required.

- **`contextCount` was hardcoded to `0`** on the dashboard and in `/api/rooms`.

- **Dashboard "Back to setup" linked to itself.** It now goes to the dashboard.

- **`hint` field name mismatch.** roomd returned `secretHint` and
  `tokenHint`; roomd-web's types expected `hint`, so the admin tables rendered
  `undefined`. The server now returns `hint` for both.

- **Room ids could be handed out after another team owned them.** Room ids are
  global in roomd and claimed by whichever team touches them first.
  roomd-web deduplicated only against its own metadata. It now claims the id
  through roomd at creation time and suffixes on collision.

- **Empty ciphertext was misreported as a malformed secret** in the new crypto
  layer (found by its own test).

### Security

- **The roomd API key no longer reaches the browser.** It was placed in the
  JWT and then on `session.user.apiKey`. Auth.js serves the session verbatim
  from `/api/auth/session`, so any logged-in user could read their team's bearer
  token from the browser. The key now lives only in Redis. Server code reads it
  through `getServerIdentity()` in `src/lib/session.ts`.
  Guarded by `roomd-web/tests/session-leak.test.ts`.

- **Passwords were hashed with unsalted SHA-256.** Replaced with salted scrypt
  (`src/lib/password.ts`), stored as `scrypt$<salt>$<hash>` and verified in
  constant time. A legacy bare-SHA-256 hash no longer validates against anything.

- **Secrets are no longer stored in plaintext in Redis.** Dynamic API keys and
  room invite tokens were stored under `dynkey:{secret}` / `invite:{token}`, and
  `dynkeyid:{keyId}` held the raw secret so it could be read back at will. They
  are now keyed by `sha256(secret)`, and the metadata record holds only a digest
  and a four-character display hint. A Redis dump no longer yields live tokens.

- **roomd-web's copy of the API key is encrypted at rest.** Hashing inside
  roomd alone was not enough: roomd-web must present the key as a bearer
  token, so it holds the plaintext, and both share one Redis. The user record now
  stores it AES-256-GCM encrypted under a key derived from `NEXTAUTH_SECRET`
  (`src/lib/crypto.ts`), so a database dump alone is not sufficient.
  Note: rotating `NEXTAUTH_SECRET` makes stored keys undecryptable, and affected
  users must sign in with their API key again.

- **`GET /room/:roomId` was public.** It returned agents, task counts and recent
  event payloads to anyone who guessed a room id. It now requires auth and room
  ownership.

- **Static API keys are compared in constant time.** Key lookup was a `Map` hit
  on the raw secret. Secrets are now compared as SHA-256 digests via
  `timingSafeEqual`, and every configured key is checked so a failed match costs
  the same regardless of which key was tried.

- **Email registration is race-safe.** The email index is claimed with `SET NX`
  before the user record is written, so two concurrent signups for one address
  cannot both succeed. Registration does not reveal whether an address is taken.

- **Input validation tightened** on every API route: bounded string lengths,
  bounded invite expiry, `email` normalised to lowercase. Errors are logged as
  messages, never as request bodies, which can carry context payloads.

### Added

#### roomd: v0.3 tools (19 tools -> 25)

- `get_task` fetches one task without reading the whole plan.
- `get_unblocked_tasks` returns pending tasks whose dependencies are all `done`,
  so an agent picks up work by asking rather than guessing. A dependency naming a
  task that is not in the plan counts as unmet.
- `update_context` revises a context entry in place and bumps its minor version
  (1.0 to 1.1), emitting `context_updated` to consuming agents. Previously a
  changed API contract meant writing a second entry and leaving the stale one
  visible, with no way for a consumer to tell which was current.
- `set_shared_var`, `get_shared_var`, `list_shared_vars` for small facts (a port,
  a staging URL) that do not deserve a typed context entry. Backed by a Redis
  hash at `{roomId}:vars`. `get_shared_var` returns `found` so an unset key is
  distinguishable from an empty value.
- `list_context` gained an `author` filter.

#### roomd: infrastructure

- **Payload schema validation per `ContextType`.** `write_context` and
  `update_context` validate `payload` against a schema chosen by `type` and
  reject a mismatch, naming the offending field path. Unknown extra fields are
  preserved. A consuming agent can now rely on shape rather than parse prose,
  which is what the typed-context model claimed but did not enforce.
- **Room TTL of 30 days**, refreshed on every authenticated tool call via a
  pipelined `EXPIRE` batch in `touchRoomTtl`. Redis previously grew forever.
  An abandoned room is reclaimable by another team once it lapses.
- `resetKeyMap()` so tests can mutate the environment.
- `ROOM_ACCESS_DENIED` exported as a constant instead of a string literal
  repeated across nine call sites.

#### Tests: 139 total, none before

- `roomd`: 91 tests via `bun test`, against an in-memory Redis fake
  (`tests/fake-redis.ts`) with a controllable clock, so TTL and expiry are tested
  without sleeping. Covers the plan lock, dependency resolution, per-agent event
  cursors, read receipts, presence expiry, lock ownership, payload validation,
  room ownership and cross-team denial, rate limiting (including fail-open), and
  the assertion that no raw secret is ever written to the store.
- `roomd-web`: 48 tests via `vitest`. Covers the MCP response contract that
  broke the dashboard, the API-key session leak, scrypt hashing, envelope
  encryption including tamper detection, and teamId derivation against
  roomd's `teamId` rule.

#### Other

- `CHANGELOG.md` (this file) and a root `README.md`.
- `roomd/.gitignore`. There was none, and `.env` sits in that directory.

### Changed

- `src/mcp/server.ts` registered 19 tools with the same 12-line try/catch and
  `assertRoomAccess` call copy-pasted into each. Replaced with one
  `registerRoomTool` helper. The room-access check is now structural: the generic
  constrains every tool's input shape to include `roomId`, so a new tool that
  forgets it does not compile, and one that skips the ownership check cannot be
  written. Error messages no longer read `Error: Error: ...`.
- Room summary logic was duplicated between `/api/rooms` and the dashboard page.
  Extracted to `src/lib/rooms.ts`.
- All API routes now use `getServerIdentity()` rather than `auth()` plus
  `session.user.apiKey`.
- `POST /api/rooms` claims the room id through roomd before storing metadata.

### Removed

- `roomd/fly.toml` and `roomd/Dockerfile`. They described a deploy that
  never happened; `roomd.fly.dev` does not resolve.
- `roomd-web/src/lib/r2.ts`. A stub whose only function threw. Nothing imported
  it, and the `R2_ENABLED` guard it documented was never used. Its env vars are
  gone from `.env.local.example`.
- Every em dash and en dash in source and docs, per the project writing rule.

### Documentation

Corrected earlier docs that were wrong:

- `roomd/docs/UPCOMING.md` listed multi-tenant API keys, room ownership,
  rate limiting, and the entire invite system as "Not built". All four had been
  built. Rewritten against the code, with a pointer to the test covering each
  claim.
- `roomd/CLAUDE.md` pointed agents at `https://roomd.fly.dev/mcp`,
  which does not resolve, and documented 19 of the 25 tools. Rewritten.
- `roomd/docs/SETUP.md` pointed at a dead Railway URL and promised "8
  coordination tools". Rewritten around local setup, with a troubleshooting
  section.
- `roomd/docs/redis-schema.md` documented `dynkey:{secret}` and said
  `dynkeyid` "includes the raw secret", and marked every room key `TTL: none`.
  Updated for hashed lookups and the 30-day room TTL, plus the new `:vars` key
  and a "what is never stored" section.
- `docs/plans/2026-05-28-roomd.md` told agents to connect over SSE at
  `/sse`, an endpoint that does not exist. Marked historical, with a banner
  listing what superseded it, and the misleading snippet corrected.
- `roomd-web-spec.md` marked historical. Its session shape included `apiKey`,
  which is the leak fixed above.
- `protocol/` claimed deployment on Railway and 19 tools, in both documents.
  Corrected to 25 tools and local execution. The tool table gained the new
  operations and a paragraph on shared variables as a sixth minor primitive.

### Known gaps

- No account deletion in roomd-web. GDPR erasure is therefore not satisfied,
  and personal data now exists (`app:user:*`, `app:waitlist`).
- No rate limiting on roomd-web's own routes, including `/api/auth/register`
  and `/api/waitlist`. roomd rate limits per team, but that only starts
  after an account exists.
- No CI. `bun test`, `vitest run` and `tsc --noEmit` pass but nothing enforces it.
- The repository is not under version control. `git init` has not been run.
- `git`-based review of this changeset is therefore not possible; there is no
  baseline commit to diff against.

---

## [0.2.0] - 2026-06-01 (reconstructed)

Never tagged. Recorded here from the code as it stood, since `UPCOMING.md`
claimed most of this was unbuilt.

### Added
- Multi-tenant API keys: static env keys, dynamic Redis keys, room-scoped invite
  tokens, all resolving to a team identity.
- Room ownership by first-touch atomic claim; cross-team access denied.
- Per-team fixed-window rate limiting that fails open when Redis is unreachable.
- Per-agent event cursors (`get_unread_events`), read receipts
  (`mark_event_read`, `get_event_reads`), threaded replies (`reply_to_event`).
- Presence via heartbeat with a 120-second TTL.
- Distributed locks, plus an internal plan lock with bounded backoff.
- `get_my_tasks`, `get_my_summary`.
- Admin HTTP API for key and invite management, and `GET /admin/me`.
- roomd-web: the entire Next.js dashboard.

---

## [0.1.0] - 2026-05-28

### Added
- roomd: stateless MCP server over streamable HTTP, backed by Upstash Redis.
- Plan, context, and event primitives. A single shared `ROOMD_SECRET`.
