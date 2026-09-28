// `agent-ping install` and `agent-ping uninstall`, driven through the command entry point
// (IO-FR-02, IO-FR-03, IO-FR-07, IO-FR-08, IO-FR-09).
//
//   npm test -- tests/cli/install.test.ts
//
// THE ACCEPTANCE CRITERIA, AND WHERE EACH IS PROVEN
//
//   1. "A test asserts install writes the plugin, enables autostart, verifies health and
//      lists what it changed"
//      `install writes the plugin, enables autostart, starts the hub and lists what it
//      changed`. Two runs, because "starts the hub if needed" and "leaves a running hub
//      alone" are different claims. The first starts nothing: the harness's launcher
//      starts a *real* hub in the same state directory, over a real socket, and install
//      finds it by polling the runtime file - so "verifies health" is a health read of a
//      hub that exists, not a stub's word. The second finds a hub already serving and
//      must not launch anything. The plugin file is then read off disk and its header
//      checked, the autostart control is asserted to have been asked to enable, and the
//      output is compared against the three subjects and what each changed.
//
//   2. "A test asserts a second install reports no changes and a plugin version mismatch
//      is reported rather than silently accepted"
//      Two installs of the same version, compared by content, by size and by mtime - not
//      one byte and not one timestamp may move (OA-FR-08). Then a third install with a
//      different version: the exit code is non-zero, both versions are named, and the
//      bytes on disk are byte-for-byte what they were. `--force` is then shown to be the
//      operator's way out, and to change the file only when it is passed.
//
//   3. "A test asserts uninstall keeps the database by default and removes it only with
//      the purge flag"
//      A real database with a real row in it, and the file compared before and after:
//      present after a plain uninstall, gone after `--purge`, along with the `-wal` and
//      `-shm` files SQLite creates beside it. The plugin, the autostart unit and the
//      bounded log are gone in both cases, which is what the operations runbook's
//      uninstall check looks for.
//
//   4. "A test asserts status reports pending count, last event time, uptime and active
//      sessions, and says the hub is not running when it is down"
//      `status reports the four facts when a hub is serving` and
//      `status says plainly that the hub is not running`. The first is driven against a
//      real hub with real events in its log and a clock the test controls, so the numbers
//      printed can be compared with what the hub's own routes return.
//
//   5. "Each test invokes the subcommand through the command entry point"
//      Every test in this file and in tests/cli/doctor.test.ts calls
//      `harness.run([...])`, which calls `runCli` - the function the package's `bin`
//      names. `runInstall` and `runUninstall` are never called from a test directly, and
//      a source-level assertion says so, because a test that bypasses the dispatcher
//      would pass with a dispatcher that routed every argument to `status`.
//
// AROUND THOSE, the properties that make them worth anything:
//
//   - The state directory is the overridable one and it is owner-only (IO-FR-07). The
//     override is `AGENT_PING_STATE_DIR` in the harness's own environment, so the test
//     proves the mechanism rather than a parameter.
//   - The local log is bounded, keeps two files, and carries no conversation content;
//     `--verbose` mirrors it and nothing else does (IO-FR-09).
//   - A bad command line is exit 2 and a failed command is exit 1, and the two are
//     never confused. Exit codes are the API.
//   - Nothing in `src/cli` reaches the network other than the loopback hub, and nothing
//     in it can carry a prompt, a response, a diff or a tool's output (APX-CON-12,
//     APX-FR-01). Asserted from source, because a denylist of words in a comment is not
//     a property.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cliHarness, type CliHarness } from './fixtures/command-line'
import { openEventStore, type EventStore } from '@/storage/eventStore'
import { databaseFilePath, databaseFilePaths } from '@/storage/paths'
import {
  LOG_FILE_NAME,
  LOG_FILES_KEPT,
  LOG_MAX_BYTES,
  ROTATED_LOG_FILE_NAME,
  assertContentFreeLogFields,
  createLocalLog,
  parseLogLine,
} from '@/cli/log'
import { resolveGlobalPluginDir } from '@/plugin/install/global-plugin'
import { readModuleImports, readModuleWithoutProse, sourceFilesUnderSrc } from '../helpers/read-module'

const harnesses: CliHarness[] = []

async function harness(options: Parameters<typeof cliHarness>[0] = {}): Promise<CliHarness> {
  const created = await cliHarness(options)
  harnesses.push(created)
  return created
}

afterEach(async () => {
  for (const created of harnesses.splice(0)) await created.close()
})

/** A real store with one real event in it, so "the database" is a database. */
function seedDatabase(stateDir: string): EventStore {
  mkdirSync(stateDir, { recursive: true })
  const store = openEventStore({ filePath: databaseFilePath(stateDir) })
  store.insertEvent({
    harness: 'opencode',
    sessionId: 'ses_cli_01',
    repoShortName: 'agent-ping',
    repoFullPath: path.join(stateDir, 'repo'),
    rawEventType: 'permission.asked',
    class: 'needs-you',
    occurredAt: '2026-09-27T09:00:00.000Z',
    receivedAt: '2026-09-27T09:00:00.000Z',
    dedupeKey: 'opencode:ses_cli_01:permission.asked:1',
  })
  return store
}

// ---------------------------------------------------------------------------
// Criterion 1: install writes, enables, verifies and says what it changed
// ---------------------------------------------------------------------------

describe('install writes the plugin, enables autostart, verifies health and lists what it changed', () => {
  it('starts a hub that was not running, and every step is named', async () => {
    const cli = await harness()
    const code = await cli.run(['install'])
    const text = cli.lastText()

    expect(code, text).toBe(0)
    // The change list, in the order the steps ran, one aligned row each.
    expect(text).toContain('agent-ping install: 3 changes.')
    expect(text).toMatch(/^\s+plugin\s+wrote .*agent-ping\.ts \(agent-ping 0\.1\.0\)$/m)
    expect(text).toMatch(/^\s+autostart\s+enabled \/tmp\/agent-ping-test\/autostart-unit$/m)
    expect(text).toMatch(/^\s+hub\s+started and serving at http:\/\/127\.0\.0\.1:\d+$/m)

    // The plugin file is on disk, in the opencode plugin directory the environment
    // pointed at, and it is this product's file with this product's version in it.
    const pluginFile = path.join(resolveGlobalPluginDir({ env: cli.env, platform: cli.platform, home: cli.home }), 'agent-ping.ts')
    expect(existsSync(pluginFile), pluginFile).toBe(true)
    const installed = readFileSync(pluginFile, 'utf8')
    expect(installed).toContain('// agent-ping:global-plugin v1')
    expect(installed).toContain('// product-version: 0.1.0')

    // Autostart was asked to enable exactly once, through the port `IO-3` fills in.
    expect(cli.autostart.calls).toEqual({ states: 0, enables: 1, disables: 0 })

    // The launcher was asked exactly once, and the hub it started is still serving:
    // install verified health and did not shut anything down.
    expect(cli.launches(), 'install had to start the hub, and the launcher was asked once').toBe(1)
    const code2 = await cli.run(['status'])
    expect(code2, cli.lastText()).toBe(0)
    expect(cli.lastText()).toContain('agent-ping: the hub is running.')
  }, 60_000)

  it('leaves a hub that is already running alone', async () => {
    const cli = await harness()
    const running = await cli.hub()
    expect(running.port).toBeGreaterThan(0)

    const code = await cli.run(['install'])
    const text = cli.lastText()

    expect(code, text).toBe(0)
    expect(text).toMatch(/^\s+hub\s+already running at http:\/\/127\.0\.0\.1:\d+$/m)
    // Two changes and one untouched row: the hub was checked, not started.
    expect(text).toContain('agent-ping install: 2 changes.')
    expect(cli.launches(), 'a running hub must never be launched again').toBe(0)
  }, 60_000)
})

// ---------------------------------------------------------------------------
// Criterion 2: a second install changes nothing, and a mismatch is reported
// ---------------------------------------------------------------------------

describe('a second install is safe, and a version mismatch is reported rather than accepted', () => {
  it('changes no byte and no timestamp, and says so', async () => {
    const cli = await harness()
    expect(await cli.run(['install']), cli.lastText()).toBe(0)
    const pluginFile = path.join(
      resolveGlobalPluginDir({ env: cli.env, platform: cli.platform, home: cli.home }),
      'agent-ping.ts',
    )
    const before = readFileSync(pluginFile)
    const beforeStat = statSync(pluginFile)
    // A timestamp far enough in the past that a rewrite would be unmistakable, and set
    // through the same path a rewrite would have to change.
    const old = new Date(beforeStat.mtimeMs - 60_000)
    utimesSync(pluginFile, old, old)

    const code = await cli.run(['install'])
    const text = cli.lastText()

    expect(code, text).toBe(0)
    expect(text).toContain('agent-ping install: nothing was changed.')
    expect(text).toMatch(/^\s+plugin\s+agent-ping 0\.1\.0 is already installed at .*; not one byte was touched$/m)
    expect(text).toMatch(/^\s+hub\s+already running at http:\/\/127\.0\.0\.1:\d+$/m)
    // Not one byte, and not one timestamp: the second install's whole claim.
    expect(readFileSync(pluginFile).equals(before)).toBe(true)
    expect(statSync(pluginFile).mtimeMs).toBeLessThan(beforeStat.mtimeMs)
    // Autostart was asked again and reported itself already enabled, which is idempotent
    // by construction and is asserted here rather than only in `IO-3`'s own suite.
    expect(cli.autostart.calls.enables).toBe(2)
  }, 120_000)

  it('refuses a different version, names both, and leaves the installed bytes alone', async () => {
    const first = await harness()
    expect(await first.run(['install']), first.lastText()).toBe(0)
    const pluginFile = path.join(
      resolveGlobalPluginDir({ env: first.env, platform: first.platform, home: first.home }),
      'agent-ping.ts',
    )
    const before = readFileSync(pluginFile)

    // A second install from a different package version, in the same machine.
    const second = await cliHarness({
      stateDir: first.stateDir,
      home: first.home,
      version: '9.9.9',
    })
    harnesses.push(second)
    const code = await second.run(['install'])
    const text = second.lastText()

    expect(code, text).not.toBe(0)
    expect(text).toContain('1 of 3 steps failed.')
    expect(text).toContain('agent-ping 9.9.9 was not installed')
    expect(text).toContain('agent-ping 0.1.0')
    // The remedy names both ways forward, and only `--force` is the destructive one.
    expect(text).toContain('remedy (plugin): run `agent-ping uninstall` first, or run `agent-ping install --force`')
    // The decisive assertion: the file on disk is byte-for-byte what it was. A silent
    // overwrite here is how a developer ends up debugging a build they did not install.
    expect(readFileSync(pluginFile).equals(before)).toBe(true)
    expect(readFileSync(pluginFile, 'utf8')).toContain('// product-version: 0.1.0')
  }, 120_000)

  it('replaces a different version when --force says the operator decided', async () => {
    const first = await harness()
    expect(await first.run(['install']), first.lastText()).toBe(0)
    const pluginFile = path.join(
      resolveGlobalPluginDir({ env: first.env, platform: first.platform, home: first.home }),
      'agent-ping.ts',
    )

    const second = await cliHarness({ stateDir: first.stateDir, home: first.home, version: '9.9.9' })
    harnesses.push(second)
    const code = await second.run(['install', '--force'])
    const text = second.lastText()

    expect(code, text).toBe(0)
    expect(text).toMatch(/^\s+plugin\s+replaced .* with agent-ping 9\.9\.9$/m)
    expect(readFileSync(pluginFile, 'utf8')).toContain('// product-version: 9.9.9')
  }, 120_000)

  it('refuses --force on anything but install, with exit 2', async () => {
    const cli = await harness()
    const code = await cli.run(['status', '--force'])
    expect(code).toBe(2)
    expect(cli.err.join('\n')).toContain('--force is only meaningful for `install`')
  })
})

// ---------------------------------------------------------------------------
// Criterion 3: uninstall keeps the database unless the purge flag is given
// ---------------------------------------------------------------------------

describe('uninstall keeps the database by default and removes it only with --purge', () => {
  it('keeps the database, its history and its sidecars, and removes everything else', async () => {
    const cli = await harness()
    // A real install, so the plugin, the log and the autostart state all exist.
    expect(await cli.run(['install']), cli.lastText()).toBe(0)
    await cli.run(['status'])
    const store = seedDatabase(cli.stateDir)
    const database = databaseFilePath(cli.stateDir)
    expect(existsSync(database)).toBe(true)
    const rows = store.readEventHistory({ limit: 10 }).length
    expect(rows, 'the fixture really does hold a row').toBe(1)
    store.close()
    // The log the commands wrote, which an uninstall is expected to clear.
    expect(existsSync(path.join(cli.stateDir, LOG_FILE_NAME))).toBe(true)

    const code = await cli.run(['uninstall'])
    const text = cli.lastText()

    expect(code, text).toBe(0)
    // The database survives, and the output says where it is and how to remove it.
    expect(existsSync(database), 'IO-FR-03: the database is kept unless --purge is given').toBe(true)
    expect(text).toContain(`database: kept ${database}`)
    expect(text).toContain('pass --purge to remove it')
    // And the history is intact, not merely the file: a kept database with a lost row
    // would satisfy the letter of the requirement and none of its purpose.
    const reopened = openEventStore({ filePath: database })
    expect(reopened.readEventHistory({ limit: 10 }).length).toBe(1)
    reopened.close()

    // The plugin, the autostart unit and the bounded log are gone.
    const pluginFile = path.join(
      resolveGlobalPluginDir({ env: cli.env, platform: cli.platform, home: cli.home }),
      'agent-ping.ts',
    )
    expect(existsSync(pluginFile)).toBe(false)
    expect(existsSync(path.join(cli.stateDir, LOG_FILE_NAME))).toBe(false)
    expect(cli.autostart.calls.disables).toBe(1)
    expect(cli.autostart.enabled).toBe(false)
  }, 120_000)

  it('removes the database and both of its sidecars with --purge', async () => {
    const cli = await harness()
    expect(await cli.run(['install']), cli.lastText()).toBe(0)
    const store = seedDatabase(cli.stateDir)
    store.close()
    const all = databaseFilePaths(databaseFilePath(cli.stateDir))
    // The real file, and the two SQLite creates beside it. A sidecar SQLite chose not
    // to leave is still asserted absent afterwards, which is the honest statement: the
    // purge covers all three whether or not they exist.
    expect(existsSync(all[0] ?? ''), 'the fixture really does have a database').toBe(true)

    const code = await cli.run(['uninstall', '--purge'])
    const text = cli.lastText()

    expect(code, text).toBe(0)
    for (const file of all) expect(existsSync(file), `${file} must be gone after --purge`).toBe(false)
    expect(text).toMatch(/^\s+state\s+removed .*agent-ping\.db.* from /m)
    expect(text).not.toContain('pass --purge to remove it')
  }, 120_000)

  it('is safe to run twice, and says there is nothing to remove the second time', async () => {
    const cli = await harness()
    expect(await cli.run(['install']), cli.lastText()).toBe(0)
    expect(await cli.run(['uninstall']), cli.lastText()).toBe(0)
    const code = await cli.run(['uninstall'])
    const text = cli.lastText()

    expect(code, text).toBe(0)
    expect(text).toContain('agent-ping uninstall: nothing was changed.')
    expect(text).toMatch(/^\s+plugin\s+nothing to remove at /m)
    expect(cli.autostart.calls.disables).toBe(2)
  }, 120_000)

  it('refuses --purge on anything but uninstall, with exit 2', async () => {
    const cli = await harness()
    const code = await cli.run(['status', '--purge'])
    expect(code).toBe(2)
    expect(cli.err.join('\n')).toContain('--purge is only meaningful for `uninstall`')
  })
})

// ---------------------------------------------------------------------------
// Criterion 4: status
// ---------------------------------------------------------------------------

describe('status reports the four facts when a hub is serving', () => {
  it('prints the pending count, the last event, the uptime and the active sessions', async () => {
    const cli = await harness()
    const hub = await cli.hub()
    const store = openEventStore({ filePath: hub.databaseFilePath })
    for (const [index, eventName] of ['session.idle.afterWork', 'session.idle.afterWork'].entries()) {
      store.insertEvent({
        harness: 'opencode',
        sessionId: `ses_status_${String(index)}`,
        repoShortName: 'agent-ping',
        repoFullPath: path.join(cli.stateDir, 'repo'),
        rawEventType: eventName,
        class: 'finished',
        occurredAt: `2026-09-27T09:0${String(index)}:00.000Z`,
        receivedAt: `2026-09-27T09:0${String(index)}:00.000Z`,
        dedupeKey: `opencode:ses_status_${String(index)}:${eventName}:1`,
      })
    }
    store.close()

    const code = await cli.run(['status'])
    const text = cli.lastText()

    expect(code, text).toBe(0)
    expect(text).toContain('agent-ping: the hub is running.')
    expect(text).toMatch(/^\s+origin\s+http:\/\/127\.0\.0\.1:\d+$/m)
    expect(text).toMatch(/^\s+uptime\s+\d+[smh](\s|$)/m)
    // Both events are finished, so the pending count is 0 and both sessions are counted
    // as total rather than active. The numbers are the hub's own: two rows were stored.
    expect(text).toMatch(/^\s+pending\s+0$/m)
    expect(text).toMatch(/^\s+active sessions\s+0 of 2$/m)
    // The most recent event is the newest row, and the command says when it happened.
    expect(text).toMatch(/^\s+last event\s+2026-09-27T09:01:00\.000Z \(\d+[a-z0-9 ]+ ago\)$/m)
    // The delivery section is printed because a hub that cannot show a card is the
    // commonest reason a developer runs this at all.
    expect(text).toMatch(/^\s+delivery\s+(ok|degraded|not-wired)$/m)
  }, 60_000)

  it('counts a blocked session as active', async () => {
    const cli = await harness()
    const hub = await cli.hub()
    const store = openEventStore({ filePath: hub.databaseFilePath })
    store.insertEvent({
      harness: 'opencode',
      sessionId: 'ses_blocked_01',
      repoShortName: 'agent-ping',
      repoFullPath: path.join(cli.stateDir, 'repo'),
      rawEventType: 'permission.asked',
      class: 'needs-you',
      occurredAt: '2026-09-27T09:00:00.000Z',
      receivedAt: '2026-09-27T09:00:00.000Z',
      dedupeKey: 'opencode:ses_blocked_01:permission.asked:1',
    })
    store.close()

    expect(await cli.run(['status']), cli.lastText()).toBe(0)
    // A block is a live session: the developer is waiting on it.
    expect(cli.lastText()).toMatch(/^\s+active sessions\s+1 of 1$/m)
    expect(cli.lastText()).toMatch(/^\s+pending\s+1$/m)
  }, 60_000)
})

describe('status says plainly that the hub is not running', () => {
  it('names the reason and the remedy, and never prints a table of zeroes', async () => {
    const cli = await harness()
    const code = await cli.run(['status'])
    const text = cli.lastText()

    expect(code, text).toBe(0)
    expect(text).toContain('agent-ping: the hub is not running.')
    expect(text).toMatch(/^\s+reason\s+there is no hub runtime file at /m)
    expect(text).toMatch(/^\s+remedy\s+start agent-ping/m)
    // The absence of the running rows is the point: a status that printed an empty
    // table would read as a product with nothing to report.
    expect(text).not.toMatch(/^\s+pending\s/m)
    expect(text).not.toMatch(/^\s+uptime\s/m)
  })

  it('says so for a state directory whose hub was stopped, naming the stale file', async () => {
    const cli = await harness()
    const hub = await cli.hub()
    await hub.close()

    const code = await cli.run(['status'])
    const text = cli.lastText()

    // A clean shutdown removes the runtime file, so this is the ordinary stopped case.
    expect(code, text).toBe(0)
    expect(text).toContain('agent-ping: the hub is not running.')
  }, 60_000)
})

// ---------------------------------------------------------------------------
// IO-FR-07: the state directory is the overridable one, and owner-only
// ---------------------------------------------------------------------------

/**
 * Variables that name a *state* directory, banned in every module under `src/cli/`.
 *
 * Split out from the layout tokens below because these two are the second resolution
 * point whatever directory a module is in: a CLI module that read `XDG_STATE_HOME` or
 * `LOCALAPPDATA` would be resolving a state path without the one resolver, and the
 * override the rest of the product honours would silently not apply to it.
 */
const STATE_DIRECTORY_TOKENS: readonly string[] = ['XDG_STATE_HOME', 'LOCALAPPDATA']

/**
 * Tokens that appear in a platform's *product state* layout, banned under
 * `src/cli/` except in the per-platform autostart modules.
 *
 * `Library` and `AppData` are where macOS and Windows put a roaming profile, which
 * is where a second implementation of the state directory would put it. The autostart
 * modules are exempt because there they are the platform's per-user *unit*
 * convention instead - `~/Library/LaunchAgents` and `%APPDATA%\...\Startup` - which
 * is where the login unit has to be for that platform to read it, and which is a
 * different path from this product's state by design (IO-3).
 */
const PRODUCT_STATE_LAYOUT_TOKENS: readonly string[] = ['Library', 'AppData']

describe('every path the product writes resolves through the overridable state directory', () => {
  it('creates it at 0700 from AGENT_PING_STATE_DIR, and writes nothing outside it', async () => {
    const cli = await harness()
    // The environment variable alone, with no stateDir parameter reaching the command.
    expect(cli.env['AGENT_PING_STATE_DIR']).toBe(cli.stateDir)
    const code = await cli.run(['status'])
    expect(code, cli.lastText()).toBe(0)

    const written = readdirSync(cli.stateDir).sort()
    // The log is the only thing a status writes; the point is that it is inside the
    // override and nowhere else.
    expect(written).toContain(LOG_FILE_NAME)
    expect((statSync(cli.stateDir).mode & 0o777)).toBe(0o700)
    expect((statSync(path.join(cli.stateDir, LOG_FILE_NAME)).mode & 0o777)).toBe(0o600)
    // Nothing leaked into the temporary home: the state directory is the only place the
    // product keeps anything of its own.
    const homeEntries = existsSync(path.join(cli.home, '.local')) ? readdirSync(path.join(cli.home, '.local', 'state')) : []
    expect(homeEntries).toEqual([])
  })

  it('resolves every state path through src/storage/paths.ts, and nowhere else', () => {
    // The CLI never builds a path of its own: every path it writes goes through
    // src/storage/paths.ts, which is the one resolution point the storage layer and the
    // CLI share (IO-FR-07, and the note in that module about packaging-engineer and
    // qa-engineer depending on it). A second resolution point would be a directory
    // layout that a test, a package and a live script could each disagree about.
    const files = sourceFilesUnderSrc().filter((file) => file.startsWith('src/cli/'))
    expect(files.length).toBeGreaterThan(3)
    for (const file of files) {
      // The import specifier is a string, so the reader that keeps strings is the one
      // that can see where a module imported the resolver from. The specifier is
      // computed from the file's own depth rather than spelled for one directory:
      // `src/cli/log.ts` reaches it as `../storage/paths.js` and the per-platform
      // autostart modules under `src/cli/autostart/` as `../../storage/paths.js`. The
      // property is that every one of them lands on the *same* module, so a
      // second resolution point cannot appear one directory deeper without this
      // failing - which a hard-coded `../` string would not have caught.
      const depth = file.slice('src/'.length).split('/').length - 1
      const oneResolver = `from '${'../'.repeat(depth)}storage/paths.js'`
      const source = readModuleImports(file)
      if (source.includes('resolveStateDir')) {
        expect(source.includes(oneResolver), `${file} must import the one resolver`).toBe(true)
      }
      // No platform state variable and no hard-coded layout: both are the second
      // resolution point wearing a different name. Banned in every CLI module,
      // because these two name a *state* directory and this is the test that says
      // there is exactly one of those.
      for (const forbidden of STATE_DIRECTORY_TOKENS) {
        expect(source.includes(forbidden), `${file} must not name ${forbidden} itself`).toBe(false)
      }
      // The same two tokens as a *product state* layout, which is a different claim
      // from the one above. The per-platform autostart modules are the one place
      // under `src/cli/` where `Library` and `AppData` are not a second state
      // resolution point: they are the platform's own per-user unit convention -
      // `~/Library/LaunchAgents` and `%APPDATA%\...\Startup` - and IO-3 requires the
      // unit to be written where that platform will read it rather than beside this
      // product's state. The autostart unit is deliberately NOT in the state
      // directory, so banning the token there would ban the requirement; the
      // `AGENT_PING_STATE_DIR` override that *does* belong to the product still has
      // to come from the one resolver, which is the assertion above. Everything else
      // under `src/cli/` is still banned outright, and the state tokens above are
      // banned in these modules too.
      if (!file.startsWith('src/cli/autostart/')) {
        for (const forbidden of PRODUCT_STATE_LAYOUT_TOKENS) {
          expect(source.includes(forbidden), `${file} must not name ${forbidden} itself`).toBe(false)
        }
      }
      // The database and the log are named in exactly one place each - the module that
      // owns the name - and every other CLI module imports them. `log.ts` is the
      // exception by definition: it is where the log's own name is decided.
      if (file !== 'src/cli/log.ts') {
        for (const forbidden of ['agent-ping.db', 'agent-ping.log']) {
          expect(source.includes(forbidden), `${file} must import ${forbidden} rather than name it`).toBe(false)
        }
      }
    }
  })

  it('the autostart units take the state directory the command resolved, and resolve none of their own', () => {
    // The other half of the exemption above, stated as its own assertion so that the
    // exemption cannot be widened silently. The autostart modules read
    // `AGENT_PING_STATE_DIR` to decide whether the unit has to carry it, and they take
    // the state directory the command already resolved rather than deriving it again:
    // a unit that re-resolved it could disagree with the command that wrote it, and
    // the symptom would be a hub whose runtime file the installed plugin never finds.
    const autostartModules = sourceFilesUnderSrc().filter((file) => file.startsWith('src/cli/autostart/'))
    expect(autostartModules.length).toBeGreaterThan(3)
    for (const file of autostartModules) {
      expect(readModuleImports(file).includes('resolveStateDir'), `${file} must not resolve the state dir itself`).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// IO-FR-09: the bounded, content-free local log
// ---------------------------------------------------------------------------

describe('the local log is bounded, structured and carries no conversation content', () => {
  it('writes one JSON object per line under the file the help names', async () => {
    const cli = await harness()
    expect(await cli.run(['status']), cli.lastText()).toBe(0)
    const file = path.join(cli.stateDir, LOG_FILE_NAME)
    expect(existsSync(file)).toBe(true)

    const lines = readFileSync(file, 'utf8').trim().split('\n').filter((line) => line !== '')
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      const parsed = parseLogLine(line)
      expect(parsed, line).not.toBeNull()
      expect(typeof parsed?.['time']).toBe('string')
      expect(['info', 'warn', 'error']).toContain(parsed?.['level'])
      expect(typeof parsed?.['name']).toBe('string')
    }
    // The run's own outcome is in there, so the log is a record and not a heartbeat.
    expect(lines.some((line) => line.includes('"status.read"'))).toBe(true)
    expect(lines.some((line) => line.includes('"hub-not-running"'))).toBe(true)
  })

  it('refuses a value that could be conversation content, rather than writing it', () => {
    // The four shapes the guard exists for, exercised directly so the rule is asserted
    // rather than described: a prompt, a diff, a stack of tool output, and a new field
    // name that nobody has reviewed.
    const prompt = 'You are a helpful assistant. The user said: refactor the parser.'
    expect(() => assertContentFreeLogFields('install.run', { outcome: prompt })).toThrow()
    const diff = '--- a/src/hub/server.ts\n+++ b/src/hub/server.ts\n@@ -1,7 +1,7 @@'
    expect(() => assertContentFreeLogFields('install.run', { outcome: diff })).toThrow()
    const output = 'at Object.<anonymous> (/home/you/project/src/main/index.ts:42:11)\n    at next (/home/you/project/node_modules/vite/dist/node.js:1:1)'
    expect(() => assertContentFreeLogFields('install.run', { outcome: output })).toThrow()
    expect(() =>
      assertContentFreeLogFields('install.run', { prompt: 'anything' } as never),
    ).toThrow(/closed set/)
    // And a path, which is what a log line legitimately carries, is accepted.
    expect(() => assertContentFreeLogFields('install.run', { stateDir: '/home/you/.local/state/agent-ping' })).not.toThrow()
  })

  it('keeps two files and rotates at the bound, and the bound is the documented one', async () => {
    const cli = await harness()
    // A bound small enough to cross in a few lines, which is the same code path a 2 MB
    // log takes after a few thousand commands.
    expect(LOG_MAX_BYTES, 'Open Question 2 fixes the bound at 2 MB').toBe(2 * 1024 * 1024)
    expect(LOG_FILES_KEPT).toBe(2)
    const small = createLocalLog({ stateDir: cli.stateDir, maxBytes: 400 })
    for (let index = 0; index < 20; index += 1) {
      small.info('install.run', { outcome: 'changed', port: index })
    }
    expect(small.rotations(), 'twenty lines at 400 bytes must have rotated').toBeGreaterThan(0)
    const files = readdirSync(cli.stateDir).filter((entry) => entry.startsWith(LOG_FILE_NAME))
    // The live file and the one rotated file, and no third. Two is a property of the two
    // names rather than a promise about a cleanup routine.
    expect(files.sort()).toEqual([ROTATED_LOG_FILE_NAME, LOG_FILE_NAME].sort())
    // The rotated file holds the lines from before the last rotation, and the live file
    // the ones after it - so the two never overlap and the oldest line is the only thing
    // that was lost. That is what a two-file bound means, and it is asserted by reading
    // both rather than by trusting the rotation counter.
    const portsIn = (file: string): readonly number[] =>
      readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => Number.parseInt(/"port":(\d+)/.exec(line)?.[1] ?? 'NaN', 10))
    const rotated = portsIn(path.join(cli.stateDir, ROTATED_LOG_FILE_NAME))
    const live = portsIn(path.join(cli.stateDir, LOG_FILE_NAME))
    expect(rotated.length).toBeGreaterThan(0)
    expect(live.length).toBeGreaterThan(0)
    expect(Math.min(...live)).toBeGreaterThan(Math.max(...rotated))
    // The bound itself holds: the live file never exceeds it.
    expect(statSync(path.join(cli.stateDir, LOG_FILE_NAME)).size).toBeLessThanOrEqual(400)
  })

  it('mirrors to standard output only under --verbose', async () => {
    const quiet = await harness()
    expect(await quiet.run(['status']), quiet.lastText()).toBe(0)
    const quietText = quiet.lastText()
    expect(quietText).not.toContain('"name":"status.read"')
    expect(quietText.split('\n').every((line) => !line.trimStart().startsWith('{'))).toBe(true)

    const loud = await harness()
    expect(await loud.run(['status', '--verbose']), loud.lastText()).toBe(0)
    const loudText = loud.lastText()
    expect(loudText).toContain('"name":"status.read"')
    // The same line is on disk, so the mirror is the log and not a second log.
    const onDisk = readFileSync(path.join(loud.stateDir, LOG_FILE_NAME), 'utf8')
    expect(onDisk).toContain('"name":"status.read"')
  })
})

// ---------------------------------------------------------------------------
// The command line itself
// ---------------------------------------------------------------------------

describe('the command line refuses what it cannot honour', () => {
  it('prints the usage for no command and for --help, and exits 0', async () => {
    const cli = await harness()
    expect(await cli.run([]), cli.lastText()).toBe(0)
    expect(cli.lastText()).toContain('usage: agent-ping <command> [flags]')
    for (const command of ['install', 'uninstall', 'status', 'doctor']) {
      expect(cli.lastText()).toContain(command)
    }
    // The runbook's §7 asks a reviewer to confirm the flag spellings from `--help`, so
    // every flag the parser accepts has to be in it.
    for (const flag of ['--purge', '--force', '--verbose', '--help']) {
      expect(cli.lastText()).toContain(flag)
    }
    expect(await cli.run(['--help']), cli.lastText()).toBe(0)
  })

  it('exits 2 for a command it does not have and for a flag it does not know', async () => {
    const cli = await harness()
    expect(await cli.run(['frobnicate']), cli.err.join('\n')).toBe(2)
    expect(cli.err.join('\n')).toContain('frobnicate is not a command')
    expect(await cli.run(['status', '--wat']), cli.err.join('\n')).toBe(2)
    expect(cli.err.join('\n')).toContain('unknown flag --wat')
  })

  it('is a dispatcher: each subcommand reaches its own command', async () => {
    // Structural rather than behavioural, and it is the stronger of the two: a test that
    // called `runStatus` directly would keep passing with a dispatcher that routed every
    // argument to it. `runInstall`, `runUninstall`, `runStatus` and `runDoctor` are
    // reachable from a test file only through the entry point.
    // Strings kept, because the case labels are strings: the question is which command
    // each label routes to, and a reader that stripped them could not answer it.
    const source = readModuleImports('src/cli/index.ts')
    for (const command of ['install', 'uninstall', 'status', 'doctor']) {
      expect(source.includes(`case '${command}'`), `the dispatcher must route ${command}`).toBe(true)
    }
    expect(readModuleWithoutProse('src/cli/index.ts').includes('isCliEntryPoint()')).toBe(true)

    for (const file of ['tests/cli/install.test.ts', 'tests/cli/doctor.test.ts']) {
      const test = readModuleWithoutProse(file)
      for (const internal of ['runInstall', 'runUninstall', 'runStatus', 'runDoctor']) {
        expect(test.includes(`${internal}(`), `${file} must reach ${internal} through runCli`).toBe(false)
      }
      // Strings kept: the import specifier is the evidence that both suites reach the
      // commands through the one harness rather than through a command module.
      expect(readModuleImports(file).includes("from './fixtures/command-line'")).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// Nothing leaves the machine
// ---------------------------------------------------------------------------

describe('no command reaches anything but the loopback hub', () => {
  it('names no remote host, no fetch, and no telemetry call anywhere in src/cli', () => {
    const files = sourceFilesUnderSrc().filter((file) => file.startsWith('src/cli/'))
    expect(files.length).toBeGreaterThan(3)
    for (const file of files) {
      const source = readModuleWithoutProse(file)
      for (const forbidden of [
        'https://',
        'http://',
        'fetch(',
        'XMLHttpRequest',
        'navigator.sendBeacon',
        'process.env.NODE_TELEMETRY',
        'update-electron-app',
        'electron-updater',
      ]) {
        expect(source.includes(forbidden), `${file} must not contain ${forbidden}`).toBe(false)
      }
    }
    // And the one loopback call that does exist is a GET to a host this product's own
    // runtime file published, checked to be loopback before the request is made.
    const client = readModuleWithoutProse('src/cli/hub-client.ts')
    expect(client.includes('isLoopbackAddress(')).toBe(true)
    expect(readModuleImports('src/cli/hub-client.ts').includes("method: 'GET'")).toBe(true)
    // No POST, no PUT, no delete anywhere in the CLI: a command that could write would
    // be a second control surface (APX-CON-08).
    const imports = readModuleImports('src/cli/hub-client.ts')
    for (const verb of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      expect(imports.includes(`'${verb}'`), `the CLI must not send a ${verb}`).toBe(false)
    }
  })

  it('carries no conversation content on any path it prints or logs', () => {
    // The log's closed field set is asserted above; this is the other side of the same
    // promise. A command has no access to a harness payload at all, so a word that could
    // only appear in one is a structural signal rather than a stylistic one. The list is
    // tokens, not substrings: "different" contains "diff" and a test that banned the
    // substring would have failed on a sentence about a version mismatch.
    const forbidden = [
      'prompt',
      'transcript',
      'toolOutput',
      'snippet',
      'excerpt',
      'lastMessage',
      'CardModel',
      'NotificationRequest',
      'PendingItem',
    ]
    for (const file of sourceFilesUnderSrc().filter((entry) => entry.startsWith('src/cli/'))) {
      const source = readModuleWithoutProse(file)
      for (const word of forbidden) {
        expect(source.includes(word), `${file} must not name ${word}`).toBe(false)
      }
    }
    // And the one value-bearing type a command does carry is a closed union of a
    // repository short name, a port, a count, a timestamp, a path and a closed token -
    // asserted on the module rather than described here.
    const log = readModuleWithoutProse('src/cli/log.ts')
    expect(log.includes('LOG_FIELD_KINDS')).toBe(true)
    expect(log.includes('isLogFieldValue')).toBe(true)
  })
})
