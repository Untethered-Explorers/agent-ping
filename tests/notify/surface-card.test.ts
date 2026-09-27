// The card's model: what a card says, built purely from the delivery plan, and the
// source-level sweep that keeps the whole notification path off every platform
// notification mechanism (NT-FR-01, NT-FR-02, NT-FR-11, APX-FR-01, ADR-003, ADR-004,
// ADR-008, ADR-012).
//
//   npm test -- tests/notify/surface-card.test.ts
//
// WHAT THIS SUITE OWNS, AND WHY THE SWEEP IS HERE
// Two of NT-7's seven criteria are about the model and the words on a card; the other
// five are split across the other two suites. The source-level sweep lives here because
// it is the criterion that is about the *whole* notification path rather than about one
// file: NT-FR-11 says a test asserts it, and a test in a per-module suite cannot. One
// suite reads every module under src/notify and answers it once, so a seventh file
// cannot join the notification path without this file noticing.
//
// THE SEVEN ACCEPTANCE CRITERIA OF NT-7, AND WHERE EACH IS PROVEN
//
//   1. lifetime table total, throws for a class it does not carry
//      tests/notify/surface-lifetime.test.ts
//   2. the needs-you cell has no re-arming timer; finished expires on a fixed interval
//      tests/notify/surface-lifetime.test.ts
//   3. "a rendered card carries the repository short name and one sentence and no count,
//      path, session identifier or harness name"
//      `the card is the two lines the policy decided` below for the model, and
//      tests/notify/surface-card-view.test.ts for what the document actually shows.
//   4. focusable, a role, an accessible name, urgency as an icon and a word
//      `urgency is an icon and a word` and `the accessible name` below for the words,
//      and tests/notify/surface-card-view.test.ts for the DOM.
//   5. the view writes no inline style
//      tests/notify/surface-card-view.test.ts, in the rendered subtree and in the
//      module's source; the last describe here covers the whole tree.
//   6. a card is removed when its lifetime ends and when the host is destroyed
//      tests/notify/surface-card-view.test.ts
//   7. "no notification API call, no audio element, no notify-send, osascript or powershell
//      string and no inline style exists anywhere under src/notify"
//      `the notification path reaches no platform notification mechanism`, below.
//
// ONE THING THIS SUITE DELIBERATELY DOES NOT CLAIM
// The four platform notifiers NT-8 deletes are still in the tree, so the literal form of
// criterion 7 - clean everywhere under src/notify - cannot hold until NT-8 lands, and
// NT-7 excludes that deletion. What is asserted instead is stronger than a promise and
// narrower than a fiction: the surface path is clean file by file, and the set of modules
// anywhere under src/notify that still reach a withdrawn mechanism is *enumerated* and
// asserted to be exactly the six files NT-8 removes or rewrites. A seventh joins that set
// and this test fails; NT-8 empties the list and it passes with the literal claim. The
// gap is recorded in the code, not left in a comment somewhere else.

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  buildCardModel,
  cardAccessibleName,
  cardUrgency,
  CARD_TEXT_FIELDS,
  CARD_URGENCY,
  type CardModel,
} from '@/notify/surface/card'
import { cardLifetimeFor } from '@/notify/surface/lifetime'
import { CLASS_POLICIES, planNotification, type NotificationPlan } from '@/notify/policy'
import { NOTIFICATION_APP_NAME, type NotificationUrgency } from '@/notify/types'

/**
 * A repository-relative path, resolved through node:path rather than `new URL`.
 *
 * `new URL(relative, import.meta.url)` is rewritten by Vite's asset handling and does not
 * survive a change of test environment - the jsdom suite proved that - so the repository
 * root is resolved once from this file's own location and everything else hangs off it.
 */
const REPOSITORY_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..')

function repositoryPath(relative: string): string {
  return resolvePath(REPOSITORY_ROOT, relative)
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SESSION = 'ses_card_01'
const ORIGIN = 'http://127.0.0.1:43117'
const PENDING = 3
const HARNESS = 'opencode'

/** A real delivery plan, built by the real class policy from the real input shape. */
function plan(overrides: Partial<Parameters<typeof planNotification>[0]> = {}) {
  return planNotification({
    class: 'needs-you',
    repoShortName: 'agent-ping',
    origin: ORIGIN,
    sessionId: SESSION,
    ...overrides,
  })
}

/** A model for the class a plan is built from, or null when the class is refused. */
function modelFor(overrides: Parameters<typeof plan>[0] = {} as Parameters<typeof plan>[0], pending = PENDING): CardModel | null {
  return buildCardModel(plan(overrides), pending)
}

// ---------------------------------------------------------------------------
// Criterion 3: the model's two lines, and what it must never carry
// ---------------------------------------------------------------------------

describe('the card is the two lines the policy decided', () => {
  it('is the plan\'s five fields, and nothing else', () => {
    // Enumerated from the model rather than restated: a sixth field added for
    // convenience fails here instead of reaching a screen.
    const model = buildCardModel(plan(), PENDING) as CardModel
    expect(Object.keys(model).sort()).toEqual(['body', 'deepLink', 'pendingCount', 'title', 'urgency'])
    expect(Object.isFrozen(model)).toBe(true)
  })

  it('takes its title, body and urgency from the class policy cell', () => {
    for (const eventClass of ['needs-you', 'finished'] as const) {
      const policy = CLASS_POLICIES[eventClass]
      const model = modelFor({ class: eventClass })
      if (model === null) throw new Error(`the ${eventClass} class must render a card`)
      expect(model.title).toBe('agent-ping')
      // The sentence is the policy cell's own, not a second table in this file.
      expect(model.body).toBe(policy.kind === 'deliver' ? policy.body : null)
      expect(model.urgency).toBe(policy.kind === 'deliver' ? policy.urgency : null)
    }
  })

  it('is the repository short name, never a path', () => {
    expect(modelFor({ repoShortName: 'knowledge-dungeon' })?.title).toBe('knowledge-dungeon')
    // A path reaching the title is the APX-FR-01 leak: a home directory on a screen and
    // in a screenshot of it. The model refuses it rather than trimming it, because a
    // trimmed path is still a path.
    expect(() => modelFor({ repoShortName: '/home/dev/Projects/agent-ping' })).toThrow(/may not be a filesystem path/)
    expect(() => modelFor({ repoShortName: 'C:\\Users\\dev\\agent-ping' })).toThrow(/may not be a filesystem path/)
  })

  it("falls back to this product's own name when the short name could not be read", () => {
    // src/hub/delivery.ts answers null when the session row read fails, and a missing
    // repository name is not a reason to withhold a block from a developer.
    expect(modelFor({ repoShortName: null })?.title).toBe(NOTIFICATION_APP_NAME)
    expect(modelFor({ repoShortName: '   ' })?.title).toBe(NOTIFICATION_APP_NAME)
  })

  it('refuses a two-line title or body, because a card is two lines', () => {
    expect(() => modelFor({ repoShortName: 'agent-ping\nsecret' })).toThrow(/may not span lines/)
    // The body is reachable on a hand-built plan only, because the class policy writes
    // every sentence itself. A caller with a sentence of their own is the case the guard
    // exists for.
    const delivered = deliveredPlan()
    const wrapped: NotificationPlan = {
      kind: 'deliver',
      policy: delivered.policy,
      request: { ...delivered.request, body: 'A session is blocked,\nand here is a stack trace.' },
    }
    expect(() => buildCardModel(wrapped, PENDING)).toThrow(/may not span lines/)
  })

  it('refuses a blank title, so a caller cannot bypass the fallback', () => {
    // The plan builder falls back before this point, so the guard is only reachable by a
    // hand-built plan - which is exactly why it is asserted on one.
    const delivered = deliveredPlan()
    const blank: NotificationPlan = {
      kind: 'deliver',
      policy: delivered.policy,
      request: { ...delivered.request, title: '   ' },
    }
    expect(() => buildCardModel(blank, PENDING)).toThrow(/may not be blank/)
  })

  it('carries the count without printing it, and never a number that is not the count', () => {
    const model = buildCardModel(plan(), 17) as CardModel
    expect(model.pendingCount).toBe(17)
    // The count is a fact the model knows and the card does not print: the badge and the
    // dashboard carry it, and a number in a card is a second place a count exists that
    // is wrong the moment a second block arrives.
    expect(CARD_TEXT_FIELDS).toEqual(['title', 'body'])
    expect(`${model.title} ${model.body}`).not.toMatch(/17/)
    // And it refuses a value that is not a count rather than rendering a made-up one.
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => buildCardModel(plan(), bad)).toThrow(RangeError)
    }
  })

  it('carries the deep link, and none at all before the socket is bound', () => {
    expect((buildCardModel(plan(), PENDING) as CardModel).deepLink).toBe(`${ORIGIN}/?session=${SESSION}`)
    // Null rather than a link built from a port that was only a preference: a developer
    // sent to whatever else answers on this machine is the one thing a loopback sidecar
    // must never do (APX-CON-01, HC-FR-01).
    expect((buildCardModel(plan({ origin: '' }), PENDING) as CardModel).deepLink).toBeNull()
  })

  it('produces nothing at all for a refused plan, so an fyi has no card to render', () => {
    // Structural rather than a branch: the refused plan carries no request, so there are
    // no words to copy. A caller that ignored the null would render an empty card, which
    // is visible; inventing words for an fyi is not reachable from here (NT-FR-02).
    expect(buildCardModel(plan({ class: 'fyi' }), PENDING)).toBeNull()
    // And it is the only class the table refuses.
    const refused = Object.entries(CLASS_POLICIES)
      .filter(([, policy]) => policy.kind === 'refuse')
      .map(([eventClass]) => eventClass)
    expect(refused).toEqual(['fyi'])
    for (const eventClass of refused) {
      expect(buildCardModel(plan({ class: eventClass as 'fyi' }), PENDING)).toBeNull()
      expect(cardLifetimeFor(eventClass as 'fyi').rendered).toBe(false)
    }
  })

  it('carries no harness name, because nothing about a harness reaches a card', () => {
    const model = buildCardModel(plan(), PENDING) as CardModel
    // The two lines a person reads, checked for the three things that must never appear
    // on a screen: a harness name, a tool or permission name, and a path.
    const text = `${model.title} ${model.body}`
    expect(text).not.toContain(HARNESS)
    expect(text).not.toContain('permission')
    expect(text).not.toContain('/')
    // The session identifier exists only inside the loopback deep link, and there as a
    // query value: a loopback host, no path, and nothing the hub ever reads back
    // (APX-CON-01, APX-FR-01).
    const link = new URL(String(model.deepLink))
    expect(link.host).toBe('127.0.0.1:43117')
    expect(link.pathname).toBe('/')
    expect(link.searchParams.get('session')).toBe(SESSION)
  })
})

/**
 * The delivered half of a real plan, for the two cases only a hand-built plan reaches.
 *
 * The refusal in the type is kept rather than cast away, so these cases cannot be written
 * against a plan shape this product does not actually produce.
 */
function deliveredPlan(): Extract<NotificationPlan, { readonly kind: 'deliver' }> {
  const built = plan()
  if (built.kind !== 'deliver') throw new Error('a deliver plan was expected')
  return built
}

// ---------------------------------------------------------------------------
// Criterion 4: urgency as an icon and a word
// ---------------------------------------------------------------------------

describe('urgency is an icon and a word', () => {
  it('is total over the urgency union, with a distinct icon and word for each', () => {
    // Compared against the union itself, so a new urgency is a compile error here and a
    // failing test there rather than a card with no shape and no word.
    expect(Object.keys(CARD_URGENCY).sort()).toEqual(['critical', 'low', 'normal'])
    for (const urgency of Object.keys(CARD_URGENCY) as NotificationUrgency[]) {
      const encoding = cardUrgency(urgency)
      expect(encoding.icon.length).toBeGreaterThan(0)
      expect(encoding.word.length).toBeGreaterThan(1)
      // Not the same glyph twice: two urgencies sharing an icon would be distinguished by
      // colour, which is the thing this encoding exists to avoid.
      expect(encoding.icon).not.toBe(encoding.word)
      // A one-glyph icon, so it cannot be mistaken for a word, and a readable word, so
      // it cannot be mistaken for a symbol.
      expect([...encoding.icon]).toHaveLength(1)
      expect(/^[A-Za-z]/.test(encoding.word)).toBe(true)
    }
    const icons = Object.values(CARD_URGENCY).map((encoding) => encoding.icon)
    expect(new Set(icons).size).toBe(icons.length)
    const words = Object.values(CARD_URGENCY).map((encoding) => encoding.word)
    expect(new Set(words).size).toBe(words.length)
  })

  it('says "needs you" for the class that blocks, in words rather than symbols', () => {
    // The product's own vocabulary: a permission name or a harness word would be
    // harness vocabulary leaking onto a screen (ADR-004, ADR-003).
    expect(cardUrgency('critical').word).toBe('Needs you')
    expect(cardUrgency('normal').word).toBe('Finished')
    expect((buildCardModel(plan(), PENDING) as CardModel).urgency).toBe('critical')
  })

  it('throws for an urgency the table does not carry, rather than rendering no icon', () => {
    expect(() => cardUrgency('apocalyptic' as NotificationUrgency)).toThrow(/unhandled card urgency/)
    expect(() => cardUrgency('apocalyptic' as NotificationUrgency)).toThrow(/urgency with no icon and no word/)
  })
})

// ---------------------------------------------------------------------------
// Criterion 4: the accessible name
// ---------------------------------------------------------------------------

describe('the accessible name', () => {
  it('is the urgency, the repository and the sentence, in that order', () => {
    const model = buildCardModel(plan(), PENDING) as CardModel
    expect(cardAccessibleName(model)).toBe('Needs you: agent-ping. A session is blocked and needs a decision from you.')
  })

  it('carries no count, no path, no session identifier and no origin', () => {
    // The name is what a screen reader announces, so anything that must never be on a
    // screen must not be in it. Built with a large count and the real deep link, because
    // those are the two values a name could plausibly pick up by accident.
    const model = buildCardModel(plan(), 128) as CardModel
    const name = cardAccessibleName(model)
    expect(name).toContain('agent-ping')
    expect(name).toContain(model.body)
    expect(name).not.toMatch(/\d/)
    expect(name).not.toContain(SESSION)
    expect(name).not.toContain('http')
    expect(name).not.toContain('/')
    expect(name).not.toContain(HARNESS)
  })

  it('reads the same three values the card shows, so the two cannot drift', () => {
    // The name is built from the model rather than from the DOM, so a stylesheet cannot
    // change what is announced and a re-render cannot change it either.
    const model = buildCardModel(plan({ repoShortName: 'knowledge-dungeon' }), 1) as CardModel
    const name = cardAccessibleName(model)
    for (const part of [cardUrgency(model.urgency).word, model.title, model.body]) {
      expect(name).toContain(part)
    }
  })
})

// ---------------------------------------------------------------------------
// Criterion 7: the whole notification path, read from source
// ---------------------------------------------------------------------------

/** Every TypeScript module under src/notify, as a path relative to the repository root. */
function notifyModules(directory = 'src/notify'): string[] {
  const found: string[] = []
  for (const entry of readdirSync(repositoryPath(directory), { withFileTypes: true })) {
    const relative = `${directory}/${entry.name}`
    if (entry.isDirectory()) {
      found.push(...notifyModules(relative))
      continue
    }
    // `.cts` as well as `.ts` (NS-2): the preload is CommonJS and is the only module on
    // this path that runs inside a renderer, so a sweep that read only `.ts` was not
    // reading the file most worth reading.
    if (entry.name.endsWith('.ts') || entry.name.endsWith('.cts')) found.push(relative)
  }
  return found.sort()
}


/**
 * Every call a forbidden mechanism would be reached through.
 *
 * Each entry is a substring of code, not a word, because the point is to catch the call
 * rather than the vocabulary. `new Notification` is a call and a word; `Audio` alone would
 * be matched by this product's own prose.
 */
const FORBIDDEN_CALLS = [
  // With the parenthesis, so it is the *call* and not this product's own type names:
  // `new NotificationFailedError(...)` is the hub's failure record, not a notification.
  'new Notification(',
  'Notification.requestPermission',
  'requestPermission',
  'showNotification',
  'setNotificationHandler',
  'UNUserNotificationCenter',
  'NotificationCenter',
  'new Audio',
  'Audio(',
  '<audio',
  'HTMLAudioElement',
  'AudioContext',
  'navigator.vibrate',
  'vibrate(',
  'child_process',
  'spawn(',
  'execFile',
  'exec(',
  'fork(',
  'process.platform',
  'process.arch',
  'os.platform',
  // Inline style. `style=` covers markup, `.style` covers the CSSOM, `setProperty(` the
  // long way round, and the attribute form the one loophole a strict policy still allows
  // nothing through.
  '.style',
  'cssText',
  'setProperty(',
  "setAttribute('style'",
  'setAttribute("style"',
  'style=',
  'terminal bell',
  '\u0007',
] as const

/**
 * The tools this product stopped using, by name.
 *
 * NT-FR-11 says the test asserts "none of the names of the tools that were removed", so
 * the names are the assertion and not a summary of it (ADR-012).
 */
const WITHDRAWN_TOOL_NAMES = [
  'notify-send',
  'osascript',
  'powershell',
  'pwsh',
  'terminal-notifier',
  'msg.exe',
  'wsl-notify-send',
  'ToastGeneric',
  'libnotify',
  'dbus-send',
] as const

/**
 * The modules under src/notify that may still reach a withdrawn mechanism.
 *
 * Empty, and kept as a named list rather than deleted, because NT-7 could only state
 * NT-FR-11's literal form as "the surface path is clean file by file, and these six are
 * the only ones allowed to be unclean". NT-8 deleted five of them and rewrote the
 * sixth, so the honest form is now the literal one: nothing under src/notify reaches a
 * platform notification mechanism. A seventh file reaching one fails this list, and so
 * does a new module that reaches one without being added here (ADR-012).
 */
const MODULES_PENDING_THE_PLATFORM_REMOVAL: readonly string[] = []

/** The modules under src/notify/surface: the surface path, and the card's own code. */
function surfaceModules(): string[] {
  return notifyModules().filter((file) => file.startsWith('src/notify/surface/'))
}

describe('the notification path reaches no platform notification mechanism', () => {
  it('reads every module under src/notify, and says which it read', () => {
    // The sweep is only as good as its coverage, so the file list is asserted rather than
    // assumed: the six surface modules of NT-6 and NT-7, the class policy, the surface
    // notifier NT-8 built, and the notifier's own vocabulary. Nine modules, and the
    // count is stated so a tenth one fails here rather than being swept in silence.
    const modules = notifyModules()
    expect(modules).toEqual(
      expect.arrayContaining([
        'src/notify/surface/host.ts',
        'src/notify/surface/electron-host.ts',
        'src/notify/surface/position.ts',
        'src/notify/surface/lifetime.ts',
        'src/notify/surface/card.ts',
        'src/notify/surface/card-view.ts',
        // NS-2 added these three: the channel contract, the preload that carries a card
        // into the document, and the module that says where that preload is. All three are
        // on the notification path, and the preload is the only one of them that runs
        // inside a renderer - so they are swept, not exempted.
        'src/notify/surface/channel.ts',
        'src/notify/surface/preload.cts',
        'src/notify/surface/preload.ts',
        'src/notify/policy.ts',
        'src/notify/registry.ts',
        'src/notify/types.ts',
      ]),
    )
    expect(modules).toHaveLength(12)
  })

  it('has no notification API call, no audio and no spawned command on the surface path', () => {
    // NT-FR-02 and NT-FR-11, enforced by the suite rather than promised in a comment.
    // The surface path is the notification path after ADR-012, and it is checked file by
    // file so a new module under src/notify/surface is covered the day it is added.
    for (const file of surfaceModules()) {
      const source = readModuleWithoutProse(file)
      for (const forbidden of FORBIDDEN_CALLS) {
        expect(source.includes(forbidden), `${file} must not contain ${forbidden}`).toBe(false)
      }
    }
  })

  it('names no withdrawn tool on the surface path', () => {
    for (const file of surfaceModules()) {
      const source = readModuleWithoutProse(file)
      for (const tool of WITHDRAWN_TOOL_NAMES) {
        expect(source.toLowerCase().includes(tool), `${file} must not name ${tool}`).toBe(false)
      }
    }
  })

  it('keeps the surface path to one implementation, with no per-platform branch', () => {
    // APX-CON-06 and ADR-012: what differs between the three desktops is window-manager
    // behaviour, and this product makes no decision per platform. A branch here would be
    // the start of the second and third delivery path this decision deleted.
    for (const file of surfaceModules()) {
      const source = readModuleWithoutProse(file)
      for (const platform of ["'linux'", "'darwin'", "'win32'", "'macos'", "'windows'"]) {
        expect(source.includes(platform), `${file} must not branch on ${platform}`).toBe(false)
      }
    }
  })

  it('reaches a withdrawn mechanism nowhere under src/notify, and the exemption list is empty', () => {
    // The literal form of criterion 7, which NT-7 could only state as an exemption list:
    // the computed set of offenders is compared with the list in both directions, so a
    // new offender fails and so does a new entry added to excuse one. NT-8 deleted the
    // platform notifiers and rewrote this module, which is what emptied the list
    // (ADR-012, NT-FR-11).
    const offending = notifyModules().filter((file) => {
      const source = readModuleWithoutProse(file)
      return (
        FORBIDDEN_CALLS.some((forbidden) => source.includes(forbidden)) ||
        WITHDRAWN_TOOL_NAMES.some((tool) => source.toLowerCase().includes(tool)) ||
        ["'linux'", "'darwin'", "'win32'", "'macos'", "'windows'"].some((platform) => source.includes(platform))
      )
    })
    expect(offending).toEqual([...MODULES_PENDING_THE_PLATFORM_REMOVAL])
    expect(MODULES_PENDING_THE_PLATFORM_REMOVAL).toEqual([])
  })

  it('writes no inline style anywhere under src/notify', () => {
    // Separate from the sweep above because inline style is a *this task* property: the
    // card has to render under `style-src 'self'`, and no module on the path may quietly
    // set up the habit that would break it.
    for (const file of notifyModules()) {
      const source = readModuleWithoutProse(file)
      for (const forbidden of ['.style', 'cssText', 'setProperty(', 'style=', "setAttribute('style'"]) {
        expect(source.includes(forbidden), `${file} must not contain ${forbidden}`).toBe(false)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// The source reader
// ---------------------------------------------------------------------------

/**
 * One product source file with its comments removed and its strings kept.
 *
 * Comments go because a source-level check is about the calls a module makes, not about
 * the sentences describing them - and this repository's prose names every forbidden tool
 * it deliberately avoids, so keeping comments would make the check fail on its own
 * documentation. Strings stay, because a forbidden *name* is most often only ever a
 * string.
 *
 * The walk tracks the three states a line of TypeScript can be in - a line comment, a
 * block comment, or a string - and replaces comment bodies with spaces, preserving
 * newlines so a failure's line numbers still point at the line being looked at. A `//`
 * inside a string such as `http://127.0.0.1` cannot end the scan, because the scanner
 * knows it is inside a string when it gets there.
 *
 * Known limitation, stated rather than hidden: a backtick template is read as one string
 * to its closing backtick, so a nested template inside a `${...}` would end the scan
 * early. No module on this path contains one, and a missed token would still be caught by
 * the same token in the value the code then uses.
 */
function readModuleWithoutProse(relative: string): string {
  const source = readFileSync(repositoryPath(relative), 'utf8')
  let out = ''
  let index = 0
  const blank = (length: number): void => {
    for (let offset = 0; offset < length; offset += 1) out += source[index + offset] === '\n' ? '\n' : ' '
  }
  while (index < source.length) {
    const pair = source.slice(index, index + 2)
    if (pair === '//') {
      let end = source.indexOf('\n', index)
      if (end === -1) end = source.length
      blank(end - index)
      index = end
      continue
    }
    if (pair === '/*') {
      const found = source.indexOf('*/', index + 2)
      const stop = found === -1 ? source.length : found + 2
      blank(stop - index)
      index = stop
      continue
    }
    const character = source[index] ?? ''
    if (character === "'" || character === '"' || character === '`') {
      let cursor = index + 1
      while (cursor < source.length) {
        const inner = source[cursor]
        if (inner === '\\') {
          cursor += 2
          continue
        }
        if (inner === character || inner === '\n') break
        cursor += 1
      }
      const stop = Math.min(cursor + 1, source.length)
      out += source.slice(index, stop)
      index = stop
      continue
    }
    out += character
    index += 1
  }
  return out
}
