// The prototype's one mount entry point (DP-FR-02) and the page's composition
// root.
//
// `mountPrototype` is the only export a caller needs, and it is the only entry
// point tests drive. It owns three things and nothing else: the size of the
// surface, the subscriptions it registers, and the teardown that removes both.
// Everything it draws comes from the mock module, so this page performs no
// network request and reads no file (DP-FR-01).
//
// The renderer arrives through a seam. The production host is real PixiJS 8; a
// test can supply a host and a scene target that record what was asked of them,
// which is how a headless jsdom run asserts the composition the browser paints.

import { Application, Container } from 'pixi.js'
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
}

export interface PrototypeDashboard {
  readonly host: DashboardHost
  /** The current plan. `rows` is canvas order, which is the mirror's order too. */
  readonly plan: ScenePlan
  readonly rows: readonly RenderedRow[]
  /** How many teardown hooks are still registered. Zero once destroyed. */
  readonly activeSubscriptions: number
  readonly isDestroyed: boolean
  /** Reveal one repository's full path, or `null` for none. The pointer path calls this. */
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

  const host = await createHost({ container, size: measureContainer(container) })
  const bag = new SubscriptionBag()
  const canvas = host.canvas
  let destroyed = false
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

  const repaint = (): void => {
    target.clear()
    paintScene(plan, target)
  }
  // Pointer targets follow the layout, not the state: a state change repaints the
  // rows and leaves them alone, because replacing the object the pointer is
  // inside cancels the very hover that asked for the repaint.
  target.setHoverRegions(plan.hoverRegions)
  repaint()

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
    repaint()
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
    repaint()
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
    get plan(): ScenePlan {
      return plan
    },
    get rows(): readonly RenderedRow[] {
      return plan.rows
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
