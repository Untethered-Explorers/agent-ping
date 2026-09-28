// macOS autostart: a launchd **user** agent (IO-FR-06, APX-CON-06).
//
// WHERE IT GOES, AND WHY IT IS NOT A HARD-CODED PATH
// launchd loads every plist in `~/Library/LaunchAgents/` for the user who owns
// them, at login, with no root and no `launchctl` call. That is the per-user
// convention and the reason the enablement is a single file: writing the plist
// *is* enabling it. The directory is resolved from the home the command was given
// rather than written as a literal, so a temporary home in a test and a real home
// on a machine are the same code path.
//
// THE LABEL, AND WHY IT IS NOT A DOMAIN THIS PRODUCT OWNS
// launchd keys a job by its `Label`, and two jobs with one label collide. The
// conventional shape is a reverse-DNS name, but this product owns no domain, and a
// label that looks like somebody else's reverse-DNS name is a name somebody else
// may already own. `local.` is the TLD reserved by RFC 6762 for exactly this -
// names that are never resolvable on the public DNS - so the label cannot collide
// with a real registrable domain, and the file is named after it the way launchd
// expects.
//
// WHAT IS IN THE PLIST AND WHY
//   ProgramArguments    this install's own Electron runtime and package root, as
//                       absolute paths. A bare `electron` would resolve against the
//                       login `PATH` and could start a different build.
//   EnvironmentVariables  the Chromium launch policy, read from
//                       CHROMIUM_LAUNCH_ENVIRONMENT - Chromium decides about the
//                       sandbox before any JavaScript here runs, so whatever
//                       launches the process has to carry it (PRD 16 Q13). Plus
//                       AGENT_PING_STATE_DIR, and only when the operator overrode
//                       it: a login-started hub that resolved the default would put
//                       its runtime file somewhere the plugin never looks.
//   RunAtLoad           the point of the file: start at login.
//   KeepAlive           as a dictionary with `SuccessfulExit` false, which is
//                       systemd's `Restart=on-failure` in launchd's spelling: a
//                       hub that dies comes back, and a tray the developer quit is
//                       exit 0 and stays quit.
//   ProcessType         `Interactive`, because the tray and the card are window-
//                       server clients and a background QoS is for daemons.
//   LimitLoadToSessionType  `Aqua` only: an SSH session has no window server, and
//                       starting a tray there produces a hub that cannot draw.
//
// WHAT IS DELIBERATELY NOT IN THE PLIST
// No `UserName` - that is how a launchd job asks to run as somebody else, it
// requires root to be set, and its absence is the "runs as the current user"
// claim. No `StandardOutPath`/`StandardErrorPath`: pointing them at a file would
// create a second, *unbounded* log beside the product's bounded local log
// (IO-FR-09), and this product's own diagnostics are `agent-ping doctor` plus that
// log. The AgentPing* keys are provenance this product reads back and the operator
// can read with `launchctl print`; launchd ignores keys it does not know.
//
// VERIFICATION STATE
// Implemented and unit-tested against a temporary home by
// tests/cli/autostart.test.ts. NOT live-verified here: this plist has never been
// loaded by a real launchd on the authoring machine, and no macOS machine was
// available. The same limitation is stated in the operations runbook and in
// README.md, and only a human gate on macOS can close it.

import path from 'node:path'
import {
  AUTOSTART_UNIT_SENTINEL,
  launchEnvironment,
  launchArguments,
  stateDirEnvironment,
  type AutostartUnit,
  type PlatformUnitContext,
} from './index.js'

/**
 * The launchd job label, and therefore the plist's file name.
 *
 * See the note above on `local.`. It is exported because a test, the runbook and
 * `doctor`'s remedy all have to name the same file, and one exported constant is
 * how they are kept to naming the same file.
 */
export const MACOS_AGENT_LABEL = 'local.agent-ping.hub'

/**
 * This module writes a *macOS* agent, so every path in it is written in POSIX form.
 *
 * The same rule, and the same reason, as in `linux.ts`: not the ambient `path`, which
 * is `path.win32` on a Windows host, and which disagreed with the `pathApiFor('darwin')`
 * that `src/cli/autostart/index.ts` used to create the containing directory. Joining
 * with the ambient flavour gave a backslashed plist path on a Windows host, so the
 * directory was never created and the write failed with ENOENT. `windows.ts` has always
 * used `path.win32` for the same reason.
 */
const POSIX = path.posix

/** The per-user agent directory, from launchd's own convention. */
export function resolveLaunchAgentsDirectory(home: string): string {
  return POSIX.join(home, 'Library', 'LaunchAgents')
}

/** The agent plist this install owns. */
export function resolveMacosUnitPath(home: string): string {
  return POSIX.join(resolveLaunchAgentsDirectory(home), `${MACOS_AGENT_LABEL}.plist`)
}

/**
 * Escape text for a plist `<string>`.
 *
 * `&`, `<` and `>` are the three that can end a value early; a path containing
 * `&` is legal on macOS and a plist that does not parse is a job launchd silently
 * never loads, so this is not a formality.
 */
function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * One `<key>`/`<value>` pair, on the lines launchd's own plists use.
 *
 * A whole pair rather than a template so that a boolean, a number and a string
 * cannot be confused for one another: `true` is `<true/>` and never the word. The
 * indent is a parameter because this file is read by a person debugging a login
 * that did not happen, and a plist whose nesting is invisible in the indentation
 * is harder to read than the two extra lines are worth.
 */
function entry(key: string, value: string, indent = '  '): readonly string[] {
  return [`${indent}<key>${xmlEscape(key)}</key>`, `${indent}<string>${xmlEscape(value)}</string>`]
}

function boolEntry(key: string, value: boolean, indent = '  '): readonly string[] {
  return [`${indent}<key>${xmlEscape(key)}</key>`, `${indent}<${value ? 'true' : 'false'}/>`]
}

/**
 * The agent: where it is, what it says, and the paths it owns.
 *
 * The sentinel is a *constant* XML comment rather than an interpolated one, and
 * that is deliberate: `--` is not legal inside an XML comment, and a home
 * directory containing `--` would make the whole plist unparseable - so the
 * comment carries no path at all, and every path this unit needs is either a
 * proper `<string>` value or one of the provenance keys, both escaped above.
 */
export function resolveMacosUnit(context: PlatformUnitContext): AutostartUnit {
  const unitDirectory = resolveLaunchAgentsDirectory(context.home)
  const unitPath = resolveMacosUnitPath(context.home)
  const { install } = context
  const executable = install.electronPath ?? 'electron'
  const environment: Record<string, string> = {
    ...launchEnvironment(),
    ...stateDirEnvironment(context.env, context.stateDir),
  }

  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!--',
    `  ${AUTOSTART_UNIT_SENTINEL}`,
    '  Written by `agent-ping install`; regenerated by every install and removed by',
    '  `agent-ping uninstall`. Do not edit it by hand.',
    '-->',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    ...entry('Label', MACOS_AGENT_LABEL),
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    <string>${xmlEscape(executable)}</string>`,
    `    <string>${xmlEscape(install.root)}</string>`,
    ...launchArguments().map((flag) => `    <string>${xmlEscape(flag)}</string>`),
    '  </array>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    ...Object.entries(environment).flatMap(([name, value]) => entry(name, value, '    ')),
    '  </dict>',
    ...boolEntry('RunAtLoad', true),
    '  <key>KeepAlive</key>',
    '  <dict>',
    ...boolEntry('SuccessfulExit', false, '    '),
    '  </dict>',
    ...entry('ProcessType', 'Interactive'),
    ...entry('LimitLoadToSessionType', 'Aqua'),
    // Provenance. This product reads these back to decide whether the file is
    // ours; an operator reads them with `launchctl print` to see which install
    // wrote the job. launchd ignores keys it does not know.
    ...(install.version === null ? [] : entry('AgentPingVersion', install.version)),
    ...(install.binPath === null ? [] : entry('AgentPingCommand', install.binPath)),
    ...entry('AgentPingPackage', install.root),
    ...entry('AgentPingRuntime', executable),
    '</dict>',
    '</plist>',
    '',
  ]

  return {
    platform: 'darwin',
    kind: 'launchd user agent',
    unitPath,
    content: lines.join('\n'),
    // launchd loads everything in ~/Library/LaunchAgents at login, so there is no
    // second artefact to own. That asymmetry with Linux is the platform's, and
    // saying it here is why the test asserts the right count per platform rather
    // than one count for all three.
    links: [],
    // launchd holds the agent in the convention directory itself, so that directory
    // is the only one this unit owns. `~/Library` above it is not ours.
    ownedDirectories: [unitDirectory],
  }
}
