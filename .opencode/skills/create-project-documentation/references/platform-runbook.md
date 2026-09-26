# Platform runbook template

> Load when documenting a platform path that was not executed on the authoring machine, or when
> adding a platform implementation to an existing runbook.

A runbook exists so someone on the right machine can confirm or refute a claim. For a path that
was written but never run there, the runbook's main job is to prevent the path from being
mistaken for a verified one.

## Required structure

```markdown
# Runbook: <subject>

## Status

| Platform | Automated coverage | Executed on this machine | Can be confirmed by |
|----------|--------------------|--------------------------|---------------------|
| Linux | full | yes, <date> | script + human review |
| macOS | argument and payload shape only | no | manual command below, on macOS |
| Windows | argument and payload shape only | no | manual command below, on Windows |

**Not live-verified:** the macOS and Windows paths have never been executed. Their argument
lists and payload shapes are covered by unit tests; their runtime behaviour is unproven. Do
not treat this runbook, or any document linking to it, as evidence that those platforms work.

## <Platform> manual reproduction

Exact command, runnable as written:

    <command>

What to observe: <the specific on-screen or returned evidence>
What would falsify this: <the observation that means the path is broken>

## What the automated tests do and do not cover

Covered: <assertion-by-assertion>
Not covered: <the gap, named>
```

## Rules

1. **The not-live-verified statement is in the body, not only in the status table.** A reader
   who opens the runbook for a command must encounter the caveat without scrolling. This is the
   single most important line in the document.
2. **The manual command is exact and runnable.** Copy it from the implementation, not from
   memory. Name the executable, its arguments and the payload shape.
3. **Each platform names what would falsify it.** "It should work" is not a check.
4. **State where a compensating signal lives.** If a badge or a durable count carries the
   signal on a platform where the transient notification cannot, say so, so nobody treats the
   weaker mechanism as a bug.
5. **Record the platform each observation was made on**, in every document that cites one.
6. **A path with a substituted mechanism is documented as substituted.** When an assumed
   mechanism turned out not to exist on a platform, record what replaced it rather than what was
   planned.

## Extending an existing runbook

When adding a platform:

- Add the row to the status table and the per-platform section in the same change, so the table
  and the sections cannot disagree.
- Re-check the not-live-verified statement. A previously verified platform does not become
  unverified, but the new platform's row must not inherit its status.
- If a previously "not live-verified" platform has since been confirmed, update the statement
  with the date and the reviewer, and change the status in the same edit. A stale "not
  verified" line understates what is known; a stale "verified" line overstates it.

## What this document is not

It is not a test report and not a substitute for running the path on the platform. It is a
precise statement of what is known, what is assumed, and exactly what a person on that platform
should do to find out.
