// Shared jsdom harness for the DP-3 suites.
//
// The prototype's real host cannot initialise in jsdom (no 2D or WebGL context),
// so the two suites that need a mounted dashboard share a host that records what
// the mount asked of it and a scene target that records the exact command stream
// the browser would paint. The assertions in those suites are therefore made
// against the real mount entry point and the real command stream, not against a
// restatement of the fixture.
//
// tests/dashboard/prototype-scene.test.ts keeps its own copies from DP-2, before
// this harness existed, and its suite is left exactly as it was.

import { Container } from 'pixi.js'
import type { DomMirror, MirrorModel } from '@/dashboard/a11y/dom-mirror'
import { createDomMirror } from '@/dashboard/a11y/dom-mirror'
import type { KeyboardNavigator } from '@/dashboard/a11y/keyboard-nav'
import { createKeyboardNavigator } from '@/dashboard/a11y/keyboard-nav'
import type { DashboardHost, PrototypeDashboard, Size } from '@/dashboard/prototype/main'
import { mountPrototype } from '@/dashboard/prototype/main'
import type { MotionController, MotionControllerOptions } from '@/dashboard/theme/motion'
import { createMotionController } from '@/dashboard/theme/motion'
import type { DrawCommand, HoverRegion, SceneTarget } from '@/dashboard/prototype/scene'

export interface RecordingTarget extends SceneTarget {
  readonly commands: DrawCommand[]
  readonly regions: HoverRegion[]
  regionRebuilds: number
}

export function createRecordingTarget(): RecordingTarget {
  const commands: DrawCommand[] = []
  const regions: HoverRegion[] = []
  return {
    commands,
    regions,
    regionRebuilds: 0,
    clear(): void {
      commands.length = 0
    },
    rect(command) {
      commands.push(command)
    },
    line(command) {
      commands.push(command)
    },
    icon(command) {
      commands.push(command)
    },
    text(command) {
      commands.push(command)
    },
    setHoverRegions(next) {
      this.regionRebuilds += 1
      regions.length = 0
      regions.push(...next)
    },
  }
}

export interface RecordingHost extends DashboardHost {
  readonly sizes: Size[]
  setSizeCalls: number
  teardownCalls: number
  readonly log: string[]
}

export function createRecordingHost(container: HTMLElement, initial: Size): RecordingHost {
  const canvas = document.createElement('canvas')
  container.appendChild(canvas)
  const sizes: Size[] = [initial]
  const log: string[] = []
  let tornDown = false
  return {
    canvas,
    root: new Container(),
    sizes,
    log,
    setSizeCalls: 0,
    teardownCalls: 0,
    getSize: () => sizes[sizes.length - 1] ?? initial,
    setSize(size: Size): void {
      this.setSizeCalls += 1
      sizes.push(size)
    },
    stopRendering(): void {
      log.push('stopRendering')
    },
    get isTornDown(): boolean {
      return tornDown
    },
    teardown(): void {
      tornDown = true
      this.teardownCalls += 1
      log.push('teardown')
    },
  }
}

/** A reduced-motion preference a test controls, standing in for `matchMedia`. */
export interface FakePreference {
  readonly preference: MotionControllerOptions['preference']
  set(matches: boolean): void
  readonly listenerCount: number
}

export function createFakePreference(initial: boolean): FakePreference {
  const listeners = new Set<() => void>()
  const preference = {
    matches: initial,
    addEventListener: (type: string, listener: () => void): void => {
      if (type === 'change') listeners.add(listener)
    },
    removeEventListener: (type: string, listener: () => void): void => {
      if (type === 'change') listeners.delete(listener)
    },
  }
  return {
    preference,
    set(matches: boolean): void {
      preference.matches = matches
      for (const listener of [...listeners]) listener()
    },
    get listenerCount(): number {
      return listeners.size
    },
  }
}

export interface MountRecordingOptions {
  readonly container?: HTMLElement
  readonly target?: RecordingTarget
  /** Injected through the mount's motion seam; `true` starts at reduced motion. */
  readonly reducedMotion?: boolean
}

export interface Recording {
  readonly dashboard: PrototypeDashboard
  readonly host: RecordingHost
  readonly target: RecordingTarget
  readonly container: HTMLElement
  /** The injected reduced-motion preference, or null when none was injected. */
  readonly preference: FakePreference | null
}

const mounted: PrototypeDashboard[] = []

/** Mount the real entry point against recording seams, and remember it for teardown. */
export async function mountRecordingPrototype(
  options: MountRecordingOptions = {},
): Promise<Recording> {
  const container = options.container ?? document.createElement('div')
  if (options.container === undefined) document.body.append(container)
  const target = options.target ?? createRecordingTarget()
  const fakePreference = options.reducedMotion === undefined ? null : createFakePreference(options.reducedMotion)
  let host: RecordingHost | null = null
  const dashboard = await mountPrototype({
    container,
    createHost: async ({ size }) => {
      host = createRecordingHost(container, size)
      return host
    },
    createTarget: () => target,
    ...(fakePreference === null
      ? {}
      : {
          createMotionController: (controllerOptions: MotionControllerOptions) =>
            createMotionController({
              ...controllerOptions,
              preference: fakePreference.preference,
            }),
        }),
  })
  mounted.push(dashboard)
  return {
    dashboard,
    host: host as unknown as RecordingHost,
    target,
    container,
    preference: fakePreference,
  }
}

export function destroyMounted(): void {
  destroyRowLists()
  while (mounted.length > 0) mounted.pop()?.destroy()
  document.body.replaceChildren()
}

/** Give an element a layout size, which jsdom reports as zero by default. */
export function setContainerSize(container: HTMLElement, width: number, height: number): void {
  Object.defineProperty(container, 'clientWidth', { value: width, configurable: true })
  Object.defineProperty(container, 'clientHeight', { value: height, configurable: true })
}

export const textCommands = (commands: readonly DrawCommand[]) =>
  commands.filter((command): command is Extract<DrawCommand, { kind: 'text' }> => command.kind === 'text')

export const iconCommands = (commands: readonly DrawCommand[]) =>
  commands.filter((command): command is Extract<DrawCommand, { kind: 'icon' }> => command.kind === 'icon')

// ---------------------------------------------------------------------------
// A row list outside the prototype mount
// ---------------------------------------------------------------------------

/**
 * The mount's own a11y wiring, built directly: motion policy, DOM mirror,
 * keyboard controller, and the mirror's rebuild hook. The prototype's row model
 * is fixed, so an update that *changes* a row cannot be produced through the
 * prototype's entry point; this is the same path the live page will use, wired
 * the same two lines, so the update behaviour under test is the shipped one rather
 * than a re-implementation of it.
 */
export interface RowList {
  readonly container: HTMLElement
  readonly mirror: DomMirror
  readonly navigator: KeyboardNavigator
  readonly motion: MotionController
  /** The one update path: render the model, then let the mirror's hook settle the keyboard model. */
  apply(model: MirrorModel): void
  destroy(): void
}

const rowLists: RowList[] = []

export function createRowList(): RowList {
  const container = document.createElement('div')
  document.body.append(container)
  const motion = createMotionController({})
  const mirror = createDomMirror({ parent: container })
  const navigator = createKeyboardNavigator({ container: mirror.root, motion })
  mirror.onRebuilt(() => {
    navigator.refresh()
  })
  const rowList: RowList = {
    container,
    mirror,
    navigator,
    motion,
    apply(model: MirrorModel): void {
      mirror.render(model)
    },
    destroy(): void {
      navigator.destroy()
      mirror.destroy()
      motion.destroy()
      container.remove()
    },
  }
  rowLists.push(rowList)
  return rowList
}

export function destroyRowLists(): void {
  while (rowLists.length > 0) rowLists.pop()?.destroy()
}

// The mirror's attribute contract, re-exported so a suite can assert against the
// names the mirror uses without reaching past this harness for each one.
export {
  MIRROR_ACTIVATIONS_ATTRIBUTE,
  MIRROR_ACTIVATED_CLASS,
  MIRROR_FOCUSED_ATTRIBUTE,
  MIRROR_FOCUSED_CLASS,
  MIRROR_STATE_LABEL_ATTRIBUTE,
} from '@/dashboard/a11y/dom-mirror'
