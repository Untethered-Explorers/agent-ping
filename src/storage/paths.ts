// Every path the product writes resolves through this module, and nowhere else.
//
// Two requirements meet here. IO-FR-07: state resolves to a platform directory
// that an environment variable can override, and every path the product writes
// is created with owner-only permissions. EL-FR-11: the store resolves its
// database file from that state directory, so a test can redirect the whole
// store at a temporary path by setting one variable.
//
// One resolution point, not two. packaging-engineer (IO-1, IO-2) and
// qa-engineer (IO-4) depend on this being the only place the layout is decided,
// so a test and a package can never disagree about where the database lives.
//
// Nothing here opens a socket, spawns a process or renders a surface, and
// nothing here leaves the machine (APX-CON-12). The only path resolved against
// something outside this machine is the state directory itself, which is by
// definition a local path.

import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/**
 * The one environment variable that redirects agent-ping's state.
 *
 * Chosen to match the project's own namespace rather than a platform variable,
 * because the layout inside the directory (the database, the runtime file, the
 * bounded local log) is agent-ping's, not the platform's. A test sets it, and
 * an operator can set it to run two installs side by side.
 */
export const STATE_DIR_ENV_VAR = 'AGENT_PING_STATE_DIR'

/** The per-install directory name inside the platform state location. */
export const APP_DIRECTORY_NAME = 'agent-ping'

/** The durable log's file name inside the state directory. */
export const DATABASE_FILE_NAME = 'agent-ping.db'

/** Owner-only on the directory: rwx for the owner, nothing for anyone else. */
export const OWNER_ONLY_DIRECTORY_MODE = 0o700

/** Owner-only on the database file itself (IO-FR-07). */
export const OWNER_ONLY_FILE_MODE = 0o600

/**
 * The `path` flavour for a platform, chosen by that platform and not by the machine.
 *
 * `resolveStateDir` is handed a `platform` so a test can drive every branch from one
 * host, which is the whole point of taking it as a parameter. Using the ambient `path`
 * to join the result quietly undid that: asked for the Linux layout on a Windows
 * machine, it answered `\home\dev\.local\state\agent-ping`, because the ambient
 * `path.join` is `path.win32.join` there. So the function was pure only on the platform
 * it was written on, and the test that asserts the Linux layout passed on Linux by
 * coincidence.
 *
 * The rule is the same one `src/cli/autostart` already applies when it generates a unit
 * for another platform: a path that belongs to a platform is written in that platform's
 * flavour. macOS and Linux get POSIX separators; Windows gets backslashes.
 */
function pathApiFor(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix
}

/**
 * Expand a leading `~` so a shell-quoted override such as
 * `AGENT_PING_STATE_DIR=~/state` resolves the way the user meant it.
 */
function expandHome(value: string, home: string, api: path.PlatformPath): string {
  if (value === '~') return home
  if (value.startsWith('~/') || value.startsWith(`~${api.sep}`)) {
    return api.join(home, value.slice(2))
  }
  return value
}

/**
 * The platform state directory for this install.
 *
 * The override wins over everything, so a test or a verification script can
 * point the whole product at a temporary directory. Without it the layout is
 * the platform convention:
 *
 *   - Linux (and any other POSIX platform): `$XDG_STATE_HOME/agent-ping`,
 *     falling back to `~/.local/state/agent-ping`.
 *   - macOS: `~/Library/Application Support/agent-ping`.
 *   - Windows: `%LOCALAPPDATA%\agent-ping`.
 *
 * `env` and `platform` are parameters rather than ambient reads so the
 * resolution is a pure function a test can drive through every platform
 * without mutating `process.env` - and `platform` now also decides the separator, so
 * the answer is the same string on every host.
 */
export function resolveStateDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  const api = pathApiFor(platform)
  const override = env[STATE_DIR_ENV_VAR]
  if (override !== undefined && override.trim() !== '') {
    return api.resolve(expandHome(override.trim(), home, api))
  }

  switch (platform) {
    case 'darwin':
      return api.join(home, 'Library', 'Application Support', APP_DIRECTORY_NAME)
    case 'win32': {
      const localAppData = env['LOCALAPPDATA']
      const base =
        localAppData !== undefined && localAppData.trim() !== ''
          ? expandHome(localAppData.trim(), home, api)
          : api.join(home, 'AppData', 'Local')
      return api.join(base, APP_DIRECTORY_NAME)
    }
    default: {
      const xdgStateHome = env['XDG_STATE_HOME']
      const base =
        xdgStateHome !== undefined && xdgStateHome.trim() !== ''
          ? expandHome(xdgStateHome.trim(), home, api)
          : api.join(home, '.local', 'state')
      return api.join(base, APP_DIRECTORY_NAME)
    }
  }
}

/**
 * Create the state directory if it is missing and hold it at owner-only
 * permissions, then return it.
 *
 * An existing directory is tightened rather than trusted: a directory created
 * by an older install, or by a script that used a wider umask, is chmod-ed back
 * to `0o700` so the metadata inside it is not readable by other users.
 *
 * A `chmod` that the platform or the filesystem refuses is not fatal. The
 * directory existing is what the store needs to start; the mode is best effort
 * on a filesystem that has no POSIX modes at all. A `mkdir` failure *is* fatal
 * and propagates, because the store cannot open a database inside a directory
 * that does not exist (APX-CON-03: restartable without loss, but not
 * invulnerable to a machine that cannot be written to).
 */
export function ensureStateDir(stateDir: string = resolveStateDir()): string {
  mkdirSync(stateDir, { recursive: true, mode: OWNER_ONLY_DIRECTORY_MODE })
  try {
    chmodSync(stateDir, OWNER_ONLY_DIRECTORY_MODE)
  } catch {
    // A filesystem without POSIX modes: the directory exists, which is enough
    // to open the database. Nothing is written anywhere else.
  }
  return stateDir
}

/**
 * Create the file with owner-only permissions if it is missing, and tighten the
 * mode if it already exists.
 *
 * better-sqlite3 has no file-mode option, so the file is created here and
 * SQLite opens the file that already exists. That is also what makes a
 * corrupt-file rebuild land on a fresh `0o600` file instead of whatever the
 * process umask would have produced.
 *
 * SQLite's write-ahead log (`-wal`) and shared-memory (`-shm`) sidecars are
 * created by SQLite itself with the umask's permissions. They are not hardened
 * here because they cannot be created without a live connection; they live
 * inside the `0o700` state directory, which is what keeps them unreadable.
 */
export function ensureOwnerOnlyFile(filePath: string): void {
  if (!existsSync(filePath)) {
    closeSync(openSync(filePath, 'a', OWNER_ONLY_FILE_MODE))
  }
  try {
    chmodSync(filePath, OWNER_ONLY_FILE_MODE)
  } catch {
    // See ensureStateDir: a filesystem without POSIX modes is not fatal.
  }
}

/**
 * Every file that makes up one database on disk, in the order they must be
 * removed to discard it.
 *
 * The rebuild path in db.ts deletes all three. Leaving a stale `-wal` or `-shm`
 * beside a freshly created database would let SQLite replay writes onto a file
 * that has none.
 */
export function databaseFilePaths(filePath: string): readonly string[] {
  return [filePath, `${filePath}-wal`, `${filePath}-shm`]
}

/** The database file inside a state directory. */
export function databaseFilePath(stateDir: string = resolveStateDir()): string {
  return path.join(stateDir, DATABASE_FILE_NAME)
}
