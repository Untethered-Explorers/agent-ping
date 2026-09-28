// The `agent-ping` command: the dispatcher, and the process entry the manifest's `bin`
// names (IO-FR-02..IO-FR-05, IO-FR-08, IO-FR-09).
//
// ONE ENTRY POINT, FOUR SUBCOMMANDS, AND A TEST THAT USES IT
// `runCli` is the whole command line: argument parsing, subcommand routing, the local
// log, the exit code and the printing. Every test in tests/cli/ drives a subcommand
// *through this function* rather than calling `runInstall` and friends, because a
// dispatcher that is never exercised is a dispatcher whose argument routing, flag
// handling and exit codes are all untested. It is also the reason the collaborators are
// parameters: a command that read `process.env` directly could not be driven against a
// temporary state directory at all (IO-FR-07).
//
// EXIT CODES ARE THE API (IO-FR-04)
//   0  the command did what it was asked
//   1  a check failed, or a step could not be completed
//   2  the command line named a command or a flag that does not exist
//
// `2` rather than `1` for a bad command line because "you asked for something that does
// not exist" and "the thing you asked for failed" are different answers, and a script
// that mistook one for the other would retry a command that cannot succeed. This matches
// the convention the repository's verification scripts already use.
//
// NOTHING EXITS THE PROCESS FROM HERE EXCEPT THE ENTRY GUARD
// `runCli` returns a number. That is what makes a failure exit assertable: a test can
// drive a failing `doctor` and read the code without ending the test runner, and the
// entry guard is the single place that turns the returned number into `process.exitCode`.
// A command that called `process.exit` itself would be untestable in exactly the place
// the product's own standard says matters most - "exit codes are the API".
//
// IT PRINTS NOTHING ELSE
// The subcommands return their lines; this module prints them. So the aligned output a
// test asserts on is the output a developer sees, from the same value, and there is no
// second writer of stdout anywhere in src/cli.
//
// NOTHING LEAVES THE MACHINE (APX-CON-12)
// The only outbound call any command makes is a GET to the loopback hub, through
// src/cli/hub-client.ts, and the one process `install` starts is this product's own
// Electron runtime. There is no telemetry, no update check, and no crash report, and
// `tests/cli/doctor.test.ts` asserts the absence of the calls that would carry one.

import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { resolveAutostartControl, type AutostartControl } from './autostart-control.js'
import { runInstall, runUninstall } from './install.js'
import { runDoctor } from './doctor.js'
import { runStatus } from './status.js'
import { createLocalLog, type LocalLog } from './log.js'
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, kv, printed, type CommandResult } from './output.js'
import {
  readProductVersion,
  type HubLauncher,
  type HubReadOptions,
  type PortAvailability,
} from './hub-client.js'
import { resolveStateDir } from '../storage/paths.js'

/** The commands this product has, in the order `--help` lists them. */
export const CLI_COMMANDS: readonly string[] = ['install', 'uninstall', 'status', 'doctor']

/** The flags `--help` documents, with the one-sentence meaning of each. */
export const CLI_FLAGS: readonly (readonly [string, string])[] = [
  ['--purge', 'with `uninstall`: also delete the database (it is kept without this flag)'],
  ['--force', 'with `install`: replace a different installed plugin version'],
  ['--verbose', 'mirror every local log line to standard output'],
  ['--help', 'print this text'],
]

/** The parsed command line: one command, the flags it was given, and nothing unexpected. */
export interface ParsedArgv {
  readonly command: string | null
  readonly purge: boolean
  readonly force: boolean
  readonly verbose: boolean
  readonly help: boolean
  /** The first thing that was wrong with the command line, or null. */
  readonly error: string | null
}

/**
 * Parse a command line.
 *
 * A flag is refused on the command it does not belong to, rather than ignored. `--purge`
 * on `status` is a developer's typo, and silently running status would be a command that
 * reported success for something it did not do.
 */
export function parseArgv(argv: readonly string[]): ParsedArgv {
  const flags = new Set<string>()
  let command: string | null = null
  for (const argument of argv) {
    if (argument.startsWith('-')) {
      if (!CLI_FLAGS.some(([flag]) => flag === argument)) {
        return {
          command,
          purge: false,
          force: false,
          verbose: false,
          help: false,
          error: `unknown flag ${argument}`,
        }
      }
      flags.add(argument)
      continue
    }
    if (command !== null) {
      return { command, purge: false, force: false, verbose: false, help: false, error: `unexpected argument ${argument}` }
    }
    command = argument
  }
  const purge = flags.has('--purge')
  const force = flags.has('--force')
  if (purge && command !== 'uninstall') {
    return { command, purge: false, force, verbose: flags.has('--verbose'), help: flags.has('--help'), error: '--purge is only meaningful for `uninstall`' }
  }
  if (force && command !== 'install') {
    return { command, purge: false, force: false, verbose: flags.has('--verbose'), help: flags.has('--help'), error: '--force is only meaningful for `install`' }
  }
  return {
    command,
    purge,
    force,
    verbose: flags.has('--verbose'),
    help: flags.has('--help'),
    error: null,
  }
}

/** The help text. One screen, and every flag the parser accepts is in it. */
export function usageText(version: string): string {
  return [
    `agent-ping ${version} - local notification dashboard for coding agents`,
    '',
    'usage: agent-ping <command> [flags]',
    '',
    '  install     write the opencode plugin, enable autostart, start the hub and say what changed',
    '  uninstall   remove the plugin, disable autostart and remove the local log; the database stays',
    '  status      report the pending count, the last event, the uptime and the active sessions',
    '  doctor      check the seven things that decide whether this install works, and exit non-zero if one fails',
    '',
    'flags:',
    ...CLI_FLAGS.map(([flag, meaning]) => `  ${flag.padEnd(10)}${meaning}`),
    '',
    'environment:',
    '  AGENT_PING_STATE_DIR   where the log, the database, the runtime file and the write token live (IO-FR-07)',
    '  XDG_CONFIG_HOME        where the opencode plugin directory is found',
  ].join('\n')
}

/** Where a command writes. A parameter so a test never captures the real streams. */
export interface CommandIo {
  out(line: string): void
  err(line: string): void
}

export interface CliDependencies {
  readonly env?: NodeJS.ProcessEnv
  readonly home?: string
  readonly platform?: NodeJS.Platform
  /** Overrides the resolved state directory. The environment variable is the other door. */
  readonly stateDir?: string
  /** The product version. Read out of the manifest when absent. */
  readonly version?: string
  readonly io?: CommandIo
  /**
   * The local log. Built for the resolved state directory when absent - and *not* built
   * for `uninstall`, which is the one command whose job is to delete it.
   */
  readonly log?: LocalLog
  /** The autostart port. Resolved - and reported honestly when absent - when not given. */
  readonly autostart?: AutostartControl
  /** Injected so a test never launches Electron. See src/cli/hub-client.ts. */
  readonly launcher?: HubLauncher
  /** Injected so a test can drive the runtime check to a failure. */
  readonly runtimeVersion?: string
  /**
   * The loopback read `status` and `doctor` use, so a test can answer without a socket.
   *
   * Injectable for the same reason `launcher` is: the alternative is a stub hub on a real
   * port that cannot produce a shape a real hub will not produce, and the shapes that
   * matter here are exactly the ones a real hub in this repository never takes - a hub
   * serving health with no `desktop` section, for one, which is a *running* hub whose
   * two desktop checks therefore cannot be evaluated. See `HealthPayload.desktop`, which
   * is optional for that reason.
   */
  readonly hub?: HubReadOptions
  /**
   * Injected so a test can drive doctor's port note either way.
   *
   * The default is a real bind attempt on the product's preferred port, which makes the
   * note a fact about the machine rather than about this code. That is right for an
   * operator and untestable for a suite, so the seam is here for the same reason `hub`
   * is: an assertion about which wording appears must not depend on whether a leftover
   * process happens to be holding 43117 on the machine running the tests.
   */
  readonly portAvailability?: () => Promise<PortAvailability>
  /** Injected so a test's expected timestamps do not depend on the wall clock. */
  readonly now?: () => Date
}

/** The real streams, resolved once. */
function defaultIo(): CommandIo {
  return {
    out: (line: string): void => {
      process.stdout.write(`${line}\n`)
    },
    err: (line: string): void => {
      process.stderr.write(`${line}\n`)
    },
  }
}

/**
 * Run one command line and return its exit code.
 *
 * The whole command line, in one function: this is what the manifest's `bin` runs and
 * what every test drives. It prints through `io`, writes the local log, and returns a
 * number; it never ends the process.
 */
export async function runCli(argv: readonly string[], dependencies: CliDependencies = {}): Promise<number> {
  const io = dependencies.io ?? defaultIo()
  const parsed = parseArgv(argv)
  let version: string
  try {
    version = dependencies.version ?? readProductVersion()
  } catch (cause) {
    io.err(`agent-ping: this installation's package.json could not be read (${String((cause as Error).message)})`)
    return EXIT_FAILED
  }

  if (parsed.help) {
    for (const line of usageText(version).split('\n')) io.out(line)
    return EXIT_OK
  }
  if (parsed.error !== null) {
    io.err(`agent-ping: ${parsed.error}`)
    io.err(`agent-ping: run \`agent-ping --help\` for the commands and flags this build accepts`)
    return EXIT_USAGE
  }
  if (parsed.command === null) {
    for (const line of usageText(version).split('\n')) io.out(line)
    return EXIT_OK
  }
  if (!CLI_COMMANDS.includes(parsed.command)) {
    io.err(`agent-ping: ${parsed.command} is not a command; this build has ${CLI_COMMANDS.join(', ')}`)
    return EXIT_USAGE
  }

  const env = dependencies.env ?? process.env
  const platform = dependencies.platform ?? process.platform
  const home = dependencies.home ?? homedir()
  const stateDir = dependencies.stateDir ?? resolveStateDir(env, platform, home)
  // `uninstall` is the one command that is given no log, and that is a decision rather
  // than an oversight: it removes the local log, so opening one for it would have every
  // run of it create the file it exists to delete and then report having changed
  // something. The record of an uninstall is the absence of the product.
  const log: LocalLog | undefined =
    parsed.command === 'uninstall'
      ? undefined
      : (dependencies.log ??
        createLocalLog({
          stateDir,
          env,
          verbose: parsed.verbose,
          mirror: (line): void => {
            io.out(line.trimEnd())
          },
        }))

  const autostart = dependencies.autostart ?? (await resolveAutostartControl({ env, platform, home, stateDir }))

  let result: CommandResult
  try {
    switch (parsed.command) {
      case 'install':
        result = await runInstall({
          env,
          platform,
          home,
          stateDir,
          version,
          force: parsed.force,
          autostart,
          log,
          ...(dependencies.launcher === undefined ? {} : { launcher: dependencies.launcher }),
        })
        break
      case 'uninstall':
        result = await runUninstall({
          env,
          platform,
          home,
          stateDir,
          purge: parsed.purge,
          autostart,
          log,
        })
        break
      case 'status':
        result = await runStatus({
          stateDir,
          log,
          ...(dependencies.hub === undefined ? {} : { hub: dependencies.hub }),
          ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
        })
        break
      case 'doctor':
        result = await runDoctor({
          env,
          platform,
          home,
          stateDir,
          version,
          autostart,
          log,
          ...(dependencies.hub === undefined ? {} : { hub: dependencies.hub }),
          ...(dependencies.runtimeVersion === undefined ? {} : { runtimeVersion: dependencies.runtimeVersion }),
          ...(dependencies.portAvailability === undefined
            ? {}
            : { portAvailability: dependencies.portAvailability }),
        })
        break
      default:
        // Unreachable: the command was checked against CLI_COMMANDS above. Stated rather
        // than left implicit, because a switch whose default arm is a real command would
        // route the *next* command somebody added straight into `doctor`.
        result = printed(
          [`agent-ping: ${parsed.command} is not a command this build has.`],
          EXIT_USAGE,
        )
        break
    }
  } catch (cause) {
    // A command that throws has still failed, and the exit code is the only thing a
    // script can trust. So the throw is turned into a reported failure here rather than
    // escaping to the entry guard, which would end the process without the command
    // having said what it could not do (APX-FR-02).
    result = printed(
      [
        `agent-ping ${parsed.command}: the command could not finish.`,
        ...kv([
          ['error', `${nameOf(cause)}: ${messageOf(cause)}`],
          ['remedy', 'run `agent-ping doctor`; it names the state directory, the port and the plugin, and one remedy per fault'],
        ]),
      ],
      EXIT_FAILED,
    )
    if (log !== undefined) log.error(`${parsed.command}.threw`, { outcome: 'threw' })
  }

  for (const line of result.lines) io.out(line)
  if (log !== undefined && log.failure !== null) io.err(`agent-ping: ${log.failure}`)
  return result.exitCode
}

/**
 * Run the command line when this module is the process entry.
 *
 * The same check `src/main/index.ts` uses, and for the same reason: Electron's argv puts
 * Chromium's own switches before the script path, so `argv[1]` is not the script on
 * every launch a packaged install can produce. Every argv entry that is not a switch is
 * compared instead.
 */
function isCliEntryPoint(): boolean {
  let self: string
  try {
    self = fileURLToPath(import.meta.url)
  } catch {
    return false
  }
  return process.argv
    .slice(1)
    .some((argument) => !argument.startsWith('-') && fileURLToPathSafe(argument) === self)
}

function fileURLToPathSafe(argument: string): string | null {
  try {
    return argument.startsWith('file:') ? fileURLToPath(argument) : argument
  } catch {
    return null
  }
}

if (isCliEntryPoint()) {
  void runCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code
    })
    .catch((cause: unknown) => {
      // A command that throws has still failed, loudly: the exit code is the contract and
      // a stack on stderr is the diagnosis. Nothing is swallowed here.
      process.stderr.write(
        `agent-ping: the command failed unexpectedly (${cause instanceof Error ? cause.name : 'unknown'}): ${
          cause instanceof Error ? cause.message : String(cause)
        }\n`,
      )
      process.exitCode = EXIT_FAILED
    })
}

/** The error's class name, for a message that names the failure without dumping it. */
function nameOf(cause: unknown): string {
  return cause instanceof Error ? cause.name : 'unknown'
}

/** The error's own message: a product sentence, never a payload the hub handed us. */
function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
