// DP-2: the static prototype scene, driven through the exported mount entry point.
//
//   npm test -- tests/dashboard/prototype-scene.test.ts
//
// What is asserted here, and what is not:
//
//   - The composition under design review: three mock rows in two repository
//     groups, blocked first, each row carrying an icon, a word, an age and one
//     line of status. Asserted against the exact draw commands the mount issues,
//     so this is the plan the browser paints, not a restatement of the fixture.
//   - The mount lifecycle: sizes to its container, registers subscriptions,
//     and on unload destroys the renderer and removes every one of them.
//   - The static guarantee: no network request at runtime, and no hub URL, in the
//     page or in any module it loads.
//
// What cannot be asserted in jsdom: that the WebGL or canvas renderer produces
// the right pixels. jsdom has no 2D or WebGL context, so `Application.init()`
// cannot resolve there. The real PixiJS host is therefore exercised through its
// own seam - a fake `Application` records the arguments it is initialised and
// destroyed with - and the painted result is left to `npm run build` plus the
// human design review in DP-4.

import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Application, Container } from 'pixi.js'
import type { DrawCommand, HoverRegion, SceneTarget } from '@/dashboard/prototype/scene'
import {
  LAYOUT,
  SESSION_STATES,
  STATE_ENCODING,
  buildScene,
  createPixiSceneTarget,
  formatAge,
  paintScene,
  stateEncoding,
  statusLine,
  textClipBand,
} from '@/dashboard/prototype/scene'
import {
  PROTOTYPE_NOW,
  PROTOTYPE_REPOSITORIES,
  repositoryShortName,
} from '@/dashboard/prototype/mock-data'
import {
  DASHBOARD_ROOT_ATTRIBUTE,
  FALLBACK_SIZE,
  RENDERER_DESTROY_OPTIONS,
  STAGE_DESTROY_OPTIONS,
  createPixiDashboardHost,
  measureContainer,
  mountPrototype,
  type DashboardHost,
  type PrototypeDashboard,
  type Size,
} from '@/dashboard/prototype/main'

// The prototype sources, read from the repository rather than imported, so the
// static scan below can see the shipped files. `process.cwd()` is the repository
// root: the jsdom test environment does not give `import.meta.url` a file scheme.
const prototypeDir = path.resolve(process.cwd(), 'src/dashboard/prototype')

// ---------------------------------------------------------------------------
// Recording doubles
// ---------------------------------------------------------------------------

/**
 * Records every draw command the mount issues, in the order it issues them. A
 * headless assertion of "the three rows render under their headers with the
 * expected state labels" has to be made against the command stream, because in
 * jsdom there is no renderer to read pixels back from.
 */
interface RecordingTarget extends SceneTarget {
  readonly commands: DrawCommand[]
  readonly regions: HoverRegion[]
  /** How many times the pointer targets were rebuilt. */
  regionRebuilds: number
}

function createRecordingTarget(): RecordingTarget {
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

interface RecordingHost extends DashboardHost {
  readonly log: string[]
  readonly sizes: Size[]
  setSizeCalls: number
  teardownCalls: number
}

function createRecordingHost(container: HTMLElement, initial: Size): RecordingHost {
  const canvas = document.createElement('canvas')
  container.appendChild(canvas)
  const log: string[] = []
  const sizes: Size[] = [initial]
  let tornDown = false
  return {
    canvas,
    root: new Container(),
    log,
    sizes,
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

const mounted: PrototypeDashboard[] = []

async function mountRecording(
  overrides: { container?: HTMLElement; target?: RecordingTarget } = {},
): Promise<{ dashboard: PrototypeDashboard; host: RecordingHost; target: RecordingTarget }> {
  const container = overrides.container ?? document.createElement('div')
  document.body.appendChild(container)
  const target = overrides.target ?? createRecordingTarget()
  let host: RecordingHost | null = null
  const dashboard = await mountPrototype({
    container,
    createHost: async ({ size }) => {
      host = createRecordingHost(container, size)
      return host
    },
    createTarget: () => target,
  })
  mounted.push(dashboard)
  return { dashboard, host: host as unknown as RecordingHost, target }
}

function setContainerSize(container: HTMLElement, width: number, height: number): void {
  Object.defineProperty(container, 'clientWidth', { value: width, configurable: true })
  Object.defineProperty(container, 'clientHeight', { value: height, configurable: true })
}

const textCommands = (commands: readonly DrawCommand[]) =>
  commands.filter((command): command is Extract<DrawCommand, { kind: 'text' }> => command.kind === 'text')

const iconCommands = (commands: readonly DrawCommand[]) =>
  commands.filter((command): command is Extract<DrawCommand, { kind: 'icon' }> => command.kind === 'icon')

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.destroy()
  document.body.replaceChildren()
})

// ---------------------------------------------------------------------------

describe('DP-2 prototype: the three mock rows under their repository headers', () => {
  it('groups three rows in two repositories, blocked first in its group', async () => {
    const { dashboard, target } = await mountRecording()

    expect(dashboard.rows).toHaveLength(3)
    expect(dashboard.plan.groups.map((group) => group.shortName)).toEqual([
      'agent-ping',
      'knowledge-dungeon',
    ])
    expect(dashboard.plan.groups.map((group) => group.rowIds)).toEqual([
      // The fixture lists the finished session first on purpose, so this order
      // is the renderer's doing and not the mock data's.
      ['session-ack-flow', 'session-ingest-route'],
      ['session-village-objects'],
    ])
    expect(dashboard.rows.map((row) => row.state)).toEqual(['blocked', 'finished', 'running'])
    expect(dashboard.rows.map((row) => row.repositoryShortName)).toEqual([
      'agent-ping',
      'agent-ping',
      'knowledge-dungeon',
    ])

    // Each row's group header is drawn above it and no row precedes the header
    // of the group it belongs to.
    const commandRows = dashboard.rows
    for (const row of commandRows) {
      const header = textCommands(target.commands).find(
        (command) =>
          command.role === 'repository-short-name' &&
          command.text === row.repositoryShortName &&
          command.y < row.y,
      )
      expect(header, `${row.sessionId} has its repository header above it`).toBeDefined()
    }
  })

  it('draws each repository short name once, as the primary label', async () => {
    const { target } = await mountRecording()
    const names = textCommands(target.commands)
      .filter((command) => command.role === 'repository-short-name')
      .map((command) => command.text)

    expect(names).toEqual(['agent-ping', 'knowledge-dungeon'])
    // APX-CON-09: identity is the short name, which is the path's basename.
    expect(names).toEqual(PROTOTYPE_REPOSITORIES.map((repository) => repositoryShortName(repository.path)))
  })

  it('gives every row an icon, a state word, an age and one line of status', async () => {
    const { dashboard, target } = await mountRecording()
    const texts = textCommands(target.commands)
    const icons = iconCommands(target.commands)

    for (const row of dashboard.rows) {
      const atRowTop = (command: { y: number }) => command.y >= row.y && command.y < row.y + row.height
      const session = PROTOTYPE_REPOSITORIES.flatMap((repository) => repository.sessions).find(
        (candidate) => candidate.id === row.sessionId,
      )
      const label = texts.find((command) => command.role === 'session-state-label' && atRowTop(command))
      const age = texts.find((command) => command.role === 'session-age' && atRowTop(command))
      const status = texts.find((command) => command.role === 'session-status' && atRowTop(command))
      const icon = icons.find((command) => atRowTop(command))

      expect(session).toBeDefined()
      expect(label?.text).toBe(stateEncoding(row.state).label)
      expect(age?.text).toBe(row.age)
      expect(status?.text).toBe(session === undefined ? undefined : statusLine(session))
      expect(icon?.icon).toBe(row.encoding.icon)
    }
  })

  it('orders the drawn commands group header then rows, in the same order as the row model', async () => {
    const { dashboard, target } = await mountRecording()
    const shortNames = textCommands(target.commands)
      .filter((command) => command.role === 'repository-short-name')
      .map((command) => command.text)

    expect(shortNames).toEqual(['agent-ping', 'knowledge-dungeon'])
    // The row model and the command stream cannot drift: the mirror in DP-3 is
    // built from the row model, so its order is the canvas order.
    expect(dashboard.rows.map((row) => row.repositoryShortName)).toEqual([
      'agent-ping',
      'agent-ping',
      'knowledge-dungeon',
    ])
  })
})

describe('DP-2 prototype: urgency is never colour alone', () => {
  it('encodes every state with a distinct icon and a text label', async () => {
    const { dashboard, target } = await mountRecording()
    const icons = iconCommands(target.commands)
    const labels = textCommands(target.commands)
      .filter((command) => command.role === 'session-state-label')
      .map((command) => command.text)

    // Exhaustive over the state union, not over the three fixture rows: a new
    // state has to arrive with an icon and a word, or this fails.
    expect(Object.keys(STATE_ENCODING).sort()).toEqual([...SESSION_STATES].sort())
    for (const state of SESSION_STATES) {
      const encoding = STATE_ENCODING[state]
      expect(encoding.icon, `${state} has an icon`).toBeTruthy()
      expect(encoding.label, `${state} has a word`).toBeTruthy()
      expect(encoding.token, `${state} has a mirror token`).toBeTruthy()
    }
    const distinctIcons = new Set(SESSION_STATES.map((state) => STATE_ENCODING[state].icon))
    const distinctLabels = new Set(SESSION_STATES.map((state) => STATE_ENCODING[state].label))
    expect(distinctIcons.size).toBe(SESSION_STATES.length)
    expect(distinctLabels.size).toBe(SESSION_STATES.length)

    // The three fixture rows cover the three states, so each icon and each word
    // must actually reach the canvas.
    expect(new Set(icons.map((icon) => icon.icon))).toEqual(new Set(SESSION_STATES.map((s) => STATE_ENCODING[s].icon)))
    expect(new Set(labels)).toEqual(new Set(SESSION_STATES.map((s) => STATE_ENCODING[s].label)))
    expect(dashboard.rows.map((row) => row.encoding.label)).toEqual(['Blocked', 'Finished', 'Running'])
  })

  it('never tints body text with a state colour', async () => {
    const { target } = await mountRecording()
    const accents = new Set(SESSION_STATES.map((state) => STATE_ENCODING[state].accent))

    for (const command of textCommands(target.commands)) {
      expect(accents.has(command.color), `text "${command.text}" is not a state accent`).toBe(false)
    }
    for (const command of iconCommands(target.commands)) {
      expect(accents.has(command.color)).toBe(true)
    }
  })
})

describe('DP-2 prototype: the full path is revealed on hover', () => {
  it('shows only short names until a repository is hovered', async () => {
    const { dashboard, target } = await mountRecording()

    expect(dashboard.plan.hoveredRepositoryId).toBeNull()
    expect(textCommands(target.commands).filter((c) => c.role === 'repository-full-path')).toHaveLength(0)
    expect(target.regions.map((region) => region.repositoryId)).toEqual([
      'repo-agent-ping',
      'repo-knowledge-dungeon',
    ])
    for (const region of target.regions) expect(region.height).toBeGreaterThan(0)
  })

  it('adds the full path beside the short name, never in place of it', async () => {
    const { dashboard, target } = await mountRecording()

    dashboard.setHoveredRepository('repo-agent-ping')

    expect(dashboard.plan.hoveredRepositoryId).toBe('repo-agent-ping')
    const names = textCommands(target.commands)
      .filter((command) => command.role === 'repository-short-name')
      .map((command) => command.text)
    expect(names).toEqual(['agent-ping', 'knowledge-dungeon'])

    const paths = textCommands(target.commands).filter((command) => command.role === 'repository-full-path')
    expect(paths.map((command) => command.text)).toEqual(['/home/dev/Projects/agent-ping'])
    // Right-aligned to the content edge, so the full path can never be drawn on
    // top of the primary label.
    expect(paths[0]?.align).toBe('right')

    dashboard.setHoveredRepository(null)
    expect(textCommands(target.commands).filter((c) => c.role === 'repository-full-path')).toHaveLength(0)
  })

  it('ignores a hover for a repository that is not in the scene', async () => {
    const { dashboard, target } = await mountRecording()
    const before = target.commands.length

    dashboard.setHoveredRepository('repo-not-here')

    expect(dashboard.plan.hoveredRepositoryId).toBeNull()
    expect(target.commands.length).toBe(before)
  })

  it('keeps the pointer targets across a state repaint, and rebuilds them on a resize', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    setContainerSize(container, 700, 400)
    const { dashboard, target } = await mountRecording({ container })

    expect(target.regionRebuilds).toBe(1)
    const regionsAfterMount = [...target.regions]

    // A hover repaints the rows. Replacing the object the pointer is inside would
    // cancel the hover that asked for the repaint, so the targets stay put.
    dashboard.setHoveredRepository('repo-agent-ping')
    expect(target.regionRebuilds).toBe(1)
    expect(target.regions).toEqual(regionsAfterMount)

    // Only a layout change moves them.
    setContainerSize(container, 1024, 640)
    dashboard.remeasure()
    expect(target.regionRebuilds).toBe(2)
    expect(target.regions.map((region) => region.width)).toEqual([1024, 1024])
  })
})

describe('DP-2 prototype: sizing and resize', () => {
  it('sizes to its container, and falls back when the container has no layout', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    setContainerSize(container, 820, 460)
    const target = createRecordingTarget()
    const { host, dashboard } = await mountRecording({ container, target })

    expect(host.sizes[0]).toEqual({ width: 820, height: 460 })
    expect(dashboard.plan.width).toBe(820)
    expect(dashboard.plan.height).toBe(460)
    // The background covers the whole surface, not just the rows.
    const background = target.commands.find((command) => command.kind === 'rect')
    expect(background).toMatchObject({ x: 0, y: 0, width: 820, height: 460 })

    expect(measureContainer(document.createElement('div'))).toEqual(FALLBACK_SIZE)
  })

  it('reports how tall the content actually is, which is not the canvas height', async () => {
    const { dashboard } = await mountRecording()
    // Two headers, three rows and one group gap, inside a 540px surface: the
    // prototype shows three rows and does not pretend a full list fits.
    expect(dashboard.plan.contentHeight).toBe(206)
    expect(dashboard.plan.contentHeight).toBeLessThan(dashboard.plan.height)
  })

  it('re-lays out when the container is resized', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    setContainerSize(container, 700, 400)
    const { host, dashboard, target } = await mountRecording({ container })

    setContainerSize(container, 1100, 640)
    window.dispatchEvent(new Event('resize'))

    expect(host.setSizeCalls).toBe(1)
    expect(host.sizes[host.sizes.length - 1]).toEqual({ width: 1100, height: 640 })
    expect(dashboard.plan.width).toBe(1100)
    expect(target.commands.find((command) => command.kind === 'rect')).toMatchObject({
      width: 1100,
      height: 640,
    })
  })
})

describe('DP-2 prototype: unload destroys the renderer and every subscription', () => {
  it('tears the renderer down on unload and leaves nothing registered', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const { dashboard, host } = await mountRecording({ container })
    const canvas = host.canvas

    expect(container.contains(canvas)).toBe(true)
    expect(dashboard.activeSubscriptions).toBeGreaterThan(0)
    expect(dashboard.isDestroyed).toBe(false)

    window.dispatchEvent(new Event('beforeunload'))

    expect(dashboard.isDestroyed).toBe(true)
    expect(dashboard.activeSubscriptions).toBe(0)
    expect(host.log).toEqual(['stopRendering', 'teardown'])
    expect(host.teardownCalls).toBe(1)
    expect(host.isTornDown).toBe(true)
    expect(container.contains(canvas)).toBe(false)
  })

  it('is idempotent, and stops responding to resize and hover once destroyed', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    setContainerSize(container, 700, 400)
    const { dashboard, host, target } = await mountRecording({ container })

    dashboard.destroy()
    const commandsAfterDestroy = target.commands.length
    const setSizeCallsAfterDestroy = host.setSizeCalls

    dashboard.destroy()
    window.dispatchEvent(new Event('beforeunload'))
    window.dispatchEvent(new Event('resize'))
    setContainerSize(container, 1200, 800)
    dashboard.remeasure()
    dashboard.setHoveredRepository('repo-agent-ping')

    expect(host.teardownCalls).toBe(1)
    expect(host.setSizeCalls).toBe(setSizeCallsAfterDestroy)
    expect(target.commands.length).toBe(commandsAfterDestroy)
    expect(dashboard.plan.hoveredRepositoryId).toBeNull()
  })

  it('removes the window listeners it added', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const added: string[] = []
    const removed: string[] = []
    const originalAdd = window.addEventListener.bind(window)
    const originalRemove = window.removeEventListener.bind(window)
    const addSpy = vi.spyOn(window, 'addEventListener')
    const removeSpy = vi.spyOn(window, 'removeEventListener')
    addSpy.mockImplementation((type, listener, options) => {
      added.push(String(type))
      originalAdd(type, listener as EventListener, options)
    })
    removeSpy.mockImplementation((type, listener, options) => {
      removed.push(String(type))
      originalRemove(type, listener as EventListener, options)
    })

    try {
      const { dashboard } = await mountRecording({ container })
      expect(added).toContain('resize')
      expect(added).toContain('beforeunload')

      dashboard.destroy()

      // Both kinds of listener the mount registered are taken back off.
      for (const type of added) expect(removed).toContain(type)
      expect(removed.sort()).toEqual(added.sort())
    } finally {
      addSpy.mockRestore()
      removeSpy.mockRestore()
    }
  })
})

describe('DP-2 prototype: the real PixiJS host', () => {
  it('initialises the application asynchronously and tears it down with textures released', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    setContainerSize(container, 800, 500)

    const canvas = document.createElement('canvas')
    // The options are captured rather than read off the mock's call tuple, so
    // the assertion is about the object the host actually passed.
    const initOptions: Record<string, unknown>[] = []
    const init = vi.fn(async (options: Record<string, unknown>) => {
      initOptions.push(options)
    })
    const resize = vi.fn()
    const stop = vi.fn()
    const destroy = vi.fn()
    const fake = {
      canvas,
      stage: new Container(),
      screen: { width: 800, height: 500 },
      init,
      render: vi.fn(),
      renderer: { resize },
      ticker: { stop },
      destroy,
    } as unknown as Application

    const host = await createPixiDashboardHost({ container, size: { width: 800, height: 500 }, createApplication: () => fake })

    // DP-FR-02: the options belong on init(), not on the constructor, and init()
    // is awaited before anything touches canvas, stage or screen.
    expect(init).toHaveBeenCalledTimes(1)
    expect(initOptions[0]).toMatchObject({ width: 800, height: 500, antialias: true, autoDensity: true })
    expect(host.root).toBeInstanceOf(Container)
    expect(fake.stage.children).toContain(host.root)
    expect(container.contains(canvas)).toBe(true)
    // The canvas carries no semantics; the DOM mirror in DP-3 is the twin.
    expect(canvas.getAttribute('aria-hidden')).toBe('true')
    expect(host.getSize()).toEqual({ width: 800, height: 500 })

    host.setSize({ width: 900, height: 600 })
    expect(resize).toHaveBeenCalledWith(900, 600)

    host.stopRendering()
    host.teardown()

    // A stopped ticker and texture-destroying stage options: the "no leaked
    // ticker, no leaked texture" half of DP-FR-02, asserted on the exact
    // objects the host hands to Application.destroy.
    expect(stop).toHaveBeenCalledTimes(1)
    expect(destroy).toHaveBeenCalledTimes(1)
    expect(destroy.mock.calls[0]?.[0]).toBe(RENDERER_DESTROY_OPTIONS)
    expect(destroy.mock.calls[0]?.[1]).toBe(STAGE_DESTROY_OPTIONS)
    expect(STAGE_DESTROY_OPTIONS).toEqual({ children: true, texture: true, textureSource: true })
    expect(RENDERER_DESTROY_OPTIONS).toEqual({ removeView: true, releaseGlobalResources: true })

    // Teardown runs once, and a late resize cannot reach a destroyed renderer.
    host.teardown()
    host.setSize({ width: 400, height: 300 })
    expect(destroy).toHaveBeenCalledTimes(1)
    expect(resize).toHaveBeenCalledTimes(1)
    expect(host.isTornDown).toBe(true)
  })
})

describe('DP-2 prototype: the PixiJS painter', () => {
  it('puts the plan into a layered scene graph', () => {
    const root = new Container()
    const target = createPixiSceneTarget(root, { onRepositoryHover: () => {} })
    const plan = buildScene(PROTOTYPE_REPOSITORIES, { width: 960, height: 540, now: PROTOTYPE_NOW })

    paintScene(plan, target)

    const ofKind = <K extends DrawCommand['kind']>(kind: K) => plan.draws.filter((c) => c.kind === kind)
    const planTexts = plan.draws.filter((c): c is Extract<DrawCommand, { kind: 'text' }> => c.kind === 'text')
    const clipped = planTexts.filter((c) => c.maxWidth !== undefined)

    // Three layers: shapes under text, pointer targets on top and invisible.
    expect(root.children).toHaveLength(3)
    const [shapes, texts, hits] = root.children as Container[]
    // Every rect, line and icon becomes one Graphics in the shape layer.
    expect(shapes?.children).toHaveLength(
      ofKind('rect').length + ofKind('line').length + ofKind('icon').length,
    )
    // Every line of text becomes exactly one child: the Text itself, or a
    // container holding the Text under its clip mask.
    expect(clipped.length).toBe(3)
    expect(texts?.children).toHaveLength(planTexts.length)
    expect(texts?.children.slice(0, clipped.length).every((child) => child instanceof Container)).toBe(true)
    // Pointer targets only exist once the layout is known to have settled.
    expect(hits?.children).toHaveLength(0)

    target.setHoverRegions(plan.hoverRegions)
    expect(hits?.children).toHaveLength(plan.hoverRegions.length)
  })

  it('makes the hover regions interactive and keeps them across a repaint', () => {
    const root = new Container()
    const hovered: (string | null)[] = []
    const target = createPixiSceneTarget(root, {
      onRepositoryHover: (repositoryId) => hovered.push(repositoryId),
    })
    const plan = buildScene(PROTOTYPE_REPOSITORIES, { width: 960, height: 540, now: PROTOTYPE_NOW })

    target.setHoverRegions(plan.hoverRegions)
    const hits = root.children[2] as Container
    const regions = hits.children as Container[]
    expect(regions).toHaveLength(2)
    expect(regions[0]?.eventMode).toBe('static')
    expect(regions[0]?.hitArea).toMatchObject({ x: 0, y: 20, width: 960, height: 117 })
    // Declared, not drawn: revealing a full path on hover adds nothing visible.
    expect(regions[0]?.width).toBe(0)
    expect(regions[0]?.height).toBe(0)

    // The region is wired to the hover callback. The handlers take no arguments,
    // so the registered listeners are invoked directly rather than synthesising a
    // FederatedPointerEvent, which needs a real renderer to mean anything.
    const fire = (region: Container | undefined, type: 'pointerover' | 'pointerout'): void => {
      for (const handler of region?.listeners(type) ?? []) (handler as () => void)()
    }
    expect(regions[0]?.listenerCount('pointerover')).toBe(1)
    fire(regions[0], 'pointerover')
    expect(hovered).toEqual(['repo-agent-ping'])
    fire(regions[0], 'pointerout')
    expect(hovered).toEqual(['repo-agent-ping', null])
    fire(regions[1], 'pointerover')
    expect(hovered).toEqual(['repo-agent-ping', null, 'repo-knowledge-dungeon'])

    // A repaint drops the picture, not the pointer targets.
    const sameObjects = [...hits.children]
    target.clear()
    expect([...hits.children]).toEqual(sameObjects)
  })

  it('clips a line of text over the band its glyphs actually occupy', () => {
    // A right-aligned Text is anchored at its right edge, so its glyphs are at
    // negative x. A band starting at 0 hides the whole line, which is a blank row
    // rather than an error.
    expect(textClipBand({ align: 'right', maxWidth: 120 })).toEqual({ x: -120, width: 120 })
    expect(textClipBand({ align: 'left', maxWidth: 120 })).toEqual({ x: 0, width: 120 })
    for (const align of ['left', 'right'] as const) {
      const band = textClipBand({ align, maxWidth: 120 })
      const glyphLeft = align === 'right' ? -80 : 0
      const glyphRight = align === 'right' ? 0 : 80
      // Overlap by more than an edge, which is what an area mask needs.
      expect(band.x).toBeLessThan(glyphRight)
      expect(band.x + band.width).toBeGreaterThan(glyphLeft)
    }
  })
})

describe('DP-2 prototype: no hub, no plugin, no network', () => {
  it('performs no network request while mounting and repainting', async () => {
    const calls: string[] = []
    const globals: Record<string, unknown> = {
      fetch: (...args: unknown[]) => {
        calls.push(`fetch(${String(args[0])})`)
        return Promise.reject(new Error('the prototype must not make a request'))
      },
      EventSource: class {
        constructor(url: string) {
          calls.push(`EventSource(${url})`)
        }
      },
      WebSocket: class {
        constructor(url: string) {
          calls.push(`WebSocket(${url})`)
        }
      },
      XMLHttpRequest: class {
        open(method: string, url: string) {
          calls.push(`XMLHttpRequest(${method} ${url})`)
        }
      },
    }
    const saved = new Map<string, PropertyDescriptor | undefined>()
    for (const [name, value] of Object.entries(globals)) {
      saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
      Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
    }

    try {
      const { dashboard } = await mountRecording()
      dashboard.setHoveredRepository('repo-agent-ping')
      dashboard.remeasure()
      dashboard.destroy()
    } finally {
      for (const [name, descriptor] of saved) {
        if (descriptor === undefined) delete (globalThis as Record<string, unknown>)[name]
        else Object.defineProperty(globalThis, name, descriptor)
      }
    }

    expect(calls).toEqual([])
  })

  it('keeps the prototype page and its modules free of any hub URL or transport', () => {
    const files = [
      ...readdirSync(prototypeDir)
        .filter((name) => name.endsWith('.ts') || name.endsWith('.html'))
        .map((name) => name),
    ]
    expect(files.sort()).toEqual(['index.html', 'main.ts', 'mock-data.ts', 'scene.ts'])

    // DP-3 added the mirror, the keyboard model and the motion policy to the
    // prototype's dependency graph, so "static" now covers those directories too.
    // A transport or a hub URL appearing in any of them would make the page that
    // was supposed to make no request make one.
    const dashboardDir = path.resolve(prototypeDir, '..')
    const scanned = [
      ...files.map((name) => ({ label: `prototype/${name}`, file: path.join(prototypeDir, name) })),
      ...['a11y', 'theme'].flatMap((directory) =>
        readdirSync(path.join(dashboardDir, directory))
          .filter((name) => name.endsWith('.ts'))
          .map((name) => ({
            label: `${directory}/${name}`,
            file: path.join(dashboardDir, directory, name),
          })),
      ),
    ]

    const forbiddenUrls = [
      'http://',
      'https://',
      'ws://',
      'wss://',
      '//127.0.0.1',
      '//localhost',
      '/api/',
      'file://',
    ]
    const forbiddenCalls = [
      'fetch(',
      'EventSource',
      'XMLHttpRequest',
      'WebSocket',
      'sendBeacon',
      'node:fs',
      'node:http',
      'node:https',
      'node:net',
      'readFile',
    ]

    for (const { label, file } of scanned) {
      const source = readFileSync(file, 'utf8')
      for (const needle of [...forbiddenUrls, ...forbiddenCalls]) {
        expect(source.includes(needle), `${label} must not contain ${needle}`).toBe(false)
      }
    }
  })

  it('mounts nothing when the page has no dashboard root', () => {
    // The module auto-mounts only for the page composition root. A test that
    // imports it to call mountPrototype must not get a second dashboard.
    expect(document.querySelector(`[${DASHBOARD_ROOT_ATTRIBUTE}]`)).toBeNull()
    expect(document.querySelectorAll('canvas')).toHaveLength(0)
  })

  it('wires the composition root through the attribute the page uses', async () => {
    const container = document.createElement('main')
    container.setAttribute(DASHBOARD_ROOT_ATTRIBUTE, '')
    document.body.appendChild(container)
    const { dashboard } = await mountRecording({ container })
    expect(container.contains(dashboard.host.canvas)).toBe(true)
  })
})

describe('DP-2 prototype: the mock data is deterministic', () => {
  it('produces the same plan on every call', () => {
    const options = { width: 960, height: 540, now: PROTOTYPE_NOW }
    expect(buildScene(PROTOTYPE_REPOSITORIES, options)).toEqual(
      buildScene(PROTOTYPE_REPOSITORIES, options),
    )
  })

  it('ages every row against a fixed clock', () => {
    expect(PROTOTYPE_REPOSITORIES.flatMap((repository) => repository.sessions).map((session) => session.state).sort()).toEqual([
      'blocked',
      'finished',
      'running',
    ])
    const { rows } = buildScene(PROTOTYPE_REPOSITORIES, { width: 960, height: 540, now: PROTOTYPE_NOW })
    expect(rows.map((row) => row.age)).toEqual(['8m', '2h', '2m'])
    expect(formatAge('2026-09-26T11:59:30.000Z', PROTOTYPE_NOW)).toBe('<1m')
    expect(formatAge('2026-09-26T12:05:00.000Z', PROTOTYPE_NOW)).toBe('now')
  })

  it('derives the short name from the path basename', () => {
    expect(repositoryShortName('/home/dev/Projects/agent-ping')).toBe('agent-ping')
    expect(repositoryShortName('/home/dev/Projects/agent-ping/')).toBe('agent-ping')
    expect(repositoryShortName('agent-ping')).toBe('agent-ping')
  })

  it('derives the same identity from a Windows path as from a POSIX one', () => {
    // A harness on Windows reports a backslash path, and the same repository must
    // group as one row rather than as two. Asserted here because the separator
    // handling is implemented in the prototype and would otherwise only ever be
    // exercised on the platform it was written on.
    expect(repositoryShortName('C:\\Users\\dev\\Projects\\agent-ping')).toBe('agent-ping')
    expect(repositoryShortName('C:\\Users\\dev\\Projects\\agent-ping\\')).toBe('agent-ping')
    expect(repositoryShortName('D:\\work\\knowledge-dungeon')).toBe('knowledge-dungeon')
    expect(repositoryShortName('C:\\Users\\dev\\Projects\\agent-ping')).toBe(
      repositoryShortName('/home/dev/Projects/agent-ping'),
    )
  })

  it('stacks the groups without overlapping them', () => {
    const { groups, rows } = buildScene(PROTOTYPE_REPOSITORIES, { width: 960, height: 540, now: PROTOTYPE_NOW })
    const second = groups[1]
    const first = groups[0]
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    if (first === undefined || second === undefined) return
    expect(second.y).toBeGreaterThanOrEqual(first.y + first.height)
    for (const group of groups) {
      const inGroup = rows.filter((row) => row.repositoryId === group.repositoryId)
      expect(inGroup).toHaveLength(group.rowIds.length)
      for (const row of inGroup) {
        expect(row.y).toBeGreaterThanOrEqual(group.y)
        expect(row.y + row.height).toBeLessThanOrEqual(group.y + group.height)
        expect(row.height).toBe(LAYOUT.rowHeight)
      }
    }
  })
})
