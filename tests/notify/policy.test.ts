// The class policy: three classes, three answers, and the one of them that is "no"
// (NT-FR-01, NT-FR-02, NT-FR-08, ADR-004, ADR-010, APX-FR-01, APX-CON-04).
//
//   npm test -- tests/notify/policy.test.ts
//
// THE ACCEPTANCE CRITERIA, AND WHERE EACH IS PROVEN
//
//   1. "A test asserts an fyi request is refused by policy and never reaches a platform
//      notifier."
//      Two halves, because "never reaches" has two meanings. As a property of the plan: a
//      refused plan carries no request at all, so there is nothing to hand a platform.
//      And end to end through the composed notifier the composition root builds, with the
//      command runner recording every invocation: an fyi produces zero commands and one
//      refusal outcome. A test that only asserted the second would still pass if the
//      planner had rendered the fyi and the notifier had dropped it later.
//
//   2. "A test asserts the needs-you request sets the resident, non-auto-dismissing
//      flags and the finished request does not."
//      The flags are built in src/notify/linux.ts and asserted there, per class, against
//      the exact array. Here it is asserted where the decision is made: `needs-you` is
//      the only cell that is resident and critical, `finished` is the only one that
//      expires, and `fyi` is the only one that is refused - as properties of the table,
//      not as a restatement of its three rows.
//
//   3. "A test asserts the notify-send argument list contains no shell interpolation of
//      the title or body."
//      The argv is asserted in tests/notify/linux.test.ts, including against a real
//      process. Here the half that belongs to the policy is asserted: the two strings a
//      person reads are the only free text in a request, they are built from the
//      repository's short name and one sentence, and they reach a platform notifier as
//      values on discrete fields rather than as one string anybody could parse.
//
// The rest is what makes the above worth something:
//   - the table is total over the class union, and a class it does not carry throws rather
//     than defaulting (a default would be a fourth way a notification could be made)
//   - the rendered request carries exactly the six fields NT-FR-01 names, asserted by key
//     set, and nothing that could carry conversation content
//   - the deep link is `?session=<id>` on the live origin, percent-encoded, and null
//     before the socket is bound rather than built from a port nobody is listening on
//   - planning is pure: the same input gives the same plan, and no call of any kind
//     happens while producing one
//   - one request becomes one delivery and nothing re-fires it (NT-FR-08)
//   - no field of the policy or the request can ask for a sound, because no such field
//     exists (APX-CON-04)

import { describe, expect, it } from 'vitest'
import type { NotificationRequest as HubNotificationRequest } from '@/hub/delivery'
import { DEEP_LINK_QUERY_KEY } from '@/hub/metrics'
import { buildNotifySendCommand, createLinuxNotifier } from '@/notify/linux'
import {
  CLASS_POLICIES,
  FALLBACK_TITLE,
  decideNotification,
  deepLinkFor,
  planNotification,
  renderTitle,
  type NotificationDeliverPolicy,
  type NotificationPlanInput,
} from '@/notify/policy'
import { createPlatformNotifier, type ComposedNotifier } from '@/notify/registry'
import type { NotificationClass, NotificationCommand, NotificationCommandRunner } from '@/notify/types'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SESSION = 'ses_policy_01'
const ORIGIN = 'http://127.0.0.1:43717'
const REPO = 'agent-ping'
const REPO_PATH = '/home/dev/Projects/agent-ping'

const ALL_CLASSES: readonly NotificationClass[] = ['needs-you', 'finished', 'fyi']

function planInput(overrides: Partial<NotificationPlanInput> = {}): NotificationPlanInput {
  return {
    class: 'needs-you',
    repoShortName: REPO,
    origin: ORIGIN,
    sessionId: SESSION,
    ...overrides,
  }
}

/** The hub's own delivery request, which is what the composition root hands a notifier. */
function hubRequest(overrides: Partial<HubNotificationRequest> = {}): HubNotificationRequest {
  const eventClass = overrides.class ?? 'needs-you'
  return {
    event: {
      eventId: 'evt_policy_01',
      sessionId: SESSION,
      class: eventClass,
      subtype: null,
      rawEventType: 'permission.asked',
      occurredAt: '2026-09-26T09:00:00.000Z',
      receivedAt: '2026-09-26T09:00:00.000Z',
      dedupeKey: `opencode:${SESSION}:policy-1`,
      ackState: 'unacknowledged',
      resolutionState: 'unresolved',
    },
    class: eventClass,
    pendingCount: 1,
    repoShortName: REPO,
    origin: ORIGIN,
    source: 'event',
    ...overrides,
  }
}

/** A runner that records every command and reports a clean exit. */
function recordingRunner(): {
  readonly run: NotificationCommandRunner
  readonly commands: NotificationCommand[]
} {
  const commands: NotificationCommand[] = []
  const run: NotificationCommandRunner = (command) => {
    commands.push(command)
    return Promise.resolve({ code: 0, signal: null, spawnError: null, stderr: '' })
  }
  return { run, commands }
}

/** The composed notifier the composition root builds, over a recording runner. */
function composedOver(
  run: NotificationCommandRunner,
): ComposedNotifier {
  const resolution = createPlatformNotifier({ platform: 'linux', run })
  if (!resolution.supported) throw new Error(`expected a supported platform: ${resolution.reason}`)
  return resolution.notifier
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

describe('the class policy is one table, and it is total', () => {
  it('carries a cell for every class, and a fourth class is a compile error', () => {
    // Enumerated against the class union rather than restated: a cell for a class the
    // classifier cannot produce, or a missing one, is what this catches.
    expect(Object.keys(CLASS_POLICIES).sort()).toEqual([...ALL_CLASSES].sort())
  })

  it('refuses exactly one class, and refuses fyi', () => {
    // The property NT-FR-02 states, as a property. Restating the three rows would pass
    // even if the table gained a fourth refusal nobody had reviewed.
    const refused = ALL_CLASSES.filter((name) => decideNotification(name).kind === 'refuse')
    expect(refused).toEqual(['fyi'])
  })

  it('makes needs-you the only resident critical cell, and finished the only expiring one', () => {
    // The other half of the class policy: the two delivered classes differ in exactly the
    // two ways that make a block findable and a finished turn forgettable (ADR-004).
    const delivered = (predicate: (policy: NotificationDeliverPolicy) => boolean): NotificationClass[] =>
      ALL_CLASSES.filter((name) => {
        const policy = CLASS_POLICIES[name]
        return policy.kind === 'deliver' && predicate(policy)
      })
    expect(delivered((policy) => policy.persistence === 'resident')).toEqual(['needs-you'])
    expect(delivered((policy) => policy.urgency === 'critical')).toEqual(['needs-you'])
    expect(delivered((policy) => policy.persistence === 'expires')).toEqual(['finished'])
    expect(delivered((policy) => policy.urgency === 'normal')).toEqual(['finished'])
  })

  it('throws for a class the table does not carry rather than defaulting', () => {
    // A default here would be a fourth way a notification could be made, which is the
    // shape NT-FR-08 and ADR-004 exist to prevent.
    expect(() => decideNotification('compacted' as NotificationClass)).toThrowError(
      /unhandled notification class/,
    )
  })

  it('carries no repeat and no sound anywhere in a cell', () => {
    // NT-FR-08 and APX-CON-04 as table properties: nothing schedules anything, and
    // nothing asks a desktop for a sound. A cell that grew a `repeat` or a `sound` key
    // would fail this before it reached a command line.
    for (const [name, policy] of Object.entries(CLASS_POLICIES)) {
      const keys = Object.keys(policy).sort()
      if (policy.kind === 'deliver') {
        expect(keys, name).toEqual(['body', 'kind', 'persistence', 'reason', 'urgency'])
      } else {
        expect(keys, name).toEqual(['kind', 'reason'])
      }
      expect(
        keys.some((key) => /sound|audio|bell|repeat|timer|interval/i.test(key)),
        name,
      ).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

describe('a delivered plan is two lines and four flags, and nothing else', () => {
  it('carries exactly the six fields NT-FR-01 names', () => {
    const plan = planNotification(planInput())
    expect(plan.kind).toBe('deliver')
    if (plan.kind !== 'deliver') throw new Error('expected a delivered plan')
    expect(Object.keys(plan.request).sort()).toEqual([
      'body',
      'class',
      'deepLink',
      'persistence',
      'title',
      'urgency',
    ])
  })

  it('titles a toast with the repository short name and one sentence, and no counts', () => {
    const plan = planNotification(planInput())
    if (plan.kind !== 'deliver') throw new Error('expected a delivered plan')
    expect(plan.request.title).toBe(REPO)
    // One sentence, naming the kind of block. The feature's own rule: no counts in a
    // toast, no stack of text, no buttons.
    expect(plan.request.body).toBe('A session is blocked and needs a decision from you.')
    expect(plan.request.body.split('.').filter((part) => part.trim() !== '')).toHaveLength(1)
    expect(plan.request.body).not.toMatch(/\d/)
  })

  it('never puts a path, a session identifier or a harness name in a toast', () => {
    for (const name of ALL_CLASSES) {
      const plan = planNotification(planInput({ class: name }))
      if (plan.kind !== 'deliver') continue
      const rendered = `${plan.request.title} ${plan.request.body}`
      expect(rendered).not.toContain(REPO_PATH)
      expect(rendered).not.toContain('/home/')
      expect(rendered).not.toContain(SESSION)
      expect(rendered.toLowerCase()).not.toContain('opencode')
    }
  })

  it('falls back to the product name when the session row could not be read', () => {
    // A repository name is not a reason to withhold a block from a developer; the hub
    // answers null for an unreadable session row and the toast still says something true.
    expect(renderTitle(null)).toBe(FALLBACK_TITLE)
    expect(renderTitle('   ')).toBe(FALLBACK_TITLE)
    expect(planNotification(planInput({ repoShortName: null }))).toMatchObject({
      kind: 'deliver',
      request: { title: FALLBACK_TITLE },
    })
  })

  it('trims a short name rather than rendering the padding around it', () => {
    expect(planNotification(planInput({ repoShortName: '  agent-ping  ' }))).toMatchObject({
      request: { title: REPO },
    })
  })

  it('is pure: the same input plans the same request, and the input is not changed', () => {
    const input = planInput()
    const before = JSON.stringify(input)
    expect(planNotification(input)).toEqual(planNotification(input))
    expect(JSON.stringify(input)).toBe(before)
  })
})

// ---------------------------------------------------------------------------
// The deep link
// ---------------------------------------------------------------------------

describe('the deep link is the published contract, or nothing', () => {
  it('uses the parameter name the hub counts and the dashboard reads', () => {
    // One name, published by src/hub/metrics.ts, so the notifier that builds the link,
    // the dashboard that resolves it and the counter that observes it cannot disagree
    // (NT-FR-07, HC-6, LD-3). Spelling it here would be a second contract.
    expect(deepLinkFor(ORIGIN, SESSION)).toBe(`${ORIGIN}/?${DEEP_LINK_QUERY_KEY}=${SESSION}`)
  })

  it('is carried on the request for a delivered class', () => {
    expect(planNotification(planInput())).toMatchObject({
      request: { deepLink: `${ORIGIN}/?${DEEP_LINK_QUERY_KEY}=${SESSION}` },
    })
  })

  it('is null before the socket is bound, rather than built from a preferred port', () => {
    // A link to a port nobody is listening on sends a developer to whatever else on
    // this machine answers there, which is the one thing a loopback sidecar must not do
    // (APX-CON-01, HC-FR-01).
    expect(deepLinkFor('', SESSION)).toBeNull()
    expect(deepLinkFor('   ', SESSION)).toBeNull()
    expect(planNotification(planInput({ origin: '' }))).toMatchObject({ request: { deepLink: null } })
  })

  it('percent-encodes a target rather than pasting it into the query', () => {
    const link = deepLinkFor(ORIGIN, 'ses a&b=c d')
    expect(link).not.toBeNull()
    expect(new URL(String(link)).searchParams.get(DEEP_LINK_QUERY_KEY)).toBe('ses a&b=c d')
  })

  it('survives an origin that arrived with a trailing slash', () => {
    expect(deepLinkFor(`${ORIGIN}/`, SESSION)).toBe(`${ORIGIN}/?${DEEP_LINK_QUERY_KEY}=${SESSION}`)
  })
})

// ---------------------------------------------------------------------------
// The refusal
// ---------------------------------------------------------------------------

describe('an fyi is refused by policy and never reaches a platform notifier', () => {
  it('produces a plan with no request in it, so there is nothing to deliver', () => {
    const plan = planNotification(planInput({ class: 'fyi' }))
    expect(plan.kind).toBe('refuse')
    // The structural half of the claim: a refused plan has no `request` key at all.
    expect(Object.keys(plan).sort()).toEqual(['kind', 'policy'])
    expect(plan).toMatchObject({ policy: { kind: 'refuse', reason: 'refused-in-app-only' } })
  })

  it('runs no command at all, and reports the refusal with its reason', async () => {
    // The end-to-end half, through the composed notifier the composition root builds.
    const { run, commands } = recordingRunner()
    const outcome = await composedOver(run)(hubRequest({ class: 'fyi' }))
    expect(commands).toEqual([])
    expect(outcome).toEqual({ status: 'refused', reason: 'refused-in-app-only', platform: 'linux' })
    // Nothing was rendered, so nothing could have been spoken: no title, no body, no
    // command to inspect.
    expect(Object.keys(outcome).sort()).toEqual(['platform', 'reason', 'status'])
  })

  it('runs one command for a block and one for a finished turn, and refuses the third', async () => {
    // The same end-to-end check for all three classes, so the refusal above is a
    // difference in behaviour rather than a notifier that never does anything.
    const { run, commands } = recordingRunner()
    const notifier = composedOver(run)
    const outcomes = [
      await notifier(hubRequest({ class: 'needs-you' })),
      await notifier(hubRequest({ class: 'finished' })),
      await notifier(hubRequest({ class: 'fyi' })),
    ]
    expect(commands).toHaveLength(2)
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['delivered', 'delivered', 'refused'])
    expect(commands[0]?.args).toContain('--hint=boolean:resident:true')
    expect(commands[1]?.args).not.toContain('--hint=boolean:resident:true')
  })

  it('refuses an fyi even when a platform notifier is handed one directly', async () => {
    // Defence in depth at the second gate, decided from the same table rather than a
    // second policy: a caller that skipped the planner still cannot get an fyi onto a
    // command line (NT-FR-02, ADR-004).
    const { run, commands } = recordingRunner()
    const outcome = await createLinuxNotifier({ run })({
      class: 'fyi',
      title: REPO,
      body: 'a sentence that must never be spoken',
      urgency: 'normal',
      deepLink: null,
      persistence: 'expires',
    })
    expect(commands).toEqual([])
    expect(outcome).toMatchObject({ status: 'refused', reason: 'refused-in-app-only' })
  })
})

// ---------------------------------------------------------------------------
// One request, one delivery
// ---------------------------------------------------------------------------

describe('planning one request produces one delivery and no repeat', () => {
  it('issues exactly one command for one request', async () => {
    // NT-FR-08: one needs-you toast per block, with persistence carried by the badge and
    // the history rather than by re-firing. Nothing here schedules anything, so the
    // observable claim is that a single request is a single command.
    const { run, commands } = recordingRunner()
    await composedOver(run)(hubRequest())
    expect(commands).toHaveLength(1)
  })

  it('carries the two lines as two discrete arguments, never as one joined string', () => {
    // The policy's half of "no shell interpolation": the strings a person reads arrive
    // at the command as values, one each, and no single argument contains both.
    // tests/notify/linux.test.ts proves what a real process makes of that.
    const plan = planNotification(planInput())
    if (plan.kind !== 'deliver') throw new Error('expected a delivered plan')
    const command = buildNotifySendCommand(plan.request)
    expect(command.args).toContain(plan.request.title)
    expect(command.args).toContain(plan.request.body)
    // The last two arguments are the two lines, in order, after the `--` terminator, and
    // no single argument carries both - which is what "not joined into a command string"
    // means from this side of the boundary.
    expect(command.args.slice(-2)).toEqual([plan.request.title, plan.request.body])
    expect(
      command.args.some((arg) => arg.includes(plan.request.title) && arg.includes(plan.request.body)),
    ).toBe(false)
  })
})
