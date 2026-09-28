// Linux autostart: a systemd **user** unit (IO-FR-06, APX-CON-06).
//
// WHERE IT GOES, AND WHY IT IS NOT A HARD-CODED PATH
// systemd reads a user's own units from `$XDG_CONFIG_HOME/systemd/user/`, falling
// back to `~/.config/systemd/user/`. That is the per-user convention, and it is
// the reason a per-user install needs no root: the directory belongs to the user,
// and the manager that loads it is the user's own systemd instance. The path is
// resolved from the same convention here rather than written as a string, so a
// machine with a non-default `XDG_CONFIG_HOME` gets its unit where systemd will
// actually look for it.
//
// IT IS ENABLED BY A FILE, NOT BY A CALL TO systemctl
// `[Install] WantedBy=default.target` plus a symlink in `default.target.wants/` is
// the whole of it: that is precisely what `systemctl --user enable` writes, and
// what `systemctl --user is-enabled` reads back. Creating those two files is
// idempotent, needs no running session manager, and leaves a developer free to
// use `systemctl --user start agent-ping` to bring it up in the current session -
// which the operations runbook records, because starting it *now* is IO-4's and
// IO-5's evidence and not this task's. See ../autostart/index.ts for the argument
// in full.
//
// WHAT IS IN THE UNIT AND WHY
//   Type=simple          the process is the service; nothing forks.
//   ExecStart            this install's own Electron runtime and package root, as
//                        absolute paths. A bare `electron` would resolve against the
//                        login `PATH` and could start a different build.
//   Environment          the Chromium launch policy, both forms, read from
//                        CHROMIUM_LAUNCH_ENVIRONMENT - Chromium decides about the
//                        sandbox before any JavaScript here runs, so whatever
//                        launches the process has to carry it (PRD 16 Q13). Plus
//                        AGENT_PING_STATE_DIR, and only when the operator overrode
//                        it: a login-started hub that resolved the default would
//                        put its runtime file somewhere the plugin never looks.
//   Restart=on-failure   a sidecar that dies comes back; a tray quit exits 0 and
//                        does not. `RestartSec` keeps a crash loop off the CPU.
//   PartOf/After         tied to `graphical-session.target`, because the tray and
//                        the card need a graphical session. Both keys are inert on
//                        a machine without that target, which is the correct
//                        behaviour rather than a failure.
//
// WHAT IS DELIBERATELY NOT IN THE UNIT
// No `User=`, no `UserGroup=`, no `sudo`, no `pkexec`. A user unit runs as the user
// who owns it and systemd rejects `User=` there; the absence is the "runs as the
// current user" claim, and tests/cli/autostart.test.ts asserts it per platform.
//
// VERIFICATION STATE
// Implemented and unit-tested against a temporary home by
// tests/cli/autostart.test.ts. NOT live-verified here: this file has never been
// started by a real systemd user manager on the authoring machine, and no live
// `systemctl` run is part of this task. IO-4's script against the real user
// service manager is that evidence, and IO-5's review is the human gate.

import path from 'node:path'
import {
  AUTOSTART_UNIT_SENTINEL,
  launchEnvironment,
  launchArguments,
  stateDirEnvironment,
  type AutostartLink,
  type AutostartUnit,
  type PlatformUnitContext,
} from './index.js'

/** The file name systemd expects: `<name>.service`. */
export const LINUX_UNIT_NAME = 'agent-ping.service'

/** The target a user unit is wanted by, and the directory that means. */
export const LINUX_WANTS_TARGET = 'default.target'

/**
 * This module writes a *Linux* unit, so every path in it is written in POSIX form.
 *
 * Not the ambient `path`, which is `path.win32` on a Windows host. `tests/cli/
 * autostart.test.ts` drives all three platforms from whichever one it is running on,
 * and `src/cli/autostart/index.ts` already created the unit's directory with
 * `pathApiFor('linux')` - that is, `path.posix`. Joining the path with the ambient
 * flavour instead produced a backslashed path on a Windows host, and then
 * `path.posix.dirname` of that string found no `/` in it, returned `.`, created no
 * directory, and the unit write failed with ENOENT sixteen times over. The two halves
 * disagreed about which platform the path belonged to.
 *
 * `windows.ts` has always done this deliberately with `path.win32`. This is the same
 * rule, applied to the other two.
 */
const POSIX = path.posix

/**
 * systemd's own quoting for a command-line word.
 *
 * A path with a space has to be quoted or systemd splits it into two arguments and
 * the unit fails to start for a reason that has nothing to do with agent-ping.
 * Inside the quotes, `\` and `"` are escaped, and `%` becomes `%%` because
 * systemd expands `%`-specifiers in `ExecStart` - a state directory or a package
 * path containing a literal `%` would otherwise be rewritten before the process
 * ever sees it.
 */
function systemdQuote(value: string): string {
  return `"${value.replace(/([\\"])/g, '\\$1').replace(/%/g, '%%')}"`
}

/**
 * A leading `~` in a configuration variable, expanded against this home.
 *
 * Deliberately a local helper rather than an import: `src/storage/paths.ts` owns
 * the *product's own* state directory and keeps this private, and a systemd unit
 * directory is the platform's convention rather than agent-ping's state. The
 * plugin installer resolves opencode's configuration the same way, and for the
 * same reason.
 */
function expandHome(value: string, home: string): string {
  if (value === '~') return home
  if (value.startsWith('~/') || value.startsWith(`~${POSIX.sep}`)) return POSIX.join(home, value.slice(2))
  return value
}

/**
 * The user unit directory, from systemd's own convention.
 *
 * `$XDG_CONFIG_HOME/systemd/user/` when the variable is set, and
 * `<home>/.config/systemd/user/` otherwise - which is what
 * `systemd.unit(5)` documents as the per-user search path.
 */
export function resolveLinuxUnitDirectory(env: NodeJS.ProcessEnv, home: string): string {
  const xdgConfigHome = env['XDG_CONFIG_HOME']
  const base =
    xdgConfigHome !== undefined && xdgConfigHome.trim() !== ''
      ? expandHome(xdgConfigHome.trim(), home)
      : POSIX.join(home, '.config')
  return POSIX.join(base, 'systemd', 'user')
}

/** The unit file this install owns, at systemd's per-user convention path. */
export function resolveLinuxUnitPath(context: Pick<PlatformUnitContext, 'env' | 'home'>): string {
  return POSIX.join(resolveLinuxUnitDirectory(context.env, context.home), LINUX_UNIT_NAME)
}

/**
 * The unit: where it is, what it says, and the one extra path it owns.
 *
 * Resolved rather than written, so `tests/cli/autostart.test.ts` can read the unit
 * a given machine would get without writing it - and so a test can assert the
 * path a platform's convention produces for each of the three.
 */
export function resolveLinuxUnit(context: PlatformUnitContext): AutostartUnit {
  const unitPath = resolveLinuxUnitPath(context)
  const { install } = context
  const executable = install.electronPath ?? 'electron'
  const command = [systemdQuote(executable), systemdQuote(install.root), ...launchArguments()].join(' ')
  const environment: Record<string, string> = { ...launchEnvironment(), ...stateDirEnvironment(context.env, context.stateDir) }
  const header = [
    `# ${AUTOSTART_UNIT_SENTINEL} - written by \`agent-ping install\``,
    '#',
    '# Regenerated by every install and removed by `agent-ping uninstall`. Do not edit it by',
    '# hand: the next install overwrites it.',
    '#',
    ...(install.version === null ? [] : [`# agent-ping ${install.version}`]),
    ...(install.binPath === null ? [] : [`# command:  ${install.binPath}`]),
    `# package:  ${install.root}`,
    `# runtime:  ${executable}`,
    '#',
    '# A *user* unit: it belongs to the account that installed agent-ping, it is loaded by',
    "# that account's own systemd user manager, and it needs no root. It names no user of its",
    '# own, so it cannot be started on another account\'s behalf.',
  ]
  const content = [
    ...header,
    '',
    '[Unit]',
    `Description=agent-ping${install.version === null ? '' : ` ${install.version}`} - local notification dashboard for coding agents`,
    `PartOf=graphical-session.target`,
    `After=graphical-session.target`,
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${command}`,
    ...Object.entries(environment).map(([name, value]) => `Environment=${systemdQuote(`${name}=${value}`)}`),
    'Restart=on-failure',
    'RestartSec=5',
    'KillSignal=SIGTERM',
    'TimeoutStopSec=20',
    '',
    '[Install]',
    `WantedBy=${LINUX_WANTS_TARGET}`,
    '',
  ].join('\n')

  const links: readonly AutostartLink[] = [
    {
      path: POSIX.join(POSIX.dirname(unitPath), `${LINUX_WANTS_TARGET}.wants`, LINUX_UNIT_NAME),
      target: unitPath,
    },
  ]
  // Two directories, both created to hold this unit and both removed by disabling it:
  // systemd's own per-user root and the `user` subtree inside it. The root comes from
  // the same function the path came from, so the two cannot drift apart. The base
  // above it (`~/.config`) is deliberately not listed - it is a directory this
  // product did not create and has no business removing.
  const ownedDirectories: readonly string[] = [
    POSIX.dirname(resolveLinuxUnitDirectory(context.env, context.home)),
    POSIX.dirname(unitPath),
  ]
  return { platform: 'linux', kind: 'systemd user unit', unitPath, content, links, ownedDirectories }
}
