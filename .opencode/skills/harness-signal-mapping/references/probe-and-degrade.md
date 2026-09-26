# Probing and degrading a missing signal

> Load when a harness signal is unconfirmed, when the harness documents no equivalent, or when
> choosing between a heuristic mapping and recording a deferral.

agent-ping's "Needs You" class depends on a block signal. Not every harness exposes one, and
discovering that is a research task with a recorded decision, not a design choice made in the
adapter.

## Three states, not two

| State | Meaning | What to record |
|-------|---------|-----------------|
| Absent | The harness exposes no such signal, confirmed against a real run | The probe's verbatim evidence, and which class degrades |
| Untriggered | The signal exists and fired, but carried no payload for this case | The observed payload shape, and why it was empty |
| Unresolved | Not yet determined whether the signal exists | The probe attempt, what it showed, and the open question |

Collapsing absent into untriggered makes a capability gap look like a quiet session. Keep the
three distinct in the signal inventory and in the report.

## Probing a real binary

A probe must run the real CLI, not a fixture.

1. Launch the binary in the target mode (`copilot --acp`, or a hook-enabled session).
2. Perform the initialize handshake and record the negotiated protocol version, the agent
   capabilities and the authentication methods.
3. Subscribe to notifications and record every notification type actually observed, verbatim.
4. For hooks, capture the real payload for each documented trigger.
5. Record the exact CLI version and a timestamp with every capture.

Write the verbatim captures to a report under `docs/research/` with the version and timestamps
inline. A summary is not evidence - a later reader must be able to re-check the conclusion
rather than trust it.

## The recorded decision

A human records the decision, citing the report. The decision states exactly one of:

- **Full adapter** - every required signal exists; name the signal for each class.
- **Heuristic only** - a proxy signal exists; name it, name what it cannot distinguish, and
  name what is reported when it fails.
- **Deferral** - the harness is not supported in this release; name the missing signals and
  what would have to change.

The default when the signals are unproven is deferral. Do not ship a heuristic class as if it
were proven; the residual risk and what a user would miss are part of the record.

## Documented degradation

A missing signal must degrade **visibly**, not silently. Three levels, in increasing severity:

1. **Reported in the dashboard.** The session is shown with an explicit state saying its block
   state could not be determined for this harness.
2. **Reported to the operator.** A runbook, a `doctor` check, or a startup breadcrumb states
   which signals the harness does not expose.
3. **Never silently absent.** The absence must never be indistinguishable from a session that
   is simply not blocked.

Wording that satisfies this: "Copilot exposes no block signal; blocks in Copilot sessions are
not detected." Wording that does not: nothing at all, or a log line at debug level.

## Implementation rules for a heuristic

- The heuristic is labelled heuristic in the code, in the table row and in the docs. Do not let
  it read like a proven mapping.
- A heuristic must not over-report. A heuristic that flags a block when none exists erodes trust
  in every real block, which is the one signal the product exists to deliver.
- The heuristic's inputs are named and bounded. A heuristic reading an arbitrary payload is a
  guess with extra steps.
- It degrades through the documented level above, not by returning a default value that reads
  as a real answer.

## After the decision

Implement exactly what the decision authorised, and nothing more. Read the decision and the
evidence before writing code.

- Full adapter or heuristic: the authorised signals map through the same envelope and the same
  dedupe keys, delivered through the existing transport, with a test that exercises the
  missing-signal path.
- Deferral: a runbook stating the harness is unsupported, which signals were missing, and what
  would have to change. No adapter code.

In both cases, no change to the hub's rules, the notifier or the dashboard.
