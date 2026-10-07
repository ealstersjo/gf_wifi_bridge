# Data deletion ownership

| Table | Owner | Foreign key | Delete behavior |
|---|---|---|---|
| `recipes` | Recipe Library | none | Recipe delete removes only the current recipe row and its stored normalized/original payload. |
| `brew_sessions` | Brew Session | none to `recipes` | Completed session delete removes the session row. Recipe snapshots are embedded JSON and are deleted with the session. |
| `telemetry_samples` | Brew Session | `session_id → brew_sessions.id` | Explicitly deleted in the same transaction before the session row. |
| `brew_events` | Brew Session | `session_id → brew_sessions.id` | Explicitly deleted in the same transaction before the session row. |

Recipe snapshots are intentionally not foreign keys to `recipes`: deleting a
current library recipe cannot affect historical sessions. Session deletion is
transactional and rejects `ACTIVE` sessions with `SESSION_ACTIVE`/HTTP 409.
No deletion operation sends a G30 command or changes telemetry behavior.
