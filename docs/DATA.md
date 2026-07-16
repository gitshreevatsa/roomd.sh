# Data we store

roomd and roomd-web share one Upstash Redis. This is what personal data looks like
and how to erase it.

## roomd-web (dashboard)

| Key pattern | Contents |
|---|---|
| `app:user:{id}` | User record (email, name, teamId, encrypted API key, auth methods) |
| `app:user:email:{email}` | Index → user id |
| `app:user:apikey:{teamId}` | Index → user id |
| `app:user:{provider}:{externalId}` | OAuth link → user id |
| `app:users` | Set of user ids |
| `app:waitlist` / `app:waitlist:meta:{email}` | Waitlist signup |
| `app:org-invites` / `app:org-invite:{email}` | Direct owner invites |
| `app:rooms:{userId}` / `app:room:{roomId}` | Dashboard room metadata only |

## roomd (MCP server)

Room coordination data is keyed by `roomId` (plans, context, events, presence).
API keys are stored as **SHA-256 digests** only (never the raw secret).
Dynamic keys and invites are team/room scoped; no email is required on the server.

## Erasure

- **Self-service:** signed-in users can `DELETE /api/account` (dashboard). This
  revokes the team's roomd keys and deletes the `app:user:*` record.
- **Operator:** Owner → Users → Delete (same effect, plus invite/waitlist rows
  when deleted from those tables).
- **Room data:** idle rooms expire after 30 days of no tool calls (TTL).

## Contact

For erasure requests beyond self-service, contact the deployment operator.
