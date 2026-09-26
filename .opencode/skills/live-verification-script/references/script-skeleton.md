# Script skeleton and the decision-function test

> Load when structuring a verification script, or when its pass/fail judgement is inline in the
> shell and cannot be unit-tested.

## Shape

```
scripts/<name>.mjs          thin shell: acquire dependency, run actions, call decide(), exit
tests/scripts/<name>.test.ts  drives decide() with injected results; no process or network
```

The shell owns every side effect. The decision function owns the judgement and is pure.

## The pure decision function

```ts
export interface Observation {
  name: string;
  expected: string;
  actual: string;
}

export interface Decision {
  verdict: 'pass' | 'fail';
  exitCode: number;
  summary: Record<string, unknown>;
  failures: string[];
}

export function decide(obs: Observation[], ctx: {
  assertionsExpected: number;
  dependencyAvailable: boolean;
  missingDependency?: string;
  remedy?: string;
}): Decision {
  const failures: string[] = [];

  if (!ctx.dependencyAvailable) {
    failures.push(
      `required dependency unavailable: ${ctx.missingDependency}. ${ctx.remedy ?? 'no remedy recorded'}`
    );
  }
  if (obs.length < ctx.assertionsExpected) {
    failures.push(
      `executed ${obs.length} of ${ctx.assertionsExpected} assertions; ` +
      'a green result that exercised nothing is not a pass'
    );
  }
  for (const o of obs) {
    if (o.expected !== o.actual) {
      failures.push(`${o.name}: expected ${o.expected}, observed ${o.actual}`);
    }
  }

  return {
    verdict: failures.length === 0 ? 'pass' : 'fail',
    exitCode: failures.length === 0 ? 0 : 1,
    summary: { assertionsRun: obs.length, assertionsExpected: ctx.assertionsExpected },
    failures,
  };
}
```

Note what is *absent*: no `process`, no `fs`, no `fetch`, no clock. That is what makes the
following test possible.

## The shell

```js
#!/usr/bin/env node
import { decide } from './decide.mjs';

const log = (m) => process.stderr.write(`${m}\n`);   // progress: stderr
const emit = (o) => process.stdout.write(`${JSON.stringify(o, null, 2)}\n`); // summary: stdout

const ASSERTIONS_EXPECTED = 4;
const observations = [];

let binary;
try {
  binary = await requireBinary('opencode');
} catch (err) {
  emit({ script: 'verify-opencode-live', verdict: 'fail',
         failures: [`opencode binary not found: ${err.message}`],
         remedy: 'install opencode 1.18.32 or set it on PATH' });
  process.exit(1);
}

const workdir = await mkdtemp(join(tmpdir(), 'agent-ping-verify-'));
try {
  observations.push(await runPermissionThenIdle(workdir));   // returns an Observation
  observations.push(await runGreetAndClose(workdir));
  observations.push(await runWithHubAbsent(workdir));
} finally {
  await rm(workdir, { recursive: true, force: true });
}

const result = decide(observations, {
  assertionsExpected: ASSERTIONS_EXPECTED,
  dependencyAvailable: true,
});
emit({ script: 'verify-opencode-live', harnessVersion: await versionOf(binary),
       startedAt, ...result });
process.exit(result.exitCode);
```

Three details carry the weight:

- The dependency failure emits its own summary and exits before any assertion runs, so it can
  never reach the `decide()` pass path.
- The temporary directory is removed in `finally`, so a mid-run failure still cleans up.
- Progress is on stderr, so stdout stays parseable as JSON.

## The decision-function test

This is the test that makes the script's judgement trustworthy without the live dependency.

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../../scripts/decide.mjs';

const ok = (name) => ({ name, expected: 'x', actual: 'x' });
const bad = (name) => ({ name, expected: 'x', actual: 'y' });

test('fails when an expected observation is missing', () => {
  const d = decide([ok('a'), ok('b')], {
    assertionsExpected: 3, dependencyAvailable: true,
  });
  assert.equal(d.verdict, 'fail');
  assert.match(d.failures.join('\n'), /executed 2 of 3/);
});

test('fails when an observation does not match', () => {
  const d = decide([ok('a'), bad('b')], {
    assertionsExpected: 2, dependencyAvailable: true,
  });
  assert.equal(d.verdict, 'fail');
  assert.match(d.failures.join('\n'), /expected x, observed y/);
});

test('fails when zero assertions ran', () => {
  const d = decide([], { assertionsExpected: 4, dependencyAvailable: true });
  assert.equal(d.verdict, 'fail');
  assert.equal(d.exitCode, 1);
});

test('fails when a dependency is absent, with a remedy', () => {
  const d = decide([], {
    assertionsExpected: 1, dependencyAvailable: false,
    missingDependency: 'playwright chromium', remedy: 'npx playwright install chromium',
  });
  assert.equal(d.verdict, 'fail');
  assert.match(d.failures.join('\n'), /npx playwright install chromium/);
});

test('passes only when every assertion ran and matched', () => {
  const d = decide([ok('a'), ok('b')], {
    assertionsExpected: 2, dependencyAvailable: true,
  });
  assert.equal(d.verdict, 'pass');
  assert.equal(d.exitCode, 0);
});
```

The "fails when zero assertions ran" test is the one that keeps the promise. Without it, a
refactor that swallows an exception in the collection phase produces a passing script that
verified nothing.

## Failure-recovery paths worth encoding

| Failure | What the script must do |
|---------|------------------------|
| Dependency missing | Non-zero exit naming the dependency and the install command |
| Dependency present but the expected version is wrong | Non-zero exit naming both versions; a version drift invalidates the captured result |
| Service manager unavailable | Non-zero exit naming the platform and the manual equivalent |
| Browser install blocked | Non-zero exit naming the block and the loopback fallback as a *different* recorded path |
| Port already in use | Read the live port from the runtime file, or bind a unique high port; never assume the default |
| State directory not writable | Non-zero exit naming the path and the permissions expected |

Each of these is a message plus an exit code. None of them is a skip.
