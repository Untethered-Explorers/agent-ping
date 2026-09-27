# Feature: Notification and Tray Presence

## Traceability

| Canonical ID | Owner / Source Link | Relationship |
|--------------|---------------------|--------------|
| APX-US-02 | [Vision](../PRD.md#17. Traceability Matrix) | participates |
| APX-CON-04 | [Vision](../PRD.md#17. Traceability Matrix) | participates |
| APX-CON-06 | [Vision](../PRD.md#17. Traceability Matrix) | participates |
| APX-CON-07 | [Vision](../PRD.md#17. Traceability Matrix) | participates |
| APX-CON-11 | [Vision](../PRD.md#17. Traceability Matrix) | participates |
| NT-FR-01 | This feature | owns |
| NT-FR-02 | This feature | owns |
| NT-FR-03 | This feature | owns |
| NT-FR-04 | This feature | owns |
| NT-FR-05 | This feature | owns |
| NT-FR-06 | This feature | owns |
| NT-FR-07 | This feature | owns |
| NT-FR-08 | This feature | owns |
| NT-FR-09 | This feature | owns |
| NT-FR-10 | This feature | owns |
| NT-FR-11 | This feature | owns |

**PRD:** [docs/PRD.md](../PRD.md)
**Decision of record:** [ADR-012 — The surface is rendered by agent-ping, not the platform](../adr/ADR-012-surface-is-rendered-by-agent-ping.md)

---

## 0. What changed in version 1.1, and what is already built

Phases 1 and 2 below are **complete**. They built a notifier interface, a class
policy, three platform notifiers (`notify-send`, `osascript`, a PowerShell toast) and
the tray badge. The class policy, the deep link and the badge survive the track
change unchanged. The three platform notifiers do not: they are removed by NT-8.

**NT-4 and NT-5 are withdrawn and are not replaced in the same shape.** NT-4 asked a
human to confirm a real libnotify toast on Linux; NT-5 asked a human to confirm a real
notification centre toast on macOS and Windows, and could not be completed from a Linux
machine at all. Both gates existed only because delivery was per-platform, and NT-5 was
blocking fourteen later tasks. Their evidence files are left untouched on disk as the
record of the mechanism that was abandoned; NT-9 replaces them with a scripted probe
against the one implementation that now exists.

The requirement IDs `NT-FR-01` through `NT-FR-04` are **repurposed, not deleted**, so
that the contracts of the already-complete Phase 1 and Phase 2 tasks still resolve.
Each now states something the current design actually requires.

---

## 1. Feature Overview

**Feature Name:** Notification and Tray Presence
**ID Prefix:** NT
**Summary:** The part that actually reaches the developer: one card, rendered by agent-ping in its own always-on-top window, that stays until a blocked session is resolved or acknowledged; one card that expires on its own when a session finishes; nothing at all for anything else; and a tray icon whose badge carries the durable pending count so nothing depends on catching a moment. No platform notification service is involved on any platform.
**Dependencies:** Hub Core and Delivery Policy
**Priority:** Must

---

## 2. User Stories

| ID | As a... | I want to... | So that... | Priority |
|----|---------|-------------|-----------|----------|
| NT-US-01 | developer in the middle of something else | get one card that stays put when a session needs a decision from me | so that I find out without watching any window | Must |
| NT-US-02 | developer who already dealt with it | see the badge drop to zero without dismissing anything | so that I am not nagged for a block that no longer exists | Must |
| NT-US-03 | developer on macOS or Windows | get identical behaviour to Linux, because there is only one implementation | so that the tool is not a different product per platform, and so that I am not asked to grant a notification permission to use it | Must |
| NT-US-04 | developer on a machine with no notification daemon, or with focus assist on | still get told | so that a missing platform service is never a reason to go unheard | Must |

---

## 3. Functional Requirements

```forge-requirement
{"id":"NT-FR-01","kind":"requirement","text":"A notifier interface takes a delivery request carrying class, title, body, urgency, deep link and lifetime, and returns a delivery outcome that records delivered, refused or failed with a reason. Lifetime is expressed in this product's own vocabulary, until-resolved or expires, never in a platform's."}
```

```forge-requirement
{"id":"NT-FR-02","kind":"requirement","text":"A needs-you card is rendered by agent-ping itself, in a window agent-ping creates and owns, positioned inside the display work area. No platform notification service, notification centre, focus-assist mechanism or notification permission is used on any platform, and nothing is handed to the operating system to display."}
```

```forge-requirement
{"id":"NT-FR-03","kind":"requirement","text":"One surface implementation serves Linux, macOS and Windows, and there is no per-platform notification code path. What remains platform-specific is window-manager behaviour, which ships with scripted checks and documented manual steps, and no claim about macOS or Windows window behaviour is ever made from a Linux machine."}
```

```forge-requirement
{"id":"NT-FR-04","kind":"requirement","text":"The surface host window is frameless, transparent, always-on-top, absent from the taskbar or dock, unfocusable, and shown without taking keyboard focus from the developer's current work. It is created when the hub starts and destroyed in the ordered shutdown, it is click-through until the pointer reaches it, and a desktop that refuses to create it leaves the hub serving with delivery recorded as not-wired rather than crashing or silently swallowing events."}
```

```forge-requirement
{"id":"NT-FR-05","kind":"requirement","text":"A tray or menu-bar icon is present for as long as the hub runs, and its badge shows the number of unacknowledged pending items, with no badge shown at zero and a capped marker above ninety-nine."}
```

```forge-requirement
{"id":"NT-FR-06","kind":"requirement","text":"The tray icon offers exactly two menu actions, open the dashboard and quit, and no mute, snooze or dismiss control that could let a pending block be forgotten silently."}
```

```forge-requirement
{"id":"NT-FR-07","kind":"requirement","text":"Every card carries a deep link to its session, and opening that link focuses the session in the dashboard and counts as a dashboard open."}
```

```forge-requirement
{"id":"NT-FR-08","kind":"requirement","text":"No repeat timer exists: one needs-you card is shown per block and is not re-armed, and the badge and history carry persistence instead of re-firing."}
```

```forge-requirement
{"id":"NT-FR-09","kind":"requirement","text":"Every delivery outcome is recorded with its reason, a refused class is never counted as a delivered one, and a failure is visible in the doctor output rather than only in a log line."}
```

```forge-requirement
{"id":"NT-FR-10","kind":"requirement","text":"The surface occupies no screen space and draws nothing when no card is showing and nothing is pending. The host window existing is not the same as the surface being visible, and the difference is what keeps this feature inside the product's quiet-by-default promise."}
```

```forge-requirement
{"id":"NT-FR-11","kind":"requirement","text":"A test asserts the notification path contains no platform notification mechanism: no notification API, no spawned notification command, no per-platform branch, and none of the names of the tools that were removed. The change of track is enforced by the suite rather than promised in prose."}
```

**Priority:** every requirement in this feature is Must. `NT-FR-03` and `NT-FR-04` were
Should in version 1.0 because they could only be confirmed on their own platforms; with
one implementation they are Must, and what remains unverifiable from Linux is narrower
and is recorded as such.

---

## 4. UI / Interaction Design

A card is two lines: the repository short name as the title, and one sentence naming
the kind of block as the body. No counts in the card, no stack of text, no buttons, no
path, no session identifier, no harness name. The card is a DOM document rather than a
canvas, so its text is real text, it is focusable, it has an accessible name, and its
urgency is carried by an icon plus a word rather than by colour alone. It writes its
state through attributes so the page needs no inline style under the dashboard's strict
content-security policy, and it honours a reduced-motion preference.

The host window is positioned inside the display work area rather than the screen
rectangle, so a taskbar, dock or top panel is never covered. It is click-through until
the pointer reaches it, and it appears without taking focus, so a card never steals the
keystroke the developer is in the middle of typing. When nothing is pending and no card
is showing, it is hidden and occupies nothing.

The tray icon is a single quiet glyph whose badge is the only moving part, so the
persistent signal is a number rather than a demand. The dashboard the tray opens is
owned by the Live Dashboard feature; this feature only guarantees the link resolves.

---

## 5. Implementation Tasks

Task review table, kept outside the phase contracts as authoring evidence.

| ID | Outcome | Owner | Needs | Files | Checks | Excluded |
|---|---|---|---|---|---|---|
| NT-1 | *(complete)* One delivery request became one platform toast with the right class policy | notification-engineer | HC-5 delivery pipeline | src/notify/types.ts, policy.ts, linux.ts, registry.ts, tests/notify/* | policy tests; exact notify-send argument test | No macOS, no Windows, no tray |
| NT-2 | *(complete)* macOS and Windows notifiers were built behind the same interface | notification-engineer | NT-1 interface | src/notify/macos.ts, windows.ts, tests/notify/*, docs/runbooks/notify-platforms.md | exact argument and payload tests; documented verification state | No live run on those platforms |
| NT-3 | *(complete)* The tray shows a live pending badge and opens the dashboard | notification-engineer | HC-1 read routes, HC-6, NT-1 | src/hub/tray.ts, src/tray/badge.ts, src/main/index.ts, tests/hub/tray.test.ts, tests/tray/badge.test.ts | tray test through the main entry point | No dashboard rendering |
| NT-6 | The Electron host is a real dependency and a real always-on-top window mounts and dies in order | notification-engineer | NT-1, HC-1 | package.json, package-lock.json, src/notify/surface/host.ts, electron-host.ts, position.ts, src/main/index.ts, tests/notify/surface-host.test.ts, surface-position.test.ts | exact window option object; ordered-close assertion; refused-mount degradation | No card content, no lifetime policy, no delivery wiring |
| NT-7 | A card is rendered as DOM with a lifetime this product owns | notification-engineer | NT-6 | src/notify/surface/lifetime.ts, card.ts, card-view.ts, tests/notify/surface-lifetime.test.ts, surface-card.test.ts, surface-card-view.test.ts | pure lifetime table; focus and accessible-name assertions; no-platform-mechanism source sweep | No delivery wiring, no deletion of the old notifiers |
| NT-8 | Delivery reaches the surface and the platform notifiers are gone | notification-engineer | NT-7, HC-5 | src/notify/types.ts, policy.ts, registry.ts, src/main/index.ts, tests/notify/policy.test.ts, tests/hub/tray.test.ts, docs/runbooks/notification-surface.md; **deleted** src/notify/linux.ts, macos.ts, windows.ts, command.ts and their four test files and docs/runbooks/notify-platforms.md | no-platform-mechanism sweep; refused-class counter test; deep-link agreement test | No new window work, no dashboard |
| NT-9 | A script proves a real card on a real desktop, or the run stops | qa-engineer | NT-8, HC-1 | scripts/verify-notification-surface.mjs, docs/reviews/notification-surface-evidence.json, docs/runbooks/notification-surface.md | machine-readable summary, non-zero exit on any failed assertion | No product code changes; records required changes instead |

### Phase 1: Notifier and toast policy

```forge-task
{
  "id": "NT-1",
  "title": "Define the notifier interface and the Linux notifier",
  "description": "This task is complete. The interface, the class policy and the Linux notify-send notifier it built are retained except for the platform notifier: NT-8 removes src/notify/linux.ts and the spawn runner, because the card is now rendered by this product. Treat the interface, the class table and the deep link as the surviving output and verify them against the current requirements before changing anything here. Define the notifier interface and implement the Linux notifier behind the delivery boundary the hub already calls. A delivery request carries class, title, body, urgency, deep link and persistence; the notifier returns an outcome recording success or failure with a reason. Implement the class policy as pure code: a needs-you request is delivered with a non-auto-dismissing resident notification, a finished request is delivered and allowed to expire, and an fyi request is refused because it never leaves the app. Build the notify-send invocation as an inspectable argument list rather than a shell string, construct the notifier for the current platform in the Electron main entry point and pass it to the delivery pipeline, and record every outcome. Add tests asserting the policy decisions, the exact argument list for each class, that the main entry point wires the platform notifier into delivery, and that a failing notify-send is reported as a failure with a reason. Exclude macOS, Windows and the tray.",
  "ownerAgent": "notification-engineer",
  "dependencies": ["HC-5"],
  "expectedOutputs": ["src/notify/types.ts", "src/notify/policy.ts", "src/notify/linux.ts", "src/notify/registry.ts", "src/main/index.ts", "tests/notify/policy.test.ts", "tests/notify/linux.test.ts", "tests/notify/registry-selection.test.ts"],
  "validationCommands": ["npm test -- tests/notify/policy.test.ts tests/notify/linux.test.ts tests/notify/registry-selection.test.ts", "npm run typecheck"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/notification-and-tray-presence.md#NT-FR-01", "docs/features/notification-and-tray-presence.md#NT-FR-08", "docs/features/notification-and-tray-presence.md#NT-FR-09"],
    "acceptanceCriteria": [
      "A test asserts an fyi request is refused by policy and never reaches a platform notifier",
      "A test asserts the needs-you request sets the resident, non-auto-dismissing flags and the finished request does not",
      "A test asserts the notify-send argument list contains no shell interpolation of the title or body",
      "A test asserts the main entry point constructs the platform notifier and the delivery pipeline uses it",
      "A test asserts a non-zero exit from the notifier is recorded as a failure with a reason rather than swallowed"
    ],
    "constraints": ["No sound in v1", "No repeat timer exists: one needs-you toast per block"],
    "constraintRefs": ["docs/PRD.md#APX-CON-04"],
    "references": ["docs/PRD.md#16. Open Questions", "docs/features/notification-and-tray-presence.md#3. Functional Requirements", "docs/IDEA.md#What Earns An Interruption"]
  }
}
```

```forge-task
{
  "id": "NT-2",
  "title": "Add the macOS and Windows notifiers",
  "description": "This task is complete and its outputs are withdrawn. The osascript and PowerShell notifiers, the platform registry and the per-platform runbook it built are removed by NT-8, and its review notes about what those mechanisms could not do are the evidence behind that decision. Nothing in the current design calls for a second or third delivery path; if you are reasoning about this task, you are looking at history. Add the macOS and Windows notifier implementations behind the existing interface, applying the same three-class policy rather than a second policy. Build each platform invocation as an inspectable argument list, assert the exact arguments and payload shape in unit tests, and register both in the platform registry alongside Linux. Write a runbook that states, per platform, the exact command a developer can run to reproduce a toast by hand, which parts are covered by automated tests here, and which parts can only be confirmed on that platform. Be explicit in the runbook and in the code that these two paths are not live-verified on the authoring machine, so nothing downstream treats them as proven. Exclude the tray and any live run on those platforms.",
  "ownerAgent": "notification-engineer",
  "dependencies": ["NT-1"],
  "expectedOutputs": ["src/notify/macos.ts", "src/notify/windows.ts", "tests/notify/macos.test.ts", "tests/notify/windows.test.ts", "docs/runbooks/notify-platforms.md"],
  "validationCommands": ["npm test -- tests/notify/macos.test.ts tests/notify/windows.test.ts", "npm run typecheck"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/notification-and-tray-presence.md#NT-FR-01", "docs/features/notification-and-tray-presence.md#NT-FR-03"],
    "acceptanceCriteria": [
      "A test asserts the macOS invocation argument list and payload shape for each class, including the refusal of fyi",
      "A test asserts the Windows invocation argument list and payload shape for each class, including the refusal of fyi",
      "A test asserts the platform registry resolves exactly one notifier per supported platform and reports an explicit unsupported result elsewhere",
      "The runbook names the manual command per platform and states that these paths are not live-verified on the authoring machine"
    ],
    "constraints": ["Platform support is Linux, macOS and Windows in v1", "No sound in v1"],
    "constraintRefs": ["docs/PRD.md#APX-CON-06", "docs/PRD.md#APX-CON-04"],
    "references": ["docs/PRD.md#16. Open Questions", "docs/features/notification-and-tray-presence.md#8. Open Questions", "docs/IDEA.md#Where The Surface Lives"]
  }
}
```

### Phase 2: Tray presence

```forge-task
{
  "id": "NT-3",
  "title": "Add the tray icon with its pending-count badge",
  "description": "This task is complete and its output is retained in full. The tray icon and the drawn pending badge stay exactly as built, including the ninety-nine cap and the two-item menu; the 1.1 track change replaced the toast, not the tray. Add persistent tray or menu-bar presence to the running hub. The icon exists for as long as the hub runs, its badge shows the number of unacknowledged pending items read from the hub's own pending route, nothing is drawn at zero, and counts above ninety-nine render a capped marker. Keep the badge a pure function of the pending set so it can be tested without a desktop. Offer exactly two menu actions, open the dashboard and quit, and deliberately provide no mute, snooze or dismiss control. Clicking the icon or the menu action resolves the dashboard deep link, which focuses that session and counts as a dashboard open. Mount the tray from the Electron main entry point and list that file as an output so the wiring is part of this task, with a test that drives the badge and the click handler through it. Exclude dashboard rendering.",
  "ownerAgent": "notification-engineer",
  "dependencies": ["NT-1", "HC-1", "HC-6"],
  "expectedOutputs": ["src/hub/tray.ts", "src/tray/badge.ts", "src/main/index.ts", "tests/hub/tray.test.ts", "tests/tray/badge.test.ts"],
  "validationCommands": ["npm test -- tests/hub/tray.test.ts tests/tray/badge.test.ts", "npm run typecheck"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/notification-and-tray-presence.md#NT-FR-05", "docs/features/notification-and-tray-presence.md#NT-FR-06", "docs/features/notification-and-tray-presence.md#NT-FR-07"],
    "acceptanceCriteria": [
      "A test asserts the badge renders zero pending items as no badge, a small count as that count, and a count above ninety-nine as the capped marker",
      "A test asserts the tray menu exposes exactly open-dashboard and quit and no suppression control",
      "A test asserts clicking the icon resolves a deep link that focuses the session and increments the deep-link counter",
      "A test drives the tray through the main entry point and asserts the badge follows the pending set returned by the hub"
    ],
    "constraints": ["No sound in v1", "No telemetry leaves the machine"],
    "constraintRefs": ["docs/PRD.md#APX-CON-04", "docs/PRD.md#APX-CON-12"],
    "references": ["docs/features/notification-and-tray-presence.md#4. UI / Interaction Design", "docs/PRD.md#16. Open Questions", "docs/IDEA.md#Where The Surface Lives"]
  }
}
```

### Phase 3: The self-rendered surface

Phase 3 replaces the withdrawn Phase 3, whose two tasks were per-platform human gates.
It contains no human gate of its own on purpose: every live-observation claim about the
card is collected by the gates that already exist and already depend on this feature —
OA-6 for a real harness session, LD-5 for the dashboard journey, IO-5 for operations.
NT-9 is a script, so a machine without a usable window fails the build loudly instead
of parking the run on a gate that a single machine cannot complete.

The evidence these four tasks are allowed to rely on already exists:
[docs/research/electron-surface-preflight.json](../research/electron-surface-preflight.json)
proved on the authoring machine that a frameless, transparent, always-on-top,
taskbar-skipping, unfocusable window can be created, shown without focus, made
click-through, painted with real DOM content and destroyed. It also recorded the
blocking finding NT-6 must decide: the npm-installed Chromium sandbox helper is not
usable and the unprivileged user-namespace fallback is blocked by AppArmor on Ubuntu
24.04, so a per-user install must launch with `--no-sandbox`.

```forge-task
{
  "id": "NT-6",
  "title": "Make the Electron host real and mount the overlay window",
  "description": "Turn the desktop shell from a code path that has never run into a real dependency. Add electron to the package dependencies and its lockfile entry without changing the npm script contract that DP-1 established. Define a NotificationSurfaceHost interface with no electron import anywhere in it, carrying exactly the operations this product needs: probe availability, show a card, hide it, release or take click-through, and destroy. Implement that interface over an Electron BrowserWindow with one asserted option set: frame false, transparent true, resizable false, skipTaskbar true, alwaysOnTop true, show false until a card exists, focusable false so the card cannot steal the keystroke the developer is typing, hasShadow false, and webPreferences with contextIsolation true, nodeIntegration false and sandbox true. Load the card document from the loopback-served bundle rather than from a file URL or an inline string. Position the window inside the display work area rather than the screen rectangle, so a taskbar, dock or top panel is never covered, and compute that placement as a pure function of the work area and a corner so it can be tested without a display. Mount the host from the main entry point beside the tray, and make destroying it the first step of the ordered shutdown so the window cannot outlive the hub. Decide the Chromium process-sandbox launch policy explicitly and assert it in a test: the pre-flight found the npm-installed chrome-sandbox helper unusable and the unprivileged user-namespace fallback blocked by AppArmor on Ubuntu 24.04, so a per-user install must pass --no-sandbox. Do not let the packaged application abort at startup and do not treat a disabled sandbox as an implementation detail; record the choice, its reason and the fact that webPreferences sandbox remains in force independently. A desktop that refuses to create the window must leave the hub serving, with a diagnostic line and delivery recorded as not-wired, the same posture the tray already takes. Exclude card content, lifetime policy and delivery wiring.",
  "ownerAgent": "notification-engineer",
  "dependencies": ["NT-1", "HC-1"],
  "expectedOutputs": ["package.json", "package-lock.json", "src/notify/surface/host.ts", "src/notify/surface/electron-host.ts", "src/notify/surface/position.ts", "src/main/index.ts", "tests/notify/surface-host.test.ts", "tests/notify/surface-position.test.ts"],
  "validationCommands": ["npm test -- tests/notify/surface-host.test.ts tests/notify/surface-position.test.ts", "npm run typecheck"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/notification-and-tray-presence.md#NT-FR-03", "docs/features/notification-and-tray-presence.md#NT-FR-04", "docs/features/notification-and-tray-presence.md#NT-FR-10"],
    "acceptanceCriteria": [
      "A test asserts the exact BrowserWindow option object, including that show is false until a card exists and that focusable is false",
      "A test asserts the card rectangle is computed inside the work area and never overlaps its insets, for each supported corner placement",
      "A test drives mount, show, hide and destroy through the main entry point and asserts the host is destroyed in the ordered shutdown before the server closes",
      "A test asserts a desktop bridge that refuses the window leaves the hub serving and records delivery as not-wired with a diagnostic",
      "A test asserts the interface module imports no electron module, so the seam is testable without a display",
      "A test asserts the chosen Chromium process-sandbox launch policy is applied explicitly rather than left to a default that aborts on this platform"
    ],
    "constraints": ["No telemetry leaves the machine", "The surface occupies no screen space when nothing is showing"],
    "constraintRefs": ["docs/PRD.md#APX-CON-12"],
    "references": ["docs/research/electron-surface-preflight.json", "docs/adr/ADR-012-surface-is-rendered-by-agent-ping.md", "docs/features/notification-and-tray-presence.md#4. UI / Interaction Design"]
  }
}
```

```forge-task
{
  "id": "NT-7",
  "title": "Render the card and own its lifetime",
  "description": "Build the card as a DOM document and give it a lifetime this product owns rather than one a notification service negotiates. Implement the lifetime policy as a pure total table with one cell per class and no repeat arm: a needs-you card is shown until the item is resolved by the harness or acknowledged by the developer, a finished card expires on its own after a fixed interval, and an fyi request is never rendered because it does not leave the app. The needs-you cell must contain no timer that re-arms, because the persistence guarantee of this product is the badge and the history, not a re-firing card. Build a pure card model from the delivery plan: the repository short name as the title, one sentence as the body, an urgency token, the pending count and the deep link, and nothing else. The model must never carry a filesystem path, a session identifier, a harness name or any conversation content. Build the DOM view so that it writes its state through attributes and never through an inline style, which keeps it inside the dashboard's strict content-security policy; so that it is focusable and carries an accessible name and a role a screen reader can announce; so that urgency is carried by an icon and a word as well as by colour; so that it honours a reduced-motion preference; and so that it is removed from the document when its lifetime ends or the host is destroyed, leaving no stale card behind. Because the card is DOM and not a canvas, the canvas-plus-DOM-mirror obligation does not apply to it; do not build a mirror. Add tests asserting the lifetime table is total and throws for a class it does not carry, that the needs-you cell has no re-arming timer, that the card renders exactly the two lines with no count in the title, that the view is focusable with an accessible name and a non-colour urgency token, and that a card is removed from the document when its lifetime ends. Add a source-level test asserting the whole notification path contains no notification API call, no audio element, no notify-send, osascript or powershell string, and no inline style assignment, so the change of track is enforced by the suite rather than asserted in prose. Exclude delivery wiring and the deletion of the old platform notifiers.",
  "ownerAgent": "notification-engineer",
  "dependencies": ["NT-6"],
  "expectedOutputs": ["src/notify/surface/lifetime.ts", "src/notify/surface/card.ts", "src/notify/surface/card-view.ts", "tests/notify/surface-lifetime.test.ts", "tests/notify/surface-card.test.ts", "tests/notify/surface-card-view.test.ts"],
  "validationCommands": ["npm test -- tests/notify/surface-lifetime.test.ts tests/notify/surface-card.test.ts tests/notify/surface-card-view.test.ts", "npm run typecheck"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/notification-and-tray-presence.md#NT-FR-02", "docs/features/notification-and-tray-presence.md#NT-FR-08", "docs/features/notification-and-tray-presence.md#NT-FR-10", "docs/features/notification-and-tray-presence.md#NT-FR-11"],
    "acceptanceCriteria": [
      "A test asserts the lifetime table carries a cell for every class and throws for a class it does not carry rather than defaulting",
      "A test asserts the needs-you cell contains no re-arming timer and the finished cell expires on a fixed interval",
      "A test asserts a rendered card carries the repository short name and one sentence and no count, path, session identifier or harness name",
      "A test asserts the card view is focusable, exposes a role and an accessible name, and encodes urgency with an icon and a word as well as colour",
      "A test asserts the view writes no inline style, so it renders under the strict content-security policy without unsafe-inline",
      "A test asserts a card is removed from the document when its lifetime ends and when the host is destroyed",
      "A test asserts no notification API call, no audio element, no notify-send, osascript or powershell string and no inline style exists anywhere under src/notify"
    ],
    "constraints": ["No sound in v1", "No repeat timer exists: one needs-you card per block", "The surface occupies no screen space when nothing is showing"],
    "constraintRefs": ["docs/PRD.md#APX-CON-04", "docs/PRD.md#APX-CON-07"],
    "references": ["docs/features/notification-and-tray-presence.md#4. UI / Interaction Design", "docs/adr/ADR-012-surface-is-rendered-by-agent-ping.md", "docs/research/electron-surface-preflight.json"]
  }
}
```

```forge-task
{
  "id": "NT-8",
  "title": "Deliver to the surface and retire the platform notifiers",
  "description": "Point the delivery boundary at the surface and delete the platform notifiers for good, so that there is exactly one delivery path in the product and exactly one set of claims to prove. Rewrite the notifier types in this product's vocabulary: a delivery request carries class, title, body, urgency, deep link and lifetime, where lifetime is until-resolved or expires rather than a platform's resident or expires; an outcome names the surface rather than a platform; and the command-shaped vocabulary for spawning a process, exit codes, signals, timeouts and command-not-found disappears entirely. Replace the platform registry with a single surface notifier construction that takes a host and composes the existing class policy with the card, keeping the fyi refusal and the deep link exactly as they are. Wire it in the main entry point where the platform notifier is constructed today, and keep the interface boundary the delivery policy already calls so nothing above it changes. Delete the Linux, macOS and Windows notifier modules, the shared spawn runner, their four test files and the per-platform runbook, and record the deletion rather than leaving the files behind as dead code. While you are in the delivery path, fix a real defect the old registry documented and never fixed: a refused class currently resolves through the port as though it had been delivered, so every fyi event increments the delivery counter and the ledger's delivered count. A refused class must be recorded as suppressed and must never be counted as a delivery; the smallest correct change is a typed refusal that the delivery policy classifies as suppressed rather than failed, and a test that proves the counter and the ledger are untouched by an fyi event. Keep the tray's deep link and the card's deep link the same string, since the tray test compares them. Add a test asserting the notification path contains no child process spawn, no exec of any kind, and none of the removed tool names. Write the replacement runbook: what the surface is, how to drive a card by hand on each platform, which parts the automated tests cover here, what the pre-flight already proved, and what remains unobservable from a Linux machine. Exclude new window work and the dashboard.",
  "ownerAgent": "notification-engineer",
  "dependencies": ["NT-7", "HC-5"],
  "expectedOutputs": ["src/notify/types.ts", "src/notify/policy.ts", "src/notify/registry.ts", "src/main/index.ts", "tests/notify/policy.test.ts", "tests/hub/tray.test.ts", "docs/runbooks/notification-surface.md"],
  "validationCommands": ["npm test -- tests/notify/policy.test.ts tests/hub/tray.test.ts", "npm run typecheck"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/notification-and-tray-presence.md#NT-FR-01", "docs/features/notification-and-tray-presence.md#NT-FR-03", "docs/features/notification-and-tray-presence.md#NT-FR-09", "docs/features/notification-and-tray-presence.md#NT-FR-11"],
    "acceptanceCriteria": [
      "A test asserts the surface notifier renders one card for a needs-you request, one for a finished request and none at all for an fyi request",
      "A test asserts a refused class increments neither the delivery counter nor the delivered count in the ledger",
      "A test asserts a host failure is recorded as a failure carrying its reason and is visible in the health payload",
      "A test asserts the main entry point constructs the surface notifier and the delivery policy uses it",
      "A test asserts the deep link on a card is the same string the tray resolves",
      "A test asserts no child process spawn, no exec call and none of notify-send, osascript or powershell exists anywhere under src/notify",
      "The four deleted test files and the per-platform runbook no longer exist, and the runbook that replaces the latter names the manual command per platform and states what is not live-verified from the authoring machine"
    ],
    "constraints": ["No sound in v1", "No telemetry leaves the machine"],
    "constraintRefs": ["docs/PRD.md#APX-CON-04", "docs/PRD.md#APX-CON-12"],
    "references": ["docs/adr/ADR-012-surface-is-rendered-by-agent-ping.md", "docs/features/notification-and-tray-presence.md#0. What changed in version 1.1, and what is already built", "docs/PRD.md#16. Open Questions"]
  }
}
```

```forge-task
{
  "id": "NT-9",
  "title": "Prove the card on a real desktop with a script",
  "description": "Prove on the running system that a card this product renders is actually visible, actually persists, and actually stays silent when it should. Write a repository script that starts the real hub from the built artefacts, drives a real needs-you event, and asserts a real window exists holding a real card positioned inside the display work area, then asserts the same card is still present after a wait, then acknowledges the item and asserts the card is gone and the badge count falls. Drive a real finished event and assert its card expires on its own without anything being dismissed. Drive a session that opens, greets and closes, and assert no window is created and no card is ever drawn, which is the anti-noise proof and the one that matters most. Then record, as an observation rather than an assertion, that the operating system's own notification centre received nothing. Follow the project's live-verification conventions: print a machine-readable summary, exit non-zero on any failed assertion, keep the decision logic unit-testable against injected results including the case where nothing ran, and treat a missing display or a missing Electron binary as a failure rather than a skip. There must be no path through this script that reports success when nothing was exercised. Record every observation including timings in the evidence file, extend the runbook NT-8 wrote at docs/runbooks/notification-surface.md with what this run actually observed and what remains unverified, and record required product changes rather than making them. Do not change product code in this task.",
  "ownerAgent": "qa-engineer",
  "dependencies": ["NT-8", "HC-1"],
  "expectedOutputs": ["scripts/verify-notification-surface.mjs", "docs/reviews/notification-surface-evidence.json", "docs/runbooks/notification-surface.md"],
  "validationCommands": ["npm run typecheck"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/notification-and-tray-presence.md#NT-FR-02", "docs/features/notification-and-tray-presence.md#NT-FR-04", "docs/features/notification-and-tray-presence.md#NT-FR-08", "docs/features/notification-and-tray-presence.md#NT-FR-10"],
    "acceptanceCriteria": [
      "The script prints a machine-readable summary and exits non-zero on any failed assertion",
      "The script's decision logic is unit-tested against injected results, including a case where nothing ran and a case where no display was available",
      "A missing display or a missing Electron binary fails the script rather than skipping it",
      "The evidence file records, for a real needs-you event, that a real card was visible, that it persisted, and that acknowledging it removed it and lowered the badge",
      "The evidence file records that a greeting-and-close session produced no window and no card at all",
      "The evidence file records what the operating system's notification centre did, as an observation rather than an assertion"
    ],
    "constraints": ["A subjective visual judgement never stands alone; the journey must have been performed on the running system", "No telemetry leaves the machine"],
    "constraintRefs": ["docs/PRD.md#APX-CON-06", "docs/PRD.md#APX-CON-12"],
    "references": ["docs/research/electron-surface-preflight.json", "docs/PRD.md#16. Open Questions"]
  }
}
```

---

## 6. Testing Strategy

| Level | Scope | Approach |
|-------|-------|----------|
| Unit | Lifetime policy, card model, corner placement, badge rendering | Pure functions over injected work areas and an injected pending set |
| Unit | Card view semantics | jsdom over the real view: focusability, accessible name, attribute-written state |
| Unit | Absence of platform integration | Source sweep across `src/notify/**` for notification APIs, spawn calls, per-platform tool names and inline styles |
| Integration | Surface wiring, degraded mount, refused class | Real hub through the main entry point with an injected or refused host bridge |
| Live | A real card on a real desktop | NT-9's script, which fails loudly rather than skipping |
| Manual | macOS and Windows window-manager behaviour | Documented manual steps only; recorded as unverified, never as passed |
| Regression | No repeat, no sound, no platform call | Policy tests plus the source sweeps above |

Key test scenarios:

1. An fyi request produces no card, and increments neither the delivery counter nor the ledger's delivered count.
2. A needs-you request produces one card with no re-arming timer, and the same card after a wait.
3. The card rectangle is inside the work area on every supported corner, and no screen pixels are occupied when nothing is showing.
4. A desktop that refuses the window leaves the hub serving with delivery not-wired.
5. The tray menu exposes exactly two actions and no suppression control.
6. No notification API call, spawn or per-platform tool name exists anywhere on the notification path.

---

## 7. Acceptance Criteria

1. One needs-you card per block, never re-armed by a timer, with no sound capability anywhere on the path.
2. Nothing occupies screen space and nothing is drawn when no card is showing and nothing is pending.
3. The tray badge always equals the unacknowledged pending count and reaches zero when the last item is resolved or acknowledged.
4. Every card deep-links to its session, the tray resolves the same link, and opening it focuses the session.
5. One implementation serves all three platforms, with no per-platform notification code path and a test that proves it.
6. The operating system's notification service is never involved, and a test proves it.
7. NT-9's evidence file records a real card rendered, persisting and clearing on the authoring machine, and records the greeting-and-close case producing nothing at all.

---

## 8. Open Questions

| # | Question | Default Assumption |
|---|----------|--------------------|
| 1 | Which corner placement survives a developer who has panels on more than one edge? | Bottom-end of the primary work area, and the placement function is pure so the answer is testable; multi-display placement is out of scope until someone asks for it |
| 2 | Does a transparent always-on-top window composite correctly under GNOME, KDE and Windows? | Unknown, and now cheap to state honestly: one code path, one window manager varying. NT-9 proves the authoring machine's desktop; everything else is documented-not-verified |
| 3 | What Chromium process-sandbox launch policy does an unprivileged per-user install use? | The pre-flight measured the answer: the installed helper is unusable and the AppArmor-restricted user-namespace fallback is blocked, so a per-user install passes `--no-sandbox`. NT-6 must assert the choice rather than inherit a default that aborts |
| 4 | Should a card be click-through, or should it take the pointer? | Click-through until the pointer reaches it, so a card cannot swallow a click meant for the window underneath; NT-6 makes both directions of that switch explicit |
| 5 | Is the historical counter name `toast_deliveries` worth renaming now that no toast exists? | Deferred. Renaming a persisted counter pulls the content-free schema guard into this track change for no functional gain. Recorded as a known misnomer and left for its own change |
| 6 | Is quitting from the tray menu still safe with a card showing? | Yes, and now for a stronger reason: the card is a rendering of durable pending state rather than a thing that exists only while a process runs, so the pending item and its badge return after restart |
