# Seam closure

> Load when a live run depends on an artefact another task was supposed to produce, when a
> verification script had to stand something in, or when re-proving a path that was previously
> proved with a substitute.

## The rule

A green result that exercised nothing is worse than a failure. A green result that exercised
**the test's own substitute** is the same lie, one level deeper: the script supplied the very
capability it then reported as working.

So a seam is named and closed, or it is reported as missing. It is never quietly supplied.

## What a seam is

A seam is any point where two independently-owned pieces meet:

| Seam | Owned by | Consumed by |
|------|----------|-------------|
| A document served by the hub, or a build artefact | the build/serve task | anything that loads it over a socket |
| A channel from a main process into a renderer | the channel task | any task that hands a model across it |
| The hook from a public write route into the delivery path | the hook task | any task that acks a record |
| The evidence summary a script writes | the script's own declared outputs | any claim that the run happened |

The rule for each is the same: assert it exists, do not assume it.

## Naming the seam before writing the script

Every task in this project declares its **outputs** in its feature document. Read them and write
the seam table first, before any code:

```
| Seam | Declared by | Exists at | Asserted by |
|------|-------------|-----------|-------------|
| dist/dashboard/card.html | NS-1 | build output | source-level existence test |
| main->renderer channel   | NS-2 | SURFACE_WINDOW_OPTIONS.preload | test asserting the global's key set |
| ack route -> dismissal   | NS-3 | HubServices port | test asserting the port is called |
```

If a row's *Declared by* column is empty, that is the finding: **nobody owns this seam**. It is
not a reason to build it inside the verification task. It is a reason to raise the missing task
and let the run report the gap.

Three of this project's Phase 3 tasks each passed every gate and collectively could not put a
card on a screen, for exactly this reason: one was told to *load* a document nobody was told to
*create*, one ran under `contextIsolation: true, nodeIntegration: false` with no preload so
nothing could hand the view a model, and one named an acknowledged end nobody wired back. Each
task was individually correct. The set was incomplete, and no assertion in any of them was
capable of noticing that.

## Asserting a seam exists

Assert existence *at the artefact*, not through a mock that stands in for it.

- Build artefact: assert the file exists in the built output, and that it is the built one - the
  post-build path, not a source file that merely compiles to something similar.
- Served document: fetch it over a real loopback socket and assert the status, the content type
  and the policy header. A 404 recorded as "not applicable" is a missing seam, not a waiver.
- Channel: assert the option that carries it is present, and assert the surface it exposes is
  exactly the declared set. A wider surface is a new capability nobody asked for.
- Route: assert the mutation reaches the delivery path, not merely that the route returns 200.

Prefer a check that fails when the artefact is deleted over a check that fails when a field is
null. Deleting the thing is the honest test of whether anything depends on it.

## Treating a substituted seam as a bug report

When the run cannot proceed because a seam is missing, the script's job changes: it stops
driving a journey and starts reporting the gap. The output is a **bug report naming the missing
product seams**, not a green journey.

Record, per missing seam:

1. What is missing, at the exact path or interface where it should exist.
2. Which task was supposed to produce it, or that **no task owns it**.
3. The journey that is blocked, and which assertions never ran.
4. What was substituted instead, so a later reader knows the result is provisional.

Then exit non-zero. A substituted seam must never appear in a summary as a pass, and the
`verdict` field must not read `pass` when any seam was supplied by the harness.

## Re-proving against the shipped build

Once the seams exist, the same journeys run again and the substitutes are **deleted**, so a
green result cannot mean the harness did the work a second time:

1. Run against the shipped entry point, not a dev server and not a fixture.
2. Delete every substitute the previous run supplied - the harness's own document, stylesheet,
   entry module, or an `executeJavaScript` bridge.
3. Assert at **source level** that those implementations are gone, not merely unreferenced.
4. Keep every journey from the earlier run, and keep the negative case: a session that opens,
   greets and closes must still produce nothing.
5. Record the previously-required product changes as closed, and name whatever is still
   unverified rather than letting the evidence imply otherwise.

Point 3 is the load-bearing one. "Unused" and "absent" are different claims, and only absence
proves the run measured the product.

## Two more seams that are easy to miss

### The declared output is part of the seam

A live run whose observations are never committed is not evidence. One task in this project
declared only its script and its test as outputs, so the journeys ran, the real binary was
exercised, and no summary was retained. The end-to-end evidence has a permanent hole and the
cheapest outstanding item on the project's review page.

Therefore: **the evidence summary is an output of the task, not a by-product of running it.**
Declare it in the task's outputs, commit it, and treat a run whose summary is uncommitted as
unrun.

### A decision record is a seam too

When the deliverable is a *decision not to build something* - a deferred harness, a withdrawn
platform path - the record itself is the artefact, and it has its own seams:

- A test asserts no adapter module for the deferred harness exists. An absence of a path is
  asserted, never assumed.
- A test asserts the recorded decision and **both evidence digests still hold**, so a later
  edit to the underlying captures cannot silently invalidate the decision.
- A test asserts that **each claim the record makes is present in the record's own text**. A
  record whose prose drifts from its conclusion fails loudly instead of reading as a decision.

This turns "we decided not to build this" into something that fails if a later change crosses the
line the gate drew.
