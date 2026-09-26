# Research probe report template

> Load when writing a probe report, or when a conclusion needs to be separated from the evidence
> that supports it.

A probe report exists so a later reader can re-check a conclusion instead of trusting it. That
only works if the report holds the raw capture, not a summary of it.

## Three states, not two

| State | Meaning | What the report records |
|-------|---------|-------------------------|
| Absent | The capability does not exist, confirmed against a real run | Verbatim evidence of its absence, and what degrades as a result |
| Untriggered | The capability exists and fired, but carried nothing for this case | The observed payload shape and why it was empty |
| Unclear | Not yet determined | What was attempted, what was observed, and the open question |

Collapsing absent into untriggered turns a capability gap into a quiet observation, and is the
most consequential error this document type has.

## Shape

```markdown
# Probe report: <subject>

## Environment

| Field | Value |
|-------|-------|
| Tool | <exact name> |
| Version | <exact version string, unabridged> |
| Mode or flags | <how it was invoked> |
| Platform | <operating system and version> |
| Captured at | <ISO 8601 timestamp with timezone> |

## What was attempted

<the procedure, step by step, so it can be repeated>

## Verbatim captures

### <probe 1: handshake>

```json
<the raw captured payload, unmodified>
```

### <probe 2: notifications observed>

| Notification type observed | Count | Verbatim sample |
|----------------------------|-------|-----------------|
| <name> | <n> | <payload> |

### <probe 3: hook payloads>

| Trigger | Fired | Verbatim payload |
|---------|-------|-----------------|
| <name> | yes/no | <payload> |

## Findings

| Signal | State | Evidence |
|--------|-------|----------|
| <name> | absent / untriggered / unclear | <which capture above shows this> |

## Conclusion

<what follows from the findings, and what does not>

## Residual risk

<what a user would miss under this conclusion, and what would change it>
```

## Rules

1. **Verbatim means verbatim.** Paste the captured payload as received. Do not pretty-print into
   a different shape, reorder keys for readability, drop fields, or redact "noisy" values. If a
   value must be redacted, say so at the point of redaction.
2. **The exact version, unabridged.** "1.0.83" and "latest" are different claims. A capture
   without a version cannot be re-checked.
3. **Timestamps on every capture**, so a later reader can tell what changed between runs.
4. **Counts, not impressions.** "No permission notification was observed across 12 runs" is a
   finding. "None appeared" is not.
5. **The conclusion is separated from the captures** and cites them. A conclusion that cannot be
   traced to a capture above is a hypothesis and should be labelled one.
6. **Residual risk is mandatory.** State what a user would miss if the conclusion is adopted,
   and what evidence would change the answer.
7. **Never overwrite a prior capture.** Re-probing appends a dated section. A changed result is
   itself the most important finding, and silently replacing it destroys the evidence that
   something changed.

## Reporting a missing capability

When a probe shows a required capability is absent:

- State it as absent, in plain words, naming the class or feature that degrades.
- Name the workaround and what it cannot distinguish.
- Name the condition under which the workaround would be promoted to a supported path, and who
  would authorise that.
- Put the same statement wherever the degraded capability is described, so a reader of the
  feature does not have to know the probe exists.

Absence of evidence is a finding, not a gap in the report.

## When the probe is inconclusive

Record it as unclear, not as absent and not as present. State what was tried, what was observed,
and what would resolve it. An unclear result that is written up as a negative answer removes the
question from the backlog.
