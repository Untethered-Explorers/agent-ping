---
name: content-free-schema-guard
description: "Prove and preserve that agent-ping can hold no conversation content. Covers the exact-column-set assertion for the SQLite schema, the envelope field assertion, ingest and metrics payload assertions, the history panel and the local log, plus the shared review procedure to run when any of them changes. Use when adding a column, field, payload, log line or dashboard panel, or when changing the schema, the envelope, the ingest route, the metrics route or the history view in agent-ping."
---

# Skill: Content-Free Schema Guard

agent-ping's central promise is that it never stores or transmits conversation content: no
prompt, response, tool output, file content or diff reaches the durable log, a log file or any
outbound request. That promise is enforced in at least six independent places, and each one is
a place where a well-meaning new column or field silently breaks it. This skill is the one
procedure that keeps all six in step.

---

## Process

### Step 1: Identify which surfaces your change touches

The boundary is enforced at six surfaces. Find every one your change reaches before writing
code, because a change usually touches more than one.

| Surface | What must never appear | Requirement |
|---------|------------------------|-------------|
| SQLite schema | A column able to hold content | EL-FR-03 |
| Normalized envelope | A field able to hold content | EL-FR-01 |
| Ingest route | Content in an accepted or stored payload | HC-3 |
| Metrics route | Content in the counters payload | HC-6 |
| History panel | Content in a rendered row | LD-3 |
| Local log | Content in a log line | IO-FR-09 |

Adding one column means the schema assertion changes, and probably the ingest payload assertion
too. If you cannot name every surface your change reaches, then you have not finished step 1.

### Step 2: Assert the exact column set, not a denylist

The schema guard is an **exact column list** for every table, compared against a literal
expected set. A denylist of forbidden names is not sufficient: it does not catch
`snippet`, `body`, `excerpt` or `summary`, which are the names that actually appear in a
well-meant change.

- Every table's full column list is written out in the test. Adding a column fails the build
  until a human adds it to the expected list and accepts that it holds no content.
- Indexes and the schema version record are asserted too, since an index on a content column
  is the same leak by another route.
- A useful second assertion is a name-shape check that fails on any column whose name suggests
  stored content, run alongside the exact list rather than instead of it.

Load `references/allowed-fields.md` for the allowed column and field lists, the name patterns
that trip the shape check, and the exactness-versus-denylist rationale.

**Output:** a passing exact-column-set assertion that fails on any new column.

### Step 3: Assert the envelope type has no content-capable field

The envelope type is the narrowest place content could enter, because everything downstream
inherits it. The assertion checks the type's field set, not the runtime value.

- Allowed: harness, session identifier, repository short name, repository full path, raw event
  type, class, optional subtype, ISO 8601 UTC occurrence and receipt timestamps, dedupe key.
- Assert the field list exactly. An optional field with no current writer is still a field that
  can hold content later, so it must be justified in the test or removed.
- A runtime value check is necessary but not sufficient: an empty string passes a value check
  and the field is still capable of holding content.

**Output:** an exact field-set assertion on the envelope type.

### Step 4: Assert the payload surfaces

Both are payload-level assertions on a real request against a running or booted instance, not
on a hand-built object.

- **Ingest:** post a valid envelope and assert the stored row and the response body contain
  only allowed fields. Post a payload carrying an extra unknown field and assert it is rejected
  as malformed rather than stored.
- **Metrics:** request the metrics route and assert the payload contains counts and timestamps
  only, with no per-request payload echo. A metrics route that echoes the last request is a
  content leak.
- **History:** assert the history panel renders class, repository, session, timestamp and
  acknowledgement or resolution state, and no content field. Check the rendered output, not the
  fixture.
- **Local log:** write through the logging path and assert no line carries prompt, response,
  tool-output or file-content text.

**Output:** four payload-level assertions, each exercised through its real path.

### Step 5: Check the outbound direction

Storing nothing is not enough; nothing may be transmitted. No telemetry leaves the machine, and
the only outbound calls are to the loopback hub and harnesses already running on this machine.

- Any new outbound call needs a named destination and a justification against that rule.
- Error and breadcrumb paths are the usual leak: a log line quoting the failing payload carries
  content. Assert the breadcrumb carries service, session and event type only.

**Output:** a recorded justification per outbound call, or no new call.

### Step 6: Re-run the whole guard set after any change

Content-freedom is a property of the system, not of one file. Run every assertion in the guard
set, not only the one your change touched. A change that is clean in isolation can still
complete a path that another change opened.

**Output:** green guard set, with the changed assertions named in the change record.

---

## Gotchas

- **A denylist passes while content is stored.** Banning `prompt`, `response` and `content`
  catches none of `snippet`, `body`, `excerpt`, `preview`, `summary` or `last_message`. The
  guard must be an exact allowlist of columns, and a denylist is at best a second net.

- **A `TEXT` column with no current writer is still a violation.** The exact-set assertion is
  what catches the speculative column added for a feature that might need it. Adding a column
  for future use means the promise is already broken.

- **A metrics route that echoes the last request leaks content.** Counters must be counts and
  timestamps. Per-request echo is invisible in code review and obvious in a payload test.

- **An empty content field passes a runtime value check.** `""` is falsy and reads as clean.
  Assert the field set, not the values present.

- **The log is the easiest leak and the least tested.** A breadcrumb that quotes the failing
  payload, or a debug line that prints the whole envelope, puts content on disk outside the
  durable log. Assert the log output, not just that the log exists.

- **Checking only the surface you changed leaves a path open.** A new ingest field is invisible
  to the schema test and a new schema column is invisible to the ingest test. The six surfaces
  are checked as a set.

- **A `db` table created outside the migration set escapes the assertion.** A test-time or
  debug-created table holding raw rows is still a content store on disk. Assert the full table
  list, not only the tables you expect.

- **Renaming a column to something neutral hides the leak without removing it.** Renaming
  `prompt` to `payload` satisfies a name check and changes nothing. Only the exact set plus a
  human accepting the new column prevents this.

---

## Validation

Run from the repository root. The guard set spans several suites; run them all after any change
to the schema, the envelope, a payload route, the history view or the log.

```bash
npm test -- tests/storage/schema.test.ts tests/domain/classify.test.ts
npm test -- tests/hub/ingest.test.ts tests/hub/metrics.test.ts
npm test -- tests/dashboard/live-interactions.test.ts
npm run typecheck
```

Confirm each item:

- [ ] A test asserts the exact column list of every table and fails if any column is added
- [ ] Every table's columns are compared against a literal expected set, not a forbidden-name
      list, and a name-shape check runs alongside as a second net
- [ ] Indexes and the schema version record are asserted
- [ ] The envelope type's field set is asserted exactly, with every optional field justified
- [ ] A posted envelope carrying an unknown extra field is rejected rather than stored
- [ ] The metrics payload contains counts and timestamps only and no per-request echo
- [ ] The history panel renders class, repository, session, timestamp and state and no content
      field, asserted on rendered output
- [ ] A line written through the real logging path contains no prompt, response, tool-output or
      file-content text
- [ ] Every outbound call has a named destination justified against the no-telemetry rule
- [ ] A new column or field that a human accepted is recorded with the reason it holds no
      content

If an assertion fails, do not widen the expected set to make it green. Decide whether the field
is needed, and if it is, record why it cannot hold content and who accepted that. A guard that
has been edited to pass has stopped guarding.
