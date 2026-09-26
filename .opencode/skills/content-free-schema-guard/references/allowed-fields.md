# Allowed fields and forbidden name shapes

> Load when adding a column, an envelope field, a payload property or a log field, or when
> writing the exact-set assertion for a new table.

## Allowed envelope fields

Exactly these, and no others. The assertion compares the type's field set to this list.

| Field | Type | Why it is safe |
|-------|------|----------------|
| `harness` | enum | A fixed set of adapter names |
| `sessionId` | string | Harness-assigned identifier, not content |
| `repoShortName` | string | Directory basename |
| `repoFullPath` | string | A filesystem path; identity, never content |
| `rawEventType` | string | A harness event name |
| `class` | enum | `needs-you` / `finished` / `fyi` |
| `subtype` | enum, optional | The five fyi subtypes |
| `occurredAt` | ISO 8601 UTC | When the signal happened |
| `receivedAt` | ISO 8601 UTC | When the hub received it |
| `dedupeKey` | string | Derived from identity only |

A `repoFullPath` is a path, not content. It is carried so the developer can identify a
repository, and the short name is always the primary label. It does not hold file contents.

## Allowed table columns

Sessions, events and counters. Write the expected set out literally in the test.

- **sessions**: identity and lifecycle - session id, harness, repo short name, repo full path,
  first seen, last seen, state, work signal.
- **events**: one row per classified event - event id, session id, class, subtype, raw event
  type, occurred at, received at, dedupe key, acknowledgement state, resolution state.
- **counters**: name, value, updated at. Nothing else.
- **schema_version**: the migration version record.

Anything about *what was said or done inside a turn* is absent by design, including a count of
messages, a token total attached to a transcript, or a last-activity label that quotes a tool
name with its arguments.

## Name shapes that must fail

Run alongside the exact-set assertion. These are the names that actually appear in a
well-meant change:

- Content: `prompt`, `response`, `reply`, `message`, `messages`, `content`, `body`, `text`,
  `snippet`, `excerpt`, `preview`, `summary`, `description`, `detail`, `details`, `note`,
  `notes`, `comment`, `comments`, `output`, `transcript`, `log`, `last_message`, `diff`,
  `patch`, `file_content`, `arguments`, `input`, `result`
- Attachment-shaped: `attachment`, `blob`, `payload`, `data`, `buffer`, `raw`
- Free-form: any column whose type is unbounded text with no enumerated set behind it

The name check is a second net, not the guard. A column named `state_detail` holding a quoted
error message passes the name check and breaks the promise, which is why the exact-set
assertion is the primary gate and the name check only reinforces it.

## Exactness versus denylist

A denylist fails on the third change that picks a fresh synonym. An exact allowlist fails on
every change, which is the behaviour the promise needs: friction on adding a column, and a
human decision in the loop. The friction is the feature.

The right response to a failing exact-set assertion is to decide whether the column is needed.
If it is, add it to the expected set **and** record why it cannot hold content. If the reason is
"we might need it later", delete it; the schema can gain a column in a later migration.

## Payload surfaces

The same allowlist applies to what leaves over the wire, with one addition per surface.

- **Ingest response**: the stored event's identity and state only. No echo of the request body.
- **Metrics**: counter name, value, timestamp. No per-request echo of any kind.
- **Sessions and history**: identity, class, state and timestamps. No content fields, and no
  field that carries a tool name together with its arguments.
- **Local log**: service name, session id, event type, outcome, error category. Error
  *categories*, not error messages quoting the failing payload.

## Migration discipline

- Migrations are versioned and applied at startup, idempotently on every open.
- A new column is a new migration, never an edit to an applied one. An applied migration that
  changes shape makes the exact-set assertion depend on migration order.
- The database is rebuilt from migrations when the file is unreadable, so every column must be
  reachable from a migration. A column created only by a debug path disappears on rebuild and
  the exact-set assertion then fails on a table that "worked" yesterday.
- A table created outside the migration set is still a table on disk. Assert the full table
  list, not only the expected tables.

## Test shape

```ts
const EXPECTED: Record<string, string[]> = {
  sessions: ['session_id', 'harness', 'repo_short_name', 'repo_full_path',
             'first_seen_at', 'last_seen_at', 'state', 'work_signal'],
  events:   ['event_id', 'session_id', 'class', 'subtype', 'raw_event_type',
             'occurred_at', 'received_at', 'dedupe_key', 'ack_state', 'resolution_state'],
  counters: ['name', 'value', 'updated_at'],
  schema_version: ['version', 'applied_at'],
};

const FORBIDDEN = /prompt|response|content|body|snippet|excerpt|preview|
                  summary|transcript|diff|patch|arguments|output/;

it('every table has exactly the approved column set', () => {
  for (const [table, columns] of Object.entries(tableColumns(db))) {
    expect([...columns].sort(), table).toEqual([...EXPECTED[table]].sort());
  }
});

it('no column name suggests stored content', () => {
  for (const columns of Object.values(tableColumns(db))) {
    for (const c of columns) expect(`${c}`).not.toMatch(FORBIDDEN);
  }
});
```
