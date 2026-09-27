# Feature: Install, Autostart and Operations

## Traceability

| Canonical ID | Owner / Source Link | Relationship |
|--------------|---------------------|--------------|
| APX-US-01 | [Vision](../PRD.md#17. Traceability Matrix) | participates |
| APX-CON-05 | [Vision](../PRD.md#17. Traceability Matrix) | participates |
| APX-CON-06 | [Vision](../PRD.md#17. Traceability Matrix) | participates |
| APX-CON-12 | [Vision](../PRD.md#17. Traceability Matrix) | participates |
| IO-FR-01 | This feature | owns |
| IO-FR-02 | This feature | owns |
| IO-FR-03 | This feature | owns |
| IO-FR-04 | This feature | owns |
| IO-FR-05 | This feature | owns |
| IO-FR-06 | This feature | owns |
| IO-FR-07 | This feature | owns |
| IO-FR-08 | This feature | owns |
| IO-FR-09 | This feature | owns |

**PRD:** [docs/PRD.md](../PRD.md)

---

## 1. Feature Overview

**Feature Name:** Install, Autostart and Operations
**ID Prefix:** IO
**Summary:** One global install and one command that tells the truth: the npm package and its binary, an installer that wires the plugin and per-platform autostart, a doctor that names what is broken, and a logout-and-back-in path that leaves the hub running without anybody thinking about it.
**Dependencies:** Notification and Tray Presence, opencode Plugin Adapter
**Priority:** Must

---

## 2. User Stories

| ID | As a... | I want to... | So that... | Priority |
|----|---------|-------------|-----------|----------|
| IO-US-01 | developer on a new machine | run one install command | so that agent-ping is working before I start my first session | Must |
| IO-US-02 | developer whose notifications stopped | run one diagnostic command | so that I learn what is wrong instead of guessing | Must |
| IO-US-03 | developer who no longer wants it | uninstall cleanly | so that nothing of mine is left behind | Must |

---

## 3. Functional Requirements

```forge-requirement
{"id":"IO-FR-01","kind":"requirement","text":"The project publishes as an npm global package exposing an agent-ping binary, with a files allowlist and a prepack check that fails when any required build artefact is missing."}
```

```forge-requirement
{"id":"IO-FR-02","kind":"requirement","text":"The install command writes the global plugin, enables autostart for the current platform, verifies hub health, and prints exactly what it changed."}
```

```forge-requirement
{"id":"IO-FR-03","kind":"requirement","text":"The uninstall command removes the global plugin, disables autostart and leaves the database in place unless a purge flag is passed."}
```

```forge-requirement
{"id":"IO-FR-04","kind":"requirement","text":"The doctor command checks the runtime version, database path and writability, port availability, plugin presence and version, autostart state, notification-surface availability and tray availability, prints an actionable remedy for each failure, and exits non-zero when any check fails."}
```

```forge-requirement
{"id":"IO-FR-05","kind":"requirement","text":"The status command reports the pending count, the time of the most recent event, hub uptime and the number of active sessions, and says so plainly when the hub is not running."}
```

```forge-requirement
{"id":"IO-FR-06","kind":"requirement","text":"Autostart is a user-level unit on each platform, needs no root, and can be enabled and disabled repeatedly with no error and no duplicate entries."}
```

```forge-requirement
{"id":"IO-FR-07","kind":"requirement","text":"State resolves to a platform directory that an environment variable can override, and every path the product writes is created with owner-only permissions."}
```

```forge-requirement
{"id":"IO-FR-08","kind":"requirement","text":"Running install again is safe, reports that nothing changed, and detects a version mismatch between the installed plugin and the package."}
```

```forge-requirement
{"id":"IO-FR-09","kind":"requirement","text":"The product writes a structured local log with bounded size that contains no conversation content, and a verbose flag mirrors it to standard output."}
```

**Priority:** every requirement in this feature is Must.

---

## 4. UI / Interaction Design

No graphical surface. The product's whole user interface here is terminal output, and it is treated as one: aligned check names, one line of remedy per failure, and a non-zero exit code whenever something is wrong, so a script can trust it.

---

## 5. Implementation Tasks

Task review table, kept outside the phase contracts as authoring evidence.

| ID | Outcome | Owner | Needs | Files | Checks | Excluded |
|---|---|---|---|---|---|---|
| IO-1 | The package installs globally and its build artefacts are guaranteed present | packaging-engineer | HC-1 build, DP-1 scripts | package.json, scripts/prepack-check.mjs, tests/packaging/package.test.ts | prepack check test | No CLI commands, no autostart |
| IO-2 | install, uninstall, status and doctor work and fail loudly | packaging-engineer | IO-1, OA-3, NT-3 | src/cli/index.ts, install.ts, doctor.ts, status.ts, tests/cli/install.test.ts, tests/cli/doctor.test.ts | CLI tests including non-zero exit | No autostart units |
| IO-3 | Autostart is installed, idempotent and reversible on all three platforms | packaging-engineer | IO-2 | src/cli/autostart/index.ts, linux.ts, macos.ts, windows.ts, tests/cli/autostart.test.ts | autostart tests against a temporary home | No live systemctl run |
| IO-4 | A script proves login, restart and pending survival on Linux | qa-engineer | IO-2, IO-3, OA-5 | scripts/verify-autostart-linux.mjs, tests/scripts/verify-autostart-linux.test.ts | script test plus documented real run | No human judgement |
| IO-5 | A human confirms the install is one command and the diagnosis is useful | human reviewer | IO-4, NT-4, NT-5 | docs/reviews/operations.json | recorded verdict plus the journey | No code changes |

### Phase 1: Package and command line

```forge-task
{
  "id": "IO-1",
  "title": "Publish the package and guard its build artefacts",
  "description": "Turn the project into an installable global npm package. Declare the agent-ping binary, a files allowlist that includes only what must ship, and the packaging metadata for each platform dependency, extending the existing package manifest without removing the scripts established earlier. Because Electron is now a load-bearing runtime dependency, ship whatever the installed Electron needs to launch on a per-user install and make the prepack check assert that the chosen Chromium process-sandbox launch policy is present in the packaged entry point, so a package that would abort at startup on the target platform cannot ship. The dashboard build now emits more than one document: assert that both the dashboard document and the notification card document are present in the build output, and add a test that serving the card document over the loopback static route does not count as a dashboard open, because the counter that backs the unprompted-pull success metric must mean a human opened the dashboard. Add a prepack check that fails when any required build artefact is missing, so a package can never be published or installed in a broken state, and make it verify the Electron main bundle, the dashboard build, the notification card document and the plugin file that the installer writes. Add a test that runs the check against a deliberately incomplete tree and asserts it fails, and against a complete tree and asserts it passes. Exclude the command implementations and autostart.",
  "ownerAgent": "packaging-engineer",
  "dependencies": ["DP-1", "HC-1", "NT-6"],
  "expectedOutputs": ["package.json", "scripts/prepack-check.mjs", "tests/packaging/package.test.ts"],
  "validationCommands": ["npm test -- tests/packaging/package.test.ts", "npm run typecheck"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/install-autostart-and-operations.md#IO-FR-01"],
    "acceptanceCriteria": [
      "A test asserts the prepack check fails when a required build artefact is absent and passes when all are present",
      "A test asserts the prepack check requires both the dashboard document and the notification card document in the build output",
      "A test asserts the packaged entry point applies the chosen Chromium process-sandbox launch policy rather than relying on a platform default",
      "A test asserts serving the notification card document over the loopback static route does not increment the dashboard-open counter",
      "A test asserts the files allowlist excludes source maps, tests and development-only configuration",
      "A test asserts the declared binary name matches the command the installer documentation uses"
    ],
    "constraints": ["Node.js 22 LTS or newer with TypeScript and npm only", "No telemetry leaves the machine"],
    "constraintRefs": ["docs/PRD.md#APX-CON-05", "docs/PRD.md#APX-CON-12"],
    "references": ["docs/PRD.md#6.1 Technology Stack", "docs/PRD.md#6.2 Project Structure", "docs/features/install-autostart-and-operations.md#3. Functional Requirements", "docs/research/electron-surface-preflight.json"]
  }
}
```

```forge-task
{
  "id": "IO-2",
  "title": "Implement the install, uninstall, status and doctor commands",
  "description": "Implement the agent-ping command line on top of the existing installer, tray, notification-surface and autostart interfaces. Install writes the global plugin, enables platform autostart, starts the hub if needed, verifies health, and prints exactly what it changed; running it again must be safe, report that nothing changed, and detect a plugin version mismatch. Uninstall removes the plugin, disables autostart, and keeps the database unless a purge flag is given. Status reports pending count, most recent event time, hub uptime and active session count, and says plainly when the hub is not running. Doctor checks the runtime version, database path and writability, port availability, plugin presence and version, autostart state, notification-surface availability and tray availability, printing one actionable remedy per failure and exiting non-zero when any check fails. Surface availability means the host can actually create its window on this machine, which is a different question from whether Electron is installed, and the remedy must name the difference rather than telling the developer to reinstall something that is already present. Resolve every path through the overridable platform state directory created with owner-only permissions, and write the bounded structured local log with no content. Add tests that invoke the command dispatcher in the command entry point for each subcommand, including the failure exits. Exclude the autostart unit implementations.",
  "ownerAgent": "packaging-engineer",
  "dependencies": ["IO-1", "OA-3", "NT-3", "NT-8"],
  "expectedOutputs": ["src/cli/index.ts", "src/cli/install.ts", "src/cli/doctor.ts", "src/cli/status.ts", "tests/cli/install.test.ts", "tests/cli/doctor.test.ts"],
  "validationCommands": ["npm test -- tests/cli/install.test.ts tests/cli/doctor.test.ts", "npm run typecheck"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/install-autostart-and-operations.md#IO-FR-02", "docs/features/install-autostart-and-operations.md#IO-FR-03", "docs/features/install-autostart-and-operations.md#IO-FR-04", "docs/features/install-autostart-and-operations.md#IO-FR-05", "docs/features/install-autostart-and-operations.md#IO-FR-07", "docs/features/install-autostart-and-operations.md#IO-FR-08", "docs/features/install-autostart-and-operations.md#IO-FR-09"],
    "acceptanceCriteria": [
      "A test asserts install writes the plugin, enables autostart, verifies health and lists what it changed",
      "A test asserts a second install reports no changes and a plugin version mismatch is reported rather than silently accepted",
      "A test asserts uninstall keeps the database by default and removes it only with the purge flag",
      "A test asserts doctor exits non-zero when any single check fails and prints a remedy naming that check",
      "A test asserts doctor distinguishes a missing notification surface from a present one and that a refused surface window is reported as a failure with its own remedy",
      "A test asserts status reports pending count, last event time, uptime and active sessions, and says the hub is not running when it is down",
      "Each test invokes the subcommand through the command entry point rather than calling an internal function directly"
    ],
    "constraints": ["No telemetry leaves the machine", "A delivery failure is never silent"],
    "constraintRefs": ["docs/PRD.md#APX-CON-12", "docs/PRD.md#APX-CON-10"],
    "references": ["docs/features/install-autostart-and-operations.md#4. UI / Interaction Design", "docs/features/opencode-plugin-adapter.md#3. Functional Requirements", "docs/IDEA.md#Availability Contract"]
  }
}
```

### Phase 2: Autostart

```forge-task
{
  "id": "IO-3",
  "title": "Install and remove per-platform autostart units",
  "description": "Implement autostart for all three supported platforms behind one interface: a systemd user unit on Linux, a launchd agent on macOS, and a per-user startup entry on Windows. Each implementation must create its unit with owner-only permissions, require no root, be idempotent across repeated enable and disable calls, and remove every trace on disable so a disabled install leaves nothing behind. Resolve the unit location from the platform convention rather than a hard-coded path, and use the packaged binary as the executable. Add tests for enable, double enable, disable, double disable and a foreign unit that must be left alone, all against a temporary home directory, plus tests asserting the generated unit content names the correct binary and requires no elevated privilege. Exclude any live system service manipulation.",
  "ownerAgent": "packaging-engineer",
  "dependencies": ["IO-2"],
  "expectedOutputs": ["src/cli/autostart/index.ts", "src/cli/autostart/linux.ts", "src/cli/autostart/macos.ts", "src/cli/autostart/windows.ts", "tests/cli/autostart.test.ts"],
  "validationCommands": ["npm test -- tests/cli/autostart.test.ts", "npm run typecheck"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/install-autostart-and-operations.md#IO-FR-06", "docs/features/install-autostart-and-operations.md#IO-FR-07"],
    "acceptanceCriteria": [
      "A test asserts enabling twice produces one unit and disabling twice is a safe no-op for each platform implementation",
      "A test asserts disabling removes the unit and leaves no agent-ping entry behind",
      "A test asserts each generated unit names the packaged binary, runs as the current user and requests no elevated privilege",
      "A test asserts a pre-existing unrelated unit in the same location is left untouched"
    ],
    "constraints": ["Platform support is Linux, macOS and Windows in v1", "No telemetry leaves the machine"],
    "constraintRefs": ["docs/PRD.md#APX-CON-06", "docs/PRD.md#APX-CON-12"],
    "references": ["docs/PRD.md#16. Open Questions", "docs/features/install-autostart-and-operations.md#8. Open Questions", "docs/IDEA.md#Availability Contract"]
  }
}
```

### Phase 3: Live operations verification and gate

```forge-task
{
  "id": "IO-4",
  "title": "Write the live autostart and restart verification script",
  "description": "Write one repository script that proves the operational contract on the real machine. Install into a temporary state directory with the real user service manager, start the hub, assert health, create a pending item, stop the hub, start it again through the service manager, and assert the pending item, its history row and the pending count survived unchanged and were not duplicated. Then disable autostart and assert the unit is gone, and assert the plugin file is removed by uninstall while the database survives. Print what was observed and exit non-zero on any failed assertion, with no path that reports success when nothing ran. Cover the script's own decision logic with a test driving it against injected command results, and record in the runbook that macOS and Windows need the same script run on those machines. Exclude human judgement.",
  "ownerAgent": "qa-engineer",
  "dependencies": ["IO-2", "IO-3", "OA-5"],
  "expectedOutputs": ["scripts/verify-autostart-linux.mjs", "tests/scripts/verify-autostart-linux.test.ts"],
  "validationCommands": ["npm test -- tests/scripts/verify-autostart-linux.test.ts", "npm run typecheck"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/install-autostart-and-operations.md#IO-FR-06", "docs/features/install-autostart-and-operations.md#IO-FR-08"],
    "acceptanceCriteria": [
      "A test drives the script against injected command results and asserts it fails when the pending item does not survive a restart",
      "A test asserts the script exits non-zero when the service manager is unavailable rather than reporting success",
      "The script asserts disable removes the unit and uninstall removes the plugin while keeping the database",
      "The runbook states that the same script must be run on macOS and Windows for those platforms to be claimed"
    ],
    "constraints": ["Never invent passing results, tool availability, deployed resources, human review or compliance"],
    "constraintRefs": ["docs/PRD.md#APX-CON-06"],
    "references": ["docs/PRD.md#12. Dependencies and Risks", "docs/features/install-autostart-and-operations.md#6. Testing Strategy", "docs/IDEA.md#Availability Contract"]
  }
}
```

```forge-task
{
  "id": "IO-5",
  "title": "Review the install and diagnostic experience",
  "description": "Human review of operations on this machine. From a clean state, install the package globally, start an ordinary opencode session, and confirm the hub is running without any manual step after the next login or restart of the session environment. Then break things on purpose one at a time: stop the hub, occupy the port, remove the plugin file, and make the notification surface un-mountable by taking its card document out of the build, using the manual commands in docs/runbooks/notification-surface.md where the failure is notification-related. After each, run the doctor command and record what it printed, whether the remedy was actionable, and whether the exit code was non-zero. The surface breakage matters more than the others: confirm doctor reports a surface that cannot create a window as a distinct failure, with a remedy that names the real cause rather than telling the developer to reinstall something already installed. Finish with uninstall and confirm nothing of the product remains except the database. Record the platform each observation was made on. Because the surface is one code path, state plainly that the same code runs on macOS and Windows and that only the window manager differs, and record which of those platforms, if any, were actually available to observe. Do not change code in this task.",
  "dependencies": ["IO-4", "NT-9"],
  "expectedOutputs": [],
  "validationCommands": [],
  "contract": {
    "version": 2,
    "kind": "human-review",
    "requirements": [],
    "requirementRefs": ["docs/features/install-autostart-and-operations.md#IO-FR-02", "docs/features/install-autostart-and-operations.md#IO-FR-03", "docs/features/install-autostart-and-operations.md#IO-FR-04", "docs/features/install-autostart-and-operations.md#IO-FR-06"],
    "acceptanceCriteria": [
      "The reviewer installed from a clean state and confirmed the hub runs with no manual step, stating the platform used",
      "For each deliberate breakage the reviewer recorded what doctor printed, whether the remedy was actionable, and the exit code",
      "The reviewer uninstalled and confirmed nothing remained except the database",
      "The reviewer recorded, per platform, that the same surface code path runs and that only the window manager differs, and named exactly what was not observable from the machine they used rather than reporting a pass for it"
    ],
    "constraints": ["Platform support is Linux, macOS and Windows in v1", "A subjective judgement never stands alone; the journey must have been performed against the running system"],
    "constraintRefs": ["docs/PRD.md#APX-CON-06"],
    "reviewFile": "docs/reviews/operations.json",
    "references": ["docs/features/notification-and-tray-presence.md#8. Open Questions", "docs/features/install-autostart-and-operations.md#4. UI / Interaction Design", "docs/PRD.md#16. Open Questions"]
  }
}
```

---

## 6. Testing Strategy

| Level | Scope | Approach |
|-------|-------|----------|
| Unit | Command behaviour and exit codes | Each command invoked with an injected environment and temporary home |
| Integration | Autostart units | Real files in a temporary home, asserting content, idempotency and removal |
| Packaging | Prepack guard | Deliberately incomplete and deliberately complete trees |
| Live | Service manager, restart, uninstall | Repository script against the real user service manager on Linux |
| Manual | Diagnostic usefulness | Human gate breaking one thing at a time |

Key test scenarios:

1. Install twice produces no duplicate and reports no changes.
2. Doctor exits non-zero for each individual failure and names a remedy.
3. Autostart enable and disable are idempotent on all three platforms.
4. A pending item survives a stop and start through the service manager exactly once.
5. Uninstall removes the plugin and autostart, keeping the database.

---

## 7. Acceptance Criteria

1. `npm install -g` yields a working `agent-ping` command with a prepack guard that cannot ship a broken build.
2. Install, uninstall, status and doctor behave as specified and fail loudly with actionable remedies.
3. Autostart is installed idempotently as a user-level unit on Linux, macOS and Windows.
4. Pending state survives a stop and start, and the live script proves it on Linux.
5. The human review file records the operational journey, the deliberate breakages and any outstanding platform gates.

---

## 8. Open Questions

| # | Question | Default Assumption |
|---|----------|--------------------|
| 1 | Should Windows autostart use a Startup-folder entry or a scheduled task? | Startup-folder entry, since it needs no elevation and is trivially reversible |
| 2 | What log size bound is enough for diagnosis without growth? | Rotate at 2 MB, keep two files |
| 3 | Should `doctor` ever attempt a repair, or only report? | Report only; a tool that fixes things silently is harder to trust |
| 4 | Is a purge flag on uninstall enough, or should the database be deleted unconditionally? | Purge is explicit, so a mistaken uninstall is recoverable |
