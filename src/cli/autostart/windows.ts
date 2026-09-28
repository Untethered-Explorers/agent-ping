// Windows autostart: a per-user Startup-folder entry (IO-FR-06, APX-CON-06,
// and the answer to Open Question 1 in the install/operations feature document:
// "Startup-folder entry, since it needs no elevation and is trivially reversible").
//
// WHERE IT GOES, AND WHY IT IS NOT A HARD-CODED PATH
// Explorer runs everything in the per-user Startup folder at logon, so the folder
// *is* the enablement: one file, no registry key, no scheduled task, nothing that
// would need elevation and nothing left behind by a "disabled" leftover. The
// folder is `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup`, resolved
// from the environment with the documented profile fallback, rather than written
// as a literal.
//
// A NOTE ON `%APPDATA%`, BECAUSE THIS PRODUCT USUALLY IGNORES IT
// `src/plugin/install/global-plugin.ts` deliberately does *not* follow `%APPDATA%`
// when it resolves opencode's configuration, because opencode resolves its own
// base directories with `xdg-basedir` and ignores the Windows variables. That is
// opencode's convention, not Windows'. The Startup folder genuinely lives under
// `%APPDATA%`, so this module follows it - and a reader who "fixes" this to match
// the plugin installer would write the entry where Explorer never looks, which is
// the same silent no-op in a different directory.
//
// WHY A `.cmd` AND NOT A SHORTCUT
// A `.lnk` is a binary shell link: creating one needs COM, a script host, or a
// hand-written OLE structure, none of which can be reviewed in a diff or verified
// from a Linux machine. A batch file is plain text, it is what the platform itself
// runs, and it is the one artefact a developer can read to see exactly what will
// happen at logon. `start "" /b` hands the process off without leaving the console
// window the logon shell would otherwise flash.
//
// WHAT IS IN THE ENTRY AND WHY
//   ELECTRON_DISABLE_SANDBOX  the Chromium launch policy, read from
//                             CHROMIUM_LAUNCH_ENVIRONMENT. Chromium decides about
//                             the sandbox before any JavaScript here runs, so
//                             whatever launches the process has to carry it (PRD
//                             16 Q13), and a batch file setting an environment
//                             variable is the only form it can carry.
//   --no-sandbox              the same decision as a switch on the command line,
//                             read from CHROMIUM_LAUNCH_FLAGS rather than
//                             restated, so a change to the policy cannot leave
//                             this entry behind it.
//   AGENT_PING_STATE_DIR      only when the operator overrode it: a login-started
//                             hub that resolved the default would put its runtime
//                             file somewhere the plugin never looks.
//   the executable and the    this install's own Electron runtime and package
//   package root              root, as absolute paths. A bare `electron` would
//                             resolve against the logon `PATH` and could start a
//                             different build.
//
// WHAT IS DELIBERATELY NOT IN THE ENTRY
// No `runas`, no `Start-Process -Verb RunAs`, no scheduled task, no `HKLM` write.
// A Startup-folder entry runs as the user who is logging in, and its absence of
// any elevation is the "runs as the current user" claim; asserted per platform in
// tests/cli/autostart.test.ts.
//
// VERIFICATION STATE
// Implemented and unit-tested against a temporary home by
// tests/cli/autostart.test.ts, including the path assembled with Windows' own path
// rules so the separators in the generated file are the ones Windows will read.
// NOT live-verified here: no Windows machine was available, no logon has been
// observed, and the logon shell's behaviour is a documented manual step in the
// operations runbook. Only a human gate on Windows can close that.

import path from 'node:path'
import {
  AUTOSTART_UNIT_SENTINEL,
  launchEnvironment,
  launchArguments,
  stateDirEnvironment,
  type AutostartUnit,
  type PlatformUnitContext,
} from './index.js'

/** The entry's file name inside the Startup folder. */
export const WINDOWS_ENTRY_NAME = 'agent-ping.cmd'

/**
 * The per-user Startup folder, from Windows' own convention.
 *
 * `%APPDATA%` when it is set, and `<home>\AppData\Roaming` when it is not - the
 * documented location of the roaming profile for the account being logged in.
 * `path.win32.join` is used rather than `path.join` so that the separators in the
 * path are the ones Windows reads, which is also what makes the generated file
 * correct when it is assembled for review on a machine that is not Windows.
 */
export function resolveWindowsStartupDirectory(env: NodeJS.ProcessEnv, home: string): string {
  const appData = env['APPDATA']
  const base =
    appData !== undefined && appData.trim() !== ''
      ? appData.trim()
      : path.win32.join(home, 'AppData', 'Roaming')
  return path.win32.join(base, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
}

/** The Startup-folder entry this install owns. */
export function resolveWindowsUnitPath(env: NodeJS.ProcessEnv, home: string): string {
  return path.win32.join(resolveWindowsStartupDirectory(env, home), WINDOWS_ENTRY_NAME)
}

/**
 * Quote one argument for `cmd.exe`.
 *
 * The quotes are what make a path with a space one argument. Inside them `%` is
 * doubled, because a batch file expands `%VAR%` before `cmd` ever sees the line -
 * a state directory containing a literal `%` would otherwise be rewritten into
 * something else, silently, at logon. `"` cannot occur in a Windows path, and `&`
 * and `^` need no escaping inside quotes.
 */
function cmdQuote(value: string): string {
  return `"${value.replace(/%/g, '%%')}"`
}

/**
 * The entry: where it is, what it says, and the paths it owns.
 *
 * The comment is a `rem`, so it is a comment to the batch file and text in the
 * file a developer reads; it carries the sentinel this product recognises its own
 * units by, and no path that would need quoting.
 */
export function resolveWindowsUnit(context: PlatformUnitContext): AutostartUnit {
  const startupDirectory = resolveWindowsStartupDirectory(context.env, context.home)
  const unitPath = resolveWindowsUnitPath(context.env, context.home)
  const { install } = context
  const executable = install.electronPath ?? 'electron'
  const environment: Record<string, string> = {
    ...launchEnvironment(),
    ...stateDirEnvironment(context.env, context.stateDir),
  }
  const header = [
    '@echo off',
    `rem ${AUTOSTART_UNIT_SENTINEL}`,
    'rem Written by `agent-ping install`; regenerated by every install and removed by',
    'rem `agent-ping uninstall`. Do not edit it by hand.',
    ...(install.version === null ? [] : [`rem agent-ping ${install.version}`]),
    ...(install.binPath === null ? [] : [`rem command: ${install.binPath}`]),
    `rem package: ${install.root}`,
    `rem runtime: ${executable}`,
    'rem A per-user Startup-folder entry: it runs as the user logging in, asks for no',
    'rem elevation, and is removed by disabling it.',
    '',
  ]
  const body = [
    ...Object.entries(environment).map(([name, value]) => `set ${cmdQuote(`${name}=${value}`)}`),
    // `start "" /b` - the first quoted argument is the window title, so the empty
    // one is required once the executable is quoted; `/b` hands the process off
    // without a console window at logon.
    `start "" /b ${cmdQuote(executable)} ${cmdQuote(install.root)} ${launchArguments().join(' ')}`,
  ]
  return {
    platform: 'win32',
    kind: 'Windows startup-folder entry',
    unitPath,
    content: [...header, ...body, ''].join('\r\n'),
    // Explorer's Startup folder *is* the registration: there is no second artefact
    // to own, and nothing to leave behind but the file itself.
    links: [],
    // Explorer reads the Startup folder, so the folder itself is the only directory
    // this entry owns. The `%APPDATA%` profile above it is not ours.
    ownedDirectories: [startupDirectory],
  }
}
