// DP-3: keyboard order, activation and the motion policy, driven through the real
// mount entry point.
//
//   npm test -- tests/dashboard/keyboard-nav.test.ts
//
// What is asserted here, and what is not:
//
//   - Traversal visits rows in the canvas's visual order, with the arrows, Home
//     and End, and Tab is left alone so the list is one tab stop rather than
//     three.
//   - Activation is observable: on the element, in the controller's state, and
//     through the callback the surface wires to its real behaviour. It performs
//     nothing, because on a static row there is nothing to perform.
//   - Focus reveals the repository's full path, exactly as hover does, and
//     traversal inside the list is not treated as leaving it.
//   - A reduced-motion preference suppresses the non-essential movement and leaves
//     the state change visible, is re-read when it changes while the page is open,
//     and paints the same picture either way.
//   - Teardown takes the keyboard model, the mirror and the stylesheet with it.
//
// What cannot be asserted in jsdom: the browser's own focus ring, and whether a
// transition actually runs. jsdom applies no layout and no animation, so the
// stylesheet is asserted as text and the reduced-motion decision is asserted where
// it is made, in the mode written to the DOM.

import { afterEach, describe, expect, it } from 'vitest'
import { MIRROR_ROOT_ATTRIBUTE, MIRROR_ROW_ATTRIBUTE, MIRROR_STYLE_ATTRIBUTE } from '@/dashboard/a11y/dom-mirror'
import { ACTIVATION_KEYS, NAVIGATION_KEYS, applyRovingTabIndex } from '@/dashboard/a11y/keyboard-nav'
import { STATE_ENCODING } from '@/dashboard/prototype/scene'
import {
  MOTION_STATE_CHANGE_ATTRIBUTE,
  NON_ESSENTIAL_MOTION,
  REDUCED_MOTION_MEDIA_QUERY,
  STATE_CHANGE_MODE,
  motionAttribute,
  prefersReducedMotion,
} from '@/dashboard/theme/motion'
import {
  MIRROR_ACTIVATIONS_ATTRIBUTE,
  MIRROR_ACTIVATED_CLASS,
  MIRROR_FOCUSED_ATTRIBUTE,
  MIRROR_FOCUSED_CLASS,
  MIRROR_STATE_LABEL_ATTRIBUTE,
  createRowList,
  destroyMounted,
  mountRecordingPrototype,
  textCommands,
} from './prototype-harness'

afterEach(() => {
  destroyMounted()
})

const key = (init: KeyboardEventInit): KeyboardEvent =>
  new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })

const press = (target: Element, init: KeyboardEventInit): KeyboardEvent => {
  const event = key(init)
  target.dispatchEvent(event)
  return event
}

const activeSession = (): string | null =>
  document.activeElement?.getAttribute(MIRROR_ROW_ATTRIBUTE) ?? null

// ---------------------------------------------------------------------------
// Traversal in visual order
// ---------------------------------------------------------------------------

describe('DP-3 keyboard: traversal follows the canvas order', () => {
  it('walks the rows in visual order with the arrow keys', async () => {
    const { dashboard } = await mountRecordingPrototype()
    const canvasOrder = dashboard.rows.map((row) => row.sessionId)
    expect(canvasOrder).toEqual(dashboard.mirror.order)

    // Nothing focused yet: forward traversal enters at the first row.
    const first = dashboard.mirror.entryForSession(canvasOrder[0] as string)
    first?.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    first?.focus()

    const visited: (string | null)[] = [activeSession()]
    for (const k of ['ArrowDown', 'ArrowDown', 'ArrowDown']) {
      press(first as Element, { key: k })
      visited.push(activeSession())
    }
    // Past the end, traversal stays on the last row rather than wrapping or
    // leaving the list.
    expect(visited).toEqual([...canvasOrder, canvasOrder[canvasOrder.length - 1]])

    press(document.activeElement as Element, { key: 'ArrowUp' })
    expect(activeSession()).toBe(canvasOrder[1])
    press(document.activeElement as Element, { key: 'ArrowUp' })
    expect(activeSession()).toBe(canvasOrder[0])
    press(document.activeElement as Element, { key: 'ArrowUp' })
    expect(activeSession()).toBe(canvasOrder[0])
  })

  it('jumps to the ends with Home and End, and reports the focused row', async () => {
    const { dashboard } = await mountRecordingPrototype()
    const first = dashboard.mirror.entryForSession('session-ack-flow')
    first?.focus()

    press(document.activeElement as Element, { key: 'End' })
    expect(activeSession()).toBe('session-village-objects')
    expect(dashboard.navigator.focusedSessionId).toBe('session-village-objects')
    expect(dashboard.navigator.focusedEntry).toBe(
      dashboard.mirror.entryForSession('session-village-objects'),
    )

    press(document.activeElement as Element, { key: 'Home' })
    expect(activeSession()).toBe('session-ack-flow')
  })

  it('enters backward from the last row when nothing is focused', async () => {
    const { dashboard } = await mountRecordingPrototype()

    // Keyed on the list itself, which is where a key event lands when focus is
    // inside the list but on the container rather than on a row.
    const event = press(dashboard.mirror.root, { key: 'ArrowUp' })

    expect(event.defaultPrevented).toBe(true)
    expect(activeSession()).toBe('session-village-objects')
  })

  it('declares the keys it handles, and swallows them so the page does not scroll', async () => {
    const { dashboard } = await mountRecordingPrototype()
    const entry = dashboard.mirror.entryForSession('session-ack-flow')
    entry?.focus()

    expect(Object.keys(NAVIGATION_KEYS).sort()).toEqual([
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
      'ArrowUp',
      'End',
      'Home',
    ])
    for (const k of Object.keys(NAVIGATION_KEYS)) {
      expect(press(entry as Element, { key: k }).defaultPrevented, k).toBe(true)
    }
    expect(press(entry as Element, { key: 'ArrowDown' }).defaultPrevented).toBe(true)
  })

  it('leaves Tab alone, so the row list is one tab stop rather than one per row', async () => {
    const { dashboard, container } = await mountRecordingPrototype()
    const entry = dashboard.mirror.entryForSession('session-ack-flow')
    entry?.focus()

    const before = activeSession()
    const event = press(entry as Element, { key: 'Tab' })

    expect(event.defaultPrevented, 'Tab is not the controller\'s business').toBe(false)
    expect(activeSession()).toBe(before)
    // One tab stop in the list, and it follows focus.
    const tabStops = [...container.querySelectorAll('[tabindex="0"]')]
    expect(tabStops).toHaveLength(1)
    expect(tabStops[0]).toBe(entry)
    expect(entry?.getAttribute('tabindex')).toBe('0')
  })

  it('ignores a modified key, so a browser shortcut is not a row command', async () => {
    const { dashboard } = await mountRecordingPrototype()
    const entry = dashboard.mirror.entryForSession('session-ack-flow')
    entry?.focus()

    press(entry as Element, { key: 'ArrowDown', altKey: true })
    press(entry as Element, { key: 'ArrowDown', metaKey: true })
    press(entry as Element, { key: 'Enter', ctrlKey: true })

    expect(activeSession()).toBe('session-ack-flow')
    expect(dashboard.activatedSessionId).toBeNull()
  })

  it('marks the focused row and moves the single tab stop with it', async () => {
    const { dashboard, container } = await mountRecordingPrototype()

    dashboard.navigator.focusSession('session-ingest-route')

    const focused = dashboard.mirror.entryForSession('session-ingest-route')
    expect(document.activeElement).toBe(focused)
    expect(focused?.getAttribute(MIRROR_FOCUSED_ATTRIBUTE)).toBe('true')
    expect(focused?.classList.contains(MIRROR_FOCUSED_CLASS)).toBe(true)
    // The row that lost focus is unmarked, so the mark never accumulates.
    const other = dashboard.mirror.entryForSession('session-ack-flow')
    expect(other?.hasAttribute(MIRROR_FOCUSED_ATTRIBUTE)).toBe(false)
    expect(other?.classList.contains(MIRROR_FOCUSED_CLASS)).toBe(false)
    expect(container.querySelectorAll('[tabindex="0"]')).toHaveLength(1)
  })

  it('recomputes the roving tabindex when the focused row changes', async () => {
    const { dashboard } = await mountRecordingPrototype()
    const container = document.createElement('div')
    document.body.append(container)
    // The rows, plus an element that is not a row, so a tab stop can never land
    // on something outside the list.
    const list = [container, ...dashboard.mirror.entries]

    // Four elements: the stray container, then the three rows.
    applyRovingTabIndex(list, 2)
    expect(list.map((entry) => entry.getAttribute('tabindex'))).toEqual(['-1', '-1', '0', '-1'])

    applyRovingTabIndex(list, 0)
    expect(list.map((entry) => entry.getAttribute('tabindex'))).toEqual(['0', '-1', '-1', '-1'])

    // Out of range is clamped rather than leaving the list with no tab stop.
    applyRovingTabIndex(list, 99)
    expect(list.map((entry) => entry.getAttribute('tabindex'))).toEqual(['-1', '-1', '-1', '0'])
    container.remove()
  })
})

// ---------------------------------------------------------------------------
// Activation is observable
// ---------------------------------------------------------------------------

describe('DP-3 keyboard: activation is reported, not implied', () => {
  it('reports activation for the focused row, on the element and in the controller', async () => {
    const { dashboard, target } = await mountRecordingPrototype()
    const entry = dashboard.mirror.entryForSession('session-ack-flow')
    entry?.focus()

    const event = press(entry as Element, { key: 'Enter' })

    expect(event.defaultPrevented).toBe(true)
    expect(dashboard.navigator.activatedSessionId).toBe('session-ack-flow')
    expect(dashboard.navigator.lastActivation).toEqual({
      sessionId: 'session-ack-flow',
      key: 'Enter',
      count: 1,
    })
    expect(entry?.getAttribute(MIRROR_ACTIVATIONS_ATTRIBUTE)).toBe('1')
    expect(entry?.classList.contains(MIRROR_ACTIVATED_CLASS)).toBe(true)
    // The surface is told, which is where a real reaction would hang.
    expect(dashboard.activatedSessionId).toBe('session-ack-flow')
    // And it activated nothing: a static row has no action behind it, so the
    // picture is untouched.
    expect(dashboard.plan.hoveredRepositoryId).not.toBeNull()
    const commandsAfterActivation = target.commands.length
    press(entry as Element, { key: 'Enter' })
    expect(target.commands.length).toBe(commandsAfterActivation)
  })

  it('accepts Space as well as Enter, and counts each activation', async () => {
    const { dashboard } = await mountRecordingPrototype()
    const entry = dashboard.mirror.entryForSession('session-village-objects')
    entry?.focus()

    for (const activationKey of ACTIVATION_KEYS) {
      const event = press(entry as Element, { key: activationKey })
      expect(event.defaultPrevented, activationKey).toBe(true)
    }

    expect(entry?.getAttribute(MIRROR_ACTIVATIONS_ATTRIBUTE)).toBe(String(ACTIVATION_KEYS.length))
    expect(dashboard.navigator.lastActivation?.key).toBe('Spacebar')
    expect(dashboard.navigator.lastActivation?.count).toBe(ACTIVATION_KEYS.length)
  })

  it('activates a named row without focusing it, and reports nothing for a row that is not there', async () => {
    const { dashboard } = await mountRecordingPrototype()

    expect(dashboard.navigator.activate('session-ingest-route')).toBe(true)
    expect(dashboard.activatedSessionId).toBe('session-ingest-route')
    expect(
      dashboard.mirror.entryForSession('session-ingest-route')?.getAttribute(
        MIRROR_ACTIVATIONS_ATTRIBUTE,
      ),
    ).toBe('1')

    expect(dashboard.navigator.activate('session-not-here')).toBe(false)
    expect(dashboard.activatedSessionId).toBe('session-ingest-route')
  })

  it('renders no control that acts on a session', async () => {
    const { container } = await mountRecordingPrototype()

    // A row on this page is a row, not a button: there is nothing here that sends,
    // interrupts, prompts or approves anything, and no send, interrupt or approve
    // control may appear later either.
    expect(container.querySelectorAll('button, a, input, select, textarea')).toHaveLength(0)
    expect(container.querySelector('[data-mirror-row]')?.querySelectorAll('*').length).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// Focus reveals the full path, like hover
// ---------------------------------------------------------------------------

describe('DP-3 keyboard: focus reveals the full path', () => {
  it('reveals the repository path on focus and clears it when focus leaves the list', async () => {
    const { dashboard, target } = await mountRecordingPrototype()

    expect(dashboard.plan.hoveredRepositoryId).toBeNull()
    const pathCommands = (): string[] =>
      textCommands(target.commands)
        .filter((command) => command.role === 'repository-full-path')
        .map((command) => command.text)

    expect(pathCommands()).toEqual([])

    const entry = dashboard.mirror.entryForSession('session-village-objects')
    entry?.focus()

    expect(dashboard.plan.hoveredRepositoryId).toBe('repo-knowledge-dungeon')
    expect(pathCommands()).toEqual(['/home/dev/Projects/knowledge-dungeon'])
    // Still beside the short name, never in place of it (APX-CON-09).
    const shortNames = textCommands(target.commands)
      .filter((command) => command.role === 'repository-short-name')
      .map((command) => command.text)
    expect(shortNames).toEqual(['agent-ping', 'knowledge-dungeon'])

    // Focus leaves the mirror entirely.
    document.body.focus()
    entry?.blur()
    expect(dashboard.plan.hoveredRepositoryId).toBeNull()
    expect(pathCommands()).toEqual([])
  })

  it('treats traversal inside the list as a move, not as leaving it', async () => {
    const { dashboard } = await mountRecordingPrototype()

    dashboard.mirror.entryForSession('session-ack-flow')?.focus()
    expect(dashboard.plan.hoveredRepositoryId).toBe('repo-agent-ping')

    // Arrow to a row in the other repository. A rebuild in the middle of the
    // traversal would replace the node the browser is focusing.
    press(document.activeElement as Element, { key: 'ArrowDown' })
    press(document.activeElement as Element, { key: 'ArrowDown' })

    expect(activeSession()).toBe('session-village-objects')
    expect(dashboard.plan.hoveredRepositoryId).toBe('repo-knowledge-dungeon')
    // And back again, to prove the intermediate repository's reveal was replaced
    // rather than left behind.
    press(document.activeElement as Element, { key: 'ArrowUp' })
    press(document.activeElement as Element, { key: 'ArrowUp' })
    expect(activeSession()).toBe('session-ack-flow')
    expect(dashboard.plan.hoveredRepositoryId).toBe('repo-agent-ping')
  })
})

// ---------------------------------------------------------------------------
// Reduced motion
// ---------------------------------------------------------------------------

describe('DP-3 motion: reduced motion suppresses movement, not state', () => {
  it('animates non-essential movement when the preference is not set', async () => {
    const { dashboard } = await mountRecordingPrototype({ reducedMotion: false })

    expect(dashboard.motion.reducedMotion).toBe(false)
    for (const effect of NON_ESSENTIAL_MOTION) {
      expect(dashboard.motion.isAnimated(effect), effect).toBe(true)
    }
    const entry = dashboard.mirror.entryForSession('session-ack-flow')
    expect(entry?.getAttribute(motionAttribute('state-arrival'))).toBe('animated')
    entry?.focus()
    expect(entry?.getAttribute(motionAttribute('focus-indicator'))).toBe('animated')
  })

  it('suppresses every non-essential movement and keeps the state change visible', async () => {
    const { dashboard } = await mountRecordingPrototype({ reducedMotion: true })

    expect(dashboard.motion.reducedMotion).toBe(true)
    for (const effect of NON_ESSENTIAL_MOTION) {
      expect(dashboard.motion.isAnimated(effect), effect).toBe(false)
      expect(dashboard.motion.mode(effect, true), effect).toBe('instant')
      // Not "off": the effect still happens, it just does not move.
      expect(dashboard.motion.mode(effect, false), effect).toBe('off')
    }

    const blocked = dashboard.mirror.entryForSession('session-ack-flow')
    expect(blocked?.getAttribute(motionAttribute('state-arrival'))).toBe('instant')
    blocked?.focus()
    expect(blocked?.getAttribute(motionAttribute('focus-indicator'))).toBe('instant')
    // The information survives: a newly arrived blocked row is still a blocked
    // row, with its icon and its word.
    expect(blocked?.getAttribute(MOTION_STATE_CHANGE_ATTRIBUTE)).toBe(STATE_CHANGE_MODE)
    expect(blocked?.querySelector(`[${MIRROR_STATE_LABEL_ATTRIBUTE}]`)?.textContent).toBe(
      STATE_ENCODING.blocked.label,
    )
  })

  it('suppresses the full path reveal, and still reveals the path', async () => {
    const { dashboard, target } = await mountRecordingPrototype({ reducedMotion: true })

    dashboard.navigator.focusSession('session-ingest-route')

    // The reveal is decoration and does not move...
    const group = dashboard.mirror.groupForRepository('repo-agent-ping')
    expect(group?.getAttribute(motionAttribute('full-path-reveal'))).toBe('instant')
    // ...while the path it reveals is the identity detail the requirement promises
    // on focus, and is drawn either way.
    expect(dashboard.plan.hoveredRepositoryId).toBe('repo-agent-ping')
    expect(
      textCommands(target.commands)
        .filter((command) => command.role === 'repository-full-path')
        .map((command) => command.text),
    ).toEqual(['/home/dev/Projects/agent-ping'])
  })

  it('re-reads the preference when it changes, without a remount', async () => {
    const { dashboard, preference } = await mountRecordingPrototype({ reducedMotion: false })
    if (preference === null) throw new Error('the preference was not injected')

    const entry = dashboard.mirror.entryForSession('session-ack-flow')
    entry?.focus()
    expect(entry?.getAttribute(motionAttribute('focus-indicator'))).toBe('animated')
    const entryNode = entry

    preference.set(true)

    // The element that was already marked is updated in place: a preference
    // changed while the page is open applies to what is on screen, not to the
    // next thing that happens to arrive.
    expect(dashboard.motion.reducedMotion).toBe(true)
    expect(dashboard.mirror.entryForSession('session-ack-flow')).toBe(entryNode)
    expect(entryNode?.getAttribute(motionAttribute('focus-indicator'))).toBe('instant')
    expect(entryNode?.getAttribute(MOTION_STATE_CHANGE_ATTRIBUTE)).toBe(STATE_CHANGE_MODE)

    preference.set(false)
    expect(dashboard.motion.reducedMotion).toBe(false)
    expect(entryNode?.getAttribute(motionAttribute('focus-indicator'))).toBe('animated')
  })

  it('paints the same picture with and without reduced motion', async () => {
    const reduced = await mountRecordingPrototype({ reducedMotion: true })
    const full = await mountRecordingPrototype({ reducedMotion: false })

    // The static canvas has no movement of its own to suppress, so the picture is
    // identical and only the DOM treatment differs. That is the assertion worth
    // making: reduced motion changed the mirror's transitions and nothing about
    // what the rows say.
    expect(reduced.target.commands).toEqual(full.target.commands)
    expect(reduced.dashboard.mirror.order).toEqual(full.dashboard.mirror.order)
    for (const row of reduced.dashboard.rows) {
      const entry = reduced.dashboard.mirror.entryForSession(row.sessionId)
      expect(entry?.getAttribute(MOTION_STATE_CHANGE_ATTRIBUTE)).toBe(STATE_CHANGE_MODE)
      expect(entry?.textContent).toBe(
        full.dashboard.mirror.entryForSession(row.sessionId)?.textContent,
      )
      expect(entry?.getAttribute(motionAttribute('state-arrival'))).toBe('instant')
    }
  })

  it('declares a transition only for the animated mode, with a reduced-motion backstop', async () => {
    const { container } = await mountRecordingPrototype()
    const sheet = document.querySelector(`style[${MIRROR_STYLE_ATTRIBUTE}]`)?.textContent ?? ''

    // Every declared effect has a rule that animates it and only it.
    for (const effect of NON_ESSENTIAL_MOTION) {
      expect(sheet).toContain(`[${motionAttribute(effect)}='animated']`)
    }
    expect(sheet).toMatch(/\[data-motion-state-arrival='animated'\] \{\n\s+transition:/)
    // Nothing transitions the instant mode or the state change.
    expect(sheet).not.toMatch(/\[data-motion-state-arrival='instant'\]/)
    expect(sheet).not.toMatch(/\[data-motion-state-change='visible'\][^{]*\{[^}]*transition/)
    // And the backstop covers the whole subtree, with the right precedence.
    expect(sheet).toMatch(/@media \(prefers-reduced-motion: reduce\)/)
    expect(sheet).toMatch(/transition: none !important/)
    expect(container.querySelector(`[${MIRROR_ROOT_ATTRIBUTE}]`)).not.toBeNull()
  })

  it('reads the preference it is given, and ignores a change once destroyed', async () => {
    const { dashboard, preference } = await mountRecordingPrototype({ reducedMotion: true })
    if (preference === null) throw new Error('the preference was not injected')

    const entry = dashboard.mirror.entryForSession('session-ack-flow')
    entry?.focus()
    expect(dashboard.motion.watchedTargets).toBeGreaterThan(0)
    expect(preference.listenerCount).toBe(1)

    dashboard.destroy()

    expect(dashboard.motion.watchedTargets).toBe(0)
    expect(preference.listenerCount).toBe(0)
    // A change after teardown touches nothing, because nothing is listening.
    preference.set(false)
    expect(dashboard.motion.reducedMotion).toBe(true)
  })

  it('reads the preference through a matchMedia source, and tolerates having none', () => {
    expect(REDUCED_MOTION_MEDIA_QUERY).toBe('(prefers-reduced-motion: reduce)')

    const asked: string[] = []
    expect(
      prefersReducedMotion({
        matchMedia: (query) => {
          asked.push(query)
          return { matches: true }
        },
      }),
    ).toBe(true)
    expect(asked).toEqual([REDUCED_MOTION_MEDIA_QUERY])

    // An environment with no matchMedia at all is "not reduced", not a crash.
    expect(prefersReducedMotion({})).toBe(false)
    expect(prefersReducedMotion({ matchMedia: () => null })).toBe(false)
    expect(prefersReducedMotion(null)).toBe(false)

    // The default wiring reads the window and survives this environment, which has
    // no matchMedia of its own.
    const list = createRowList()
    expect(list.motion.reducedMotion).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

describe('DP-3 keyboard: teardown leaves nothing listening', () => {
  it('stops responding to keys and focus once the dashboard is destroyed', async () => {
    const { dashboard } = await mountRecordingPrototype()
    const root = dashboard.mirror.root
    const entry = dashboard.mirror.entryForSession('session-ack-flow')
    entry?.focus()
    expect(dashboard.activeSubscriptions).toBeGreaterThan(0)

    window.dispatchEvent(new Event('beforeunload'))

    expect(dashboard.isDestroyed).toBe(true)
    expect(dashboard.activeSubscriptions).toBe(0)
    expect(dashboard.navigator.isDestroyed).toBe(true)
    // Events on the detached subtree change nothing and are not handled.
    const event = press(root, { key: 'ArrowDown' })
    expect(event.defaultPrevented).toBe(false)
    expect(dashboard.navigator.activatedSessionId).toBeNull()
    expect(dashboard.navigator.activate('session-ack-flow')).toBe(false)
    expect(dashboard.navigator.focusNext()).toBeNull()
  })
})
