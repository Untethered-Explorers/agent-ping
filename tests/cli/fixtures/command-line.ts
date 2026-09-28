// A command line, driven the way a developer drives it, against a temporary machine.
//
// WHAT THIS ADDS OVER CALLING `runInstall` DIRECTLY
// Everything the dispatcher is responsible for, and the only place those things are
// tested: argument routing, flag parsing, the environment the state directory resolves
// from, the local log, the lines that reach standard output, and the exit code. Every
// test in tests/cli/ goes through `harness.run(...)`, which calls `runCli` - the
// function the package's `bin` runs. A test that called a command function directly
// would pass with a dispatcher that routed every argument to `status`.
//
// THE ENVIRONMENT IS REDIRECTED, NOT A PARAMETER
// `AGENT_PING_STATE_DIR` and `XDG_CONFIG_HOME` are set in the harness's own `env` object
// and that object is what the command is given, so the test proves the override
// mechanism (IO-FR-07) rather than only the `stateDir` parameter. `HOME` points at a
// temporary directory too, so a command that resolved anything against the real user's
// home - the opencode plugin directory in particular - would fail here rather than write
// to the machine running the suite.
//
// TWO PORTS AND TWO HUBS, NEVER THE SAME ONE
// `startHub` claims the runtime file for a state directory, so a harness owns the
// directory it creates. `launcher` starts a *real* hub over a *real* socket rather than
// pretending to, which is what makes "install verifies health" a claim about a hub
// rather than about a stub.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runCli, type CliDependencies, type CommandIo } from '@/cli/index'
import { startHub, type RunningHub, type StartHubOptions } from '@/main/index'
import {
  type AutostartChange,
  type AutostartControl,
  type AutostartState,
} from '@/cli/autostart-control'
import { STATE_DIR_ENV_VAR } from '@/storage/paths'
import type { HubLaunchOutcome, HubLauncher } from '@/cli/hub-client'
import { writeTokenFilePath } from '@/hub/security'

/** What the recording autostart control was asked, in order. */
export interface AutostartCalls {
  readonly states: number
  readonly enables: number
  readonly disables: number
}

/** An autostart control that records rather than writes, because `IO-3` owns the units. */
export class RecordingAutostart implements AutostartControl {
  implementation = 'autostart-units' as const
  calls: AutostartCalls = { states: 0, enables: 0, disables: 0 }
  unitPath: string | null = '/tmp/agent-ping-test/autostart-unit'
  enabled = false
  /** The answer `enable` gives. A test that needs a failure sets it. */
  enableFailure: string | null = null
  /** The answer `disable` gives. */
  disableFailure: string | null = null
  /** The answer `state` gives when the control is asked before anything enabled it. */
  stateWhenDisabled: AutostartState | null = null

  constructor(readonly platform: NodeJS.Platform = 'linux') {}

  async state(): Promise<AutostartState> {
    this.calls = { ...this.calls, states: this.calls.states + 1 }
    if (this.enabled) {
      return { availability: 'enabled', unitPath: this.unitPath, detail: 'enabled' }
    }
    return (
      this.stateWhenDisabled ?? {
        availability: 'disabled',
        unitPath: this.unitPath,
        detail: 'disabled',
      }
    )
  }

  async enable(): Promise<AutostartChange> {
    this.calls = { ...this.calls, enables: this.calls.enables + 1 }
    if (this.enableFailure !== null) {
      return {
        changed: false,
        unitPath: this.unitPath,
        detail: this.enableFailure,
        failure: this.enableFailure,
      }
    }
    const changed = !this.enabled
    this.enabled = true
    return { changed, unitPath: this.unitPath, detail: 'enabled', failure: null }
  }

  async disable(): Promise<AutostartChange> {
    this.calls = { ...this.calls, disables: this.calls.disables + 1 }
    if (this.disableFailure !== null) {
      return {
        changed: false,
        unitPath: this.unitPath,
        detail: this.disableFailure,
        failure: this.disableFailure,
      }
    }
    const changed = this.enabled
    this.enabled = false
    return { changed, unitPath: this.unitPath, detail: 'disabled', failure: null }
  }
}

export interface CliHarnessOptions {
  readonly platform?: NodeJS.Platform
  /** The product version the harness claims. Overridden to test a version mismatch. */
  readonly version?: string
  /** The Node version reported to the runtime check. Only a failure test sets this. */
  readonly runtimeVersion?: string
  /** Reuse a state directory across two harnesses, e.g. a real global install. */
  readonly stateDir?: string
  /** Reuse a home directory, for the same reason. */
  readonly home?: string
}

export interface CliHarness {
  readonly root: string
  readonly home: string
  readonly stateDir: string
  readonly env: NodeJS.ProcessEnv
  readonly platform: NodeJS.Platform
  readonly autostart: RecordingAutostart
  readonly out: readonly string[]
  readonly err: readonly string[]
  /** Everything printed to standard output, joined. */
  text(): string
  /** The lines of the last run's standard output, as one string. */
  lastText(): string
  /** Run one command line through the entry point and return its exit code. */
  run(argv: readonly string[], overrides?: Partial<CliDependencies>): Promise<number>
  /** Start a real hub in this harness's state directory. */
  hub(options?: Partial<StartHubOptions>): Promise<RunningHub>
  /** The launcher `install` uses; starts a real hub unless one is already running. */
  readonly launcher: HubLauncher
  /** How many times the launcher was asked to start something. */
  launches(): number
  /** Stop every hub this harness started and delete the temporary directory. */
  close(): Promise<void>
}

/**
 * A temporary machine: a home, a state directory, an environment that points at both,
 * and a command line wired to them.
 */
export async function cliHarness(options: CliHarnessOptions = {}): Promise<CliHarness> {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-ping-cli-'))
  const home = options.home ?? path.join(root, 'home')
  const stateDir = options.stateDir ?? path.join(root, 'state')
  const platform = options.platform ?? 'linux'
  const env: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'] ?? '',
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    [STATE_DIR_ENV_VAR]: stateDir,
  }
  const autostart = new RecordingAutostart(platform)
  const out: string[] = []
  const err: string[] = []
  const io: CommandIo = {
    out: (line) => {
      out.push(line)
    },
    err: (line) => {
      err.push(line)
    },
  }
  const hubs: RunningHub[] = []
  let launches = 0

  const launcher: HubLauncher = {
    launch: async (): Promise<HubLaunchOutcome> => {
      launches += 1
      const hub = await startHub({
        stateDir,
        // No dashboard build in a test tree, and the card document is not what these
        // tests are about: a hub with no dashboard still serves every read route.
        dashboardRoot: null,
        lifecycle: { installSignals: false },
      })
      hubs.push(hub)
      return {
        started: true,
        // The process the launcher stands in for, which in this fixture is the test
        // runner: the hub it starts is a real one, in this process.
        pid: process.pid,
        detail: `launched a real hub on ${hub.origin}`,
        command: 'agent-ping',
      }
    },
  }

  return {
    root,
    home,
    stateDir,
    env,
    platform,
    autostart,
    out,
    err,
    text: () => out.join('\n'),
    lastText: () => out.join('\n'),
    launcher,
    launches: () => launches,
    // No `log` is passed: the dispatcher builds the local log itself, which is what a
    // developer's command does, and which is therefore what these tests observe - the
    // file on disk, its bound and its content, not an injected double.
    run: async (argv, overrides = {}) => {
      out.length = 0
      err.length = 0
      return runCli(argv, {
        env,
        home,
        platform,
        stateDir,
        version: options.version ?? '0.1.0',
        io,
        autostart,
        launcher,
        runtimeVersion: options.runtimeVersion ?? process.version,
        ...overrides,
      })
    },
    hub: async (hubOptions = {}) => {
      const hub = await startHub({
        stateDir,
        dashboardRoot: null,
        lifecycle: { installSignals: false },
        ...hubOptions,
      })
      hubs.push(hub)
      return hub
    },
    close: async () => {
      for (const hub of hubs.splice(0)) {
        await hub.close()
      }
      rmSync(root, { recursive: true, force: true })
    },
  }
}

/** The write token path inside a state directory, for the uninstall check. */
export function tokenPath(stateDir: string): string {
  return writeTokenFilePath(stateDir)
}
