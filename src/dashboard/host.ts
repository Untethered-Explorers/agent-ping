// The renderer's plumbing, shared by both dashboard pages.
//
// LD-1 moved this out of `prototype/main.ts` so the live page can mount the same
// real PixiJS 8 host without importing a module that auto-mounts the prototype the
// moment it is loaded. The prototype re-exports every name from here, so its entry
// point's public surface - and DP-2's and DP-3's suites, which import through it -
// are unchanged.
//
// What lives here is the part that is about the renderer rather than about any
// particular page: how big the surface is, how the application is initialised (the
// asynchronous `init`, which is the only correct PixiJS 8 shape), how it is
// destroyed with its textures, and the bag that holds every teardown hook so a
// mount can prove it removed all of them.

// PixiJS 8 generates some of its GPU plumbing with `new Function`, and it checks
// for the permission first: under a policy without `unsafe-eval` its WebGL and
// uniform-group systems refuse to initialise, and `Application.init()` rejects with
// "Current environment does not allow unsafe-eval". The hub sends exactly that
// policy (DASHBOARD_CSP in src/hub/security.ts), so a dashboard built without this
// import mounts nothing in a real browser and jsdom cannot see it.
//
// `pixi.js/unsafe-eval` is the module the library points at for this case, and
// despite the name it is what *removes* the need: it installs the polyfills that
// do the same work without eval. The alternative - adding `unsafe-eval` to the
// policy - is the one the security module forbids in as many words, and a weakened
// policy looks exactly like a working one in review. This line is load-bearing and
// a real browser is what proved it: see the CSP check in the LD-1 evidence.
import 'pixi.js/unsafe-eval'

import { Application, Container } from 'pixi.js'
import { PROTOTYPE_COLORS } from './prototype/scene'

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
 * Every teardown hook a mount registered, in one place, so teardown can prove it
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
// The renderer
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
 * because owning it keeps every subscription in one bag the teardown path empties.
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
  // The canvas carries no semantics of its own: the DOM mirror is the accessible
  // twin, and announcing an empty canvas only adds noise.
  canvas.setAttribute('aria-hidden', 'true')
  // Deliberately no inline style here. The hub's policy has no `unsafe-inline` in
  // `style-src`, and a browser refuses an inline style it did not hash - so the
  // canvas's `display: block` comes from the page's own stylesheet
  // (src/dashboard/dashboard.css, and the prototype page's sheet) instead. A real
  // browser is what surfaced this: the one CSP error the page logged was this line.
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
