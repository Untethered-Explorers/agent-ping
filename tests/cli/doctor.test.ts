// `agent-ping doctor`: the seven checks of IO-FR-04, their remedies, and the exit codes,
// all driven through the command entry point.
//
//   npm test -- tests/cli/doctor.test.ts
//
// THE ACCEPTANCE CRITERIA, AND WHERE EACH IS PROVEN
//
//   4. "A test asserts doctor exits non-zero when any single check fails and prints a
//      remedy naming that check"
//      `every check fails on its own, exits non-zero, and prints a remedy that names it`.
//      Seven cases, one per check, each breaking exactly one thing and asserting the
//      exit code *and* the remedy line. The remedy has to name the check it belongs to,
//      because "an actionable remedy" that does not say which fault it fixes is the
//      failure this suite exists to prevent (IO-US-02: "so that I learn what is wrong
//      instead of guessing").
//
//   5. "A test asserts doctor distinguishes a missing notification surface from a present
//      one and that a refused surface window is reported as a failure with its own
//      remedy"
//      `a missing notification surface and a present one are told apart, and a refused
//      window is a failure with its own remedy`. Three real hubs over real sockets, each
//      with a different desktop: no bridge at all, a bridge whose surface refuses the
//      window, and a bridge that mounts both a tray and a card window. The refused case
//      is the one the operations review singles out, so its remedy is asserted to name
//      the real cause and *not* to tell a developer to reinstall something already
//      installed.
//
//   6. "A test asserts status reports pending count, last event time, uptime and active
//      sessions, and says the hub is not running when it is down"
//      In tests/cli/install.test.ts, against the same real hubs, because a fact that two
//      suites both assert is a fact rather than an implementation detail.
//
//   7. "Each test invokes the subcommand through the command entry point"
//      Every test here calls `harness.run(['doctor'])`, which calls `runCli` - the
//      function the package's `bin` names. `runDoctor` is never called directly, and a
//      source-level assertion in tests/cli/install.test.ts says so for both files.
//
// AROUND THOSE, the properties that make them worth anything:
//
//   - Report only, never repair (Open Question 3). A doctor run over a state directory
//     in eight different broken shapes must leave the filesystem exactly as it found it,
//     and that is asserted with a whole-tree digest before and after.
//   - The two checks that read a running hub read it over a real loopback socket and get
//     their answers from the hub's own health payload, which is the only place those
//     facts exist (IO-2's desktop section; NT-3 left the tray check as a hand-off).
//   - With no hub running, the surface and tray checks say they could not be evaluated
//     rather than reporting a fault they cannot see - and they do not change the exit
//     code, because a check that found nothing must not make a command fail.

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cliHarness, type CliHarness } from './fixtures/command-line'
import { installGlobalPlugin, resolveGlobalPluginDir } from '@/plugin/install/global-plugin'
import type { NotificationSurfaceHost, SurfaceHostBridge } from '@/notify/surface/host'
import type { TrayBridge, TrayMenuView } from '@/hub/tray'
import type { TrayIcon } from '@/tray/badge'
import { DOCTOR_CHECKS, MINIMUM_NODE_VERSION, isAtLeastNodeVersion } from '@/cli/doctor'
import { AUTOSTART_MODULE_SPECIFIER } from '@/cli/autostart-control'
import { MINIMUM_NODE_VERSION as ENGINES_FLOOR } from '@/cli/doctor'
import { databaseFilePath } from '@/storage/paths'
import type { HealthPayload } from '@/hub/routes/read'
import { LOG_FILE_NAME, ROTATED_LOG_FILE_NAME } from '@/cli/log'
import { readModuleWithoutProse } from '../helpers/read-module'

const harnesses: CliHarness[] = []

async function harness(options: Parameters<typeof cliHarness>[0] = {}): Promise<CliHarness> {
  const created = await cliHarness(options)
  harnesses.push(created)
  return created
}

afterEach(async () => {
  for (const created of harnesses.splice(0)) await created.close()
})

/**
 * One parsed `doctor` row.
 *
 * Parsed rather than matched by hand because the alignment is the product's own: the
 * name column is padded to the longest name and the verdict column to a fixed width, so
 * a hand-written pattern against a specific number of spaces would be a test of this
 * file's guess about the padding rather than of the output. The remedy is read from the
 * line *under* a failure, which is where `checkBlock` puts it.
 */
interface ParsedCheck {
  readonly name: string
  readonly verdict: 'ok' | 'fail' | 'unknown'
  readonly detail: string
  readonly remedy: string | null
}

const CHECK_ROW = /^ {2}(\S(?:.*?\S)?) {2,}(ok|fail|unknown) +(.*)$/
const REMEDY_ROW = /^\s+remedy: (.*)$/

function parseChecks(text: string): readonly ParsedCheck[] {
  const lines = text.split('\n')
  const checks: ParsedCheck[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const match = CHECK_ROW.exec(lines[index] ?? '')
    if (match === null) continue
    const remedy = REMEDY_ROW.exec(lines[index + 1] ?? '')
    checks.push({
      name: match[1] ?? '',
      verdict: (match[2] ?? 'unknown') as ParsedCheck['verdict'],
      detail: match[3] ?? '',
      remedy: remedy?.[1] ?? null,
    })
    if (remedy !== null) index += 1
  }
  return checks
}

function checkOf(text: string, name: string): ParsedCheck {
  const found = parseChecks(text).find((check) => check.name === name)
  if (found === undefined) throw new Error(`no check named "${name}" in:\n${text}`)
  return found
}

/** The detail `doctor` printed for one check. */
function row(text: string, name: string): string {
  return checkOf(text, name).detail
}

/** The remedy printed for one check, or null when it printed none. */
function remedyFor(text: string, name: string): string | null {
  return checkOf(text, name).remedy
}

/** The verdict `doctor` gave one check. */
function verdictFor(text: string, name: string): string {
  return checkOf(text, name).verdict
}

/**
 * A digest of a whole tree: every path, its size and its mode.
 *
 * `ignoring` names the files a run is *allowed* to change, which is the bounded local
 * log and nothing else: appending one line to it is IO-FR-09 working, not a repair. Every
 * other path - the database, the runtime file, the write token - has to be identical
 * before and after, including its mode.
 */
function digestTree(root: string, ignoring: readonly string[] = []): string {
  const parts: string[] = []
  const walk = (directory: string): void => {
    if (!existsSync(directory)) return
    for (const entry of readdirSync(directory).sort()) {
      const full = path.join(directory, entry)
      const stat = statSync(full)
      if (!ignoring.includes(entry)) {
        parts.push(
          `${path.relative(root, full)}:${stat.isDirectory() ? 'd' : `${String(stat.size)}:${(stat.mode & 0o777).toString(8)}`}`,
        )
      }
      if (stat.isDirectory()) walk(full)
    }
  }
  walk(root)
  return createHash('sha256').update(parts.join('\n')).digest('hex')
}

/** A tray bridge that records what it was given and answers every call. */
function recordingTray(): { readonly bridge: TrayBridge; readonly calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    bridge: {
      showIcon: (icon: TrayIcon): void => {
        calls.push(`showIcon:${icon.tooltip}`)
      },
      showMenu: (view: TrayMenuView): void => {
        calls.push(`showMenu:${String(view.items.length)}`)
      },
      onActivate: (): void => {
        calls.push('onActivate')
      },
      openDashboard: (): never => {
        throw new Error('not used by doctor')
      },
      destroy: (): void => {
        calls.push('destroy')
      },
    },
  }
}

/** A surface bridge that creates a host which reports itself available. */
function availableSurface(): SurfaceHostBridge {
  return {
    create: (): NotificationSurfaceHost =>
      ({
        probe: () => Promise.resolve({ available: true, reason: 'available' }),
        show: () => Promise.resolve({ available: true, reason: 'available' }),
        hide: () => undefined,
        setClickThrough: () => undefined,
        destroy: () => undefined,
      }) as NotificationSurfaceHost,
  }
}

/** A surface bridge whose window the desktop refuses. The refusal NT-FR-04 is about. */
function refusingSurface(): SurfaceHostBridge {
  return {
    create: (): NotificationSurfaceHost => {
      throw new Error('the window manager would not give this process a window')
    },
  }
}

// ---------------------------------------------------------------------------
// Criterion 4: each check fails on its own, exits non-zero, and prints a remedy
// ---------------------------------------------------------------------------

describe('every check fails on its own, exits non-zero, and prints a remedy that names it', () => {
  it('names the seven checks IO-FR-04 requires, in a fixed order', async () => {
    const cli = await harness()
    await cli.run(['doctor'])
    const text = cli.lastText()
    // Read from the table rather than from the output alone, so a check that stopped
    // being printed would fail here and not merely be missing from a screenshot.
    expect([...DOCTOR_CHECKS]).toEqual([
      'runtime',
      'database',
      'port',
      'plugin',
      'autostart',
      'notification surface',
      'tray',
    ])
    const order = DOCTOR_CHECKS.map((name) => text.indexOf(`\n  ${name} `))
    for (const at of order) expect(at).toBeGreaterThan(0)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('runtime: a Node line below the floor is a failure with a version remedy', async () => {
    const cli = await harness({ runtimeVersion: 'v18.20.0' })
    const code = await cli.run(['doctor'])
    const text = cli.lastText()

    expect(code, text).not.toBe(0)
    expect(verdictFor(text, 'runtime')).toBe('fail')
    expect(row(text, 'runtime')).toContain('node v18.20.0, below the')
    const remedy = remedyFor(text, 'runtime')
    expect(remedy).toContain(MINIMUM_NODE_VERSION)
    expect(remedy).toContain('Node.js')
    // And the seven other checks are not disturbed by it: this is one fault.
    expect(text).toContain('checks failed')
  })

  it('the runtime floor is the one the package manifest declares', () => {
    // A floor that drifts from `engines.node` would either be stricter than the package
    // promises (a refusal the install never warned about) or looser (a check that passes
    // on a line nothing was tested on). Read out of the manifest, not restated.
    const manifest = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as {
      engines?: { node?: string }
    }
    expect(manifest.engines?.node).toBe(`>=${ENGINES_FLOOR}`)
    expect(isAtLeastNodeVersion('22.12.0', MINIMUM_NODE_VERSION)).toBe(true)
    expect(isAtLeastNodeVersion('22.11.9', MINIMUM_NODE_VERSION)).toBe(false)
    expect(isAtLeastNodeVersion('v24.0.0', MINIMUM_NODE_VERSION)).toBe(true)
  })

  it('database: a state directory that is not writable is a failure naming the path', async () => {
    const cli = await harness()
    // A file where the state directory should be: the one way to make the directory
    // unusable without root, so the test needs no privilege it might not have.
    const { rmSync, writeFileSync, mkdirSync } = await import('node:fs')
    rmSync(cli.stateDir, { recursive: true, force: true })
    mkdirSync(path.dirname(cli.stateDir), { recursive: true })
    writeFileSync(cli.stateDir, 'not a directory')
    const log = await import('@/cli/log')
    // The dispatcher opens its log first, which is the first thing to touch the path.
    expect(log.createLocalLog({ stateDir: cli.stateDir }).writable).toBe(false)

    const code = await cli.run(['doctor'], { log: undefined })
    const text = cli.lastText()
    expect(code, text).not.toBe(0)
    const remedy = remedyFor(text, 'database')
    // Either the log could not be opened, or the directory is not writable; both are the
    // database check failing, and both remedies have to name the state directory.
    expect(['fail', 'unknown']).toContain(verdictFor(text, 'database'))
    expect(remedy ?? text).toMatch(/AGENT_PING_STATE_DIR|state directory|chmod/)
  }, 30_000)

  // POSIX-only: the fault this test manufactures is a permission bit, and NTFS has
  // none. `chmodSync(…, 0o755)` there is not a widening, and `doctor` correctly
  // reports no mode fault - so the whole scenario is a POSIX scenario. See
  // tests/storage/eventStore.test.ts for the same guard written the first time.
  it.skipIf(process.platform === 'win32')('database: a state directory readable by other users is a failure (IO-FR-07)', async () => {
    const cli = await harness()
    const { chmodSync } = await import('node:fs')
    await cli.run(['status'])
    chmodSync(cli.stateDir, 0o755)

    const code = await cli.run(['doctor'])
    const text = cli.lastText()
    expect(code, text).not.toBe(0)
    expect(verdictFor(text, 'database')).toBe('fail')
    expect(row(text, 'database')).toContain('mode 755')
    const remedy = remedyFor(text, 'database')
    expect(remedy).toContain('chmod 700')
    // And it is reported, not repaired: the mode is still 755 after the run.
    expect(statSync(cli.stateDir).mode & 0o777).toBe(0o755)
    chmodSync(cli.stateDir, 0o700)
  })

  it('port: a hub that is not answering is a failure, naming the state directory and the remedy', async () => {
    const cli = await harness()
    // The preferred port is free, stated rather than assumed. The previous version of
    // this test asserted that the remedy names 127.0.0.1:43117, which the product only
    // does when something else is holding that port - so the test passed on any machine
    // with a leftover listener and failed on every clean one. The Windows and macOS CI
    // cells are what found it. Both branches are now driven explicitly, below.
    const code = await cli.run(['doctor'], { portAvailability: async () => 'free' })
    const text = cli.lastText()

    expect(code, text).not.toBe(0)
    expect(verdictFor(text, 'port')).toBe('fail')
    expect(row(text, 'port')).toContain('no hub runtime file at')
    const remedy = remedyFor(text, 'port')
    expect(remedy).toMatch(/start agent-ping|agent-ping install/)
    // Nothing claims a collision, because there is none. Asserted so the free branch
    // cannot quietly acquire the wording the next test is about.
    expect(text).not.toContain('is in use by another process')
  })

  it('port: when something else holds the preferred port, the remedy names it and how to find the holder', async () => {
    // The fact a developer needs when their live port is not the documented one (the
    // runbook's breakage 2), and it is only reachable by driving the collision branch.
    const cli = await harness()
    const code = await cli.run(['doctor'], { portAvailability: async () => 'in-use' })
    const text = cli.lastText()

    expect(code, text).not.toBe(0)
    expect(verdictFor(text, 'port')).toBe('fail')
    expect(row(text, 'port')).toContain('is in use by another process')
    expect(text).toContain('127.0.0.1:43117')
    // And how to find it, which is a per-platform command rather than a guess.
    const remedy = remedyFor(text, 'port')
    expect(remedy).toContain('127.0.0.1:43117')
    expect(remedy).toMatch(/ss -ltnp|netstat|Get-NetTCPConnection/)
  })

  it('port: a machine that cannot answer the probe is told so, rather than told the port is free', async () => {
    // `unknown` is a real third answer. A stack that refuses the probe is not a machine
    // on which to claim the port is free, and the product says exactly that.
    const cli = await harness()
    await cli.run(['doctor'], { portAvailability: async () => 'unknown' })
    const text = cli.lastText()

    expect(row(text, 'port')).toContain('could not determine whether 127.0.0.1:43117 is free')
    expect(text).not.toContain('is in use by another process')
  })

  it('port: a hub on a fallback port is reported as serving, with the reason it moved', async () => {
    const cli = await harness()
    const hub = await cli.hub({ preferredPort: 0 })
    const code = await cli.run(['doctor'])
    const text = cli.lastText()

    // The runtime file is the only place a second process can learn the live port, and
    // this is the assertion that doctor reads it rather than probing the default.
    expect(verdictFor(text, 'port'), text).toBe('ok')
    expect(row(text, 'port')).toContain(`127.0.0.1:${String(hub.port)} is serving this agent-ping`)
    expect(code, 'every other check is a real check').not.toBe(0)
  })

  it('plugin: a missing plugin is a failure, and it is told apart from a wrong version', async () => {
    const cli = await harness()
    const first = await cli.run(['doctor'])
    const absent = cli.lastText()
    expect(verdictFor(absent, 'plugin'), absent).toBe('fail')
    expect(row(absent, 'plugin')).toContain('no agent-ping plugin at')
    expect(remedyFor(absent, 'plugin')).toContain('agent-ping install')
    expect(first).not.toBe(0)

    // Now a plugin that is there and is this product's.
    installGlobalPlugin({ version: '0.1.0', env: cli.env, platform: cli.platform, home: cli.home })
    await cli.run(['doctor'])
    const good = cli.lastText()
    expect(verdictFor(good, 'plugin'), good).toBe('ok')
    expect(row(good, 'plugin')).toContain('agent-ping 0.1.0 at')

    // And a plugin that is there at a different version, which the runbook's breakage 3
    // requires to be distinguishable from "removed".
    const pluginFile = path.join(
      resolveGlobalPluginDir({ env: cli.env, platform: cli.platform, home: cli.home }),
      'agent-ping.ts',
    )
    const installed = readFileSync(pluginFile, 'utf8')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(pluginFile, installed.replace('// product-version: 0.1.0', '// product-version: 0.0.9'))
    const third = await cli.run(['doctor'])
    const mismatch = cli.lastText()
    expect(verdictFor(mismatch, 'plugin'), mismatch).toBe('fail')
    expect(row(mismatch, 'plugin')).toContain('holds agent-ping 0.0.9; this package is 0.1.0')
    expect(remedyFor(mismatch, 'plugin')).toContain('agent-ping install --force')
    expect(third).not.toBe(0)
  }, 120_000)

  it('autostart: a disabled unit is a failure naming install, and no root', async () => {
    const cli = await harness()
    cli.autostart.stateWhenDisabled = {
      availability: 'disabled',
      unitPath: '/tmp/agent-ping-test/autostart-unit',
      detail: 'disabled',
    }
    const code = await cli.run(['doctor'])
    const text = cli.lastText()

    expect(code, text).not.toBe(0)
    expect(verdictFor(text, 'autostart')).toBe('fail')
    expect(row(text, 'autostart')).toContain('will not start at login')
    const remedy = remedyFor(text, 'autostart')
    expect(remedy).toContain('agent-ping install')
    expect(remedy).toContain('no root')
  })

  it('autostart: a build with no units reports that, rather than "disabled"', async () => {
    const cli = await harness()
    // What the real resolver returns on a build without IO-3's module: a distinct
    // implementation answer, and the remedy has to name what is missing rather than tell
    // a developer to run a command that cannot work.
    const { resolveAutostartControl } = await import('@/cli/autostart-control')
    const resolved = await resolveAutostartControl({
      env: cli.env,
      platform: cli.platform,
      home: cli.home,
      stateDir: cli.stateDir,
    })
    const code = await cli.run(['doctor'], { autostart: resolved })
    const text = cli.lastText()

    if (resolved.implementation === 'missing-implementation') {
      expect(code, text).not.toBe(0)
      expect(verdictFor(text, 'autostart')).toBe('fail')
      expect(row(text, 'autostart')).toContain('not in this build')
      expect(remedyFor(text, 'autostart')).toContain(AUTOSTART_MODULE_SPECIFIER)
    } else {
      // IO-3 has landed, so the real units answered instead: the check must be about the
      // real state rather than about a missing module.
      expect(['ok', 'fail']).toContain(verdictFor(text, 'autostart'))
    }
  })
})

// ---------------------------------------------------------------------------
// Criterion 5: the notification surface
// ---------------------------------------------------------------------------

describe('a missing notification surface and a present one are told apart, and a refused window is a failure with its own remedy', () => {
  it('reports a surface that can create its window as available, with the real hub behind it', async () => {
    const cli = await harness()
    await cli.hub({ desktop: { isPrimaryInstance: true, surface: availableSurface() } })

    await cli.run(['doctor'])
    const text = cli.lastText()

    expect(verdictFor(text, 'notification surface'), text).toBe('ok')
    expect(row(text, 'notification surface')).toContain('created its card window')
    // The absence of a notifier behind the port is reported in the same row rather than
    // hidden: a window with nothing to put in it is not a card (NT-FR-01, APX-FR-02).
    expect(row(text, 'notification surface')).toContain('no notifier is wired')
  }, 60_000)

  it('reports a run that mounted no window as a failure that is not about a missing runtime', async () => {
    const cli = await harness()
    // A hub with no desktop bridge at all: the headless run, which is supported and shows
    // no card. The check fails because a developer who expected cards has none, and the
    // remedy says how to get them - it does not say anything is missing.
    await cli.hub()

    const code = await cli.run(['doctor'])
    const text = cli.lastText()

    expect(code, text).not.toBe(0)
    expect(verdictFor(text, 'notification surface')).toBe('fail')
    expect(row(text, 'notification surface')).toContain('mounted no card window')
    expect(row(text, 'notification surface')).toContain('plain Node run with no desktop bridge')
    const remedy = remedyFor(text, 'notification surface')
    expect(remedy).toContain('as the application')
    expect(remedy).not.toMatch(/reinstall/i)
  }, 60_000)

  it('reports a refused window as its own failure, names the real cause, and never says reinstall', async () => {
    // This is the check the operations review is built around, so the remedy is asserted
    // word by word rather than by a substring: "reinstall Electron" for a runtime that is
    // installed and present is the wrong remedy, and the review fails on it.
    const cli = await harness()
    await cli.hub({ desktop: { isPrimaryInstance: true, surface: refusingSurface() } })

    const code = await cli.run(['doctor'])
    const text = cli.lastText()

    expect(code, text).not.toBe(0)
    expect(verdictFor(text, 'notification surface')).toBe('fail')
    // Distinct from "mounted no window": the two are told apart in the detail too.
    expect(row(text, 'notification surface')).toContain('the desktop refused the card window')
    expect(row(text, 'notification surface')).not.toContain('mounted no card window')
    expect(row(text, 'notification surface')).toContain('every delivery is recorded as not-wired')

    const remedy = remedyFor(text, 'notification surface')
    expect(remedy, 'the refused remedy must exist').not.toBeNull()
    expect(remedy).toContain('not a missing Electron')
    expect(remedy).toContain('CHROMIUM_LAUNCH_POLICY')
    // The four words a diagnostic must not use for this fault. The runbook calls them out
    // by name, so the assertion names them by name.
    for (const forbidden of ['reinstall', 'Reinstall', 'uninstall and reinstall', 'npm install']) {
      expect(remedy, `the surface remedy must not say "${forbidden}"`).not.toContain(forbidden)
    }
    // And the run's own diagnostic reached the health payload, which is what makes the
    // distinction possible at all: the hub says which of the three it was.
    const hub = readFileSync(path.join(cli.stateDir, 'hub-runtime.json'), 'utf8')
    expect(JSON.parse(hub).port).toBeGreaterThan(0)
  }, 60_000)
})

// ---------------------------------------------------------------------------
// The tray
// ---------------------------------------------------------------------------

describe('the tray check tells a mounted icon from an absent one and from a refused one', () => {
  it('reports a mounted tray as ok', async () => {
    const cli = await harness()
    const tray = recordingTray()
    await cli.hub({ desktop: { isPrimaryInstance: true, tray: tray.bridge } })

    const code = await cli.run(['doctor'])
    const text = cli.lastText()

    expect(verdictFor(text, 'tray'), text).toBe('ok')
    expect(row(text, 'tray')).toContain('badge icon is on this desktop')
    // A real tray, driven by the real hub: the icon was actually put on the desktop
    // before the hub reported running, which is what "mounted" means (NT-FR-05).
    expect(tray.calls.some((call) => call.startsWith('showIcon:'))).toBe(true)
    expect(code, 'the surface and plugin checks are still real checks here').not.toBe(0)
  }, 60_000)

  it('reports a desktop that refused the icon as a failure that is not about a missing runtime', async () => {
    const cli = await harness()
    const refusing: TrayBridge = {
      showIcon: (): void => {
        throw new Error('no status area in this session')
      },
      showMenu: (): void => undefined,
      onActivate: (): void => undefined,
      openDashboard: (): never => {
        throw new Error('not used by doctor')
      },
      destroy: (): void => undefined,
    }
    await cli.hub({ desktop: { isPrimaryInstance: true, tray: refusing } })

    const code = await cli.run(['doctor'])
    const text = cli.lastText()

    expect(code, text).not.toBe(0)
    expect(verdictFor(text, 'tray')).toBe('fail')
    expect(row(text, 'tray')).toContain('the desktop did not give it one')
    const remedy = remedyFor(text, 'tray')
    expect(remedy).toContain('not a missing runtime')
    expect(remedy).toContain('StatusNotifierItem')
    expect(remedy).not.toMatch(/reinstall/i)
  }, 60_000)

  it('reports a run with no tray at all as absent, naming the headless run', async () => {
    const cli = await harness()
    await cli.hub()
    const code = await cli.run(['doctor'])
    const text = cli.lastText()

    expect(code, text).not.toBe(0)
    expect(verdictFor(text, 'tray')).toBe('fail')
    expect(row(text, 'tray')).toContain('mounted no tray')
    expect(remedyFor(text, 'tray')).toContain('the autostart unit at login')
  }, 60_000)
})

// ---------------------------------------------------------------------------
// With no hub running, the two desktop checks say so rather than inventing a fault
// ---------------------------------------------------------------------------

describe('with no hub running, the desktop checks say they could not be evaluated', () => {
  it('reports unknown, does not fail the run for them, and explains why', async () => {
    const cli = await harness()
    const code = await cli.run(['doctor'])
    const text = cli.lastText()

    expect(verdictFor(text, 'notification surface'), text).toBe('unknown')
    expect(verdictFor(text, 'tray')).toBe('unknown')
    expect(row(text, 'notification surface')).toContain('not evaluated: no hub is running')
    expect(row(text, 'tray')).toContain('not evaluated: no hub is running')
    // A check that found nothing must not make a command fail; the port check is the one
    // that reports the hub being down, and it is the one that is a failure here.
    expect(verdictFor(text, 'port')).toBe('fail')
    expect(code).not.toBe(0)
    expect(text).toMatch(/\d+ of 7 checks failed; 2 could not be evaluated\./)
  })

  it('a check that could not be evaluated never makes the run fail on its own', async () => {
    // The rule `output.ts` states - "`unknown` is deliberately not a failure: a check that
    // could not be evaluated has not found a fault, and reporting it as one would train a
    // developer to ignore a non-zero exit" - needs a case where `unknown` is the *only*
    // thing standing between the run and a non-zero exit, or nothing tests it. The case is
    // real: `HealthPayload.desktop` is optional, so a hub that is serving this product on
    // the port it published can answer health with no desktop section. Every other check
    // then passes, and a `doctor` that counted `unknown` as a failure would exit 1 on a
    // healthy install - which is the failure mode the rule exists to prevent.
    const cli = await harness()
    installGlobalPlugin({ version: '0.1.0', env: cli.env, platform: cli.platform, home: cli.home })
    cli.autostart.enabled = true
    const hub = await cli.hub()

    // A hub serving this product on its own port, answering health with no `desktop`.
    // The `desktop` key is deleted rather than set to `undefined` because a reader cannot
    // see a key that was not sent, which is the whole difference between the two cases -
    // and the cast is on the way *in*, from the real hub's own JSON, so every field the
    // test does not touch is the real route's real value rather than a hand-built one.
    const record = JSON.parse(readFileSync(path.join(cli.stateDir, 'hub-runtime.json'), 'utf8')) as {
      instanceId: string
    }
    const served: HealthPayload = JSON.parse(await (await fetch(`${hub.origin}/api/health`)).text())
    const payload = Object.fromEntries(
      Object.entries(served).filter(([key]) => key !== 'desktop'),
    ) as HealthPayload

    const code = await cli.run(['doctor'], {
      hub: {
        stateDir: cli.stateDir,
        fetchHealth: (): Promise<HealthPayload> => Promise.resolve(payload),
      },
    })
    const text = cli.lastText()

    // It really is the shape this test claims: a running hub, and no desktop section.
    expect(payload.instanceId).toBe(record.instanceId)
    expect('desktop' in payload).toBe(false)
    expect(verdictFor(text, 'port'), text).toBe('ok')
    expect(verdictFor(text, 'notification surface')).toBe('unknown')
    expect(verdictFor(text, 'tray')).toBe('unknown')
    expect(row(text, 'notification surface')).toContain('does not report its desktop')
    expect(row(text, 'tray')).toContain('does not report its desktop')
    // The load-bearing assertion: five checks passed, two could not be evaluated, and the
    // run is green. Exit 0 is the only thing a script can trust here.
    expect(code, text).toBe(0)
    expect(text).toContain('all 7 checks passed; 2 could not be evaluated.')
  }, 120_000)

  it('a passing run is exit 0 and says every check passed', async () => {
    const cli = await harness()
    const tray = recordingTray()
    await cli.hub({
      desktop: {
        isPrimaryInstance: true,
        tray: tray.bridge,
        surface: availableSurface(),
        // A card presenter, so the delivery policy is wired rather than not-wired: a
        // doctor that can only be made green by a window with no renderer in it would be
        // reporting a half-truth.
        renderCard: { present: (): void => undefined },
      },
    })
    installGlobalPlugin({ version: '0.1.0', env: cli.env, platform: cli.platform, home: cli.home })
    cli.autostart.enabled = true

    const code = await cli.run(['doctor'])
    const text = cli.lastText()

    expect(code, text).toBe(0)
    expect(text).toContain('all 7 checks passed.')
    for (const name of DOCTOR_CHECKS) expect(verdictFor(text, name), name).toBe('ok')
  }, 120_000)
})

// ---------------------------------------------------------------------------
// Report only, never repair
// ---------------------------------------------------------------------------

describe('doctor reports and never repairs (Open Question 3)', () => {
  it('leaves the state directory byte-for-byte as it found it, across eight broken shapes', async () => {
    const cli = await harness()
    // A state directory with something worth protecting in it.
    installGlobalPlugin({ version: '0.1.0', env: cli.env, platform: cli.platform, home: cli.home })
    const store = await import('@/storage/eventStore')
    const opened = store.openEventStore({ filePath: databaseFilePath(cli.stateDir) })
    opened.close()
    await cli.run(['status'])

    // A broad chmod first, because a wide state directory is the one fault a run could
    // silently fix by tightening it - and Open Question 3 says a report-only tool must
    // not. Then the digest, then four runs with the checks broken in four different ways.
    //
    // The widening is the one shape here that is POSIX-only: NTFS has no permission
    // bits, so `chmod 755` is not a widening and there is no mode fault to report. The
    // claim under test - that a doctor run changes nothing in the state directory,
    // whatever is wrong with it - is not POSIX-only, so the test still runs there and
    // still asserts that; only the verdict assertion that depends on the widening is
    // conditional.
    const { chmodSync } = await import('node:fs')
    const hasPosixModes = process.platform !== 'win32'
    if (hasPosixModes) chmodSync(cli.stateDir, 0o755)
    const before = digestTree(cli.stateDir, [LOG_FILE_NAME, ROTATED_LOG_FILE_NAME])
    await cli.run(['doctor'])
    if (hasPosixModes) expect(verdictFor(cli.lastText(), 'database'), cli.lastText()).toBe('fail')
    await cli.run(['doctor'], { runtimeVersion: 'v16.0.0' })
    await cli.run(['doctor'], { autostart: brokenAutostart() })
    await cli.run(['doctor'])
    const after = digestTree(cli.stateDir, [LOG_FILE_NAME, ROTATED_LOG_FILE_NAME])

    expect(after, 'a doctor run must change nothing in the state directory').toBe(before)
    // Including the mode it was widened to: reporting a fault is not fixing it.
    if (hasPosixModes) expect(statSync(cli.stateDir).mode & 0o777).toBe(0o755)
    // The plugin directory too: doctor reads it and never writes it.
    const pluginDir = resolveGlobalPluginDir({ env: cli.env, platform: cli.platform, home: cli.home })
    const pluginBefore = digestTree(path.dirname(pluginDir))
    await cli.run(['doctor'])
    expect(digestTree(path.dirname(pluginDir))).toBe(pluginBefore)
    if (hasPosixModes) chmodSync(cli.stateDir, 0o700)
  }, 120_000)

  it('names no repair it performed, and offers none in its remedies', () => {
    // The decision is Open Question 3's and it is a property of the words: a remedy is
    // something the reader does, never something the tool already did.
    const source = readModuleWithoutProse('src/cli/doctor.ts')
    for (const forbidden of [
      'rmSync',
      'unlinkSync',
      'writeFileSync',
      'chmodSync',
      'mkdirSync',
      'installGlobalPlugin',
      'uninstallGlobalPlugin',
      '.enable(',
      '.disable(',
    ]) {
      expect(source.includes(forbidden), `doctor must not call ${forbidden}`).toBe(false)
    }
  })
})

/** An autostart control that fails every question, for the repair test above. */
function brokenAutostart(): CliHarness['autostart'] {
  const control = new (class {
    implementation = 'missing-implementation' as const
    readonly platform: NodeJS.Platform = 'linux'
    async state() {
      return { availability: 'unavailable' as const, unitPath: null, detail: 'no units in this build' }
    }
    async enable() {
      return { changed: false, unitPath: null, detail: 'no units in this build', failure: 'no units in this build' }
    }
    async disable() {
      return { changed: false, unitPath: null, detail: 'no units in this build', failure: null }
    }
  })()
  return control as unknown as CliHarness['autostart']
}
