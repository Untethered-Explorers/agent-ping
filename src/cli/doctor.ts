// `agent-ping doctor`: the seven checks of IO-FR-04, one remedy per failure, and a
// non-zero exit whenever any of them failed.
//
// REPORT ONLY, NEVER REPAIR (Open Question 3)
// The feature document's third open question answers itself: "should doctor ever attempt a
// repair, or only report?" - report only, "a tool that fixes things silently is harder to
// trust". So this module opens no log, writes no unit, installs no plugin, and starts no
// process. Everything it says, it observed. The one thing it creates is the bounded local
// log every command writes (src/cli/log.ts), which is the product's own state and not a
// repair of anything the check found.
//
// THE SEVEN CHECKS, AND WHY EACH ONE EXISTS
//   runtime               the Node line this build is compiled and tested against
//   database              the log's path, and whether the machine can write it
//   port                  whether the port this install published is serving *this* hub
//   plugin                the opencode adapter, and whether it is the version installed
//   autostart             the user-level unit, and whether it is enabled
//   notification surface  whether a card window can be created here at all
//   tray                  whether the badge icon is on this desktop
//
// THE PORT CHECK IS THE ONE THAT OWNS "IS THE HUB RUNNING"
// The hub prefers 43117 and falls back to the next free port (HC-1), so a doctor that
// probed only the default would report a fault on every machine where something else
// already holds it, and nothing on the machines that matter. The runtime file is the
// product's own published record, and this is the only place it is read for a verdict.
// Two cases are a failure and the rest are not, and the difference is the point:
//
//   FAIL  a runtime file publishes a port and nothing is serving *this* hub there. The
//         adapters follow that file, so a file pointing at something else is the fault.
//   FAIL  no hub is answering, with no unit to start one. The install is not working.
//   ok    a hub is serving this product's instance on the port it published.
//   ok    nothing is running and the preferred port is free: nothing is broken yet, and
//         the port check says so rather than inventing a problem.
//
// A SURFACE THAT CANNOT OPEN A WINDOW IS NOT A MISSING ELECTRON
// This is the check the operations review singles out, so it is the check whose remedy is
// written with the most care. "Can a window be created here" and "is a runtime installed"
// are two different questions (NT-FR-04, NT-FR-11), and the answer this check gives for
// each is:
//
//   available        the hub created its window; a card can be shown
//   window-refused   the runtime is present and the desktop would not give the window
//   not-mounted      no window is asked for: a plain Node run, not an application
//
// None of the three remedies says "reinstall". The refused remedy names the launch
// policy, which is the one thing measured to stop a card on this platform
// (CHROMIUM_LAUNCH_POLICY, PRD 16 Open Question 13), and says the runtime is present.

import { accessSync, constants as fsConstants, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import {
  installedVersionOf,
  resolveGlobalPluginDir,
  type OpencodePathOptions,
} from '../plugin/install/global-plugin.js'
import {
  OWNER_ONLY_DIRECTORY_MODE,
  OWNER_ONLY_FILE_MODE,
  databaseFilePath,
  resolveStateDir,
} from '../storage/paths.js'
import {
  PREFERRED_HUB_PORT,
  portHolderCommand,
  probePortAvailability,
  readHub,
  type HubReadOptions,
  type HubUnreachable,
} from './hub-client.js'
import { AUTOSTART_MODULE_SPECIFIER, type AutostartControl } from './autostart-control.js'
import type { LocalLog } from './log.js'
import {
  EXIT_FAILED,
  EXIT_OK,
  checkBlock,
  checkSummary,
  printed,
  type CheckLine,
  type CommandResult,
} from './output.js'
import type { HealthPayload } from '../hub/routes/read.js'

/**
 * The Node line this build is compiled and tested against (APX-CON-05).
 *
 * Mirrors `engines.node` in package.json, and a test asserts the two agree: a floor
 * that drifts from the manifest would make this check either useless (a floor nobody
 * enforces) or wrong (a floor stricter than the one the package declares).
 */
export const MINIMUM_NODE_VERSION = '22.12.0'

/** The seven check names, in the order they are printed. */
export const DOCTOR_CHECKS: readonly string[] = [
  'runtime',
  'database',
  'port',
  'plugin',
  'autostart',
  'notification surface',
  'tray',
]

export interface DoctorOptions {
  readonly env?: NodeJS.ProcessEnv
  readonly home?: string
  readonly platform?: NodeJS.Platform
  readonly stateDir?: string
  /** The product version, for the plugin check. Never guessed. */
  readonly version?: string
  /** Injected so a test can drive the runtime check to a failure. */
  readonly runtimeVersion?: string
  /** The autostart port. `IO-3` supplies the implementation. */
  readonly autostart: AutostartControl
  /** The loopback read. Defaults to a real GET against the published port. */
  readonly hub?: HubReadOptions
  readonly log?: LocalLog
}

/** `22.22.2` as three numbers, or null for a string that is not a version. */
function parseNodeVersion(raw: string): readonly [number, number, number] | null {
  const cleaned = raw.startsWith('v') ? raw.slice(1) : raw
  const parts = cleaned.split('.').map((part) => Number.parseInt(part, 10))
  if (parts.length < 2 || parts.some((part) => !Number.isInteger(part))) return null
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0]
}

/** Is `candidate` at least `floor`? Both are `major.minor.patch`. */
export function isAtLeastNodeVersion(candidate: string, floor: string): boolean {
  const left = parseNodeVersion(candidate)
  const right = parseNodeVersion(floor)
  if (left === null || right === null) return false
  for (let index = 0; index < 3; index += 1) {
    const a = left[index] ?? 0
    const b = right[index] ?? 0
    if (a > b) return true
    if (a < b) return false
  }
  return true
}

function runtimeCheck(version: string): CheckLine {
  const supported = isAtLeastNodeVersion(version, MINIMUM_NODE_VERSION)
  return {
    name: 'runtime',
    severity: supported ? 'passed' : 'failed',
    detail: supported
      ? `node ${version}`
      : `node ${version}, below the ${MINIMUM_NODE_VERSION} this build supports`,
    ...(supported
      ? {}
      : {
          remedy: `install Node.js ${MINIMUM_NODE_VERSION} or newer and run \`agent-ping doctor\` again (APX-CON-05)`,
        }),
  }
}

/** The permission failure, or null when the path is reachable and writable. */
function writeFailure(target: string): string | null {
  try {
    accessSync(target, fsConstants.W_OK)
    return null
  } catch (cause) {
    return codeOf(cause)
  }
}

/** True when the path exists and is a file rather than the directory it should be. */
function isFile(target: string): boolean {
  try {
    return statSync(target).isFile()
  } catch {
    return false
  }
}

/** The mode as four octal digits, or null when the filesystem has no POSIX modes. */
function modeOf(target: string): string | null {
  try {
    return (statSync(target).mode & 0o777).toString(8).padStart(3, '0')
  } catch {
    return null
  }
}

/**
 * The database check: the path, and whether the machine can write it.
 *
 * Four faults with four remedies, checked separately because a developer who fixed one
 * still has the others. The database file is not opened: `doctor` reports, and opening a
 * log is what the hub does (APX-FR-02). A state directory that exists but is readable by
 * other users is reported too, because IO-FR-07 promises owner-only and a directory at
 * 0755 is a promise this build failed to keep - reported, not chmod-ed. A state
 * directory that is a *file* is reported as itself, because "not writable" would be a
 * misleading answer to "there is a file where the directory should be".
 */
function databaseCheck(stateDir: string, logWritable: boolean, logFailure: string | null): CheckLine {
  const file = databaseFilePath(stateDir)
  if (isFile(stateDir)) {
    return {
      name: 'database',
      severity: 'failed',
      detail: `${stateDir} is a file, so it cannot hold the log directory the database lives in`,
      remedy: `remove or rename ${stateDir} and set AGENT_PING_STATE_DIR to a directory you own; every path the product writes resolves through it (IO-FR-07)`,
    }
  }
  const dirMode = modeOf(stateDir)
  const dirFailure = writeFailure(stateDir)
  if (dirFailure !== null) {
    return {
      name: 'database',
      severity: 'failed',
      detail: `${file} cannot be written: ${stateDir} is not writable (${dirFailure})`,
      remedy: `fix the permissions on ${stateDir}, or set AGENT_PING_STATE_DIR to a directory you own (IO-FR-07)`,
    }
  }
  if (dirMode !== null && (Number.parseInt(dirMode, 8) & 0o077) !== 0) {
    return {
      name: 'database',
      severity: 'failed',
      detail: `${stateDir} is mode ${dirMode}; agent-ping keeps its state directory owner-only (0${OWNER_ONLY_DIRECTORY_MODE.toString(8)})`,
      remedy: `run \`chmod 700 ${stateDir}\`; nothing else in agent-ping needs to change, and the directory holds the log and the write token (IO-FR-07)`,
    }
  }
  // A database that does not exist yet is the ordinary state of a machine where the hub
  // has never run, and the store creates it; so only an existing file's own permissions
  // are a fault. The local log is the other file in the directory, and its writability is
  // a fact this run observed rather than one it re-derived.
  if (!logWritable && logFailure !== null) {
    return {
      name: 'database',
      severity: 'failed',
      detail: `the local log could not be written: ${logFailure}`,
      remedy: `fix the permissions on ${stateDir}, or set AGENT_PING_STATE_DIR to a directory you own; nothing in the directory is writable as it stands (IO-FR-07, IO-FR-09)`,
    }
  }
  const fileFailure = existsSync(file) ? writeFailure(file) : null
  if (fileFailure !== null) {
    return {
      name: 'database',
      severity: 'failed',
      detail: `${file} is not writable (${fileFailure})`,
      remedy: `make ${file} writable by its owner (0${OWNER_ONLY_FILE_MODE.toString(8)}), or point AGENT_PING_STATE_DIR somewhere else (IO-FR-07)`,
    }
  }
  return {
    name: 'database',
    severity: 'passed',
    detail: `${file}, state directory mode ${dirMode ?? 'unknown'}, writable`,
  }
}

/**
 * The port check, and the one that owns "is the hub running".
 *
 * A hub serving this product's instance on the port it published is the healthy case. A
 * published port that nothing is serving is a failure with the runtime file's own remedy,
 * because the adapters follow that file. A hub that has not started is a failure with a
 * remedy that starts it.
 *
 * When no hub is running the check also says whether the *preferred* port is free, and
 * that is a note rather than a failure. The hub falls back to the next free port (HC-1),
 * so an occupied 43117 does not stop this product working - but a developer whose live
 * port is not the documented one needs to be told which it is and how to find its holder,
 * which is what the operations review asks for by name.
 */
async function portCheck(
  failure: HubUnreachable | null,
  running: boolean,
  port: number | null,
  platform: NodeJS.Platform,
): Promise<CheckLine> {
  if (running && port !== null) {
    return {
      name: 'port',
      severity: 'passed',
      detail:
        port === PREFERRED_HUB_PORT
          ? `127.0.0.1:${String(port)} is serving this agent-ping`
          : `127.0.0.1:${String(port)} is serving this agent-ping; the preferred ${String(PREFERRED_HUB_PORT)} was not available`,
    }
  }
  const base = {
    name: 'port',
    severity: 'failed' as const,
    detail: failure?.detail ?? 'no hub is answering on this state directory',
    remedy: failure?.remedy ?? 'run `agent-ping install` to start the hub and enable the unit that starts it at login',
  }
  if (failure !== null && failure.kind !== 'no-runtime-file') return base
  const availability = await probePortAvailability()
  if (availability === 'in-use') {
    return {
      ...base,
      detail: `${base.detail}; the preferred port 127.0.0.1:${String(PREFERRED_HUB_PORT)} is in use by another process, so the next hub will bind the next free port instead`,
      remedy: `${base.remedy}. To see what holds 127.0.0.1:${String(PREFERRED_HUB_PORT)}, run \`${portHolderCommand(PREFERRED_HUB_PORT, platform)}\``,
    }
  }
  if (availability === 'unknown') {
    return {
      ...base,
      detail: `${base.detail}; this run could not determine whether 127.0.0.1:${String(PREFERRED_HUB_PORT)} is free`,
    }
  }
  return base
}

/**
 * The plugin check: present, and the version this package installed.
 *
 * Four answers, because the operations review asks for the first two to be told apart:
 * absent (run install), present but written by somebody else (move it aside), present at
 * a different version (decide), and present at this version. A version mismatch is a
 * failure here for the same reason it is one in `install` - a developer debugging a card
 * is usually debugging a build they did not mean to be running.
 */
function pluginCheck(options: DoctorOptions, pluginPaths: OpencodePathOptions): CheckLine {
  const file = path.join(resolveGlobalPluginDir(pluginPaths), 'agent-ping.ts')
  const version = options.version ?? 'unknown'
  let installed: string | null
  try {
    installed = installedVersionOf(file)
  } catch (cause) {
    return {
      name: 'plugin',
      severity: 'failed',
      detail: `${file} could not be read (${codeOf(cause)})`,
      remedy: `run \`agent-ping install\`; if it refuses, move ${file} aside first`,
    }
  }
  if (installed === null) {
    return {
      name: 'plugin',
      severity: 'failed',
      detail: `no agent-ping plugin at ${file}, or that file was not written by agent-ping`,
      remedy: `run \`agent-ping install\`; if a plugin of yours is already at that path, move it aside and install again (APX-CON-03)`,
    }
  }
  if (installed !== version) {
    return {
      name: 'plugin',
      severity: 'failed',
      detail: `${file} holds agent-ping ${installed}; this package is ${version}`,
      remedy: `run \`agent-ping install --force\` to install ${version}, or \`agent-ping uninstall\` first; a different version is never replaced silently (IO-FR-08)`,
    }
  }
  return { name: 'plugin', severity: 'passed', detail: `agent-ping ${version} at ${file}` }
}

async function autostartCheck(control: AutostartControl): Promise<CheckLine> {
  const state = await control.state()
  if (state.availability === 'enabled') {
    return {
      name: 'autostart',
      severity: 'passed',
      detail: `enabled (${state.unitPath ?? 'the user-level unit'})`,
    }
  }
  if (state.availability === 'disabled') {
    return {
      name: 'autostart',
      severity: 'failed',
      detail: `disabled; ${state.unitPath ?? 'no unit'} is not enabled, so agent-ping will not start at login`,
      remedy: 'run `agent-ping install`, which enables it; no root and no system service is involved (IO-FR-06)',
    }
  }
  return {
    name: 'autostart',
    severity: 'failed',
    detail: state.detail,
    // The remedy names the module, because the fault is in the build rather than in the
    // operator's machine: there is nothing for a developer to run and nothing to chmod.
    remedy: `nothing to run on this machine: this build has no per-platform unit, and the module that provides one is ${AUTOSTART_MODULE_SPECIFIER} (IO-3, IO-FR-06)`,
  }
}

/**
 * The surface check, and the one the operations review is built around.
 *
 * `unknown` is a real answer here rather than a failure: with no hub running there is no
 * window to create and nothing to probe, and reporting that as a broken surface would
 * send a developer to fix a card that does not exist yet. The `port` check is what says
 * the hub is down.
 */
function surfaceCheck(health: HealthPayload | null): CheckLine {
  if (health === null) {
    return {
      name: 'notification surface',
      severity: 'unknown',
      detail: 'not evaluated: no hub is running, so there is no window to create a card in',
    }
  }
  const desktop = health.desktop
  if (desktop === undefined) {
    return {
      name: 'notification surface',
      severity: 'unknown',
      detail: 'this hub does not report its desktop, so the surface cannot be judged from outside it',
    }
  }
  if (desktop.surface === 'available') {
    return {
      name: 'notification surface',
      severity: 'passed',
      detail: `the hub created its card window${health.delivery.wired ? ' and a notifier is wired behind it' : ', though no notifier is wired'}`,
    }
  }
  if (desktop.surface === 'window-refused') {
    // The remedy names the real cause and says the runtime is present, because the one
    // wrong answer here is "reinstall Electron" and a developer who follows it reinstalls
    // something that is already installed (NT-FR-04, NT-FR-11).
    return {
      name: 'notification surface',
      severity: 'failed',
      detail: `the Electron runtime is present and the desktop refused the card window; no card can be shown and every delivery is recorded as not-wired`,
      remedy:
        'this is not a missing Electron: the runtime is installed and the window was refused. Check CHROMIUM_LAUNCH_POLICY in src/notify/surface/electron-host.ts (the setuid-sandbox helper aborts an unprivileged launch), then the compositor (NT-FR-04, NT-FR-11)',
    }
  }
  return {
    name: 'notification surface',
    severity: 'failed',
    detail: `this run mounted no card window${desktop.bridge === 'absent' ? ': it is a plain Node run with no desktop bridge' : ''}`,
    remedy:
      'start agent-ping as the application (the tray icon, or the autostart unit at login) rather than as a plain Node process; a headless run is supported and shows no card (NT-FR-04, ADR-012)',
  }
}

/** The tray check. Same three answers as the surface, and the same reason. */
function trayCheck(health: HealthPayload | null): CheckLine {
  if (health === null) {
    return {
      name: 'tray',
      severity: 'unknown',
      detail: 'not evaluated: no hub is running, so there is no tray to report on',
    }
  }
  const desktop = health.desktop
  if (desktop === undefined) {
    return { name: 'tray', severity: 'unknown', detail: 'this hub does not report its desktop' }
  }
  if (desktop.tray === 'mounted') {
    return { name: 'tray', severity: 'passed', detail: 'the badge icon is on this desktop' }
  }
  if (desktop.tray === 'closed') {
    return {
      name: 'tray',
      severity: 'failed',
      detail: 'the tray was mounted and has been taken down, so the pending count is not on the desktop',
      remedy: 'restart the application; the tray is mounted before the hub reports running and removed before the log closes (NT-FR-05)',
    }
  }
  if (desktop.tray === 'unavailable') {
    return {
      name: 'tray',
      severity: 'failed',
      detail: 'this run asked for a tray and the desktop did not give it one, so the pending count is not on the desktop',
      remedy:
        'this is not a missing runtime: the desktop refused the icon. Check that the session has a status area (a StatusNotifierItem host on Linux) and re-run `agent-ping doctor` (NT-FR-05, NT-FR-11)',
    }
  }
  return {
    name: 'tray',
    severity: 'failed',
    detail: `this run mounted no tray${desktop.bridge === 'absent' ? ': it is a plain Node run with no desktop bridge' : ''}`,
    remedy:
      'start agent-ping as the application (the tray icon, or the autostart unit at login); the badge is the durable signal and it is not on a headless run (NT-FR-05)',
  }
}

export async function runDoctor(options: DoctorOptions): Promise<CommandResult> {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const stateDir = options.stateDir ?? resolveStateDir(env, platform, options.home)
  const pluginPaths: OpencodePathOptions = {
    env,
    platform,
    ...(options.home === undefined ? {} : { home: options.home }),
  }

  const reading = await readHub(options.hub ?? { stateDir })
  const health = reading.kind === 'running' ? reading.health : null
  const checks: CheckLine[] = [
    runtimeCheck(options.runtimeVersion ?? process.version),
    databaseCheck(stateDir, options.log?.writable ?? true, options.log?.failure ?? null),
    await portCheck(
      reading.kind === 'down' ? reading.failure : null,
      reading.kind === 'running',
      reading.kind === 'running' ? reading.record.port : null,
      platform,
    ),
    pluginCheck(options, pluginPaths),
    await autostartCheck(options.autostart),
    surfaceCheck(health),
    trayCheck(health),
  ]

  const failedChecks = checks.filter((check) => check.severity === 'failed')
  const version = options.version ?? '0.0.0'
  const lines = [
    `agent-ping doctor ${version} on ${platform}`,
    `  state directory  ${stateDir}`,
    ...checkBlock(checks),
    `  ${checkSummary(checks)}`,
  ]
  options.log?.info('doctor.run', {
    stateDir,
    outcome: failedChecks.length === 0 ? 'checks-passed' : 'checks-failed',
    version,
  })
  return printed(
    lines,
    failedChecks.length === 0 ? EXIT_OK : EXIT_FAILED,
    'doctor.run',
    { stateDir, outcome: failedChecks.length === 0 ? 'checks-passed' : 'checks-failed' },
  )
}

function codeOf(cause: unknown): string {
  if (typeof cause === 'object' && cause !== null && 'code' in cause) {
    return String((cause as { code?: unknown }).code ?? 'unknown')
  }
  return 'unknown'
}
