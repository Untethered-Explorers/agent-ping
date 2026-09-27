// The visually hidden, focusable DOM mirror of every visible row (DP-FR-05,
// APX-CON-07).
//
// A row drawn on a canvas is invisible to a keyboard and to a screen reader, so
// every row the plan draws gets a twin here: one focusable element, in the
// canvas's own order, carrying the row's state as an icon token and a word, its
// repository as a nested group, and the full path as detail that never becomes
// the label (APX-CON-09).
//
// Three properties the implementation is shaped around:
//
//   - Hidden by clipping, never by `display: none`, `visibility: hidden` or the
//     `hidden` attribute. Those three make entries unfocusable or drop the subtree
//     from the accessibility tree, which passes a DOM-count assertion and still
//     leaves a dead-end page. The clip-rect pattern keeps the entries focusable
//     and keeps a forced-colors focus indicator renderable.
//   - Built from the row model the canvas renders, in that model's order. Neither
//     renderer sorts anything itself, so a mirror ordered differently from the
//     canvas is not expressible here.
//   - Focus addressed by session identifier. A re-render replaces the focused
//     element and the browser would move focus to `body`, so `render` puts it
//     back by identity, or on the nearest surviving row, or on the container when
//     the list has emptied.
//
// The module owns no colour and no motion policy: it reads the state encoding off
// the row model it is given, so a state cannot gain an icon here and a word there.

import {
  MOTION_STATE_CHANGE_ATTRIBUTE,
  MOTION_SUPPRESSED_DECLARATION,
  MOTION_TRANSITION_DECLARATION,
  NON_ESSENTIAL_MOTION,
  STATE_CHANGE_MODE,
  animatedSelector,
} from '../theme/motion'

// ---------------------------------------------------------------------------
// The row model the mirror needs
// ---------------------------------------------------------------------------

/**
 * The encoding a row carries. Structural rather than the prototype's own type, so
 * the mirror never imports the renderer, the mock module or PixiJS, and the live
 * page's row model satisfies it without inheriting from anything.
 */
export interface MirrorStateEncoding {
  /** The silhouette drawn on the canvas. Carried so a test can compare both. */
  readonly icon: string
  /** The word that carries the state without either icon or colour. */
  readonly label: string
  /** The text token for the reader, which has no shape to draw. */
  readonly token: string
}

export interface MirrorRow {
  /** Stable identity. Focus and highlighting are addressed by this, never by index. */
  readonly sessionId: string
  readonly repositoryId: string
  /** The primary repository label: the short name, never the path (APX-CON-09). */
  readonly repositoryShortName: string
  /** Detail, revealed on hover or focus. Never the label. */
  readonly repositoryPath: string
  readonly state: string
  readonly encoding: MirrorStateEncoding
  readonly label: string
  /** One line of state text. Never conversation content (APX-FR-01). */
  readonly status: string
  readonly age: string
}

export interface MirrorGroup {
  readonly repositoryId: string
  readonly shortName: string
  readonly path: string
  readonly rowIds: readonly string[]
}

/** What one render needs: the groups, and the rows in the order the canvas draws them. */
export interface MirrorModel {
  readonly groups: readonly MirrorGroup[]
  readonly rows: readonly MirrorRow[]
}

// ---------------------------------------------------------------------------
// The DOM contract
// ---------------------------------------------------------------------------

export const MIRROR_ROOT_ATTRIBUTE = 'data-dashboard-mirror'
export const MIRROR_CLASS = 'dashboard-mirror'
export const MIRROR_GROUP_ATTRIBUTE = 'data-mirror-group'
export const MIRROR_GROUP_LABEL_ATTRIBUTE = 'data-mirror-group-label'
export const MIRROR_ROWS_ATTRIBUTE = 'data-mirror-rows'
export const MIRROR_ROW_ATTRIBUTE = 'data-mirror-row'
export const MIRROR_ROW_SELECTOR = `[${MIRROR_ROW_ATTRIBUTE}]`
export const MIRROR_STATE_ATTRIBUTE = 'data-mirror-state'
export const MIRROR_ICON_ATTRIBUTE = 'data-mirror-icon'
export const MIRROR_ICON_TEXT_ATTRIBUTE = 'data-mirror-icon-text'
export const MIRROR_STATE_LABEL_ATTRIBUTE = 'data-mirror-state-label'
export const MIRROR_SESSION_LABEL_ATTRIBUTE = 'data-mirror-session-label'
export const MIRROR_STATUS_ATTRIBUTE = 'data-mirror-status'
export const MIRROR_AGE_ATTRIBUTE = 'data-mirror-age'
export const MIRROR_REPOSITORY_ATTRIBUTE = 'data-mirror-repository'
export const MIRROR_PATH_ATTRIBUTE = 'data-mirror-path'
export const MIRROR_FOCUSED_ATTRIBUTE = 'data-mirror-focused'
export const MIRROR_ACTIVATIONS_ATTRIBUTE = 'data-mirror-activations'
export const MIRROR_FOCUSED_CLASS = 'is-focused'
export const MIRROR_ACTIVATED_CLASS = 'is-activated'
/** The one injected `<style>` element, shared by every mirror in the document. */
export const MIRROR_STYLE_ATTRIBUTE = 'data-dashboard-mirror-styles'
export const MIRROR_DEFAULT_LABEL = 'Sessions by repository'
/** Between two fields of a row's spoken name. */
export const MIRROR_FIELD_SEPARATOR = ' — '

// ---------------------------------------------------------------------------
// The spoken name of a row
// ---------------------------------------------------------------------------

export function mirrorAge(age: string): string {
  return `${age} ago`
}

/**
 * The fields of a row's accessible name, in order, each with the attribute its
 * text is tagged with in the DOM.
 *
 * One function builds both the name and the elements, so the spoken name and the
 * DOM cannot describe different things. The repository short name leads, because
 * identity is the short name and a row read in isolation has to say which
 * repository it belongs to; the icon token and the state word follow, so the state
 * survives with neither the shape nor the colour.
 */
export function mirrorRowFields(
  row: MirrorRow,
): readonly { readonly attribute: string; readonly text: string }[] {
  return [
    { attribute: MIRROR_ICON_TEXT_ATTRIBUTE, text: row.encoding.token },
    { attribute: MIRROR_STATE_LABEL_ATTRIBUTE, text: row.encoding.label },
    { attribute: MIRROR_SESSION_LABEL_ATTRIBUTE, text: row.label },
    { attribute: MIRROR_STATUS_ATTRIBUTE, text: row.status },
    { attribute: MIRROR_AGE_ATTRIBUTE, text: mirrorAge(row.age) },
  ]
}

/** The accessible name a mirror entry carries, derived from the same fields. */
export function mirrorRowName(row: MirrorRow): string {
  return [row.repositoryShortName, ...mirrorRowFields(row).map((field) => field.text)].join(
    MIRROR_FIELD_SEPARATOR,
  )
}

// ---------------------------------------------------------------------------
// The stylesheet
// ---------------------------------------------------------------------------

/**
 * The mirror's rules, composed from the motion policy's declarations because the
 * mirror owns the subtree they apply to.
 *
 * Two things are asserted about this text by the tests, and both are the reason it
 * is written down rather than assumed: the hiding must be a clip and not
 * `display: none` or `visibility: hidden`, and the transition must exist only for
 * the `animated` mode.
 */
export function mirrorStyleSheet(): string {
  const animated = NON_ESSENTIAL_MOTION.map(
    (effect) => `.${MIRROR_CLASS} ${animatedSelector(effect)}`,
  ).join(',\n')
  return [
    `/* Hidden by clipping. Either of the two CSS visibility switches, or the`,
    `   hidden attribute, would make these entries unfocusable and would drop them`,
    `   from the accessibility tree, while still passing a DOM-count assertion. */`,
    `.${MIRROR_CLASS} {`,
    '  position: absolute;',
    '  width: 1px;',
    '  height: 1px;',
    '  margin: -1px;',
    '  padding: 0;',
    '  border: 0;',
    '  overflow: hidden;',
    '  clip: rect(0 0 0 0);',
    '  clip-path: inset(50%);',
    '  white-space: nowrap;',
    '}',
    '',
    `/* Non-essential movement, and only while an effect is in play and permitted. */`,
    `${animated} {`,
    `  ${MOTION_TRANSITION_DECLARATION}`,
    '}',
    '',
    `/* A state change is information, not movement: it appears in place. */`,
    `.${MIRROR_CLASS} [${MOTION_STATE_CHANGE_ATTRIBUTE}='${STATE_CHANGE_MODE}'] {`,
    '  /* no movement, deliberately */',
    '}',
    '',
    `/* Backstop for anything that reaches the DOM without asking the policy. */`,
    '@media (prefers-reduced-motion: reduce) {',
    `  .${MIRROR_CLASS},`,
    `  .${MIRROR_CLASS} * {`,
    `    ${MOTION_SUPPRESSED_DECLARATION}`,
    '  }',
    '}',
  ].join('\n')
}

/**
 * One stylesheet for the whole document, reference counted.
 *
 * Two mirrors in one document would otherwise emit the same rules twice, and a
 * test asking "is the mirror hidden" could find the other mirror's sheet. The
 * element goes when the last mirror does, so a mount's teardown really does leave
 * nothing of its own in the document.
 */
let installedSheet: { readonly element: HTMLStyleElement; owners: number } | null = null

function installStyleSheet(doc: Document): void {
  if (installedSheet !== null && installedSheet.element.isConnected) {
    installedSheet.owners += 1
    return
  }
  const element = doc.createElement('style')
  element.setAttribute(MIRROR_STYLE_ATTRIBUTE, '')
  element.textContent = mirrorStyleSheet()
  doc.head.append(element)
  installedSheet = { element, owners: 1 }
}

function releaseStyleSheet(): void {
  if (installedSheet === null) return
  installedSheet.owners -= 1
  if (installedSheet.owners > 0) return
  installedSheet.element.remove()
  installedSheet = null
}

// ---------------------------------------------------------------------------
// The mirror
// ---------------------------------------------------------------------------

export interface DomMirror {
  readonly root: HTMLElement
  /** One entry per visible row, in canvas order. */
  readonly entries: readonly HTMLElement[]
  /** The session identifiers in canvas order, which is the order the canvas draws. */
  readonly order: readonly string[]
  /**
   * Called after every rebuild, so the keyboard model can re-read the entries and
   * move the roving tabindex onto wherever focus ended up. Wiring this here rather
   * than in the caller is what makes it impossible to rebuild the mirror and forget
   * the list is left unreachable by Tab.
   */
  onRebuilt(listener: () => void): void
  /** The rows of one group, in canvas order. */
  entriesForRepository(repositoryId: string): readonly HTMLElement[]
  entryForSession(sessionId: string): HTMLElement | null
  groupForRepository(repositoryId: string): HTMLElement | null
  /** Rebuild from the row model, restoring focus by session identity. */
  render(model: MirrorModel): void
  readonly isDestroyed: boolean
  destroy(): void
}

export interface DomMirrorOptions {
  /** Where the mirror is mounted. Normally the same container as the canvas. */
  readonly parent: HTMLElement
  /** The accessible name of the list itself. */
  readonly label?: string
  /** Defaults to the document the parent belongs to. */
  readonly document?: Document
  /**
   * Whether to inject this module's own `<style>` element. Defaults to true.
   *
   * An inline `<style>` element is exactly what the hub's content-security-policy
   * refuses: `style-src 'self'` with no `unsafe-inline` (DASHBOARD_CSP in
   * src/hub/security.ts) makes a browser drop the sheet and log a policy
   * violation for it. A page served by the hub therefore sets this to false and
   * carries the same rules in its own linked stylesheet - which the browser
   * accepts, because that is what `style-src 'self'` is for. jsdom has no policy
   * and the prototype page is opened from a file, so both keep the default and
   * the mirror stays hidden with no stylesheet of its own depending on anything
   * a caller remembered to set.
   *
   * The obligation this creates is on the caller, so it is stated here rather
   * than left implied: a caller that passes false must already carry
   * `mirrorStyleSheet()`'s rules in a sheet the policy allows. The live page's
   * suite asserts both halves - the rules are present, and no `<style>` element
   * is injected.
   */
  readonly injectStyleSheet?: boolean
}

let instanceCount = 0

export function createDomMirror(options: DomMirrorOptions): DomMirror {
  const doc = options.document ?? options.parent.ownerDocument
  instanceCount += 1
  const instanceId = `dashboard-mirror-${instanceCount}`
  const ownsStyleSheet = options.injectStyleSheet !== false
  if (ownsStyleSheet) installStyleSheet(doc)

  const root = doc.createElement('ul')
  root.setAttribute(MIRROR_ROOT_ATTRIBUTE, '')
  root.className = MIRROR_CLASS
  root.setAttribute('aria-label', options.label ?? MIRROR_DEFAULT_LABEL)
  // Focusable only so an emptied list can hold focus; never a tab stop.
  root.setAttribute('tabindex', '-1')
  options.parent.append(root)

  let rows: readonly MirrorRow[] = []
  let entries: readonly HTMLElement[] = []
  let signature = ''
  let destroyed = false
  let rebuilt: () => void = () => {}

  const readEntries = (): void => {
    entries = [...root.querySelectorAll<HTMLElement>(MIRROR_ROW_SELECTOR)]
  }

  /**
   * Everything about a model the mirror actually renders, flattened to a string.
   *
   * Compared before rebuilding, so a repaint that changes nothing the mirror shows
   * - revealing a repository's full path, or re-laying out after a resize - does
   * not replace every entry in the document. That matters beyond the wasted work:
   * a rebuild replaces the focused element, so a reveal triggered *by* focus
   * would otherwise destroy the node the browser had just focused.
   */
  const modelSignature = (model: MirrorModel): string =>
    model.groups
      .map(
        (group) =>
          `${group.repositoryId} ${group.shortName} ${group.path} ${group.rowIds.join(',')}`,
      )
      .join('') +
    '' +
    model.rows
      .map(
        (row) =>
          `${row.sessionId} ${row.state} ${row.encoding.token} ${row.encoding.label}` +
          ` ${row.label} ${row.status} ${row.age} ${row.repositoryId}`,
      )
      .join('')

  const buildRow = (row: MirrorRow): HTMLElement => {
    const entry = doc.createElement('li')
    entry.className = `${MIRROR_CLASS}__row`
    entry.setAttribute(MIRROR_ROW_ATTRIBUTE, row.sessionId)
    entry.setAttribute(MIRROR_STATE_ATTRIBUTE, row.state)
    // The silhouette the canvas draws, carried so a test can compare the two
    // renderers rather than trust that they agree.
    entry.setAttribute(MIRROR_ICON_ATTRIBUTE, row.encoding.icon)
    entry.setAttribute(MIRROR_REPOSITORY_ATTRIBUTE, row.repositoryShortName)
    // Detail, not label: never announced as the name and never drawn on the
    // canvas as the primary label.
    entry.setAttribute(MIRROR_PATH_ATTRIBUTE, row.repositoryPath)
    // Every entry is focusable. Roving tabindex decides which one Tab lands on;
    // the keyboard controller moves that as focus moves.
    entry.setAttribute('tabindex', '-1')
    // Identity, spoken first, because a row read away from its group has to say
    // which repository it belongs to.
    entry.append(doc.createTextNode(row.repositoryShortName))
    for (const field of mirrorRowFields(row)) {
      entry.append(doc.createTextNode(MIRROR_FIELD_SEPARATOR))
      const span = doc.createElement('span')
      span.setAttribute(field.attribute, '')
      span.textContent = field.text
      entry.append(span)
    }
    return entry
  }

  const build = (model: MirrorModel): void => {
    root.replaceChildren()
    for (const group of model.groups) {
      const groupItem = doc.createElement('li')
      groupItem.className = `${MIRROR_CLASS}__group`
      groupItem.setAttribute(MIRROR_GROUP_ATTRIBUTE, group.repositoryId)
      groupItem.setAttribute(MIRROR_PATH_ATTRIBUTE, group.path)

      // The group heading is the short name and is what the row list is named by,
      // so a screen reader announces the repository as focus enters it. Ids are
      // per instance because two mirrors in one document would otherwise share
      // them and `aria-labelledby` would resolve ambiguously.
      const heading = doc.createElement('span')
      heading.className = `${MIRROR_CLASS}__group-label`
      heading.setAttribute(MIRROR_GROUP_LABEL_ATTRIBUTE, group.repositoryId)
      heading.id = `${instanceId}-group-${group.repositoryId}`
      heading.textContent = group.shortName
      groupItem.append(heading)

      const list = doc.createElement('ul')
      list.className = `${MIRROR_CLASS}__rows`
      list.setAttribute(MIRROR_ROWS_ATTRIBUTE, group.repositoryId)
      list.setAttribute('aria-labelledby', heading.id)
      groupItem.append(list)

      // Rows are taken from the row model in the model's order and matched to
      // their group, so the mirror cannot sort independently of the canvas.
      for (const row of model.rows) {
        if (row.repositoryId !== group.repositoryId) continue
        list.append(buildRow(row))
      }
      root.append(groupItem)
    }
    rows = model.rows
    readEntries()
  }

  const focusedSessionId = (): string | null => {
    const active = doc.activeElement
    if (active === null || !root.contains(active)) return null
    return active.getAttribute(MIRROR_ROW_ATTRIBUTE)
  }

  /**
   * Put focus back after a rebuild, addressing it by session identifier.
   *
   * Three outcomes, all deliberate: the row is still there and takes focus; the
   * row is gone and the nearest survivor by previous position takes it, so the
   * developer stays inside the list; the list has emptied and the container takes
   * it, so focus is never dropped to the body. Nothing is ever blurred.
   */
  const restoreFocus = (sessionId: string | null, previousIndex: number): void => {
    if (sessionId !== null) {
      const index = entries.findIndex(
        (entry) => entry.getAttribute(MIRROR_ROW_ATTRIBUTE) === sessionId,
      )
      if (index >= 0) {
        entries[index]?.focus()
        return
      }
      if (entries.length > 0) {
        const nearest = Math.min(Math.max(previousIndex, 0), entries.length - 1)
        entries[nearest]?.focus()
        return
      }
    }
    // Nothing survives to take focus. Hold it on the container rather than let it
    // fall to the body, and never take it from whatever else has it.
    const active = doc.activeElement
    if (active !== null && active !== doc.body && !root.contains(active)) return
    root.focus()
  }

  const render = (model: MirrorModel): void => {
    if (destroyed) return
    const next = modelSignature(model)
    if (next === signature) return
    signature = next
    // Read focus before replacing anything: after the rebuild the focused element
    // is gone and the browser has already moved focus to the body.
    const active = doc.activeElement
    const hadFocusInside = active !== null && root.contains(active)
    const previous = focusedSessionId()
    const previousIndex = previous === null ? -1 : rows.findIndex((row) => row.sessionId === previous)

    build(model)
    // Announced before focus is restored, so the listener sees the finished
    // element list. It re-reads them again afterwards from `document.activeElement`,
    // which is why the roving tabindex is right either way.
    rebuilt()

    if (previous === null && !hadFocusInside) return
    restoreFocus(previous, previousIndex < 0 ? 0 : previousIndex)
  }

  readEntries()

  return {
    root,
    get entries(): readonly HTMLElement[] {
      return entries
    },
    get order(): readonly string[] {
      return entries.map((entry) => entry.getAttribute(MIRROR_ROW_ATTRIBUTE) ?? '')
    },
    onRebuilt(listener: () => void): void {
      rebuilt = listener
    },
    entriesForRepository(repositoryId: string): readonly HTMLElement[] {
      return entries.filter((entry) => {
        const group = entry.closest(`[${MIRROR_GROUP_ATTRIBUTE}]`)
        return group?.getAttribute(MIRROR_GROUP_ATTRIBUTE) === repositoryId
      })
    },
    entryForSession(sessionId: string): HTMLElement | null {
      return entries.find((entry) => entry.getAttribute(MIRROR_ROW_ATTRIBUTE) === sessionId) ?? null
    },
    groupForRepository(repositoryId: string): HTMLElement | null {
      // Compared rather than matched with an attribute selector: the identifier
      // comes from a repository path, and interpolating one into a selector is a
      // quoting bug waiting for a checkout directory with an apostrophe in it.
      for (const child of root.children) {
        if (child.getAttribute(MIRROR_GROUP_ATTRIBUTE) === repositoryId) {
          return child as HTMLElement
        }
      }
      return null
    },
    render,
    get isDestroyed(): boolean {
      return destroyed
    },
    destroy(): void {
      if (destroyed) return
      destroyed = true
      // No focus call here on purpose: removing the focused node already moves
      // focus to the body, and nudging it back would fire a focus change during
      // teardown that nothing is left to handle.
      entries = []
      rows = []
      signature = ''
      rebuilt = () => {}
      root.remove()
      if (ownsStyleSheet) releaseStyleSheet()
    },
  }
}
