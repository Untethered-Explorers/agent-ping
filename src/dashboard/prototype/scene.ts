// The prototype scene: a pure layout pass plus the PixiJS 8 painter that draws
// it.
//
// The split is deliberate. `buildScene` is a pure function of the mock data, the
// canvas size and the hovered repository, so the composition under review can be
// asserted without a GPU. `createPixiSceneTarget` turns that plan into real
// Graphics and Text objects. Keeping the two apart is what lets a headless test
// drive the same plan the browser paints, instead of asserting a parallel
// re-implementation of it.
//
// WHAT LD-1 ADDED TO IT, AND WHY IT IS HERE RATHER THAN IN THE LIVE MODULE
// The geometry lives in `layoutGroups`, which takes a repository, some rows, an
// icon and a word and nothing about where they came from. `buildScene` is the mock
// module's adapter onto it. The live page (src/dashboard/live/session-list.ts)
// adapts the hub's own session rows onto the same shape and lays them out with the
// same function, because the approved prototype layout *is* the layout (LD-FR-01,
// LD-FR-10): a second copy of the arithmetic would be a second layout that can
// drift from the one a human signed off, and the row model, the group model and
// the state union are all parameterised for exactly that reason. Nothing the
// prototype draws changes: `contentHeight` for the three mock rows, every row
// position and every draw command is still the output of the same arithmetic,
// which is what tests/dashboard/prototype-scene.test.ts pins.

import { Container, Graphics, Rectangle, Text, TextStyle } from 'pixi.js'
import type { MockRepository, MockSession, SessionState } from './mock-data'
import { repositoryShortName } from './mock-data'

// ---------------------------------------------------------------------------
// Colour tokens
// ---------------------------------------------------------------------------

/**
 * Colour is used for grouping only. State is icon plus text, so a monochrome or
 * colour-blind reading loses nothing (APX-CON-07, DP-FR-03): every state accent
 * here tints a shape, never a piece of body text.
 *
 * Every text token is asserted against its actual background for WCAG 2.1 AA in
 * tests/dashboard from DP-3 onward.
 */
export const PROTOTYPE_COLORS = Object.freeze({
  pageBackground: 0x0f1115,
  groupHeaderText: 0xc7ccd8,
  rowLabelText: 0xf2f4f8,
  rowMutedText: 0xa8b0c0,
  rowDivider: 0x2a2f3a,
  blockedAccent: 0xff6b6b,
  finishedAccent: 0x7bd88f,
  runningAccent: 0x74a9ff,
})

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/** Density is the thing under review: if three rows already feel crowded, the real list will be worse. */
export const LAYOUT = Object.freeze({
  pagePaddingX: 24,
  pagePaddingTop: 20,
  groupIndent: 12,
  groupHeaderHeight: 28,
  groupGap: 16,
  rowIndent: 10,
  // Three mock rows come to about 200px of content. A busy afternoon is roughly
  // five repositories of ten sessions, which is well past one screen, and this
  // prototype deliberately has no scrolling: whether a busy list scrolls the page
  // or grows a scroll region inside it is a design question for DP-4, not
  // something to decide quietly here.
  rowHeight: 44,
  iconSize: 13,
  iconGap: 11,
  repositoryNameSize: 13,
  stateLabelSize: 12.5,
  metaSize: 11.5,
  statusSize: 11.5,
  statusLineTop: 26,
  labelLineTop: 9,
  labelLineHeight: 15,
  dividerWidth: 1,
  cornerRadius: 3,
  /** Share of the content width the revealed full path may occupy. */
  fullPathWidthFraction: 0.5,
})

const SYSTEM_FONT =
  'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'

// ---------------------------------------------------------------------------
// Non-colour state encoding (DP-FR-03)
// ---------------------------------------------------------------------------

/**
 * Four silhouettes, not four hues: a filled square reads as "stopped", a tick as
 * "done", a triangle as "in flight", a dot as "reported, nothing needed". Each is
 * paired with a word, so a row is fully legible with colour, with the icon, or with
 * neither.
 *
 * `dot` arrives with LD-1: information-only is the live page's fourth state
 * (LD-FR-02), and a state that is not colour alone needs a shape of its own. The
 * prototype's three rows do not use it, so the approved page is unchanged.
 */
export type StateIconName = 'stop' | 'check' | 'triangle' | 'dot'

export interface StateEncoding {
  readonly icon: StateIconName
  /** The word that carries the state when the icon and colour are both absent. */
  readonly label: string
  /**
   * A short text token for the visually hidden DOM mirror, where an icon is
   * drawn by the reader's own rendering rather than by this canvas.
   */
  readonly token: string
  /** Tints the icon only. Never applied to body text. */
  readonly accent: number
}

/**
 * Total by construction: `SessionState` is a closed union and this record is
 * typed against it, so adding a state is a compile error here rather than a row
 * that silently loses its non-colour encoding.
 */
export const STATE_ENCODING: Readonly<Record<SessionState, StateEncoding>> = Object.freeze({
  blocked: Object.freeze({ icon: 'stop' as const, label: 'Blocked', token: '[stop]', accent: PROTOTYPE_COLORS.blockedAccent }),
  finished: Object.freeze({ icon: 'check' as const, label: 'Finished', token: '[check]', accent: PROTOTYPE_COLORS.finishedAccent }),
  running: Object.freeze({ icon: 'triangle' as const, label: 'Running', token: '[play]', accent: PROTOTYPE_COLORS.runningAccent }),
})

/** Every state name, for exhaustive checks in the tests. */
export const SESSION_STATES: readonly SessionState[] = Object.freeze([
  'blocked',
  'finished',
  'running',
] as const satisfies readonly SessionState[])

export function stateEncoding(state: SessionState): StateEncoding {
  return STATE_ENCODING[state]
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

/** Blocked first, then most recently active; the session id breaks exact ties. */
const STATE_RANK: Readonly<Record<SessionState, number>> = Object.freeze({
  blocked: 0,
  running: 1,
  finished: 2,
})

/**
 * The only rows that can need something sort to the top of their group, so
 * blocked comes first. Ties break on recency and then on the id, which keeps the
 * order total and therefore stable between renders.
 */
export function orderSessions(sessions: readonly MockSession[]): readonly MockSession[] {
  return [...sessions].sort((left, right) => {
    const byState = STATE_RANK[left.state] - STATE_RANK[right.state]
    if (byState !== 0) return byState
    const byRecency = Date.parse(right.lastEventAt) - Date.parse(left.lastEventAt)
    if (byRecency !== 0) return byRecency
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  })
}

// ---------------------------------------------------------------------------
// Age
// ---------------------------------------------------------------------------

/**
 * A compact age, e.g. "8m", "2h", "3d". Deterministic because both arguments are
 * ISO strings, never a live clock.
 */
export function formatAge(lastEventAt: string, now: string): string {
  const elapsedMs = Date.parse(now) - Date.parse(lastEventAt)
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return 'now'
  const seconds = Math.floor(elapsedMs / 1000)
  if (seconds < 60) return '<1m'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/**
 * The row's one line of status: what the session is, then what it is waiting on.
 * Composed here rather than stored, so the row model keeps `label` and `status`
 * as separate fields for the DOM mirror while the canvas spends one line on them.
 */
export function statusLine(session: MockSession): string {
  return composeStatusLine(session.label, session.status)
}

/**
 * The one composition of a row's label and status into the line the canvas draws.
 *
 * Shared with the live page (`composeStatusLine` is what `layoutGroups` calls), so
 * the approved row and the live row speak the same single line rather than two
 * similar ones.
 */
export function composeStatusLine(label: string, status: string): string {
  return label.length === 0 ? status : `${label} – ${status}`
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export type TextRole =
  | 'repository-short-name'
  | 'repository-full-path'
  | 'session-state-label'
  | 'session-age'
  | 'session-status'

export interface RectCommand {
  readonly kind: 'rect'
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly fill: number
  readonly radius: number
}

export interface LineCommand {
  readonly kind: 'line'
  readonly x1: number
  readonly y1: number
  readonly x2: number
  readonly y2: number
  readonly color: number
  readonly width: number
}

export interface IconCommand {
  readonly kind: 'icon'
  readonly icon: StateIconName
  readonly x: number
  readonly y: number
  readonly size: number
  readonly color: number
}

export interface TextCommand {
  readonly kind: 'text'
  readonly role: TextRole
  readonly text: string
  readonly x: number
  readonly y: number
  readonly size: number
  readonly color: number
  readonly weight: 'normal' | 'semibold'
  readonly align: 'left' | 'right'
  /** Present when the text must be clipped to a single line. */
  readonly maxWidth?: number
}

export type DrawCommand = RectCommand | LineCommand | IconCommand | TextCommand

/** The pointer region that reveals a repository's full path. */
export interface HoverRegion {
  readonly repositoryId: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** One visible session row, in canvas order. DP-3's DOM mirror derives from this. */
export interface RenderedRow<S extends string = SessionState> {
  readonly sessionId: string
  readonly repositoryId: string
  readonly repositoryShortName: string
  readonly repositoryPath: string
  readonly state: S
  readonly encoding: StateEncoding
  readonly label: string
  readonly status: string
  readonly age: string
  readonly y: number
  readonly height: number
}

export interface RenderedGroup {
  readonly repositoryId: string
  /** The primary label. Never the full path (APX-CON-09). */
  readonly shortName: string
  readonly path: string
  readonly y: number
  readonly height: number
  readonly rowIds: readonly string[]
}

export interface ScenePlan<S extends string = SessionState> {
  readonly width: number
  readonly height: number
  /** How tall the rows actually are, which can be less than the canvas height. */
  readonly contentHeight: number
  readonly groups: readonly RenderedGroup[]
  /** Canvas order: groups in order, blocked-first rows within each group. */
  readonly rows: readonly RenderedRow<S>[]
  /** Paint order. Every command here is a command the painter issues. */
  readonly draws: readonly DrawCommand[]
  readonly hoverRegions: readonly HoverRegion[]
  readonly hoveredRepositoryId: string | null
}

export interface BuildSceneOptions {
  readonly width: number
  readonly height: number
  readonly now: string
  /** Repository whose full path is revealed. `null` for none. */
  readonly hoveredRepositoryId?: string | null
}

/**
 * A row the layout is told about, before it is positioned.
 *
 * The layout needs a repository, a row, an icon and a word - nothing about where
 * the data came from. That is what lets the live page lay its own rows out with
 * this module's geometry instead of restating it: the approved layout is one
 * function, and a second copy of the arithmetic is a second layout that can drift.
 */
export interface LayoutRow<S extends string = string> {
  readonly id: string
  readonly state: S
  readonly encoding: StateEncoding
  /** The row's own short label, spoken separately from the status line. */
  readonly label: string
  /** One line of state text. Never conversation content (APX-FR-01). */
  readonly status: string
  /** Already formatted against the plan's own clock. */
  readonly age: string
}

/** One repository's rows, in the order the layout must draw them. */
export interface LayoutGroup<S extends string = string> {
  readonly id: string
  /** The primary label: the short name, never the path (APX-CON-09). */
  readonly shortName: string
  readonly path: string
  readonly rows: readonly LayoutRow<S>[]
}

/**
 * Lay groups of rows into a draw plan. Pure, and the one place the geometry lives.
 *
 * Every row is laid out, whatever the canvas height: the plan describes the rows
 * the surface has, and the canvas paints the part of them that fits. A caller whose
 * rows can exceed its own height decides what to do about that (the live page
 * grows its canvas to the content; the prototype's three rows never reach the
 * question).
 */
export function layoutGroups<S extends string>(
  groups: readonly LayoutGroup<S>[],
  options: BuildSceneOptions,
): ScenePlan<S> {
  const hovered = options.hoveredRepositoryId ?? null
  const hoveredIsKnown = groups.some((group) => group.id === hovered)
  const hoveredId = hoveredIsKnown ? hovered : null

  const width = Math.max(0, Math.round(options.width))
  const contentRight = Math.max(0, width - LAYOUT.pagePaddingX)
  const contentWidth = contentRight - LAYOUT.pagePaddingX
  const nameX = LAYOUT.pagePaddingX + LAYOUT.groupIndent
  const rowX = LAYOUT.pagePaddingX + LAYOUT.groupIndent + LAYOUT.rowIndent

  const draws: DrawCommand[] = [
    // Painted first so the group and row marks sit on top of it.
    {
      kind: 'rect',
      x: 0,
      y: 0,
      width,
      height: Math.max(0, options.height),
      fill: PROTOTYPE_COLORS.pageBackground,
      radius: 0,
    },
  ]
  const rows: RenderedRow<S>[] = []
  const groups_: RenderedGroup[] = []
  const hoverRegions: HoverRegion[] = []

  let cursorY = LAYOUT.pagePaddingTop

  for (const group of groups) {
    const groupTop = cursorY
    const shortName = group.shortName
    const headerTextTop = groupTop + 4

    draws.push({
      kind: 'text',
      role: 'repository-short-name',
      text: shortName,
      x: nameX,
      y: headerTextTop,
      size: LAYOUT.repositoryNameSize,
      color: PROTOTYPE_COLORS.groupHeaderText,
      weight: 'semibold',
      align: 'left',
    })

    // The full path is revealed beside the short name, right-aligned to the
    // content edge so it can never sit on top of the primary label. It is never
    // the primary label and never appears alone.
    if (hoveredId === group.id && contentWidth > 0) {
      draws.push({
        kind: 'text',
        role: 'repository-full-path',
        text: group.path,
        x: contentRight,
        y: headerTextTop,
        size: LAYOUT.metaSize,
        color: PROTOTYPE_COLORS.rowMutedText,
        weight: 'normal',
        align: 'right',
        maxWidth: Math.round(contentWidth * LAYOUT.fullPathWidthFraction),
      })
    }

    const headerRuleY = groupTop + LAYOUT.groupHeaderHeight
    draws.push({
      kind: 'line',
      x1: nameX,
      y1: headerRuleY,
      x2: contentRight,
      y2: headerRuleY,
      color: PROTOTYPE_COLORS.rowDivider,
      width: LAYOUT.dividerWidth,
    })

    const groupRowIds: string[] = []
    let rowY = headerRuleY + 1

    for (const [index, row] of group.rows.entries()) {
      const iconX = rowX
      const iconY = rowY + LAYOUT.labelLineTop + (LAYOUT.labelLineHeight - LAYOUT.iconSize) / 2
      const textX = iconX + LAYOUT.iconSize + LAYOUT.iconGap
      const statusWidth = Math.max(0, contentRight - textX)

      rows.push({
        sessionId: row.id,
        repositoryId: group.id,
        repositoryShortName: shortName,
        repositoryPath: group.path,
        state: row.state,
        encoding: row.encoding,
        label: row.label,
        status: row.status,
        age: row.age,
        y: rowY,
        height: LAYOUT.rowHeight,
      })
      groupRowIds.push(row.id)

      // A row carries four things: a state icon, the word that goes with it, an
      // age, and one line of status. The session's own label and its status are
      // composed into that single status line rather than given a line each,
      // because density is what the design review is judging.
      draws.push({
        kind: 'icon',
        icon: row.encoding.icon,
        x: iconX,
        y: iconY,
        size: LAYOUT.iconSize,
        color: row.encoding.accent,
      })
      draws.push({
        kind: 'text',
        role: 'session-state-label',
        text: row.encoding.label,
        x: textX,
        y: rowY + LAYOUT.labelLineTop,
        size: LAYOUT.stateLabelSize,
        color: PROTOTYPE_COLORS.rowLabelText,
        weight: 'semibold',
        align: 'left',
      })
      draws.push({
        kind: 'text',
        role: 'session-age',
        text: row.age,
        x: contentRight,
        y: rowY + LAYOUT.labelLineTop,
        size: LAYOUT.metaSize,
        color: PROTOTYPE_COLORS.rowMutedText,
        weight: 'normal',
        align: 'right',
      })
      draws.push({
        kind: 'text',
        role: 'session-status',
        text: composeStatusLine(row.label, row.status),
        x: textX,
        y: rowY + LAYOUT.statusLineTop,
        size: LAYOUT.statusSize,
        color: PROTOTYPE_COLORS.rowMutedText,
        weight: 'normal',
        align: 'left',
        ...(statusWidth > 0 ? { maxWidth: statusWidth } : {}),
      })

      rowY += LAYOUT.rowHeight
      if (index < group.rows.length - 1) {
        draws.push({
          kind: 'line',
          x1: rowX,
          y1: rowY - LAYOUT.dividerWidth / 2,
          x2: contentRight,
          y2: rowY - LAYOUT.dividerWidth / 2,
          color: PROTOTYPE_COLORS.rowDivider,
          width: LAYOUT.dividerWidth,
        })
      }
    }

    const groupHeight = rowY - groupTop
    groups_.push({
      repositoryId: group.id,
      shortName,
      path: group.path,
      y: groupTop,
      height: groupHeight,
      rowIds: groupRowIds,
    })
    hoverRegions.push({
      repositoryId: group.id,
      x: 0,
      y: groupTop,
      width,
      height: groupHeight,
    })

    cursorY = rowY + LAYOUT.groupGap
  }

  const contentHeight = Math.max(0, cursorY - LAYOUT.groupGap - LAYOUT.pagePaddingTop)

  return {
    width,
    height: Math.max(0, Math.round(options.height)),
    contentHeight,
    groups: groups_,
    rows,
    draws,
    hoverRegions,
    hoveredRepositoryId: hoveredId,
  }
}

/**
 * Lay the mock data out into a draw plan. Pure: the same inputs always produce
 * the same plan, which is what makes the design review repeatable.
 *
 * The mock module's own types are adapted into the layout's neutral row shape and
 * nothing else: ordering, encoding and ageing are the renderer's job, and the
 * geometry below is the single copy of it that the live page also draws with.
 */
export function buildScene(
  repositories: readonly MockRepository[],
  options: BuildSceneOptions,
): ScenePlan {
  const groups: LayoutGroup<SessionState>[] = repositories.map((repository) => ({
    id: repository.id,
    shortName: repositoryShortName(repository.path),
    path: repository.path,
    rows: orderSessions(repository.sessions).map((session) => ({
      id: session.id,
      state: session.state,
      encoding: stateEncoding(session.state),
      label: session.label,
      status: session.status,
      age: formatAge(session.lastEventAt, options.now),
    })),
  }))
  return layoutGroups(groups, options)
}

// ---------------------------------------------------------------------------
// The PixiJS 8 painter
// ---------------------------------------------------------------------------

export interface SceneTargetOptions {
  /** Called with a repository id on hover, and with `null` on leave. */
  readonly onRepositoryHover: (repositoryId: string | null) => void
}

/**
 * The drawing surface the plan is painted into. The production implementation
 * below targets PixiJS; tests can supply a recorder and assert the exact
 * commands without a GPU.
 *
 * Note the split between `clear` and `setHoverRegions`. Hover regions are
 * pointer targets, not picture: they are rebuilt only when the layout geometry
 * moves, and deliberately not when a state change repaints the rows. Rebuilding
 * them on every repaint destroys the object the pointer is currently inside,
 * which reads as a hover that appears and instantly reverts.
 */
export interface SceneTarget {
  /** Drop everything drawn so far, releasing the textures those objects owned. */
  clear(): void
  rect(command: RectCommand): void
  line(command: LineCommand): void
  icon(command: IconCommand): void
  text(command: TextCommand): void
  setHoverRegions(regions: readonly HoverRegion[]): void
}

export function paintScene<S extends string>(plan: ScenePlan<S>, target: SceneTarget): void {
  for (const command of plan.draws) {
    switch (command.kind) {
      case 'rect':
        target.rect(command)
        break
      case 'line':
        target.line(command)
        break
      case 'icon':
        target.icon(command)
        break
      case 'text':
        target.text(command)
        break
    }
  }
}

/** Draw one state silhouette. Three distinct shapes, so colour is never the only cue. */
export function drawStateIcon(graphics: Graphics, command: IconCommand): void {
  const { x, y, size, color, icon } = command
  switch (icon) {
    case 'stop':
      graphics.roundRect(x, y, size, size, LAYOUT.cornerRadius).fill(color)
      break
    case 'check':
      graphics
        .moveTo(x, y + size * 0.55)
        .lineTo(x + size * 0.36, y + size * 0.92)
        .lineTo(x + size, y + size * 0.1)
        .stroke({ color, width: 2, cap: 'round', join: 'round' })
      break
    case 'triangle':
      graphics.poly([x, y, x + size, y + size / 2, x, y + size]).fill(color)
      break
    case 'dot':
      // A disc, not a fifth square: a reader told these apart by shape alone must
      // still tell this one apart from the blocked row's square.
      graphics.circle(x + size / 2, y + size / 2, size / 2.7).fill(color)
      break
  }
}

function textStyleFor(command: TextCommand): TextStyle {
  return new TextStyle({
    fontFamily: SYSTEM_FONT,
    fontSize: command.size,
    fill: command.color,
    fontWeight: command.weight === 'semibold' ? '600' : '400',
    align: 'left',
  })
}

/**
 * The visible band for a clipped line of text, in the text's own local space.
 *
 * A right-aligned `Text` is anchored at its right edge, so its glyphs occupy
 * negative x while a left-aligned one's occupy positive x. A mask band that
 * always started at x = 0 therefore sits beside the glyphs instead of over them,
 * and clips the text away entirely. Exported because that is a silent blank row
 * rather than an error, and a silent blank row is worth a test.
 */
export function textClipBand(command: {
  readonly align: TextCommand['align']
  readonly maxWidth: number
}): { readonly x: number; readonly width: number } {
  return { x: command.align === 'right' ? -command.maxWidth : 0, width: command.maxWidth }
}

/**
 * Paint a plan into a PixiJS container.
 *
 * The hover regions are invisible `Graphics` objects with an explicit `hitArea`
 * rather than drawn geometry, so adding pointer support for the full path adds
 * nothing to the picture.
 */
export function createPixiSceneTarget(
  root: Container,
  options: SceneTargetOptions,
): SceneTarget {
  const textLayer = new Container()
  const shapeLayer = new Container()
  const hitLayer = new Container()
  root.addChild(shapeLayer, textLayer, hitLayer)

  const addText = (command: TextCommand): void => {    const text = new Text({ text: command.text, style: textStyleFor(command) })
    if (command.align === 'right') text.anchor.set(1, 0)
    if (command.maxWidth === undefined) {
      text.position.set(command.x, command.y)
      textLayer.addChild(text)
      return
    }
    // A status line is one line by contract, not by wrapping: the text keeps its
    // real measured single-line width and the mask clips whatever runs past the
    // column. No word wrap, so the row never grows a second line under it.
    const clipped = new Container()
    clipped.position.set(command.x, command.y)
    clipped.addChild(text)
    const band = textClipBand({ align: command.align, maxWidth: command.maxWidth })
    // A mask Graphics has to be filled, not merely have a path, or it masks
    // everything away instead of nothing.
    const mask = new Graphics()
      .rect(band.x, 0, band.width, LAYOUT.statusSize * 1.6)
      .fill(0xffffff)
    clipped.addChild(mask)
    clipped.mask = mask
    textLayer.addChild(clipped)
  }

  return {
    clear(): void {
      // The hit layer is not picture and outlives a repaint; see SceneTarget.
      for (const layer of [shapeLayer, textLayer]) {
        for (const child of layer.removeChildren()) child.destroy({ children: true })
      }
    },
    rect(command: RectCommand): void {
      const graphics = new Graphics()
      graphics.roundRect(command.x, command.y, command.width, command.height, command.radius)
      graphics.fill(command.fill)
      shapeLayer.addChild(graphics)
    },
    line(command: LineCommand): void {
      const graphics = new Graphics()
      graphics
        .moveTo(command.x1, command.y1)
        .lineTo(command.x2, command.y2)
        .stroke({ color: command.color, width: command.width })
      shapeLayer.addChild(graphics)
    },
    icon(command: IconCommand): void {
      const graphics = new Graphics()
      drawStateIcon(graphics, command)
      shapeLayer.addChild(graphics)
    },
    text: addText,
    setHoverRegions(regions: readonly HoverRegion[]): void {
      for (const child of hitLayer.removeChildren()) child.destroy({ children: true })
      for (const region of regions) {
        // No drawn geometry: the hit area is declared, so revealing a full path
        // on hover adds nothing to the picture.
        const graphics = new Graphics()
        graphics.eventMode = 'static'
        graphics.hitArea = new Rectangle(region.x, region.y, region.width, region.height)
        graphics.on('pointerover', () => {
          options.onRepositoryHover(region.repositoryId)
        })
        graphics.on('pointerout', () => {
          options.onRepositoryHover(null)
        })
        hitLayer.addChild(graphics)
      }
    },
  }
}
