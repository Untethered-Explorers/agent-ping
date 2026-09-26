// DP-3: the visually hidden, focusable DOM mirror, driven through the real mount
// entry point.
//
//   npm test -- tests/dashboard/dom-mirror.test.ts
//
// What is asserted here, and what is not:
//
//   - One focusable entry per visible row, in the canvas's order, in the canvas's
//     repository groups, compared against the mounted dashboard's own row model
//     rather than a hardcoded list. A mirror ordered differently from the canvas
//     is a silent failure, and comparing the two orders is the only assertion that
//     catches it.
//   - Each entry's accessible name, state as an icon token plus a word, and
//     repository grouping, with the full path present as detail and absent from
//     the name (APX-CON-09).
//   - That the mirror is hidden by clipping rather than by `display: none` or
//     `visibility: hidden`, which pass a DOM-count assertion and still leave a
//     dead-end page.
//   - That every state is legible without colour: the icon and the word exist for
//     every state in the union, and the canvas and the mirror carry the same
//     encoding.
//   - That text meets WCAG 2.1 AA against the background the plan actually paints
//     over, computed from the recorded command stream rather than from a token
//     name (APX-CON-07).
//   - That focus survives a re-render, is addressed by session identity, and is
//     never dropped to the document body.
//
// What cannot be asserted in jsdom: the real pixels, and the browser's own
// focus rendering. jsdom applies no layout, so a test cannot see a focus ring; the
// stylesheet is asserted as text for that reason, and the painted result is left to
// `npm run build` and the human design review in DP-4.

import { afterEach, describe, expect, it } from 'vitest'
import {
  MIRROR_AGE_ATTRIBUTE,
  MIRROR_ACTIVATIONS_ATTRIBUTE,
  MIRROR_ACTIVATED_CLASS,
  MIRROR_FOCUSED_ATTRIBUTE,
  MIRROR_FOCUSED_CLASS,
  MIRROR_ICON_ATTRIBUTE,
  MIRROR_ICON_TEXT_ATTRIBUTE,
  MIRROR_ROOT_ATTRIBUTE,
  MIRROR_ROW_ATTRIBUTE,
  MIRROR_ROW_SELECTOR,
  MIRROR_ROWS_ATTRIBUTE,
  MIRROR_STATE_ATTRIBUTE,
  MIRROR_STATE_LABEL_ATTRIBUTE,
  MIRROR_STATUS_ATTRIBUTE,
  MIRROR_STYLE_ATTRIBUTE,
  mirrorRowName,
  mirrorStyleSheet,
} from '@/dashboard/a11y/dom-mirror'
import { PROTOTYPE_NOW, PROTOTYPE_REPOSITORIES } from '@/dashboard/prototype/mock-data'
import type { ScenePlan } from '@/dashboard/prototype/scene'
import { PROTOTYPE_COLORS, SESSION_STATES, STATE_ENCODING, buildScene } from '@/dashboard/prototype/scene'
import {
  createRecordingTarget,
  createRowList,
  destroyMounted,
  iconCommands,
  mountRecordingPrototype,
  setContainerSize,
  textCommands,
} from './prototype-harness'

afterEach(() => {
  destroyMounted()
})

const entries = (container: HTMLElement): HTMLElement[] =>
  [...container.querySelectorAll<HTMLElement>(MIRROR_ROW_SELECTOR)]

const attributeText = (entry: HTMLElement, attribute: string): string =>
  entry.querySelector(`[${attribute}]`)?.textContent ?? ''

/**
 * The prototype's row model without a mount: the plan the canvas paints, which is
 * also structurally the whole input the mirror takes. The row list under test is
 * driven with it rather than with a hand-written list, so an assertion cannot pass
 * against rows the canvas never draws.
 */
function rowModel(): ScenePlan {
  return buildScene(PROTOTYPE_REPOSITORIES, { width: 960, height: 540, now: PROTOTYPE_NOW })
}

/** The same row model with one session gone, which is what a hub update can produce. */
function withoutSession(plan: ScenePlan, sessionId: string): ScenePlan {
  return {
    ...plan,
    groups: plan.groups.map((group) => ({
      ...group,
      rowIds: group.rowIds.filter((id) => id !== sessionId),
    })),
    rows: plan.rows.filter((row) => row.sessionId !== sessionId),
  }
}

// ---------------------------------------------------------------------------
// One entry per visible row, in canvas order, in the canvas's groups
// ---------------------------------------------------------------------------

describe('DP-3 mirror: one focusable entry per visible row', () => {
  it('holds one entry per row, in the canvas order, grouped as the canvas groups them', async () => {
    const { dashboard, container } = await mountRecordingPrototype()

    const rows = dashboard.rows
    const found = entries(container)

    expect(found).toHaveLength(rows.length)
    // Compared against the row model the canvas renders, not a hardcoded list, so
    // the two renderers cannot disagree about order without failing here.
    expect(found.map((entry) => entry.getAttribute(MIRROR_ROW_ATTRIBUTE))).toEqual(
      rows.map((row) => row.sessionId),
    )
    expect(dashboard.mirror.order).toEqual(rows.map((row) => row.sessionId))

    for (const row of rows) {
      const entry = dashboard.mirror.entryForSession(row.sessionId)
      expect(entry, `${row.sessionId} has a mirror entry`).not.toBeNull()
      if (entry === null) continue
      // The group is the repository, and the repository's list is named by the
      // short-name heading, so a screen reader announces which repository focus
      // has entered.
      const group = entry.closest('[data-mirror-group]')
      expect(group?.getAttribute('data-mirror-group')).toBe(row.repositoryId)
      const heading = group?.querySelector('[data-mirror-group-label]')
      expect(heading?.textContent).toBe(row.repositoryShortName)
      const list = entry.parentElement
      expect(list?.getAttribute('aria-labelledby')).toBe(heading?.id)
      expect(list?.getAttribute(MIRROR_ROWS_ATTRIBUTE)).toBe(row.repositoryId)
      expect(dashboard.mirror.entriesForRepository(row.repositoryId).length).toBeGreaterThan(0)
    }

    expect(dashboard.mirror.entriesForRepository('repo-agent-ping')).toHaveLength(2)
    expect(dashboard.mirror.entriesForRepository('repo-knowledge-dungeon')).toHaveLength(1)
  })

  it('gives every entry a focusable tabindex, with one row in the tab order', async () => {
    const { container } = await mountRecordingPrototype()

    const found = entries(container)
    const tabIndexes = found.map((entry) => entry.getAttribute('tabindex'))

    // Focusable: every entry carries a tabindex, so the arrow keys can reach all
    // of them. Exactly one is a tab stop, because a list of three, let alone
    // thirty, tab stops is not operable in practice.
    expect(tabIndexes.every((value) => value === '0' || value === '-1')).toBe(true)
    expect(tabIndexes.filter((value) => value === '0')).toHaveLength(1)
    expect(found[0]?.getAttribute('tabindex')).toBe('0')
  })

  it('is hidden by clipping, never by display:none or visibility:hidden', async () => {
    const { container } = await mountRecordingPrototype()

    const root = container.querySelector<HTMLElement>(`[${MIRROR_ROOT_ATTRIBUTE}]`)
    expect(root).not.toBeNull()
    if (root === null) return

    // The two declarations that make entries unfocusable while still passing a
    // DOM-count assertion. The clip-rect pattern is what keeps them focusable.
    const sheet = mirrorStyleSheet()
    expect(sheet).toMatch(/clip:\s*rect\(/)
    expect(sheet).toMatch(/clip-path:\s*inset\(/)
    expect(sheet).not.toMatch(/display:\s*none/)
    expect(sheet).not.toMatch(/visibility:\s*hidden/)
    // And the applied rule is the one that was asserted, not a copy of it.
    const applied = document.querySelector(`style[${MIRROR_STYLE_ATTRIBUTE}]`)?.textContent ?? ''
    expect(applied).toBe(sheet)

    const style = getComputedStyle(root)
    expect(style.display).not.toBe('none')
    expect(style.visibility).not.toBe('hidden')
  })

  it('keeps focus inside the list, so a focused entry is real focus and not a node', async () => {
    const { dashboard } = await mountRecordingPrototype()

    const entry = dashboard.mirror.entryForSession('session-ack-flow')
    entry?.focus()

    expect(document.activeElement).toBe(entry)
    expect(dashboard.navigator.focusedSessionId).toBe('session-ack-flow')
  })
})

// ---------------------------------------------------------------------------
// Accessible name, state, grouping
// ---------------------------------------------------------------------------

describe('DP-3 mirror: names, state text and grouping', () => {
  it('exposes the state as an icon token and a word on every row', async () => {
    const { dashboard } = await mountRecordingPrototype()

    for (const row of dashboard.rows) {
      const entry = dashboard.mirror.entryForSession(row.sessionId)
      expect(entry, `${row.sessionId} has an entry`).not.toBeNull()
      if (entry === null) continue
      const encoding = STATE_ENCODING[row.state]
      expect(entry.getAttribute(MIRROR_STATE_ATTRIBUTE)).toBe(row.state)
      // The silhouette the canvas draws, compared rather than assumed.
      expect(entry.getAttribute(MIRROR_ICON_ATTRIBUTE)).toBe(encoding.icon)
      expect(attributeText(entry, MIRROR_ICON_TEXT_ATTRIBUTE)).toBe(encoding.token)
      expect(attributeText(entry, MIRROR_STATE_LABEL_ATTRIBUTE)).toBe(encoding.label)
      expect(attributeText(entry, MIRROR_STATUS_ATTRIBUTE)).toBe(row.status)
      expect(attributeText(entry, MIRROR_AGE_ATTRIBUTE)).toBe(`${row.age} ago`)
    }
  })

  it('gives every row the same accessible name the canvas row carries', async () => {
    const { dashboard } = await mountRecordingPrototype()

    for (const row of dashboard.rows) {
      const entry = dashboard.mirror.entryForSession(row.sessionId)
      if (entry === null) throw new Error(`${row.sessionId} has no mirror entry`)
      // One function builds the name and the elements, so the spoken name and the
      // DOM cannot describe different things. Asserted on textContent because that
      // is what a screen reader derives the name from.
      expect(entry.textContent).toBe(mirrorRowName(row))
      expect(entry.textContent).toContain(row.repositoryShortName)
      expect(entry.textContent).toContain(row.status)
    }
  })

  it('never makes the full path the label', async () => {
    const { dashboard } = await mountRecordingPrototype()

    for (const row of dashboard.rows) {
      const entry = dashboard.mirror.entryForSession(row.sessionId)
      if (entry === null) throw new Error(`${row.sessionId} has no mirror entry`)
      // Available, on hover and focus, and never the primary label (APX-CON-09).
      expect(entry.getAttribute('data-mirror-path')).toBe(row.repositoryPath)
      expect(entry.textContent).not.toContain(row.repositoryPath)
      expect(entry.textContent).not.toContain('/home/dev/')
      const group = entry.closest('[data-mirror-group]')
      expect(group?.querySelector('[data-mirror-group-label]')?.textContent).toBe(
        row.repositoryShortName,
      )
    }
  })

  it('carries no colour at all, so nothing in the mirror can be colour-only', async () => {
    const { container } = await mountRecordingPrototype()

    const root = container.querySelector(`[${MIRROR_ROOT_ATTRIBUTE}]`)
    // No inline style and no style attribute anywhere: the mirror's presentation
    // is the one injected sheet, which declares no colour at all.
    expect(root?.outerHTML).not.toMatch(/style="/)
    expect(mirrorStyleSheet()).not.toMatch(/color/i)
  })
})

// ---------------------------------------------------------------------------
// Urgency is never colour alone
// ---------------------------------------------------------------------------

describe('DP-3 urgency: every state is icon plus word', () => {
  it('encodes every state with a distinct icon and a distinct word', () => {
    // Exhaustive over the state union, not over the three fixture rows: a fourth
    // state has to arrive with an icon and a word, or this fails.
    expect(Object.keys(STATE_ENCODING).sort()).toEqual([...SESSION_STATES].sort())
    for (const state of SESSION_STATES) {
      const encoding = STATE_ENCODING[state]
      expect(encoding.icon, `${state} has an icon`).toBeTruthy()
      expect(encoding.label, `${state} has a word`).toBeTruthy()
      expect(encoding.token, `${state} has a reader token`).toBeTruthy()
    }
    expect(new Set(SESSION_STATES.map((state) => STATE_ENCODING[state].icon)).size).toBe(
      SESSION_STATES.length,
    )
    expect(new Set(SESSION_STATES.map((state) => STATE_ENCODING[state].label)).size).toBe(
      SESSION_STATES.length,
    )
    expect(new Set(SESSION_STATES.map((state) => STATE_ENCODING[state].token)).size).toBe(
      SESSION_STATES.length,
    )
  })

  it('puts both signals on the canvas and in the mirror for every state', async () => {
    const { dashboard, target } = await mountRecordingPrototype()
    const texts = textCommands(target.commands)
    const icons = iconCommands(target.commands)

    // The fixture covers every state, so each state can be checked end to end
    // rather than only in the table above.
    for (const state of SESSION_STATES) {
      const row = dashboard.rows.find((candidate) => candidate.state === state)
      expect(row, `the fixture renders a ${state} row`).toBeDefined()
      if (row === undefined) continue

      const entry = dashboard.mirror.entryForSession(row.sessionId)
      if (entry === null) throw new Error(`${row.sessionId} has no mirror entry`)
      expect(entry.getAttribute(MIRROR_ICON_ATTRIBUTE), `${state} in the mirror`).toBeTruthy()
      expect(
        attributeText(entry, MIRROR_STATE_LABEL_ATTRIBUTE),
        `${state} is spelled out in the mirror`,
      ).toBe(STATE_ENCODING[state].label)

      const atRowTop = (command: { y: number }) =>
        command.y >= row.y && command.y < row.y + row.height
      expect(
        texts.find((command) => command.role === 'session-state-label' && atRowTop(command))?.text,
        `${state} is spelled out on the canvas`,
      ).toBe(STATE_ENCODING[state].label)
      expect(icons.find((command) => atRowTop(command))?.icon).toBe(STATE_ENCODING[state].icon)
    }
  })
})

// ---------------------------------------------------------------------------
// WCAG 2.1 AA contrast, against the background the plan actually paints
// ---------------------------------------------------------------------------

/** WCAG relative luminance of an sRGB colour given as 0xRRGGBB. */
function relativeLuminance(color: number): number {
  const channel = (value: number): number => {
    const srgb = value / 255
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4
  }
  const red = channel((color >> 16) & 0xff)
  const green = channel((color >> 8) & 0xff)
  const blue = channel(color & 0xff)
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

function contrastRatio(foreground: number, background: number): number {
  const first = relativeLuminance(foreground)
  const second = relativeLuminance(background)
  const lighter = Math.max(first, second)
  const darker = Math.min(first, second)
  return (lighter + 0.05) / (darker + 0.05)
}

const AA_NORMAL_TEXT = 4.5
const AA_NON_TEXT = 3

describe('DP-3 contrast: AA against the painted background', () => {
  it('meets AA for every piece of text the plan draws over the surface it paints', async () => {
    const { target } = await mountRecordingPrototype()

    // The background is the rect the plan actually paints, read from the command
    // stream rather than named from a token, so a state-specific row background
    // added later cannot pass this by being verified against the wrong pair.
    const background = target.commands.find((command) => command.kind === 'rect')
    if (background === undefined || background.kind !== 'rect') {
      throw new Error('the plan paints no surface')
    }
    expect(background.fill).toBe(PROTOTYPE_COLORS.pageBackground)

    const texts = textCommands(target.commands)
    expect(texts.length).toBeGreaterThan(0)
    for (const command of texts) {
      const ratio = contrastRatio(command.color, background.fill)
      expect(ratio, `"${command.text}" against the painted surface`).toBeGreaterThanOrEqual(
        AA_NORMAL_TEXT,
      )
    }
  })

  it('meets the non-text ratio for every state icon', async () => {
    const { target } = await mountRecordingPrototype()

    const background = target.commands.find((command) => command.kind === 'rect')
    if (background === undefined || background.kind !== 'rect') {
      throw new Error('the plan paints no surface')
    }
    const icons = iconCommands(target.commands)
    expect(icons).toHaveLength(SESSION_STATES.length)
    for (const command of icons) {
      expect(
        contrastRatio(command.color, background.fill),
        `${command.icon} against the painted surface`,
      ).toBeGreaterThanOrEqual(AA_NON_TEXT)
    }
  })

  it('keeps state accents off body text, so a hue is never the only cue', async () => {
    const { target } = await mountRecordingPrototype()

    const accents = new Set(SESSION_STATES.map((state) => STATE_ENCODING[state].accent))
    for (const command of textCommands(target.commands)) {
      expect(accents.has(command.color), `"${command.text}" is not a state accent`).toBe(false)
    }
    for (const command of iconCommands(target.commands)) {
      expect(accents.has(command.color)).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// Focus retention across a rebuild
// ---------------------------------------------------------------------------

describe('DP-3 mirror: focus survives a rebuild', () => {
  it('keeps focus on the same entry when the mount repaints underneath it', async () => {
    const { dashboard, container } = await mountRecordingPrototype()

    // The last row, so an implementation that always refocuses the first row
    // cannot pass this by accident.
    const focused = dashboard.mirror.entryForSession('session-village-objects')
    focused?.focus()
    expect(document.activeElement).toBe(focused)

    // Every repaint path the mount owns, including the reveal that focusing the
    // row itself triggers in the middle of this.
    dashboard.remeasure()
    dashboard.setHoveredRepository('repo-agent-ping')
    dashboard.setHoveredRepository(null)
    dashboard.remeasure()

    expect(document.activeElement).toBe(focused)
    expect(focused?.isConnected).toBe(true)
    expect(focused?.getAttribute('tabindex')).toBe('0')
    expect(entries(container).filter((entry) => entry.getAttribute('tabindex') === '0')).toHaveLength(1)
    expect(dashboard.mirror.order).toEqual(dashboard.rows.map((row) => row.sessionId))
  })

  it('keeps the focus mark and the mirror order through the mount repaint paths', async () => {
    const { dashboard } = await mountRecordingPrototype()

    dashboard.mirror.entryForSession('session-ack-flow')?.focus()
    dashboard.remeasure()
    dashboard.setHoveredRepository('repo-knowledge-dungeon')

    const focused = document.activeElement
    expect(focused?.getAttribute(MIRROR_ROW_ATTRIBUTE)).toBe('session-ack-flow')
    expect(focused?.getAttribute(MIRROR_FOCUSED_ATTRIBUTE)).toBe('true')
    expect(focused?.classList.contains(MIRROR_FOCUSED_CLASS)).toBe(true)
    expect(dashboard.mirror.order).toEqual(dashboard.rows.map((row) => row.sessionId))
  })

  it('keeps focus on the same session when the row model changes for another row', () => {
    const plan = rowModel()
    const list = createRowList()
    list.apply(plan)
    expect(list.mirror.order).toEqual(plan.rows.map((row) => row.sessionId))

    const before = list.mirror.entryForSession('session-village-objects')
    before?.focus()
    expect(document.activeElement).toBe(before)

    // An update for a different row, delivered through the same update path the
    // live feed will use.
    list.apply({
      groups: plan.groups,
      rows: plan.rows.map((row) =>
        row.sessionId === 'session-ack-flow'
          ? { ...row, state: 'running' as const, encoding: STATE_ENCODING.running }
          : row,
      ),
    })

    const after = list.mirror.entryForSession('session-village-objects')
    expect(after, 'the rebuild replaced the elements').not.toBe(before)
    expect(document.activeElement, 'focus stays on the same session').toBe(after)
    // The roving tabindex follows focus, or the list becomes unreachable by Tab.
    expect(after?.getAttribute('tabindex')).toBe('0')
    expect(list.mirror.order).toEqual(plan.rows.map((row) => row.sessionId))
    // And the change arrived, so this is a rebuild that happened rather than one
    // that was skipped.
    expect(list.mirror.entryForSession('session-ack-flow')?.getAttribute(MIRROR_STATE_ATTRIBUTE)).toBe(
      'running',
    )
  })

  it('moves focus to the row above when the focused last row is gone', () => {
    const plan = rowModel()
    const list = createRowList()
    list.apply(plan)

    // The last row, so a nearest-survivor implementation cannot pass by always
    // focusing the first one.
    const last = list.mirror.entryForSession('session-village-objects')
    last?.focus()
    expect(document.activeElement).toBe(last)

    list.apply(withoutSession(plan, 'session-village-objects'))

    expect(list.mirror.order).toEqual(['session-ack-flow', 'session-ingest-route'])
    // Focus must not fall out of the list to the body, which is what an
    // implementation with no retention path does.
    expect(document.activeElement).not.toBe(document.body)
    // Nearest by previous position, clamped into the surviving range: the row that
    // was directly above the one that left.
    expect(document.activeElement?.getAttribute(MIRROR_ROW_ATTRIBUTE)).toBe('session-ingest-route')
    expect(document.activeElement?.getAttribute('tabindex')).toBe('0')
  })

  it('keeps the ordinal position when a middle row is the one that left', () => {
    const plan = rowModel()
    const list = createRowList()
    list.apply(plan)

    const middle = list.mirror.entryForSession('session-ingest-route')
    middle?.focus()
    expect(document.activeElement).toBe(middle)

    list.apply(withoutSession(plan, 'session-ingest-route'))

    // Equidistant either way, and the tie is broken downward: the row that was
    // directly below the one that left. What must not happen is focus leaving the
    // list, or jumping to the first row because the index was treated as identity.
    expect(list.mirror.order).toEqual(['session-ack-flow', 'session-village-objects'])
    expect(document.activeElement?.getAttribute(MIRROR_ROW_ATTRIBUTE)).toBe('session-village-objects')
    expect(document.activeElement?.getAttribute('tabindex')).toBe('0')
  })

  it('holds focus on the container when the list empties', () => {
    const plan = rowModel()
    const list = createRowList()
    list.apply(plan)

    list.mirror.entryForSession('session-ack-flow')?.focus()

    list.apply({ groups: [], rows: [] })

    expect(list.mirror.order).toEqual([])
    // Not the body: the container keeps it so the next update has something to
    // restore into.
    expect(document.activeElement).toBe(list.mirror.root)
    expect(document.activeElement).not.toBe(document.body)
  })

  it('does not steal focus when nothing was focused', () => {
    const plan = rowModel()
    const list = createRowList()
    list.apply(plan)

    const before = document.activeElement
    list.apply({ groups: plan.groups, rows: plan.rows })

    expect(document.activeElement).toBe(before)
    expect(list.navigator.focusedSessionId).toBeNull()
  })

  it('skips the rebuild when the model says nothing the mirror shows has changed', () => {
    const model = rowModel()
    const list = createRowList()
    list.apply(model)

    const first = list.mirror.entryForSession('session-ack-flow')
    // A rebuild that changes nothing replaces the focused element for nothing,
    // which is how a focus-triggered reveal used to cancel the focus that asked
    // for it.
    list.apply({ ...model, groups: [...model.groups] })
    list.apply({ ...model, rows: [...model.rows] })

    expect(list.mirror.entryForSession('session-ack-flow')).toBe(first)
    expect(list.mirror.order).toEqual(model.rows.map((row) => row.sessionId))
  })
})

// ---------------------------------------------------------------------------
// The mount keeps the two renderers in step
// ---------------------------------------------------------------------------

describe('DP-3 mount: the mirror and the canvas are built from one row model', () => {
  it('rebuilds the mirror whenever the plan re-lays out, in the same order', async () => {
    const target = createRecordingTarget()
    const container = document.createElement('div')
    document.body.append(container)
    setContainerSize(container, 640, 420)
    const { dashboard } = await mountRecordingPrototype({ container, target })

    expect(entries(container)).toHaveLength(3)

    dashboard.remeasure()
    setContainerSize(container, 1200, 800)
    dashboard.remeasure()

    // A resize changes the canvas geometry and nothing the mirror shows, so the
    // entries stay; what has to survive either way is the order.
    expect(entries(container).map((entry) => entry.getAttribute(MIRROR_ROW_ATTRIBUTE))).toEqual(
      dashboard.rows.map((row) => row.sessionId),
    )
    expect(target.commands.find((command) => command.kind === 'rect')).toMatchObject({
      width: 1200,
      height: 800,
    })
  })

  it('replaces the entries on a rebuild rather than duplicating them', () => {
    const plan = rowModel()
    const list = createRowList()
    list.apply(plan)

    const first = list.mirror.entryForSession('session-ack-flow')
    list.apply({
      groups: plan.groups,
      rows: plan.rows.map((row) =>
        row.sessionId === 'session-ack-flow' ? { ...row, age: '4h' } : row,
      ),
    })
    const second = list.mirror.entryForSession('session-ack-flow')

    expect(second).not.toBe(first)
    expect(list.mirror.order).toHaveLength(3)
    expect(list.container.querySelectorAll(`[${MIRROR_ROOT_ATTRIBUTE}]`)).toHaveLength(1)
    expect(attributeText(second as HTMLElement, MIRROR_AGE_ATTRIBUTE)).toBe('4h ago')
  })

  it('leaves no activation mark on a row that was never activated', async () => {
    const { dashboard } = await mountRecordingPrototype()

    for (const row of dashboard.rows) {
      const entry = dashboard.mirror.entryForSession(row.sessionId)
      expect(entry?.hasAttribute(MIRROR_ACTIVATIONS_ATTRIBUTE)).toBe(false)
      expect(entry?.classList.contains(MIRROR_ACTIVATED_CLASS)).toBe(false)
    }
  })

  it('leaves no mirror and no stylesheet in the document after teardown', async () => {
    const { dashboard, container } = await mountRecordingPrototype()

    expect(container.querySelector(`[${MIRROR_ROOT_ATTRIBUTE}]`)).not.toBeNull()
    expect(document.querySelector(`style[${MIRROR_STYLE_ATTRIBUTE}]`)).not.toBeNull()

    dashboard.destroy()

    expect(container.querySelector(`[${MIRROR_ROOT_ATTRIBUTE}]`)).toBeNull()
    expect(document.querySelector(`style[${MIRROR_STYLE_ATTRIBUTE}]`)).toBeNull()
    expect(dashboard.mirror.isDestroyed).toBe(true)
    expect(dashboard.navigator.isDestroyed).toBe(true)
    expect(dashboard.motion.isDestroyed).toBe(true)
    expect(dashboard.activeSubscriptions).toBe(0)
  })
})
