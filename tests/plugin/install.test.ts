// The global plugin installer: one file installed once, removed cleanly, and never
// silently replacing something it did not write (OA-FR-01, OA-FR-08, ADR-006,
// APX-CON-03, APX-FR-02).
//
//   npm test -- tests/plugin/install.test.ts
//
// The four acceptance criteria, and where each one is proven:
//
//   1. A TEST INSTALLS INTO A TEMPORARY HOME AND ASSERTS EXACTLY ONE PLUGIN FILE AND
//      ITS METADATA EXIST AFTERWARDS.
//      `describe('a fresh install')` installs into a temporary home with the real
//      renderer and the real verification, then reads the directory back off disk: the
//      file count is 2, the plugin file is the one opencode would load, and the
//      metadata is the install record. The verification is the real one - a child Node
//      process importing the written file - so this is also the evidence that the
//      written file loads as a plugin module.
//   2. A TEST INSTALLS TWICE AND ASSERTS NO DUPLICATE FILE AND NO ERROR.
//      `describe('a repeated install')` installs, then installs again, and asserts the
//      second call reports `unchanged`, that the file's bytes and modification time are
//      identical, and that the directory still holds one plugin file. A third install
//      whose *rendered bytes differ* is `reinstalled`: the file is replaced in place,
//      still exactly one, with the previous version reported.
//   3. A TEST ASSERTS A DIFFERENT INSTALLED VERSION IS REPORTED RATHER THAN SILENTLY
//      OVERWRITTEN.
//      `describe('a different installed version')` installs 0.1.0, asks for 0.2.0, and
//      asserts the outcome is `conflict`, the message names both versions, and - the
//      part that matters - the bytes on disk are still 0.1.0's. `force` then replaces
//      it and says so.
//   4. A TEST UNINSTALLS AND ASSERTS THE FILE IS GONE AND A SECOND UNINSTALL IS A SAFE
//      NO-OP.
//      `describe('removal')` removes both files, asserts the directory is left with
//      nothing of ours, runs removal a second time and asserts `absent` with no error,
//      and asserts an uninstall with nothing installed at all is also `absent`.
//
// Around those four, the properties that make them worth anything:
//
//   - THE PATH IS RESOLVED, NOT TYPED. Table-driven over linux, darwin and win32 with
//     and without `XDG_CONFIG_HOME`, asserting the plugin directory is
//     `<config>/plugins` in every case and never an `%APPDATA%` path - the mistake that
//     writes plugin files where opencode does not read them. `OPENCODE_CONFIG_DIR` is
//     asserted to be ignored, with the reason.
//   - THE GENERATED FILE IS THE PRODUCT'S OWN CODE. The render is asserted to inline
//     the eleven modules the adapter and the transport reach, to erase their relative
//     imports, to hoist node builtins without duplicating a binding, to have no
//     remaining `import`/`export` statement of its own, to declare no npm dependency,
//     to carry exactly one export, and to be byte-identical across two renders.
//   - THE SCANNER IS NOT FOOLED BY PROSE. The closure is asserted to be the eleven
//     modules and *not* the SQLite store, which `src/domain/envelope.ts` mentions in a
//     comment whose text ends in a real import specifier. That is the whole reason the
//     generator tokenises instead of substituting, and it is asserted rather than
//     assumed.
//   - A FILE THAT IS NOT OURS IS REPORTED, NOT REPLACED. A developer's own
//     `agent-ping.ts`, and a `package.json` in the plugin directory with no install
//     record, are both `blocked` with the path in the message and the bytes untouched -
//     on install and on removal.
//   - NOTHING IS PUBLISHED UNLESS IT LOADED. A verification that fails leaves no file
//     in the plugin directory, so a broken render cannot be discovered by the next
//     opencode session instead of by the install command.
//   - THE INSTALLER TOUCHES NOTHING ELSE. No file outside the plugin directory is
//     created, modified or removed; a sibling plugin and opencode's own config file
//     survive an install and a removal.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  GENERATED_SENTINEL,
  OPENCODE_DIR_NAME,
  INSTALL_RECORD_VERSION,
  METADATA_FILE_NAME,
  METADATA_KEY,
  PLUGIN_DIR_NAME,
  PLUGIN_EXPORT_NAME,
  PLUGIN_FILE_NAME,
  PluginRenderError,
  XDG_CONFIG_HOME_ENV_VAR,
  installGlobalPlugin,
  installedVersionOf,
  readInstalledMetadata,
  renderPluginSource,
  resolveGlobalPluginDir,
  resolveOpencodeConfigDir,
  uninstallGlobalPlugin,
  verifyPluginFile,
  type InstallResult,
  type RenderedPlugin,
  type UninstallResult,
  type VerifyObservation,
  type VerifyResult,
} from '@/plugin/install/global-plugin'

// ---------------------------------------------------------------------------
// A temporary home, and a real install into it
// ---------------------------------------------------------------------------

const VERSION = '0.1.0'

/** Every temporary home this file creates, removed after each test. */
const temporaries: string[] = []

function temporaryHome(): { home: string; env: NodeJS.ProcessEnv } {
  const home = mkdtempSync(path.join(tmpdir(), 'agent-ping-home-'))
  temporaries.push(home)
  return { home, env: { [XDG_CONFIG_HOME_ENV_VAR]: path.join(home, '.config') } as NodeJS.ProcessEnv }
}

function pluginDirOf(env: NodeJS.ProcessEnv, home: string): string {
  return resolveGlobalPluginDir({ env, home })
}

function pluginFileOf(env: NodeJS.ProcessEnv, home: string): string {
  return path.join(pluginDirOf(env, home), PLUGIN_FILE_NAME)
}

function metadataFileOf(env: NodeJS.ProcessEnv, home: string): string {
  return path.join(pluginDirOf(env, home), METADATA_FILE_NAME)
}

function install(env: NodeJS.ProcessEnv, home: string, version = VERSION, extra = {}): InstallResult {
  return installGlobalPlugin({ version, env, home, ...extra })
}

function remove(env: NodeJS.ProcessEnv, home: string): UninstallResult {
  return uninstallGlobalPlugin({ env, home })
}

function readMetadataJson(metadataFile: string): Record<string, unknown> {
  return JSON.parse(readFileSync(metadataFile, 'utf8')) as Record<string, unknown>
}

beforeEach(() => {
  temporaries.length = 0
})

afterEach(() => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true })
  temporaries.length = 0
})

// ---------------------------------------------------------------------------
// 1. A fresh install leaves exactly one plugin file and its metadata
// ---------------------------------------------------------------------------

describe('a fresh install into a temporary home', () => {
  it('writes exactly one plugin file and its metadata, and nothing else', () => {
    const { home, env } = temporaryHome()
    expect(existsSync(pluginDirOf(env, home))).toBe(false)

    const result = install(env, home)

    expect(result.outcome).toBe('installed')
    expect(result.message).toContain(`agent-ping ${VERSION} installed at`)
    // Two entries: the one plugin file and the one metadata file. A third entry would
    // be a second plugin, which is the failure this whole feature exists to prevent.
    expect(readdirSync(pluginDirOf(env, home)).sort()).toEqual([METADATA_FILE_NAME, PLUGIN_FILE_NAME].sort())
  }, 60_000)

  it('puts the file where opencode discovers global plugins, resolved from the platform path', () => {
    const { home, env } = temporaryHome()
    install(env, home)
    expect(pluginDirOf(env, home)).toBe(
      path.join(env[XDG_CONFIG_HOME_ENV_VAR] as string, 'opencode', PLUGIN_DIR_NAME),
    )
    // Spelled out rather than derived from the resolver under test, so a resolver that
    // is wrong in both places still fails here.
    expect(pluginFileOf(env, home)).toBe(
      path.join(env[XDG_CONFIG_HOME_ENV_VAR] as string, 'opencode', PLUGIN_DIR_NAME, PLUGIN_FILE_NAME),
    )
  }, 60_000)

  it('records the version, the file and the generated hash in the metadata', () => {
    const { home, env } = temporaryHome()
    const result = install(env, home)
    const metadata = readMetadataJson(metadataFileOf(env, home))

    expect(metadata['type']).toBe('module')
    expect(metadata['version']).toBe(VERSION)
    // Empty on purpose: the plugin needs no package, so opencode never has to install
    // anything for it to load.
    expect(metadata['dependencies']).toEqual({})

    const record = metadata[METADATA_KEY] as Record<string, unknown>
    expect(record['schemaVersion']).toBe(INSTALL_RECORD_VERSION)
    expect(record['product']).toBe('agent-ping')
    expect(record['version']).toBe(VERSION)
    expect(record['pluginFile']).toBe(PLUGIN_FILE_NAME)
    expect(record['sourceHash']).toBe(result.sourceHash)
    expect(String(record['installedAt'])).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    // The record and the file agree, which is what makes `doctor` able to answer
    // whether the installed plugin is the one this product would install today.
    expect(installedVersionOf(pluginFileOf(env, home))).toBe(VERSION)
    expect(readInstalledMetadata(metadataFileOf(env, home)).ours).toBe(true)
  }, 60_000)

  it('writes a file that loads as a plugin module and reports through the harness logger', () => {
    const { home, env } = temporaryHome()
    const result = install(env, home)

    // Not asserted through the installer: the written file is loaded again, from its
    // published path, by the real verifier. So the property is "the file opencode will
    // read loads", not "the staged copy loaded".
    const verification = verifyPluginFile(result.pluginFile)
    expect(verification.ok).toBe(true)
    const observed = verification.observed as VerifyObservation
    // One export, named the way opencode's own example plugin names it.
    expect(observed.exportNames).toEqual([PLUGIN_EXPORT_NAME])
    // The three hooks the adapter subscribes through.
    expect(observed.hookNames).toContain('event')
    expect(observed.hookNames).toContain('tool.execute.before')
    expect(observed.hookNames).toContain('tool.execute.after')
    // And it reports: with no hub running, the transport's breadcrumb reached the stub
    // harness logging client under this product's service name. A file that loaded and
    // said nothing would be the failure worth catching.
    expect(observed.logServices).toContain('agent-ping')
    expect(observed.logLines).toBeGreaterThan(0)
  }, 60_000)

  it('is idempotent about the directory: a second fresh home starts from nothing', () => {
    const first = temporaryHome()
    const second = temporaryHome()
    install(first.env, first.home)
    expect(existsSync(pluginDirOf(second.env, second.home))).toBe(false)
    expect(install(second.env, second.home).outcome).toBe('installed')
    expect(readdirSync(pluginDirOf(second.env, second.home))).toHaveLength(2)
  }, 120_000)
})

// ---------------------------------------------------------------------------
// 2. A repeated install duplicates nothing and raises nothing
// ---------------------------------------------------------------------------

describe('a repeated install', () => {
  it('reports unchanged, writes no duplicate and does not touch the file', () => {
    const { home, env } = temporaryHome()
    const first = install(env, home)
    const before = readFileSync(first.pluginFile, 'utf8')
    const beforeStat = statSync(first.pluginFile)

    const second = install(env, home)

    expect(second.outcome).toBe('unchanged')
    expect(second.previousVersion).toBe(VERSION)
    expect(second.message).toContain('already installed')
    // The strongest form of "no duplicate and no error": not one byte and not one
    // timestamp changed, and the metadata still records the same hash.
    expect(readFileSync(first.pluginFile, 'utf8')).toBe(before)
    expect(statSync(first.pluginFile).mtimeMs).toBe(beforeStat.mtimeMs)
    expect(readdirSync(pluginDirOf(env, home))).toHaveLength(2)
    const record = readMetadataJson(metadataFileOf(env, home))[METADATA_KEY] as Record<string, unknown>
    expect(record['sourceHash']).toBe(first.sourceHash)
  }, 120_000)

  it('replaces a same-version file in place when the generated bytes differ', () => {
    const { home, env } = temporaryHome()
    const first = install(env, home)
    // A patched build of the same version: same version, different file. It has to be
    // replaceable, or a fixed build could never be installed without an uninstall.
    const patched = `${readFileSync(first.pluginFile, 'utf8')}\n// a local patch\n`
    writeFileSync(first.pluginFile, patched, 'utf8')

    const second = install(env, home)

    expect(second.outcome).toBe('reinstalled')
    expect(second.previousVersion).toBe(VERSION)
    expect(second.message).toContain('replaced the copy')
    expect(readdirSync(pluginDirOf(env, home))).toHaveLength(2)
    // Replaced by the freshly generated bytes, which is the point: a patched build is
    // what the render produces, and the patch is not carried forward.
    expect(readFileSync(first.pluginFile, 'utf8')).toBe(renderPluginSource({ version: VERSION }).text)
    expect(readFileSync(first.pluginFile, 'utf8')).not.toBe(patched)
  }, 120_000)

  it('stays at one plugin file after ten installs of the same version', () => {
    const { home, env } = temporaryHome()
    const outcomes = Array.from({ length: 10 }, () => install(env, home).outcome)
    expect(outcomes.filter((outcome) => outcome === 'installed')).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome === 'unchanged')).toHaveLength(9)
    expect(readdirSync(pluginDirOf(env, home)).filter((name) => name.endsWith('.ts'))).toHaveLength(1)
  }, 180_000)
})

// ---------------------------------------------------------------------------
// 3. A different installed version is reported, not overwritten
// ---------------------------------------------------------------------------

describe('a different installed version', () => {
  it('is reported, and the installed bytes are untouched', () => {
    const { home, env } = temporaryHome()
    const first = install(env, home, '0.1.0')
    const before = readFileSync(first.pluginFile, 'utf8')

    const second = install(env, home, '0.2.0')

    expect(second.outcome).toBe('conflict')
    expect(second.previousVersion).toBe('0.1.0')
    expect(second.version).toBe('0.2.0')
    // The message is what the CLI prints, so it has to name both versions and say that
    // replacing one is a decision. "Reported rather than silently overwritten" is a
    // property of the bytes and of the sentence, and both are asserted.
    expect(second.message).toContain('agent-ping 0.2.0')
    expect(second.message).toContain('agent-ping 0.1.0')
    expect(second.message).toContain('force')
    expect(readFileSync(first.pluginFile, 'utf8')).toBe(before)
    expect(installedVersionOf(first.pluginFile)).toBe('0.1.0')
    const record = readMetadataJson(metadataFileOf(env, home))[METADATA_KEY] as Record<string, unknown>
    expect(record['version']).toBe('0.1.0')
  }, 120_000)

  it('is replaced when the caller forces it, and the replacement is named', () => {
    const { home, env } = temporaryHome()
    const first = install(env, home, '0.1.0')

    const forced = install(env, home, '0.2.0', { force: true })

    expect(forced.outcome).toBe('reinstalled')
    expect(forced.previousVersion).toBe('0.1.0')
    expect(installedVersionOf(first.pluginFile)).toBe('0.2.0')
    const record = readMetadataJson(metadataFileOf(env, home))[METADATA_KEY] as Record<string, unknown>
    expect(record['version']).toBe('0.2.0')
    expect(readdirSync(pluginDirOf(env, home))).toHaveLength(2)
  }, 120_000)

  it('is not a conflict when the older version is the one being asked for either', () => {
    const { home, env } = temporaryHome()
    install(env, home, '0.2.0')
    // Downgrading is the same situation and is reported the same way. An installer that
    // let a downgrade through would be a silent overwrite with a version bump.
    expect(install(env, home, '0.1.0').outcome).toBe('conflict')
  }, 120_000)
})

// ---------------------------------------------------------------------------
// 4. Removal, and a second removal as a safe no-op
// ---------------------------------------------------------------------------

describe('removal', () => {
  it('refuses to install with no version, because the next install could not tell whose file it was', () => {
    const { home, env } = temporaryHome()
    const result = installGlobalPlugin({ version: '  ', env, home })
    expect(result.outcome).toBe('failed')
    expect(result.code).toBe('no-version')
    expect(existsSync(pluginDirOf(env, home))).toBe(false)
  })

  it('reports a failure rather than claiming success when it cannot write', () => {
    // A staging parent that is a regular file cannot hold a directory, which is a
    // portable way to make the write fail - and the outcome that matters is that the
    // result says `failed` with nothing published, rather than `installed` with a
    // message a person would believe.
    const { home, env } = temporaryHome()
    const notADirectory = path.join(home, 'a-file')
    writeFileSync(notADirectory, 'not a directory\n', 'utf8')

    const result = installGlobalPlugin({ version: VERSION, env, home, stageDir: notADirectory })

    expect(result.outcome).toBe('failed')
    expect(result.code).toBe('not-writable')
    expect(result.message).toContain('did not install')
    expect(existsSync(pluginFileOf(env, home))).toBe(false)
    expect(existsSync(metadataFileOf(env, home))).toBe(false)
  })

  it('removes the file and the metadata and leaves no orphan', () => {
    const { home, env } = temporaryHome()
    const installed = install(env, home)
    expect(existsSync(installed.pluginFile)).toBe(true)
    expect(existsSync(installed.metadataFile)).toBe(true)

    const result = remove(env, home)

    expect(result.outcome).toBe('removed')
    expect([...result.removed].sort()).toEqual([installed.metadataFile, installed.pluginFile].sort())
    expect(result.kept).toEqual([])
    expect(existsSync(installed.pluginFile)).toBe(false)
    expect(existsSync(installed.metadataFile)).toBe(false)
    // Nothing of ours is left anywhere under the config directory.
    expect(existsSync(pluginDirOf(env, home))).toBe(false)
  }, 120_000)

  it('is a safe no-op the second time, and says so', () => {
    const { home, env } = temporaryHome()
    install(env, home)
    expect(remove(env, home).outcome).toBe('removed')

    const second = remove(env, home)

    expect(second.outcome).toBe('absent')
    expect(second.removed).toEqual([])
    expect(second.message).toContain('Nothing was changed')
  }, 120_000)

  it('is a safe no-op when the plugin directory exists but holds nothing of ours', () => {
    // The state a machine is in after a hand clean-up: the directory is there, both of
    // our files are gone. Reporting `removed` for a removal that removed nothing would
    // be a lie the CLI would print.
    const { home, env } = temporaryHome()
    mkdirSync(pluginDirOf(env, home), { recursive: true })

    const result = remove(env, home)

    expect(result.outcome).toBe('absent')
    expect(result.removed).toEqual([])
    expect(result.message).toContain('no plugin file')
  })

  it('is a safe no-op when nothing was ever installed', () => {
    const { home, env } = temporaryHome()
    const result = remove(env, home)
    expect(result.outcome).toBe('absent')
    expect(result.removed).toEqual([])
    expect(result.message).toContain('no plugin directory')
  })

  it('installs again afterwards, because a removal left a clean machine', () => {
    const { home, env } = temporaryHome()
    install(env, home)
    remove(env, home)
    const again = install(env, home)
    expect(again.outcome).toBe('installed')
    expect(readdirSync(pluginDirOf(env, home))).toHaveLength(2)
  }, 120_000)
})

// ---------------------------------------------------------------------------
// A file that is not ours
// ---------------------------------------------------------------------------

describe('a file this installer did not write', () => {
  it('is not overwritten on install, and the message names the path', () => {
    const { home, env } = temporaryHome()
    const dir = pluginDirOf(env, home)
    mkdirSync(dir, { recursive: true })
    const theirs = path.join(dir, PLUGIN_FILE_NAME)
    const contents = '// a developer\'s own plugin\nexport const Mine = async () => ({})\n'
    writeFileSync(theirs, contents, 'utf8')

    const result = install(env, home)

    expect(result.outcome).toBe('blocked')
    expect(result.code).toBe('metadata-not-ours')
    expect(result.message).toContain(theirs)
    expect(result.message).toContain('was not written by agent-ping')
    expect(readFileSync(theirs, 'utf8')).toBe(contents)
    // And the metadata was not created either: nothing of ours exists now.
    expect(existsSync(metadataFileOf(env, home))).toBe(false)
  })

  it('is not removed, and the message names the path', () => {
    const { home, env } = temporaryHome()
    const dir = pluginDirOf(env, home)
    mkdirSync(dir, { recursive: true })
    const theirs = path.join(dir, PLUGIN_FILE_NAME)
    writeFileSync(theirs, '// not ours\n', 'utf8')

    const result = remove(env, home)

    expect(result.outcome).toBe('blocked')
    expect([...result.kept]).toEqual([theirs])
    expect(result.message).toContain('not written by agent-ping')
    expect(existsSync(theirs)).toBe(true)
  })

  it('is not overwritten when it is a package.json without an install record', () => {
    const { home, env } = temporaryHome()
    const dir = pluginDirOf(env, home)
    mkdirSync(dir, { recursive: true })
    const theirs = path.join(dir, METADATA_FILE_NAME)
    writeFileSync(theirs, `${JSON.stringify({ name: 'their-plugins', type: 'module' }, null, 2)}\n`, 'utf8')

    expect(install(env, home).outcome).toBe('blocked')

    const metadata = readMetadataJson(theirs)
    expect(metadata['name']).toBe('their-plugins')
    expect(metadata[METADATA_KEY]).toBeUndefined()
  })

  it('is not overwritten when a damaged file claims to be ours', () => {
    const { home, env } = temporaryHome()
    const dir = pluginDirOf(env, home)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, METADATA_FILE_NAME), '{ this is not json', 'utf8')

    const result = install(env, home)

    expect(result.outcome).toBe('blocked')
    expect(readFileSync(path.join(dir, METADATA_FILE_NAME), 'utf8')).toBe('{ this is not json')
  })
})

// ---------------------------------------------------------------------------
// The installer touches nothing else
// ---------------------------------------------------------------------------

describe('what the installer touches', () => {
  it('leaves a sibling plugin and opencode\'s own config file alone', () => {
    const { home, env } = temporaryHome()
    const configDir = resolveOpencodeConfigDir({ env, home })
    mkdirSync(configDir, { recursive: true })
    const opencodeConfig = path.join(configDir, 'opencode.json')
    const sibling = path.join(pluginDirOf(env, home), 'theirs.ts')
    writeFileSync(opencodeConfig, '{"model":"x"}\n', 'utf8')
    mkdirSync(path.dirname(sibling), { recursive: true })
    writeFileSync(sibling, 'export const Theirs = async () => ({})\n', 'utf8')

    install(env, home)

    expect(readFileSync(opencodeConfig, 'utf8')).toBe('{"model":"x"}\n')
    expect(readFileSync(sibling, 'utf8')).toBe('export const Theirs = async () => ({})\n')

    remove(env, home)

    // The sibling's presence is also what stops the directory being pruned, which is
    // how "removes our files" stays short of "removes the user's plugin directory".
    expect(readFileSync(sibling, 'utf8')).toBe('export const Theirs = async () => ({})\n')
    expect(readFileSync(opencodeConfig, 'utf8')).toBe('{"model":"x"}\n')
    expect(existsSync(path.join(pluginDirOf(env, home), PLUGIN_FILE_NAME))).toBe(false)
    expect(existsSync(pluginDirOf(env, home))).toBe(true)
  }, 120_000)

  it('creates no file anywhere outside the plugin directory', () => {
    const { home, env } = temporaryHome()
    const before = listTree(home)
    install(env, home)
    const added = listTree(home).filter((entry) => !before.includes(entry))
    const pluginDir = pluginDirOf(env, home)
    expect(added.every((entry) => entry.startsWith(`${pluginDir}${path.sep}`))).toBe(true)
    expect(added.map((entry) => path.relative(pluginDir, entry)).sort()).toEqual(
      [METADATA_FILE_NAME, PLUGIN_FILE_NAME].sort(),
    )
  }, 120_000)

  it('leaves no staging directory behind on any path, including a failed one', () => {
    // The staged copy is pointed at the temporary home here, so "left nothing behind"
    // is observable: without the seam it would live in the system temporary directory,
    // where a leak is invisible and unbounded.
    const { home, env } = temporaryHome()
    const stageDir = path.join(home, 'staging')

    install(env, home, VERSION, { stageDir })
    remove(env, home)
    install(env, home, VERSION, { stageDir })
    // And a path that fails after the file was staged, which is where a leak would
    // actually happen. The version has to match what is installed, or this returns as a
    // version conflict and never reaches the staging at all.
    const failed = installGlobalPlugin({
      version: VERSION,
      env,
      home,
      stageDir,
      render: () => ({ text: 'not a module\n', hash: 'sha256:bad', modules: [], builtins: [] }),
    })
    expect(failed.outcome).toBe('unverified')

    // Directories as well as files: a leaked staging directory is empty once its
    // contents are moved away, so a file-only listing would not see it.
    expect(readdirSync(stageDir)).toEqual([])
    expect(listTree(home).map((entry) => path.relative(home, entry)).sort()).toEqual(
      [
        path.join('.config', 'opencode', PLUGIN_DIR_NAME, METADATA_FILE_NAME),
        path.join('.config', 'opencode', PLUGIN_DIR_NAME, PLUGIN_FILE_NAME),
      ].sort(),
    )
  }, 120_000)

  it('leaves nothing behind in the system temporary directory on any path', () => {
    // The test above proves the staging paths clean up after themselves, but it proves
    // it where the leak was pointed at a directory the test owns. The DEFAULT staging
    // directory is the system temporary directory, and that is the configuration a real
    // `agent-ping install` runs in: there a leak is invisible to the test that made it
    // and unbounded over an operator's repeated installs. So this one counts the real
    // thing.
    //
    // Two paths leaked here, and both are exercised below: a repeat install of an
    // unchanged product, which is the most common thing an operator does, and a direct
    // `verifyPluginFile` call, which is what `doctor` makes. Neither passes a `stateDir`,
    // so each has to clean up after itself.
    const before = scratchCounts()
    const { home, env } = temporaryHome()

    const first = install(env, home)
    expect(first.outcome).toBe('installed')
    // `unchanged`: the path that re-verifies the published file without writing it.
    expect(install(env, home).outcome).toBe('unchanged')
    // And the verifier called the way a caller with no state directory calls it, which
    // is `doctor`'s call and the one that has to clean up after itself.
    expect(verifyPluginFile(first.pluginFile).ok).toBe(true)
    // A conflict returns before any staging, and a removal stages nothing either.
    expect(install(env, home, '9.9.9').outcome).toBe('conflict')
    expect(remove(env, home).outcome).toBe('removed')

    expect(scratchCounts()).toEqual(before)
  }, 180_000)
})

/**
 * What the installer has left in the system temporary directory.
 *
 * Counted by prefix and for both kinds, so a leak on either path fails the assertion
 * above. `mkdtemp` names are unique, so any difference means a directory this code made
 * and did not remove; leftovers from an earlier run are on both sides of the count and
 * cancel out.
 */
function scratchCounts(): { stage: number; verify: number } {
  const entries = readdirSync(tmpdir())
  return {
    stage: entries.filter((entry) => entry.startsWith('agent-ping-stage-')).length,
    verify: entries.filter((entry) => entry.startsWith('agent-ping-verify-')).length,
  }
}

function listTree(root: string): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else found.push(full)
    }
  }
  walk(root)
  return found.sort()
}

// ---------------------------------------------------------------------------
// Nothing is published unless it loaded
// ---------------------------------------------------------------------------

describe('a generated file that does not load', () => {
  const brokenRender = (): RenderedPlugin => ({
    text: `${GENERATED_SENTINEL} - generated, do not edit\n// product-version: 0.1.0\nexport const AGENT_PING_PLUGIN = (\n`,
    hash: 'sha256:broken',
    modules: ['plugin/opencode/index.ts'],
    builtins: [],
  })

  it('is not written to the plugin directory, and the install says why', () => {
    const { home, env } = temporaryHome()
    const result = installGlobalPlugin({
      version: VERSION,
      env,
      home,
      render: brokenRender,
      verify: () => ({ ok: false, code: 'unloadable', errorName: 'SyntaxError', message: 'Unexpected end of input' }),
    })

    expect(result.outcome).toBe('unverified')
    expect(result.code).toBe('unloadable')
    expect(result.message).toContain('did not load')
    expect(result.message).toContain('SyntaxError')
    // The point of verifying before publishing: a developer's next session must not be
    // the thing that discovers a file this install already knew was broken.
    expect(existsSync(pluginFileOf(env, home))).toBe(false)
    expect(existsSync(metadataFileOf(env, home))).toBe(false)
  })

  it('names a file that loads but exports no plugin', () => {
    const { home, env } = temporaryHome()
    const result = installGlobalPlugin({
      version: VERSION,
      env,
      home,
      render: () => ({ text: 'export const Something = 1\n', hash: 'sha256:x', modules: [], builtins: [] }),
      verify: () => ({ ok: false, code: 'not-a-plugin' }),
    })
    expect(result.outcome).toBe('unverified')
    expect(result.code).toBe('not-a-plugin')
    expect(result.message).toContain('did not load')
    expect(existsSync(pluginFileOf(env, home))).toBe(false)
  })

  it('refuses a file that loads and then reports nothing at all', () => {
    // A file that parses, exports a plugin, builds its hooks and says nothing has not
    // been checked: it is the silent adapter (APX-FR-02). The real verifier decides
    // this, not an injected one, so the render below is a real module on disk.
    const { home, env } = temporaryHome()
    const result = installGlobalPlugin({
      version: VERSION,
      env,
      home,
      render: () => ({
        text: `${GENERATED_SENTINEL} - generated, do not edit\n// product-version: ${VERSION}\nexport const ${PLUGIN_EXPORT_NAME} = async () => ({ event: async () => undefined })\n`,
        hash: 'sha256:silent',
        modules: [],
        builtins: [],
      }),
    })
    expect(result.outcome).toBe('unverified')
    expect(result.code).toBe('silent')
    expect(result.message).toContain('reported nothing at all')
    expect(existsSync(pluginFileOf(env, home))).toBe(false)
  }, 60_000)

  it('reports a verification that ran out of time rather than waiting forever', () => {
    const { home, env } = temporaryHome()
    const result = installGlobalPlugin({
      version: VERSION,
      env,
      home,
      render: brokenRender,
      verify: () => ({ ok: false, code: 'timeout' }),
    })
    expect(result.outcome).toBe('unverified')
    expect(result.code).toBe('timeout')
    expect(result.message).toContain('longer than the bound')
  })

  it('really does load a file that does not load, rather than trusting the seam', () => {
    // The three rows above inject a failing verification, which only proves the
    // installer's reaction. This one hands the real verifier a file that cannot parse.
    const { home, env } = temporaryHome()
    const result = installGlobalPlugin({ version: VERSION, env, home, render: brokenRender })

    expect(result.outcome).toBe('unverified')
    expect(result.code).toBe('unloadable')
    expect(result.message).toContain('did not load')
    expect(existsSync(pluginFileOf(env, home))).toBe(false)
  }, 60_000)
})

// ---------------------------------------------------------------------------
// The path is resolved from the platform configuration path
// ---------------------------------------------------------------------------

describe('resolving the global plugin directory', () => {
  const PLATFORMS: readonly NodeJS.Platform[] = ['linux', 'darwin', 'win32']

  it('spells the opencode layout literally, because the resolver is not the evidence', () => {
    // Everything else in this file checks the resolver against its own constants, which
    // proves nothing about the constants. This row is the only one that pins the two
    // names opencode documents - `~/.config/opencode/plugins/` - so changing either
    // constant fails here rather than quietly writing plugin files into a directory
    // opencode does not read.
    expect(resolveGlobalPluginDir({ env: {}, home: '/home/dev' })).toBe('/home/dev/.config/opencode/plugins')
    expect(PLUGIN_DIR_NAME).toBe('plugins')
    expect(OPENCODE_DIR_NAME).toBe('opencode')
    expect(XDG_CONFIG_HOME_ENV_VAR).toBe('XDG_CONFIG_HOME')
  })

  it.each(PLATFORMS)('is <home>/.config/opencode/plugins on %s without the variable', (platform) => {
    const home = path.join(path.sep, 'home', 'dev')
    expect(resolveOpencodeConfigDir({ env: {}, platform, home })).toBe(
      path.join(home, '.config', 'opencode'),
    )
    expect(resolveGlobalPluginDir({ env: {}, platform, home })).toBe(
      path.join(home, '.config', 'opencode', PLUGIN_DIR_NAME),
    )
  })

  it.each(PLATFORMS)('honours XDG_CONFIG_HOME on %s, which opencode honours', (platform) => {
    const xdg = path.join(path.sep, 'tmp', 'xdg-probe')
    const env = { [XDG_CONFIG_HOME_ENV_VAR]: xdg }
    expect(resolveGlobalPluginDir({ env, platform, home: path.join(path.sep, 'home', 'dev') })).toBe(
      path.join(xdg, 'opencode', PLUGIN_DIR_NAME),
    )
  })

  it.each(PLATFORMS)('ignores an empty or blank XDG_CONFIG_HOME on %s', (platform) => {
    const home = path.join(path.sep, 'home', 'dev')
    for (const value of ['', '   ']) {
      const env = { [XDG_CONFIG_HOME_ENV_VAR]: value }
      expect(resolveGlobalPluginDir({ env, platform, home })).toBe(
        path.join(home, '.config', 'opencode', PLUGIN_DIR_NAME),
      )
    }
  })

  it.each(PLATFORMS)('never resolves to an APPDATA path on %s', (platform) => {
    // opencode resolves its base directories with xdg-basedir, which does not use
    // %APPDATA% or %LOCALAPPDATA%. A resolver that "fixed" this for Windows would put
    // the plugin where opencode never reads it, which is the silent failure this whole
    // resolution exists to prevent.
    const env = { APPDATA: path.join(path.sep, 'Users', 'dev', 'AppData', 'Roaming'), LOCALAPPDATA: path.join(path.sep, 'Users', 'dev', 'AppData', 'Local') }
    const resolved = resolveGlobalPluginDir({ env, platform, home: path.join(path.sep, 'home', 'dev') })
    expect(resolved).not.toContain('AppData')
  })

  it('ignores OPENCODE_CONFIG_DIR, because that is an extra directory and not the global one', () => {
    // opencode's docs make it a directory searched *in addition to* the global one, and
    // `opencode debug paths` on 1.18.32 leaves `config` at the home path when it is set.
    // Installing there would be "wherever this invocation points", the opposite of one
    // global install (ADR-006).
    const home = path.join(path.sep, 'home', 'dev')
    const env = { OPENCODE_CONFIG_DIR: path.join(path.sep, 'tmp', 'custom-cfg') }
    expect(resolveGlobalPluginDir({ env, home })).toBe(
      path.join(home, '.config', 'opencode', PLUGIN_DIR_NAME),
    )
  })

  it('installs into the resolved directory and not into OPENCODE_CONFIG_DIR', () => {
    const { home, env } = temporaryHome()
    const custom = path.join(home, 'custom-cfg')
    const result = installGlobalPlugin({ version: VERSION, env: { ...env, OPENCODE_CONFIG_DIR: custom }, home })
    expect(result.pluginDir.startsWith(custom)).toBe(false)
    expect(result.pluginDir).toBe(pluginDirOf(env, home))
  }, 60_000)

  it('accepts an explicit plugin directory, which is the seam a test and an operator share', () => {
    const { home } = temporaryHome()
    const explicit = path.join(home, 'somewhere', 'plugins')
    const result = installGlobalPlugin({ version: VERSION, env: {}, platform: 'linux', home, pluginDir: explicit })
    expect(result.pluginDir).toBe(explicit)
    expect(existsSync(path.join(explicit, PLUGIN_FILE_NAME))).toBe(true)
  }, 60_000)
})

// ---------------------------------------------------------------------------
// The generated file is this product's own code
// ---------------------------------------------------------------------------

describe('the generated single file', () => {
  const render = (): RenderedPlugin => renderPluginSource({ version: VERSION })

  it('inlines the modules the adapter and the transport reach, and nothing else', () => {
    const rendered = render()
    expect(rendered.modules).toEqual([
      'domain/envelope.ts',
      'domain/classify.ts',
      'plugin/opencode/work-signal.ts',
      'plugin/opencode/translate.ts',
      'plugin/opencode/index.ts',
      'storage/paths.ts',
      'hub/runtime-file.ts',
      'hub/security.ts',
      'plugin/transport/breadcrumb.ts',
      'plugin/transport/http.ts',
    ])
  })

  it('does not inline the SQLite store, which only a type-only import mentions', () => {
    const rendered = render()
    // src/domain/envelope.ts contains a comment explaining its type-only import whose
    // text ends in a real specifier: "from '../storage/eventStore.js'". A generator
    // that matched `import ... from` textually would pull the store and its native
    // dependency into a file loaded into every session. This assertion is the reason
    // the generator tokenises.
    expect(rendered.modules.join(' ')).not.toContain('storage/eventStore')
    expect(rendered.modules.join(' ')).not.toContain('storage/db')
    // The name does appear in a comment in the domain, so the claim is about what the
    // file imports: nothing in it can resolve a package.
    const imports = rendered.text.match(/^import .*$/gm) ?? []
    expect(imports.some((line) => line.includes('better-sqlite3'))).toBe(false)
    expect(imports.every((line) => line.includes("from 'node:"))).toBe(true)
  })

  it('erases the inlined modules\' own imports and hoists the node builtins instead', () => {
    const rendered = render()
    const importLines = rendered.text.split('\n').filter((line) => /^import\b/.test(line))
    // Every remaining import is a node builtin, so the file needs nothing beside it.
    expect(importLines.length).toBeGreaterThan(0)
    for (const line of importLines) expect(line).toMatch(/^import .* from 'node:/)
    expect(rendered.builtins.every((name) => name.startsWith('node:'))).toBe(true)
  })

  it('declares each builtin binding once, so the emitted file has no duplicate', () => {
    const rendered = render()
    // `path` is default-imported by three of the inlined modules and `node:fs` is
    // named-imported by two; a file that kept every import verbatim would not parse.
    const imports = rendered.text.match(/^import .*$/gm) ?? []
    const defaults = imports.filter((line) => /^import [A-Za-z_$][\w$]* from /.test(line))
    expect(defaults).toEqual(['import path from \'node:path\''])
    const fsBindings = new Set(
      (rendered.text.match(/^import \{ ([^}]*) \} from 'node:fs'$/m)?.[1] ?? '')
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part !== ''),
    )
    // Union of what src/storage/paths.ts, src/hub/runtime-file.ts and
    // src/hub/security.ts each import from node:fs, in one statement.
    expect([...fsBindings].sort()).toEqual([
      'chmodSync',
      'closeSync',
      'existsSync',
      'mkdirSync',
      'openSync',
      'readFileSync',
      'renameSync',
      'unlinkSync',
      'writeFileSync',
    ])
  })

  it('exports the plugin once, by the indirect form the wrapper needs', () => {
    const rendered = render()
    const exportLines = rendered.text.split('\n').filter((line) => /^export\b/.test(line))
    // One export, and it is the indirect form: the inlined adapter already owns a
    // top-level `const AGENT_PING_PLUGIN`, so a second `export const` of that name
    // would be a duplicate declaration.
    expect(exportLines).toEqual([`export { agentPingInstalledPlugin as ${PLUGIN_EXPORT_NAME} }`])
  })

  it('carries the sentinel and the version in its own header, and lists its sources', () => {
    const rendered = render()
    expect(rendered.text.startsWith(GENERATED_SENTINEL)).toBe(true)
    expect(rendered.text).toContain(`// product-version: ${VERSION}`)
    for (const modulePath of rendered.modules) expect(rendered.text).toContain(`//   - src/${modulePath}`)
    expect(rendered.text).toContain('has no npm dependency')
  })

  it('is deterministic, so "already installed" is a fact and not a timestamp guess', () => {
    const first = render()
    const second = render()
    expect(second.text).toBe(first.text)
    expect(second.hash).toBe(first.hash)
  })

  it('builds the transport inside a guard, so a transport that cannot be built is a breadcrumb and not a fault', () => {
    // This one cannot be triggered through the real code - `createHarnessLog` and
    // `createHubTransport` only close over values, so neither throws today - and the
    // consequence of losing the guard is an exception inside somebody's session. So the
    // guarantee is asserted where it lives, in the installed source, the same way the
    // adapter's own tests assert that it never logs to the console.
    const rendered = render()
    const entry = rendered.text.slice(rendered.text.indexOf('const agentPingInstalledPlugin'))
    expect(entry).toContain('try {')
    expect(entry).toContain('createHubTransport({')
    expect(entry).toContain('catch {')
    expect(entry).toContain('deliver = undefined')
    // And the transport really is the delivery port, not a decoration.
    expect(entry).toContain('deliver })')
  })

  it('differs when the version differs, which is how the conflict check sees it', () => {
    const other = renderPluginSource({ version: '9.9.9' })
    expect(other.hash).not.toBe(render().hash)
    expect(other.text).toContain('// product-version: 9.9.9')
  })

  it('writes the version the caller asked for, never a constant of its own', () => {
    for (const version of ['0.0.1', '1.2.3-beta.1', '0.1.0']) {
      expect(renderPluginSource({ version }).text).toContain(`// product-version: ${version}`)
    }
  })
})

// ---------------------------------------------------------------------------
// The generator refuses what it cannot do honestly
// ---------------------------------------------------------------------------

describe('the generator', () => {
  const entry = 'plugin/opencode/index.ts'
  const transport = 'plugin/transport/http.ts'

  /**
   * A tree of modules, read from memory, so a case costs one object.
   *
   * Both roots are always present, because both are: the entry point and the transport
   * the installed file has to build. A test that wants to say something about a third
   * module adds it here.
   */
  function treeOf(modules: Readonly<Record<string, string>>): (modulePath: string) => string {
    const tree: Readonly<Record<string, string>> = {
      [transport]: 'export const createHubTransport = () => () => undefined\n',
      ...modules,
    }
    return (modulePath: string): string => {
      const found = tree[modulePath]
      if (found === undefined) throw Object.assign(new Error(`no such module ${modulePath}`), { code: 'ENOENT' })
      return found
    }
  }

  it('refuses a module that imports an npm package', () => {
    // A dependency in the emitted file would mean a session that cannot load because a
    // package is missing, in a directory where nothing installs packages.
    expect(() =>
      renderPluginSource({
        version: VERSION,
        read: treeOf({ [entry]: "import { join } from 'node:path'\nimport Database from 'better-sqlite3'\nexport const AGENT_PING_PLUGIN = 1\n" }),
      }),
    ).toThrowError(/imports an npm package/)
  })

  it('refuses an import it cannot resolve, naming the module and the specifier', () => {
    try {
      renderPluginSource({
        version: VERSION,
        read: treeOf({ [entry]: "import { x } from './missing.js'\nexport const AGENT_PING_PLUGIN = 1\n" }),
      })
      expect.unreachable('the render should have failed')
    } catch (cause) {
      expect(cause).toBeInstanceOf(PluginRenderError)
      const failure = cause as PluginRenderError
      expect(failure.code).toBe('module-unresolved')
      expect(failure.module).toBe(entry)
      expect(failure.detail).toBe('./missing.js')
    }
  })

  it('refuses two modules that declare one name with different bodies', () => {
    // The refusal is the point: a mechanical renamer that guessed here would put a file
    // into every session that loads and behaves differently from the source.
    expect(() =>
      renderPluginSource({
        version: VERSION,
        read: treeOf({
          [entry]: "import { a } from './a.js'\nimport { b } from './b.js'\nfunction helper() { return 1 }\nexport const AGENT_PING_PLUGIN = helper() + a + b\n",
          'plugin/opencode/a.js': 'export const a = 1\n',
          'plugin/opencode/b.js': "import { helper } from './index.js'\nexport const b = 2\nfunction helper() { return 99 }\n",
        }),
      }),
    ).toThrowError(/duplicate top-level name: helper/)
  })

  it('collapses two identical private helpers into one declaration', () => {
    // This is the real case in the adapter: `isThenable` is declared identically in
    // translate.ts and index.ts, and the hub's `isAlreadyExists` identically in
    // runtime-file.ts and security.ts. The emitted file holds one copy each.
    const helper = 'function isThenable(value: unknown): boolean {\n  return typeof value === \'object\' && value !== null\n}\n'
    const rendered = renderPluginSource({
      version: VERSION,
      read: treeOf({
        [entry]: `import { probe } from './a.js'\n${helper}export const AGENT_PING_PLUGIN = probe() && isThenable(1)\n`,
        'plugin/opencode/a.js': `import { isThenable } from './index.js'\n${helper}export const probe = () => true\n`,
      }),
    })
    expect(rendered.text.match(/function isThenable/g)).toHaveLength(1)
  })

  it('refuses an export form it would have to guess at', () => {
    for (const source of [
      "export { x } from './a.js'\n",
      "export * from './a.js'\n",
      "export default function () {}\n",
    ]) {
      expect(() =>
        renderPluginSource({ version: VERSION, read: treeOf({ [entry]: source, 'plugin/opencode/a.js': 'export const x = 1\n' }) }),
      ).toThrowError(/could not generate its opencode plugin/)
    }
  })

  it('refuses a source it cannot read', () => {
    expect(() => renderPluginSource({ version: VERSION, read: () => { throw new Error('EACCES') } })).toThrowError(
      /could not be read/,
    )
  })

  it('reads a module tree through the one seam, with no filesystem access', () => {
    const read = treeOf({
      [entry]: 'export const AGENT_PING_PLUGIN = 1\n',
      [transport]: 'export const send = 2\n',
    })
    const rendered = renderPluginSource({ version: VERSION, read })
    expect(rendered.modules).toEqual([entry, transport])
    expect(rendered.text).toContain('const send = 2')
  })
})

// ---------------------------------------------------------------------------
// The verifier
// ---------------------------------------------------------------------------

describe('verifying a written plugin file', () => {
  it('reports a file that is not there as unloadable rather than passing', () => {
    const { home } = temporaryHome()
    const result = verifyPluginFile(path.join(home, 'nothing-here.ts'))
    expect(result.ok).toBe(false)
    expect(result.code).toBe('unloadable')
  }, 60_000)

  it('reports a file that parses but exports nothing callable', () => {
    const { home } = temporaryHome()
    const file = path.join(home, 'empty.ts')
    writeFileSync(file, 'export const NOT_A_PLUGIN = 1\n', 'utf8')
    const result = verifyPluginFile(file)
    expect(result.ok).toBe(false)
    expect(result.code).toBe('not-a-plugin')
  }, 60_000)

  it('hands the caller a scratch state directory it did not have to choose', () => {
    // The verification must not read a real install's runtime file or token, so the
    // state directory is always a temporary one. Asserted through the seam.
    const { home } = temporaryHome()
    const seen: string[] = []
    const result: VerifyResult = verifyPluginFile(path.join(home, 'x.ts'), {
      run: (_file, bounds) => {
        seen.push(bounds.stateDir)
        return { ok: true, observed: { exportNames: [], hookNames: [], logServices: [], logLines: 0, breadcrumbCodes: [] } }
      },
    })
    expect(result.ok).toBe(true)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toContain('agent-ping-verify-')
    expect(seen[0]?.startsWith(home)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The installed version reader
// ---------------------------------------------------------------------------

describe('reading the installed version', () => {
  it('is null for a file that is not there', () => {
    const { home } = temporaryHome()
    expect(installedVersionOf(path.join(home, 'absent.ts'))).toBeNull()
  })

  it('is null for somebody else\'s file, however it is named', () => {
    const { home } = temporaryHome()
    const file = path.join(home, 'theirs.ts')
    writeFileSync(file, '// product-version: 1.2.3\nexport const Theirs = 1\n', 'utf8')
    expect(installedVersionOf(file)).toBeNull()
  })

  it('reads the version back out of an installed file', () => {
    const { home, env } = temporaryHome()
    install(env, home, '3.4.5')
    expect(installedVersionOf(pluginFileOf(env, home))).toBe('3.4.5')
  }, 60_000)
})
