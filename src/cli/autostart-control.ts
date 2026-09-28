// The autostart port: what `install` and `doctor` need from the per-platform units, and
// how the real units are found (IO-2, IO-FR-06).
//
// WHAT THIS FILE IS, AND WHAT IT DELIBERATELY IS NOT
// `IO-2` installs autostart and diagnoses it. `IO-3` writes the units. Those are two
// tasks and this file is the line between them: it declares what a command may ask of
// autostart - read its state, enable it, disable it - and nothing about how a systemd
// user unit, a launchd agent or a Windows startup entry is written.
//
// So there is no unit content here, no path to a platform's convention, and no
// filesystem write. `IO-3` lands `src/cli/autostart/index.ts` exporting
// `createAutostartControl`, and the resolver below finds it.
//
// WHY THE RESOLVER IMPORTS A MODULE THAT DOES NOT EXIST YET
// A static import would not compile before `IO-3` runs, and a hard-coded "the units are
// missing" answer would ship a command that cannot install what it claims to install.
// The import specifier is therefore held in a `string`-typed binding, which is the one
// way to ask for a module whose presence is a runtime fact rather than a compile error.
//
// The result is that a build without the units reports the truth instead of pretending:
// `implementation: 'missing-implementation'`, a state that says so in one sentence, and
// an `enable` that changes nothing. `install` then fails with that sentence as its
// remedy, and `doctor` reports the autostart check as failed. That is the same posture
// the prepack guard takes about a build artefact that is not there yet (IO-1): a package
// whose autostart is missing must not install quietly and report success.
//
// WHAT A COMMAND MAY ASK FOR, IN FULL
//   state()   - is it enabled, where is the unit, and if not, why not
//   enable()  - make it enabled, and say whether that changed anything
//   disable() - remove every trace, and say whether that changed anything
//
// Nothing else. There is no "restart", no "status of a service manager", no path to
// anything but the unit this product owns, and no way to run a privileged command: the
// units are user-level and this port cannot express elevation (IO-FR-06, APX-CON-06).
//
// This module opens no file, spawns nothing and makes no outbound call (APX-CON-12).

import { homedir } from 'node:os'
import { resolveStateDir } from '../storage/paths.js'

/**
 * Where the per-platform implementations live.
 *
 * A relative specifier, because the units ship in the same package as the command that
 * installs them. Named rather than inlined so a reader - and a test - has one place to
 * look for the seam, and so `IO-3`'s own test can assert that its module is the one
 * this resolver loads.
 */
export const AUTOSTART_MODULE_SPECIFIER = './autostart/index.js'

/** What a resolver found. `autostart-units` is the only one that can change anything. */
export type AutostartImplementation =
  /** The real per-platform units (IO-3). */
  | 'autostart-units'
  /** The units are not in this build. Nothing can be enabled. */
  | 'missing-implementation'
  /** This platform has no unit in v1. A distinct answer from a missing implementation. */
  | 'unsupported-platform'

/**
 * The state of the autostart unit, as one question.
 *
 * `availability` is three-valued on purpose. "Disabled" and "there is no unit here" are
 * different faults with different remedies: the first is fixed by running install, the
 * second by building the package with `IO-3` in it, and a `doctor` that collapsed them
 * would send a developer to do the wrong one.
 */
export type AutostartAvailability = 'enabled' | 'disabled' | 'unavailable'

/** One read of the unit. Bounded strings only: this ends up in `doctor` output. */
export interface AutostartState {
  readonly availability: AutostartAvailability
  /** The unit's path, or null when there is no unit to name. */
  readonly unitPath: string | null
  /** One sentence saying what was found. Never a command's output. */
  readonly detail: string
}

/** One enable or disable. `changed` is the answer to IO-FR-08's "nothing changed". */
export interface AutostartChange {
  readonly changed: boolean
  readonly unitPath: string | null
  readonly detail: string
  /** Set when the change did not happen, naming what stops it. */
  readonly failure: string | null
}

/**
 * What a command may ask of autostart. The whole of it.
 *
 * Enumerated by a test from this file's own source, so a member added later - a
 * `restart`, a `reveal`, anything that could run something - fails there rather than
 * being discovered in a platform review.
 */
export interface AutostartControl {
  readonly implementation: AutostartImplementation
  readonly platform: NodeJS.Platform
  state(): Promise<AutostartState>
  enable(): Promise<AutostartChange>
  disable(): Promise<AutostartChange>
}

/** The platforms v1 supports, and the units `IO-3` writes for them (APX-CON-06). */
export const AUTOSTART_PLATFORMS: readonly NodeJS.Platform[] = ['linux', 'darwin', 'win32']

/** The platform v1 supports that this build has no unit for. */
export function isAutostartPlatform(platform: NodeJS.Platform): boolean {
  return AUTOSTART_PLATFORMS.includes(platform)
}

export interface AutostartResolveOptions {
  readonly env?: NodeJS.ProcessEnv
  readonly platform?: NodeJS.Platform
  readonly home?: string
  readonly stateDir?: string
}

/** The shape `src/cli/autostart/index.ts` has to export, and nothing more. */
interface AutostartModule {
  createAutostartControl(options: {
    readonly env: NodeJS.ProcessEnv
    readonly platform: NodeJS.Platform
    readonly home: string
    readonly stateDir: string
  }): AutostartControl
}

function readAutostartModule(value: unknown): AutostartModule | null {
  if (typeof value !== 'object' || value === null) return null
  const factory = (value as { createAutostartControl?: unknown }).createAutostartControl
  if (typeof factory !== 'function') return null
  return { createAutostartControl: factory as AutostartModule['createAutostartControl'] }
}

/**
 * The control for this platform, or an honest answer about why there is none.
 *
 * Never throws. A command must be able to print "the autostart units are not in this
 * build" as a diagnostic, and a resolver that threw would make that a crash instead.
 */
export async function resolveAutostartControl(
  options: AutostartResolveOptions = {},
): Promise<AutostartControl> {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const home = options.home ?? homedir()
  const stateDir = options.stateDir ?? resolveStateDir(env, platform, home)

  if (!isAutostartPlatform(platform)) {
    return unavailableControl('unsupported-platform', platform, () =>
      `agent-ping has no autostart unit for ${platform}; v1 supports linux, macos and windows ` +
        '(APX-CON-06)',
    )
  }

  let loaded: unknown
  try {
    // Held in a `string`-typed binding on purpose: a literal specifier would be resolved
    // by the compiler, and the point of this import is that the module's presence is a
    // runtime fact.
    const specifier: string = AUTOSTART_MODULE_SPECIFIER
    loaded = await import(specifier)
  } catch (cause) {
    return unavailableControl('missing-implementation', platform, () =>
      `the per-platform autostart units are not in this build: ${AUTOSTART_MODULE_SPECIFIER} ` +
        `could not be loaded (${nameOf(cause)}). They are IO-3's module, and a package without ` +
        'them cannot start agent-ping at login.',
    )
  }
  const module = readAutostartModule(loaded)
  if (module === null) {
    return unavailableControl('missing-implementation', platform, () =>
      `${AUTOSTART_MODULE_SPECIFIER} loaded but exported no \`createAutostartControl\`, so there ` +
        'is nothing that can write a unit',
    )
  }
  try {
    return module.createAutostartControl({ env, platform, home, stateDir })
  } catch (cause) {
    return unavailableControl('missing-implementation', platform, () =>
      `the autostart units could not be built for ${platform} (${nameOf(cause)})`,
    )
  }
}

/**
 * A control that reports the truth and changes nothing.
 *
 * `changed: false` on both operations is the load-bearing value: `install` lists what it
 * changed, and a control that claimed to have enabled a unit it never wrote would put a
 * lie in that list.
 */
function unavailableControl(
  implementation: AutostartImplementation,
  platform: NodeJS.Platform,
  reason: () => string,
): AutostartControl {
  return {
    implementation,
    platform,
    state: (): Promise<AutostartState> =>
      Promise.resolve({ availability: 'unavailable', unitPath: null, detail: reason() }),
    enable: (): Promise<AutostartChange> =>
      Promise.resolve({
        changed: false,
        unitPath: null,
        detail: reason(),
        failure: reason(),
      }),
    disable: (): Promise<AutostartChange> =>
      Promise.resolve({
        changed: false,
        unitPath: null,
        detail: reason(),
        // Disabling something that was never enabled is not a failure: an uninstall on a
        // build with no units has nothing to remove and says so.
        failure: null,
      }),
  }
}

/** The state directory the units are resolved beside the rest of the install's state. */
export function autostartStateDir(options: AutostartResolveOptions = {}): string {
  return (
    options.stateDir ??
    resolveStateDir(
      options.env ?? process.env,
      options.platform ?? process.platform,
      options.home ?? homedir(),
    )
  )
}

function nameOf(cause: unknown): string {
  if (typeof cause === 'object' && cause !== null && 'name' in cause) {
    return String((cause as { name?: unknown }).name)
  }
  return 'unknown'
}
