---
name: live-verification-script
description: "Write a repository script that drives a real binary, browser or service manager and proves a claim about live behaviour. Covers printing a machine-readable summary, exiting non-zero on any failed assertion, having no path that reports success when nothing ran, treating a missing harness or browser as a failure rather than a skip, keeping decision logic unit-testable against injected results, and closing the seams a task depends on instead of substituting for them. Use when adding a verification or probe script under scripts/, when a live run needs an artefact another task was meant to produce, or when reviewing one that could report a green result without having exercised anything."
---

# Skill: Live Verification Script

Four separate tasks in this project need a script with the same shape - a live opencode session,
a live autostart and restart run, a browser-driven dashboard journey, and the Copilot probes.
The discipline is stricter than usual: **a green result that exercised nothing is worse than a
failure**, so a missing browser, harness or service manager is a non-zero exit, never a skip.

Step 8 is the same rule seen from the other end. A run that supplied the artefact it was meant
to verify is measuring itself, so seams are named, owned and closed rather than substituted.

---

## Process

### Step 1: State the claim before writing the script

Write the claim as a sentence with a positive path, a negative path and a failure path. A script
that only proves the happy path is a smoke test and will pass against a product that is broken
in the way that matters.

For the live opencode session, the claim is:

- Positive: a session that reaches a permission decision and then goes idle produces a
  needs-you envelope, a resolution, and exactly one finished envelope with the correct
  repository short name.
- Negative: a session that opens, greets and closes produces no finished envelope.
- Failure: a hub that is not running produces a breadcrumb rather than a silent drop.

Load `references/claim-shapes.md` for the claim, script and output shape of each of this
project's four verification scripts, and for the per-script assertion inventory.

**Output:** three assertions minimum, one per path, written before any script code.

### Step 2: Separate decision logic from execution

The script's *judgement* - given what was observed, did it pass - must be a pure function over
injected results. The script's *actions* - launch, poll, request - are the impure shell around
it.

- Export the decision function. It takes observed results and returns a summary plus an exit
  code, with no process, filesystem or network access.
- The script body collects results and calls the decision function once.
- Then unit-test the decision function against injected results: pass, fail, and the
  not-observed case.

Load `references/script-skeleton.md` before writing either file; it holds the pure decision
function, the shell that wraps it, the decision-function test to copy, and the
failure-recovery table of dependency and environment failures.

This is what makes "a test drives the script against a stub harness" possible, and it is the
difference between a script whose logic is verified and one whose logic is only ever exercised
on a machine that happens to work.

**Output:** an exported pure decision function plus a shell that feeds it.

### Step 3: Make the absence of a dependency a failure

If a browser, harness, binary or service manager cannot be obtained, the script must exit
non-zero and say what was missing and how to obtain it.

- Never `skip`, `continue`, or return success on a missing dependency.
- Never treat "the browser could not be installed" as a passing run.
- If a script may optionally install its dependency, then install it first and fail if the
  installation fails. A script that installs its own browser and then fails because the download
  was blocked is correct behaviour.
- If a dependency cannot be obtained, then the exit code is non-zero and the message names the
  dependency and the remedy. There is no third option.
- A non-zero exit on a missing dependency is a *known* failure mode, so the message must name
  the remedy, not just the problem.

**Output:** a dependency-acquisition step whose failure is a non-zero exit with a remedy.

### Step 4: Guarantee there is no zero-work success path

The property to enforce: if no assertion actually ran, the script cannot exit zero.

- Track executed assertions explicitly. Count them as they run.
- At the end, assert the expected count was reached; below it is a failure, not a pass.
- Guard the main path so a filter, an environment check or an early return cannot skip the
  whole body and fall through to a success exit.
- For a test-suite-driven script, make the runner fail when zero tests executed, and print the
  journeys that ran so a human can confirm which ones those were.

```ts
if (assertionsRun === 0) {
  fail('executed zero assertions; a green result here proves nothing');
}
```

**Output:** an executed-assertion counter whose shortfall is a failure.

### Step 5: Isolate every run into a temporary state directory

Never point a verification script at the developer's real state.

- Redirect the state directory to a fresh temporary path per run, using the override the
  product already supports.
- Redirect the harness's configuration directory too, so a probe installs its plugin into a
  temporary home and cannot disturb the developer's real installation.
- Clean up on exit, including on failure. A script that leaves a temp state directory behind
  turns the next run into a false failure.
- Use a unique port, or read the live port from the runtime file, so a concurrent run or a
  developer's own hub does not collide.

**Output:** a run that touches only temporary paths and leaves nothing behind.

### Step 6: Print a machine-readable summary

The summary is the evidence artefact. It must be parseable by a human and by a later tool
without re-running the script.

- One JSON object on stdout, with a stable shape: what was attempted, what was observed, each
  assertion with its name and outcome, and the overall verdict.
- Include the versions of everything involved - harness version, CLI version, browser version -
  because a captured result without versions cannot be re-checked later.
- Include timestamps.
- Human-readable progress goes to stderr so it does not corrupt the parseable summary on
  stdout. This separation is load-bearing: mixing them makes the summary unparseable.

```json
{
  "script": "verify-opencode-live",
  "harnessVersion": "1.18.32",
  "startedAt": "2026-09-26T10:11:09.364Z",
  "assertionsRun": 4,
  "assertions": [
    { "name": "permission-then-idle produces needs-you, resolution, one finished", "outcome": "pass" },
    { "name": "open-greet-close produces no finished envelope", "outcome": "pass" },
    { "name": "absent hub produces a breadcrumb", "outcome": "pass" }
  ],
  "verdict": "pass"
}
```

**Output:** a JSON summary on stdout with versions, timestamps and per-assertion outcomes.

### Step 7: Wire the exit code and validate

- Exit zero only when the decision function returns pass *and* the expected assertion count was
  reached.
- Any failed assertion, any missing dependency, and any zero-assertion run exit non-zero.
- Print a remedy with each failure. A non-zero exit with no next action is only marginally
  better than a skip.

**Output:** the script wired to its exit code, with the decision function unit-tested.

### Step 8: Close the seam, do not substitute for it

A green result that exercised **the test's own substitute** is the same lie as one that
exercised nothing, one level deeper. The script supplied the capability and then reported it as
working.

- Before writing the script, read the task's declared outputs and write the seam table: what the
  run depends on, which task owns each piece, and which test asserts its existence.
- Assert each seam at the artefact - the built file, the document fetched over a real socket, the
  option that carries the channel, the port the route calls - not through a mock standing in for
  it. Prefer a check that fails when the artefact is deleted over one that fails on a null field.
- If a seam has no owning task, that is the finding. Raise the missing task; do not build the
  seam inside the verification task.
- If a run cannot proceed without a substitute, stop driving the journey and emit a bug report
  naming each missing product seam, its owner (or the absence of one), the blocked assertions,
  and what was substituted. Exit non-zero; a supplied seam must never appear as a pass.
- Once the seams exist, re-run against the shipped build with every substitute **deleted**, and
  assert at source level that the substitutes are gone rather than merely unreferenced. Keep
  every earlier journey, including the negative case.
- The evidence summary is an output of the task, not a by-product of running it. Declare it,
  commit it, and treat a run whose summary is uncommitted as unrun.
- A deferral record is a seam too: assert no adapter module exists for the deferred harness,
  that the recorded decision's evidence digests still hold, and that each claim the record makes
  is present in its own text.

Load `references/seam-closure.md` for the seam table format, the artefact-level existence
assertions, the missing-seam bug-report shape, and the shipped-build re-proof procedure.

**Output:** a seam table with an owner and an existence assertion per row, no supplied seam in
any passing summary, and a re-proof run whose substitutes are asserted absent.

---

## Gotchas

- **A missing browser or harness reported as a skip makes the whole suite meaningless.** A skip
  is a green result that proved nothing, and it is the single most common way a verification
  script starts lying. Missing dependency means non-zero exit.

- **`try { ... } catch { /* ignore */ }` around the body creates a zero-work success path.**
  Anything swallowed inside the collection phase can leave the assertion counter at zero and
  still exit zero. Count assertions as they run and assert the count at the end.

- **Decision logic inline in the shell is untestable.** A script whose pass/fail judgement is
  interleaved with `execSync` and `fetch` can only be tested on a machine where everything
  works. Extract the judgement, then inject results.

- **A summary mixed with progress logs on stdout is unparseable.** Send progress to stderr and
  keep stdout for the JSON object only.

- **A summary without versions cannot be re-checked later.** A captured observation of "the
  permission signal arrived" is worthless without the harness version that produced it.

- **Running against the developer's real state directory corrupts their installation and makes
  the next run a false failure.** Redirect state and harness configuration to temporary
  directories per run, and clean up on the failure path too.

- **Asserting only the happy path passes against a product that over-reports.** The
  greeting-and-close session, the resumed session, the refused acknowledgement and the
  interrupted stream are the assertions that catch real bugs.

- **Assuming the default port collides with a running hub and produces a false pass or a false
  failure.** Read the live port from the runtime file, or bind a unique high port.

- **Exiting non-zero with no remedy trains people to ignore the exit code.** Name what was
  missing and the exact command that resolves it.

- **A script that mutates the product it is verifying produces evidence of a different
  configuration than the one shipped.** A verification run must not change product code or
  config; when a fix is needed, record it as required rather than applying it.

- **A seam the test supplied is a green result measuring the test.** Three tasks in this project
  each passed every gate and collectively could not put a card on a screen: one loaded a document
  nobody was told to create, one ran with no preload under full isolation so nothing could hand
  the view a model, and one named an acknowledged end nobody wired back. None of the three
  assertions was capable of noticing, because each was individually correct. Name the seam, name
  its owner, and assert it exists.

- **"Unused" is not "absent".** Deleting a substitute from the code path and observing that the
  run still passes does not prove the product supplied the capability; the substitute may simply
  be unreachable. Assert at source level that the harness's own document, stylesheet, entry
  module and bridge are gone, or a re-proof can silently measure the harness again.

- **A live run whose summary was never committed is not evidence.** One task declared only its
  script and its test as outputs, so the journeys ran against a real binary and no observation
  survived. The evidence summary is an output of the task; declare it and commit it, or the run
  is treated as unrun.

- **A deferral record that drifts from its own claims still reads as a decision.** Assert that
  no adapter module exists for the deferred harness, that the recorded decision's evidence
  digests still hold, and that every claim the record makes is present in its text. Otherwise a
  later change can cross the line the gate drew without anything failing.

- **A missing seam reported as a skipped journey is a lie with a paper trail.** If the run
  substituted anything to get through, the output is a bug report naming the missing product
  seams and their owners, and a non-zero exit. It is never a pass with a footnote.

---

## Validation

Run from the repository root. The script's own test is the check that its decision logic is
sound; running the script itself additionally proves the live claim.

```bash
npm test -- tests/scripts/<script-name>.test.ts
npm run typecheck
# then, on a machine where the dependency exists:
node scripts/<script-name>.mjs
```

Confirm each item:

- [ ] A test drives the script against a stub harness and asserts it fails when the expected
      observations are missing
- [ ] A test asserts the script exits non-zero when a dependency is absent
- [ ] A test asserts the script fails when zero assertions executed
- [ ] The decision logic is an exported pure function with no process, filesystem or network
      access
- [ ] A positive-path assertion, a negative-path assertion and a failure-path assertion all
      exist
- [ ] A missing browser, harness, binary or service manager exits non-zero with a remedy, and no
      code path skips
- [ ] The executed-assertion count is tracked and a shortfall is a failure
- [ ] The run uses a temporary state directory and a temporary harness configuration directory,
      and cleans both up on the failure path
- [ ] The port is read from the runtime file or is a unique high port, never an assumed default
- [ ] Stdout carries only the machine-readable JSON summary; progress goes to stderr
- [ ] The summary includes every relevant version and a timestamp
- [ ] The script changes no product code or configuration
- [ ] Every seam the run depends on is named with its owning task, and each is asserted to exist
      at the artefact rather than through a substitute
- [ ] No seam the script supplied appears as a pass anywhere in the summary; a supplied seam
      produces a non-zero exit and a report naming the missing product seams
- [ ] Any re-proof run deletes the harness's own substitutes and asserts at source level that
      they are gone, and keeps every journey from the earlier run
- [ ] The evidence summary is declared in the task's outputs and committed, not left as a
      by-product of the run
- [ ] For a deferral record: no adapter module for the deferred path exists, the recorded
      decision's evidence digests still hold, and every claim in the record is present in its text

If the script passes locally, that is necessary and not sufficient. Confirm the summary lists
the assertions you expected by name, and confirm `assertionsRun` is non-zero. A passing run with
an empty assertion list is the failure this skill exists to prevent.
