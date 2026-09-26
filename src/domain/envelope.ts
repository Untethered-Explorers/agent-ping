// The normalized envelope: the one event shape a harness adapter produces and
// every other concern reads (EL-FR-01, ADR-005, ADR-003, APX-FR-01).
//
// THE PRIVACY BOUNDARY STARTS HERE
// The claim "agent-ping never stores or transmits conversation content" is only
// true because this type cannot hold content. A field that is not needed to
// render a row or decide a class does not exist: there is no prompt, no response,
// no tool output, no file content, no diff, and no field shaped like one. The
// field list below is ten entries, in display order, and nothing else:
//
//   harness          a harness name from a closed set
//   sessionId        the harness's own session key
//   repoShortName    the session directory's basename, the primary label
//   repoFullPath     the session directory, carried for hover detail only
//   rawEventType     the harness's own event name, verbatim
//   class            needs-you | finished | fyi
//   subtype          error | retry | long-tool-call | compaction | token-burn,
//                    and only on an fyi event
//   occurredAt       ISO 8601 UTC, when the signal happened
//   receivedAt       ISO 8601 UTC, when the hub received it
//   dedupeKey        derived from identity alone
//
// The assertion that keeps it that way is in tests/domain/classify.test.ts, and
// it is an exact set rather than a denylist: the review surface is this file, and
// adding a field is a visible diff that fails the suite until a human adds the
// field to the approved list there and accepts in writing that it cannot hold
// content. A denylist of forbidden names would pass the day someone invented
// `snippet` or `body`, which are the names a well-meant change actually picks.
//
// The field *types* are part of the guarantee too. Everything here is a string
// from a closed vocabulary, two ISO 8601 UTC timestamps, or a derived key: there
// is no number that grows with what was said, because a count that tracks
// conversation volume is a transcript wearing a numeric disguise. The two
// measurements the classifier uses to decide a threshold (a duration, a token
// count) are inputs in src/domain/classify.ts and deliberately die there; only
// the class and subtype they decide survive into the envelope.
//
// IDENTITY
// The repository short name is the identity the product groups and labels by
// (APX-CON-09, ADR-008). It is derived from the session's directory rather than
// configured, so there is no registry to keep in sync, and the full path travels
// alongside it for hover detail and is never a key. src/domain/classify.ts is the
// one place the derivation happens, so an adapter cannot get it wrong.
//
// The harness name is a closed set for the same reason the class union is: the
// ingest route rejects an unknown harness (HC-FR-04), so the known set has to live
// somewhere, and it lives here rather than in a string that arrives from a
// request. v1 ships opencode; copilot-cli is named because its adapter is a
// documented, gated deliverable (PRD 6.1, ADR-005, PRD 16 Open Question 12) and
// because the classifier's table carries its signals as observed or unresolved
// rows rather than guesses. A third harness is one line here plus its own rows.
//
// WHERE THE CLASS AND SUBTYPE UNIONS COME FROM
// They are declared in src/storage/eventStore.ts and imported as types only,
// because the database is what enforces them: events.class and events.subtype
// carry CHECK constraints, so a fourth class or a sixth subtype cannot be stored
// even by a caller that ignores this type. A type-only import means the erasure
// happens at compile time, so this module and everything built on it load no
// database driver - which is what lets a plugin inside a harness build an
// envelope without pulling in better-sqlite3. tests/domain/classify.test.ts
// asserts that the domain's only reference to the store is type-only.
//
// Nothing here opens a socket, spawns a process or renders a surface, and no
// value in this module is ever sent anywhere (APX-CON-12).

import type { EventClass, FyiSubtype } from '../storage/eventStore.js'

// Re-exported so one import reaches the whole vocabulary. The definitions stay
// with the store because it is where the database enforces them; a second
// declaration here would be a second thing to drift.
export type { EventClass, FyiSubtype }

/**
 * Every harness this product can name.
 *
 * A closed set, asserted in tests/domain/classify.test.ts. `copilot-cli` is here
 * because its signals are documented and its table rows exist, marked
 * unresolved where upstream is unresolved; a harness whose adapter is deferred is
 * still a harness whose signals must not be invented (ADR-005, PRD 16 #12).
 */
export const KNOWN_HARNESSES = ['opencode', 'copilot-cli'] as const

export type Harness = (typeof KNOWN_HARNESSES)[number]

/** Whether a string names a harness this product knows. */
export function isKnownHarness(value: string): value is Harness {
  return (KNOWN_HARNESSES as readonly string[]).includes(value)
}

/**
 * The envelope's fields, in display order.
 *
 * This list is the runtime half of the exact-set assertion; the compile-time half
 * is the `Record<keyof NormalizedEvent, true>` literal in
 * tests/domain/classify.test.ts. Both are compared against each other, so a field
 * cannot be added to the interface without the list and the approved set
 * changing with it.
 */
export const ENVELOPE_FIELDS = [
  'harness',
  'sessionId',
  'repoShortName',
  'repoFullPath',
  'rawEventType',
  'class',
  'subtype',
  'occurredAt',
  'receivedAt',
  'dedupeKey',
] as const

export type EnvelopeField = (typeof ENVELOPE_FIELDS)[number]

/**
 * One normalized harness event, and the only shape that crosses from an adapter
 * into the store, the hub, the dashboard and the log.
 *
 * The ten fields are EL-FR-01's list, in EL-FR-01's order. None of them can hold
 * a prompt, a response, tool output or file content, and there is no optional
 * field with no writer: a speculative field is a field that can hold content
 * later, which is why there are none.
 *
 * `subtype` is nullable rather than an omitted optional property so the shape a
 * row renders always has the same key set, and so a needs-you or finished event
 * says plainly that it has no subtype instead of leaving the key undefined for
 * every consumer to handle. Only an fyi event may carry a subtype, and the
 * database refuses a subtype on any other class.
 *
 * This type is assignable to the store's NewEvent as it stands, so ingest passes
 * a classified envelope straight through without reshaping it (HC-FR-04).
 */
export interface NormalizedEvent {
  readonly harness: Harness
  readonly sessionId: string
  /** The session directory's basename: the primary label (APX-CON-09). */
  readonly repoShortName: string
  /** Carried for hover and focus detail; never a key (ADR-008). */
  readonly repoFullPath: string
  /** The harness's own event name, verbatim, so a row can be traced to its source. */
  readonly rawEventType: string
  readonly class: EventClass
  readonly subtype: FyiSubtype | null
  /** ISO 8601 UTC: when the signal happened. */
  readonly occurredAt: string
  /** ISO 8601 UTC: when the hub received it. Never part of the dedupe key. */
  readonly receivedAt: string
  /** Stable identity only. Two deliveries of one signal resolve to one event. */
  readonly dedupeKey: string
}
