// The prototype's one mount entry point (DP-FR-02) and the page's composition
// root.
//
// `mountPrototype` is the only export a caller needs, and it is the only entry
// point tests drive. It owns three things and nothing else: the size of the
// surface, the subscriptions it registers, and the teardown that removes both.
// Everything it draws comes from the mock module, so this page performs no
// network request and reads no file (DP-FR-01).
//
// The canvas and its DOM mirror are mounted together here, and neither can exist
// without the other (DP-FR-05, APX-CON-07): a row that is not focusable and
// legible to a screen reader is a dead end, and the two are built from one row
// model so they cannot drift out of order. Focus reveals the full path exactly as
// hover does, and activation is reported rather than implied.
//
// The renderer arrives through a seam. The production host is real PixiJS 8; a
// test can supply a host and a scene target that record what was asked of them,
// which is how a headless jsdom run asserts the composition the browser paints.

import { Application, Container } from 'pixi.js'
import { createDomMirror, type DomMirror } from '../a11y/dom-mirror'
import { createKeyboardNavigator, type KeyboardNavigator } from '../a11y/keyboard-nav'
import {
  createMotionController,
  type MotionController,
  type MotionControllerOptions,
} from '../theme/motion'
import type { MockRepository } from './mock-data'
import { PROTOTYPE_NOW, PROTOTYPE_REPOSITORIES } from './mock-data'
import type { RenderedRow, ScenePlan, SceneTarget, SceneTargetOptions } from './scene'
import {
  PROTOTYPE_COLORS,
  buildScene,
  createPixiSceneTarget,
  paintScene,
} from './scene'

/** The attribute the page HTML puts on the element the dashboard mounts into. */
export const DASHBOARD_ROOT_ATTRIBUTE = 'data-dashboard-root'

export interface Size {
  readonly width: number
  readonly height: number
}

/**
 * Used when the container reports no layout, which happens in a hidden window
 * and in jsdom. A zero-sized surface would render nothing at all, which reads
 * as a layout bug rather than as "not laid out yet".
 */
export const FALLBACK_SIZE: Size = Object.freeze({ width: 960, height: 540 })

export function measureContainer(container: HTMLElement): Size {
  const width = Math.round(container.clientWidth)
  const height = Math.round(container.clientHeight)
  return {
    width: width > 0 ? width : FALLBACK_SIZE.width,
    height: height > 0 ? height : FALLBACK_SIZE.height,
  }
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

/**
 * The arguments the renderer is destroyed with. Named constants rather than
 * inline literals so the test can assert the exact object the real host passes
 * to `Application.destroy`, including the texture options that stop a destroyed
 * dashboard from leaving canvas textures behind.
 */
export const RENDERER_DESTROY_OPTIONS = Object.freeze({ removeView: true, releaseGlobalResources: true })
export const STAGE_DESTROY_OPTIONS = Object.freeze({ children: true, texture: true, textureSource: true })

/**
 * Every teardown hook the mount registered, in one place, so unload can prove it
 * removed all of them. A leaked listener or an un-disconnected observer is the
 * failure this type exists to make visible.
 */
export class SubscriptionBag {
  private readonly removers: (() => void)[] = []

  add(remove: () => void): void {
    this.removers.push(remove)
  }

  get size(): number {
    return this.removers.length
  }

  removeAll(): void {
    while (this.removers.length > 0) {
      const remove = this.removers.pop()
      if (remove !== undefined) remove()
    }
  }
}

// ---------------------------------------------------------------------------
// The renderer seam
// ---------------------------------------------------------------------------

export interface DashboardHost {
  /** The canvas the renderer created, already in the container's subtree. */
  readonly canvas: HTMLCanvasElement
  /** Root of the scene graph the painter draws into. */
  readonly root: Container
  getSize(): Size
  setSize(size: Size): void
  /** Stops the render loop before teardown, so no frame runs against a dead renderer. */
  stopRendering(): void
  readonly isTornDown: boolean
  teardown(): void
}

export interface PixiHostOptions {
  readonly container: HTMLElement
  readonly size: Size
  /** Overridden by tests; production constructs a real `Application`. */
  readonly createApplication?: () => Application
}

/**
 * The real PixiJS 8 host.
 *
 * `new Application()` allocates nothing on its own and `app.init()` is async:
 * `app.canvas`, `app.stage` and `app.screen` only exist once it resolves. Passing
 * options to the constructor instead is the v7 shape and produces a blank page
 * that looks like a layout bug.
 *
 * Sizing is owned here rather than handed to PixiJS's `resizeTo`, because
 * `resizeTo` only follows window resizes while the surface is a container, and
 * because owning it keeps every subscription in one bag the unload path empties.
 */
export async function createPixiDashboardHost(options: PixiHostOptions): Promise<DashboardHost> {
  const application = (options.createApplication ?? ((): Application => new Application()))()

  await application.init({
    width: options.size.width,
    height: options.size.height,
    background: PROTOTYPE_COLORS.pageBackground,
    antialias: true,
    autoDensity: true,
    resolution: globalThis.devicePixelRatio > 1 ? globalThis.devicePixelRatio : 1,
  })

  const canvas = application.canvas
  // The canvas carries no semantics of its own: the DOM mirror added in DP-3 is
  // the accessible twin, and announcing an empty canvas only adds noise.
  canvas.setAttribute('aria-hidden', 'true')
  canvas.style.display = 'block'
  options.container.appendChild(canvas)

  const root = new Container()
  application.stage.addChild(root)

  let tornDown = false

  return {
    canvas,
    root,
    getSize(): Size {
      const { width, height } = application.screen
      return { width, height }
    },
    setSize(size: Size): void {
      if (tornDown) return
      application.renderer.resize(size.width, size.height)
    },
    stopRendering(): void {
      if (tornDown) return
      application.ticker.stop()
    },
    get isTornDown(): boolean {
      return tornDown
    },
    teardown(): void {
      if (tornDown) return
      tornDown = true
      application.destroy(RENDERER_DESTROY_OPTIONS, STAGE_DESTROY_OPTIONS)
    },
  }
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

export interface MountOptions {
  readonly container: HTMLElement
  /** Defaults to the deterministic mock module (DP-FR-06). */
  readonly repositories?: readonly MockRepository[]
  /** The instant ages are measured against. Defaults to the fixed prototype clock. */
  readonly now?: string
  /** Defaults to the real PixiJS 8 host. */
  readonly createHost?: (options: { container: HTMLElement; size: Size }) => Promise<DashboardHost>
  /** Defaults to the real PixiJS painter. */
  readonly createTarget?: (root: Container, options: SceneTargetOptions) => SceneTarget
  /**
   * Defaults to the real motion policy, which reads the window's reduced-motion
   * preference and re-reads it when it changes. A test injects one built from a
   * preference it controls, because jsdom has no `matchMedia`.
   */
  readonly createMotionController?: (options: MotionControllerOptions) => MotionController
  /** Defaults to the real DOM mirror. */
  readonly createMirror?: (options: { parent: HTMLElement }) => DomMirror
  /** Defaults to the real keyboard controller over the mirror. */
  readonly createNavigator?: (options: {
    container: HTMLElement
    motion: MotionController
    onActivate: (sessionId: string) => void
    onFocusRow: (sessionId: string) => void
    onBlurRow: (sessionId: string, relatedTarget: Element | null) => void
  }) => KeyboardNavigator
}

export interface PrototypeDashboard {
  readonly host: DashboardHost
  /** The current plan. `rows` is canvas order, which is the mirror's order too. */
  readonly plan: ScenePlan
  readonly rows: readonly RenderedRow[]
  /** The visually hidden, focusable twin of every row (DP-FR-05). */
  readonly mirror: DomMirror
  /** Keyboard traversal and activation over the mirror (DP-FR-04). */
  readonly navigator: KeyboardNavigator
  /** The motion policy the mirror's transitions are gated by. */
  readonly motion: MotionController
  /** The row the keyboard last activated, or null. Observability, not a control. */
  readonly activatedSessionId: string | null
  /** How many teardown hooks are still registered. Zero once destroyed. */
  readonly activeSubscriptions: number
  readonly isDestroyed: boolean
  /** Reveal one repository's full path, or `null` for none. Pointer and focus both call this. */
  setHoveredRepository(repositoryId: string | null): void
  /** Re-read the container size and re-lay out. */
  remeasure(): void
  destroy(): void
}

export async function mountPrototype(options: MountOptions): Promise<PrototypeDashboard> {
  const container = options.container
  const repositories = options.repositories ?? PROTOTYPE_REPOSITORIES
  const now = options.now ?? PROTOTYPE_NOW
  const createHost = options.createHost ?? createPixiDashboardHost
  const createTarget = options.createTarget ?? createPixiSceneTarget
  const buildMotionController = options.createMotionController ?? createMotionController

  const host = await createHost({ container, size: measureContainer(container) })
  const bag = new SubscriptionBag()
  const canvas = host.canvas
  let destroyed = false
  let activatedSessionId: string | null = null
  let hoveredRepositoryId: string | null = null
  let plan = buildScene(repositories, {
    width: host.getSize().width,
    height: host.getSize().height,
    now,
    hoveredRepositoryId,
  })
  const target = createTarget(host.root, {
    onRepositoryHover: (repositoryId) => {
      setHoveredRepository(repositoryId)
    },
  })

  // The motion policy is created before the mirror, because the mirror's
  // transitions and the keyboard controller's focus indicator both ask it.
  const motion = buildMotionController({})
  bag.add(() => {
    motion.destroy()
  })

  const mirror = (options.createMirror ?? createDomMirror)({ parent: container })
  bag.add(() => {
    mirror.destroy()
  })

  const repositoryIdFor = (sessionId: string): string | null =>
    plan.rows.find((row) => row.sessionId === sessionId)?.repositoryId ?? null

  const navigator = (options.createNavigator ?? createKeyboardNavigator)({
    container: mirror.root,
    motion,
    onActivate: (sessionId) => {
      // Nothing on a static row is activatable yet, so the activation is recorded
      // rather than performed: the point of DP-3 is that activating a row is
      // observable, and LD-3 hangs the real reaction off this callback.
      activatedSessionId = sessionId
    },
    onFocusRow: (sessionId) => {
      // Focus reveals the full path exactly as hover does (DP-FR-03), so a
      // keyboard user gets the same detail a pointer user gets.
      const repositoryId = repositoryIdFor(sessionId)
      if (repositoryId !== null) setHoveredRepository(repositoryId)
    },
    onBlurRow: (_sessionId, relatedTarget) => {
      // Traversal inside the list is not a leave. Rebuilding the plan mid-traversal
      // would replace the node the browser is in the middle of focusing, and the
      // next focusin reveals the row that actually has focus.
      if (relatedTarget !== null && mirror.root.contains(relatedTarget)) return
      setHoveredRepository(null)
    },
  })
  bag.add(() => {
    navigator.destroy()
  })

  // The mirror announces its own rebuilds and the keyboard model answers, so no
  // update path can replace the entries and leave the roving tabindex behind.
  mirror.onRebuilt(() => {
    navigator.refresh()
  })

  const repaint = (): void => {
    target.clear()
    paintScene(plan, target)
  }

  // The states the mirror was last told about, so a state change and a row that
  // has just arrived can be told apart. Empty until the first render, which makes
  // every row an arrival.
  let mirroredRows: readonly RenderedRow[] = []

  const markArrivals = (rows: readonly RenderedRow[]): void => {
    const previous = new Map(mirroredRows.map((row) => [row.sessionId, row.state] as const))
    for (const row of rows) {
      const before = previous.get(row.sessionId)
      const arrived = before === undefined
      if (!arrived && before === row.state) continue
      const entry = mirror.entryForSession(row.sessionId)
      if (entry === null) continue
      // An arriving row may move in; a state change never does. Under reduced
      // motion the arrival is instant and the state change is still visible, which
      // is the whole of what reduced motion is allowed to suppress here.
      if (arrived) motion.apply(entry, 'state-arrival', true)
      motion.showStateChange(entry)
    }
    mirroredRows = rows
  }

  /**
   * Repaint the canvas and hand the plan to its mirror.
   *
   * Every plan change goes through here, so a row can never exist on the canvas
   * and not in the mirror. The mirror skips the rebuild itself when the plan
   * carries nothing it would render differently - a revealed full path, a resize -
   * which is what keeps a reveal *caused by* focus from replacing the node the
   * browser has just focused.
   */
  const applyPlan = (): void => {
    repaint()
    // The keyboard model is refreshed by the mirror's rebuild hook, not here, so
    // the two cannot be wired up differently on this path and on any later one.
    mirror.render(plan)
    markArrivals(plan.rows)
  }

  // Pointer targets follow the layout, not the state: a state change repaints the
  // rows and leaves them alone, because replacing the object the pointer is
  // inside cancels the very hover that asked for the repaint.
  target.setHoverRegions(plan.hoverRegions)
  applyPlan()

  function setHoveredRepository(repositoryId: string | null): void {
    if (destroyed) return
    if (repositoryId === hoveredRepositoryId) return
    const next = buildScene(repositories, {
      width: plan.width,
      height: plan.height,
      now,
      hoveredRepositoryId: repositoryId,
    })
    if (next.hoveredRepositoryId === plan.hoveredRepositoryId) return
    hoveredRepositoryId = next.hoveredRepositoryId
    plan = next
    applyPlan()
    // The revealed full path is non-essential movement, so the same preference that
    // suppresses an arriving row suppresses the reveal's transition. The revealed
    // path itself is not suppressed: it is the identity detail the requirement
    // promises on focus.
    for (const group of plan.groups) {
      const revealed = group.repositoryId === hoveredRepositoryId
      const element = mirror.groupForRepository(group.repositoryId)
      if (element !== null) motion.apply(element, 'full-path-reveal', revealed)
    }
  }

  function remeasure(): void {
    if (destroyed) return
    const next = measureContainer(container)
    if (next.width === plan.width && next.height === plan.height) return
    host.setSize(next)
    const nextPlan = buildScene(repositories, {
      width: host.getSize().width,
      height: host.getSize().height,
      now,
      hoveredRepositoryId: hoveredRepositoryId,
    })
    hoveredRepositoryId = nextPlan.hoveredRepositoryId
    plan = nextPlan
    target.setHoverRegions(plan.hoverRegions)
    applyPlan()
  }

  // Two independent size sources, because neither covers the other: a
  // ResizeObserver sees the container change for any reason, and the window
  // listener is the only one that exists in an environment without the observer.
  const onWindowResize = (): void => {
    remeasure()
  }
  window.addEventListener('resize', onWindowResize)
  bag.add(() => {
    window.removeEventListener('resize', onWindowResize)
  })

  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(() => {
      remeasure()
    })
    observer.observe(container)
    bag.add(() => {
      observer.disconnect()
    })
  }

  const destroy = (): void => {
    if (destroyed) return
    destroyed = true
    bag.removeAll()
    host.stopRendering()
    host.teardown()
    if (canvas.parentNode !== null) canvas.parentNode.removeChild(canvas)
  }

  // Unload, not a bespoke teardown hook: closing the window or navigating away
  // has to be enough for the renderer and its subscriptions to go away.
  const onUnload = (): void => {
    destroy()
  }
  window.addEventListener('beforeunload', onUnload)
  bag.add(() => {
    window.removeEventListener('beforeunload', onUnload)
  })

  return {
    host,
    mirror,
    navigator,
    motion,
    get plan(): ScenePlan {
      return plan
    },
    get rows(): readonly RenderedRow[] {
      return plan.rows
    },
    get activatedSessionId(): string | null {
      return activatedSessionId
    },
    get activeSubscriptions(): number {
      return bag.size
    },
    get isDestroyed(): boolean {
      return destroyed
    },
    setHoveredRepository,
    remeasure,
    destroy,
  }
}

// ---------------------------------------------------------------------------
// Page composition root
// ---------------------------------------------------------------------------

/**
 * Mount automatically when this module is loaded as the page's entry script and
 * the page has provided a root. A test importing the module to call
 * `mountPrototype` directly finds no root in the document, so importing it mounts
 * nothing.
 */
const pageRoot = document.querySelector<HTMLElement>(`[${DASHBOARD_ROOT_ATTRIBUTE}]`)
if (pageRoot !== null) {
  void mountPrototype({ container: pageRoot }).catch((error: unknown) => {
    // Nothing else is on this page to report it, so at least keep it off the
    // console as an unhandled rejection.
    console.error('agent-ping prototype failed to mount', error)
  })
}
