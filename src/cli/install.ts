// `agent-ping install` and `agent-ping uninstall`: the two commands that change the
// machine (IO-FR-02, IO-FR-03, IO-FR-08).
//
// WHAT "PRINTS EXACTLY WHAT IT CHANGED" MEANS HERE
// Every step contributes one aligned row: the subject it acted on, and either what it
// changed or what it checked and left alone. The two are never mixed, so a repeat
// install prints three rows that all say what they did *not* do, and a first install
// prints three rows that all say what they did. The change list is a value the command
// returns rather than a side effect of printing, so a caller - and the test - can count
// it. That is IO-FR-08's "reports that nothing changed" made structural rather than
// written out by hand.
//
// A VERSION MISMATCH IS A FAILURE, NOT A REPAIR
// `installGlobalPlugin` refuses to overwrite a different installed version, because the
// developer looking at a wrong card is usually looking at a wrong build. So a conflict
// here exits non-zero, names both versions, and names the two ways forward:
// `agent-ping uninstall` first, or `agent-ping install --force` once the operator has
// decided. Nothing on this path silently replaces a version (OA-FR-08, APX-FR-02).
//
// UNINSTALL KEEPS THE DATABASE UNLESS ASKED (IO-FR-03, Open Question 4)
// The database is the developer's history and the only thing in the state directory that
// cannot be reconstructed. A purge flag exists precisely so a mistaken uninstall is
// recoverable; unconditional deletion would throw away months of pending-item history
// because someone mistyped a command. So the plugin file, the autostart unit and the
// bounded log go, the database stays, `--purge` takes the database too, and every path
// removed is named in the output.
//
// NOTHING A HUB STILL NEEDS IS REMOVED UNDER IT
// The runtime file and the write token belong to a live hub, not to an uninstall:
// deleting a running hub's pointer would make every harness adapter post to a port
// nobody is serving. When a hub is answering, those two are kept and the output says
// which and why, and the command still succeeds - the uninstall did everything it was
// asked to do (APX-CON-03).
//
// THE HUB IS STARTED, AND STARTING IT IS NOT THE SAME CLAIM AS IT SERVING
// `install` reads health first. A hub that is already answering is left alone. A hub that
// is not is launched the way the autostart unit will launch it - the Electron runtime,
// detached, with the product's own Chromium launch policy in its environment - and then
// *waited for*. A spawned pid is not a hub serving, so what `install` reports is the
// health read; a hub that never publishes a port is a failure with a remedy, not a
// warning line (APX-FR-02).
//
// Every path resolves through src/storage/paths.ts, so the state directory is the
// overridable one and everything under it is created owner-only (IO-FR-07). This module
// writes files and starts one process; it makes no outbound call of any kind
// (APX-CON-12).

import { existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import {
  installGlobalPlugin,
  uninstallGlobalPlugin,
  type InstallResult,
  type UninstallResult,
} from '../plugin/install/global-plugin.js'
import { WRITE_TOKEN_FILE_NAME } from '../hub/security.js'
import { RUNTIME_FILE_NAME } from '../hub/runtime-file.js'
import { LOG_FILE_NAME, ROTATED_LOG_FILE_NAME, type LocalLog } from './log.js'
import {
  databaseFilePath,
  databaseFilePaths,
  ensureStateDir,
  resolveStateDir,
} from '../storage/paths.js'
import {
  createHubLauncher,
  readHub,
  readProductVersion,
  waitForHub,
  type HubLauncher,
} from './hub-client.js'
import type { AutostartControl } from './autostart-control.js'
import { EXIT_FAILED, EXIT_OK, kv, printed, type CommandResult, type Row } from './output.js'

/** How long `install` waits for a hub it launched to publish a port and answer. */
export const INSTALL_HEALTH_TIMEOUT_MS = 20_000

/** The three subjects every install acts on, in the order they are attempted. */
export const INSTALL_SUBJECTS: readonly string[] = ['plugin', 'autostart', 'hub']

export interface InstallOptions {
  readonly env?: NodeJS.ProcessEnv
  readonly home?: string
  readonly platform?: NodeJS.Platform
  /** Overrides the resolved state directory. The environment variable is the other door. */
  readonly stateDir?: string
  /** The product version to write into the plugin file. Never guessed. */
  readonly version?: string
  /** Replace a different installed version. Without it a mismatch is a failure. */
  readonly force?: boolean
  /** The autostart port. `IO-3` supplies the implementation; this is the seam. */
  readonly autostart: AutostartControl
  /** How `install` starts the hub. Injectable so a test never launches Electron. */
  readonly launcher?: HubLauncher
  /** How long to wait for that hub. */
  readonly healthTimeoutMs?: number
  readonly log?: LocalLog
}

export interface UninstallOptions {
  readonly env?: NodeJS.ProcessEnv
  readonly home?: string
  readonly platform?: NodeJS.Platform
  readonly stateDir?: string
  /** Also remove the database. The only destructive thing any command does. */
  readonly purge?: boolean
  readonly autostart: AutostartControl
  readonly log?: LocalLog
}

/**
 * One step's outcome: what it acted on, what changed, and what to do when it failed.
 *
 * `changed` and `unchanged` are mutually exclusive and both are strings, because a step
 * always says something. `remedy` exists only on a failure, and a failure always has one
 * (APX-FR-02).
 */
interface Step {
  readonly subject: string
  readonly changed: string | null
  readonly unchanged: string
  readonly failure: { readonly detail: string; readonly remedy: string } | null
  readonly fields: Readonly<Record<string, string | number | boolean | null>>
  /** The local-log event this step contributes, or null when it needs no line. */
  readonly logEvent: string | null
}

const changed = (
  subject: string,
  detail: string,
  unchanged: string,
  fields: Readonly<Record<string, string | number | boolean | null>> = {},
): Step => ({ subject, changed: detail, unchanged, failure: null, fields, logEvent: null })

const untouched = (
  subject: string,
  detail: string,
  fields: Readonly<Record<string, string | number | boolean | null>> = {},
): Step => ({ subject, changed: null, unchanged: detail, failure: null, fields, logEvent: null })

const failed = (
  subject: string,
  detail: string,
  remedy: string,
  fields: Readonly<Record<string, string | number | boolean | null>> = {},
  logEvent: string | null = null,
): Step => ({
  subject,
  changed: null,
  unchanged: '',
  failure: { detail, remedy },
  fields,
  logEvent,
})

/** A plugin outcome in the installer's own words, plus whether it changed anything. */
function pluginStep(result: InstallResult): Step {
  switch (result.outcome) {
    case 'installed':
      return changed(
        'plugin',
        `wrote ${result.pluginFile} (agent-ping ${result.version})`,
        '',
        { plugin: result.pluginFile, version: result.version },
      )
    case 'reinstalled':
      return changed(
        'plugin',
        `replaced ${result.pluginFile} with agent-ping ${result.version}`,
        '',
        {
          plugin: result.pluginFile,
          version: result.version,
          ...(result.previousVersion === null || result.previousVersion === undefined
            ? {}
            : { previousVersion: result.previousVersion }),
        },
      )
    case 'unchanged':
      return untouched(
        'plugin',
        `agent-ping ${result.version} is already installed at ${result.pluginFile}; not one byte was touched`,
        { plugin: result.pluginFile, version: result.version },
      )
    case 'conflict':
      return failed(
        'plugin',
        result.message,
        // The two ways forward, both explicit. `force` is the operator's decision, and a
        // decision this command makes on its own is what IO-FR-08 forbids.
        `run \`agent-ping uninstall\` first, or run \`agent-ping install --force\` once you have decided to replace agent-ping ${String(result.previousVersion ?? 'the installed version')}`,
        {
          plugin: result.pluginFile,
          version: result.version,
          outcome: 'version-mismatch',
          ...(result.previousVersion === null || result.previousVersion === undefined
            ? {}
            : { previousVersion: result.previousVersion }),
        },
        'install.plugin',
      )
    case 'blocked':
      return failed(
        'plugin',
        result.message,
        'move the file agent-ping did not write aside, then run `agent-ping install` again',
        { plugin: result.pluginFile, outcome: 'blocked' },
        'install.plugin',
      )
    case 'unverified':
      return failed(
        'plugin',
        result.message,
        'run `agent-ping doctor`; the generated plugin did not load in the opencode runtime',
        { plugin: result.pluginFile, outcome: 'unverified' },
        'install.plugin',
      )
    case 'failed':
    default:
      return failed(
        'plugin',
        result.message,
        'run `agent-ping doctor`; it reports the state directory and whether it can be written',
        { plugin: result.pluginFile, outcome: 'failed' },
        'install.plugin',
      )
  }
}

async function autostartEnableStep(control: AutostartControl): Promise<Step> {
  const change = await control.enable()
  const unit = change.unitPath ?? 'the autostart unit'
  if (change.failure !== null) {
    return failed(
      'autostart',
      change.detail,
      change.failure,
      { outcome: 'autostart-enable-failed' },
      'install.autostart',
    )
  }
  return change.changed
    ? changed('autostart', `enabled ${unit}`, '', { autostart: unit })
    : untouched('autostart', `already enabled (${unit})`, { autostart: unit })
}

/**
 * Bring the hub up, or report plainly that it already is.
 *
 * Health first, always: a hub that is already serving is the one thing `install` must
 * never disturb, and the runtime file is how a second process knows (HC-FR-01).
 */
async function hubStep(options: InstallOptions, stateDir: string): Promise<Step> {
  const originOf = (record: { host: string; port: number | null }): string =>
    `http://${record.host}:${String(record.port ?? 'no port yet')}`
  const before = await readHub({ stateDir })
  if (before.kind === 'running') {
    return untouched('hub', `already running at ${originOf(before.record)}`, {
      outcome: 'hub-already-running',
      hub: originOf(before.record),
      port: before.record.port,
    })
  }
  const launcher = options.launcher ?? createHubLauncher({ env: options.env })
  const launched = await launcher.launch()
  if (!launched.started) {
    return failed(
      'hub',
      `not started - ${launched.detail}`,
      'run `agent-ping doctor`; it reports the runtime, the port and whether the Electron runtime could be resolved',
      { outcome: 'hub-launch-failed' },
      'install.hub',
    )
  }
  const settled = await waitForHub({
    stateDir,
    timeoutMs: options.healthTimeoutMs ?? INSTALL_HEALTH_TIMEOUT_MS,
  })
  if (settled.kind === 'down') {
    return failed(
      'hub',
      `launched (${launched.detail}) but it is not serving - ${settled.failure.detail}`,
      settled.failure.remedy,
      { outcome: 'hub-not-serving', port: launched.pid ?? 0 },
      'install.hub',
    )
  }
  return changed('hub', `started and serving at ${originOf(settled.record)}`, '', {
    outcome: 'hub-started',
    hub: originOf(settled.record),
    port: settled.record.port,
  })
}

/**
 * The header sentence, then one aligned row per step, then one remedy per failure.
 *
 * A row that both changed and noted something prints both. That is the case the
 * uninstall's state row is in - it removed the log and kept the database - and dropping
 * the second half would leave the command having removed something without saying what
 * it deliberately left behind, which is exactly the claim IO-FR-03 is about.
 */
function summarise(title: string, steps: readonly Step[]): { lines: readonly string[]; exitCode: number } {
  const changes = steps.filter((step) => step.changed !== null)
  const failures = steps.filter((step) => step.failure !== null)
  const header =
    failures.length > 0
      ? `${title}: ${String(failures.length)} of ${String(steps.length)} steps failed.`
      : changes.length === 0
        ? `${title}: nothing was changed.`
        : `${title}: ${String(changes.length)} change${changes.length === 1 ? '' : 's'}.`
  const rows: readonly Row[] = steps.map((step) => {
    const parts = [step.failure?.detail ?? step.changed, step.unchanged].filter(
      (part): part is string => part !== null && part !== '',
    )
    return [step.subject, parts.join('; ')]
  })
  const lines = [header, ...kv(rows)]
  for (const step of failures) {
    lines.push(`  remedy (${step.subject}): ${step.failure?.remedy ?? ''}`)
  }
  return { lines, exitCode: failures.length === 0 ? EXIT_OK : EXIT_FAILED }
}

function report(
  title: string,
  logEvent: string,
  steps: readonly Step[],
  log: LocalLog | undefined,
  fields: Readonly<Record<string, string | number | boolean | null>>,
): CommandResult {
  const { lines, exitCode } = summarise(title, steps)
  for (const step of steps) {
    if (step.logEvent !== null) log?.error(step.logEvent, step.fields)
  }
  log?.info(logEvent, fields)
  return printed(lines, exitCode, logEvent, fields)
}

export async function runInstall(options: InstallOptions): Promise<CommandResult> {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const stateDir = ensureStateDir(options.stateDir ?? resolveStateDir(env, platform, options.home))
  const version = options.version ?? readProductVersion()
  const log = options.log
  const shared = { env, platform, ...(options.home === undefined ? {} : { home: options.home }) }

  const installed = installGlobalPlugin({ ...shared, version, force: options.force === true })
  // Autostart is attempted even when the plugin failed: the two are independent, a
  // half-finished install beats none, and the exit code still reports the plugin failure.
  const steps: Step[] = [
    pluginStep(installed),
    await autostartEnableStep(options.autostart),
    await hubStep(options, stateDir),
  ]

  return report('agent-ping install', 'install.run', steps, log, {
    version,
    stateDir,
    outcome: installed.outcome,
  })
}

// ---------------------------------------------------------------------------
// Uninstall
// ---------------------------------------------------------------------------

function uninstallStep(result: UninstallResult): Step {
  switch (result.outcome) {
    case 'removed':
      return changed(
        'plugin',
        `removed ${String(result.removed.length)} file${result.removed.length === 1 ? '' : 's'} from ${result.pluginDir}`,
        '',
        { plugin: result.pluginDir, removed: result.removed.length },
      )
    case 'absent':
      return untouched('plugin', `nothing to remove at ${result.pluginFile}`, { plugin: result.pluginFile })
    case 'blocked':
      return failed(
        'plugin',
        result.message,
        'move the file agent-ping did not write aside, then run `agent-ping uninstall` again',
        { plugin: result.pluginFile, outcome: 'blocked' },
        'uninstall.plugin',
      )
    case 'failed':
    default:
      return failed(
        'plugin',
        result.message,
        'run `agent-ping uninstall` again; removing the plugin is safe to repeat',
        { plugin: result.pluginFile, outcome: 'failed' },
        'uninstall.plugin',
      )
  }
}

async function autostartDisableStep(control: AutostartControl): Promise<Step> {
  const change = await control.disable()
  const unit = change.unitPath ?? 'the autostart unit'
  if (change.failure !== null) {
    return failed(
      'autostart',
      change.detail,
      change.failure,
      { outcome: 'autostart-disable-failed' },
      'uninstall.autostart',
    )
  }
  return change.changed
    ? changed('autostart', `removed ${unit}`, '', { autostart: unit })
    : untouched('autostart', `nothing to remove (${unit})`, { autostart: unit })
}

/**
 * Remove this product's own files from the state directory, and name every one.
 *
 * The candidate list is built from names this product owns and each path is then checked
 * to be directly inside the state directory, so a bug in the list cannot reach anything
 * else: an uninstall must not be the one command on the machine that deletes a path it
 * did not write (APX-CON-03).
 */
function stateStep(
  stateDir: string,
  purge: boolean,
  hubIsRunning: boolean,
): { step: Step; removed: readonly string[] } {
  const removed: string[] = []
  const kept: string[] = []
  const remove = (file: string): boolean => {
    const resolved = path.resolve(file)
    if (path.dirname(resolved) !== path.resolve(stateDir)) return false
    if (!existsSync(resolved)) return false
    rmSync(resolved, { force: true })
    removed.push(resolved)
    return true
  }

  // The bounded log always goes: it is a diagnostic artefact of a product that is no
  // longer installed, and the operations runbook's uninstall check looks for exactly it.
  for (const name of [LOG_FILE_NAME, ROTATED_LOG_FILE_NAME]) remove(path.join(stateDir, name))

  const database = databaseFilePath(stateDir)
  if (purge) {
    for (const file of databaseFilePaths(database)) remove(file)
  } else if (existsSync(database)) {
    kept.push(database)
  }

  for (const name of [RUNTIME_FILE_NAME, WRITE_TOKEN_FILE_NAME]) {
    const file = path.join(stateDir, name)
    if (hubIsRunning) kept.push(file)
    else remove(file)
  }

  const names = removed.map((file) => path.basename(file))
  const detail =
    names.length === 0
      ? 'nothing of the product was left in the state directory'
      : `removed ${names.join(', ')} from ${stateDir}`
  const notes: string[] = []
  if (!purge) {
    notes.push(
      kept.includes(database)
        ? `database: kept ${database}; pass --purge to remove it (Open Question 4: a mistaken uninstall must be recoverable)`
        : 'database: there was none to keep',
    )
  }
  const live = kept.filter((file) => file !== database)
  if (live.length > 0) {
    notes.push(
      `kept ${live.map((file) => path.basename(file)).join(' and ')}: a hub is running and its adapters still need them; stop it and run uninstall again`,
    )
  }
  const step: Step =
    names.length === 0
      ? untouched('state', `${detail}${notes.length === 0 ? '' : `; ${notes.join('; ')}`}`, { stateDir, removed: 0 })
      : changed('state', detail, notes.join('; '), { stateDir, removed: names.length })
  return { step, removed }
}

export async function runUninstall(options: UninstallOptions): Promise<CommandResult> {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const stateDir = options.stateDir ?? resolveStateDir(env, platform, options.home)
  const log = options.log
  const shared = { env, platform, ...(options.home === undefined ? {} : { home: options.home }) }

  const removed = uninstallGlobalPlugin(shared)
  const steps: Step[] = [
    uninstallStep(removed),
    await autostartDisableStep(options.autostart),
  ]
  const hub = await readHub({ stateDir })
  const state = stateStep(stateDir, options.purge === true, hub.kind === 'running')
  steps.push(state.step)

  return report('agent-ping uninstall', 'uninstall.run', steps, log, {
    stateDir,
    outcome: removed.outcome,
    removed: state.removed.length,
  })
}

/** The subjects `uninstall` acts on, in the order it acts on them. */
export const UNINSTALL_SUBJECTS: readonly string[] = ['plugin', 'autostart', 'state']
