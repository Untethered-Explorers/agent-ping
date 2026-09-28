// Removing a directory tree, in a way that works on all three operating systems.
//
// WHY THIS EXISTS
//
// `rmSync(dir, { recursive: true, force: true })` is the obvious spelling and it fails
// on Windows. The `force` flag suppresses "the path does not exist"; it does nothing
// about a path that *does* exist and cannot be deleted because some handle is still
// open, and on NTFS an open handle is an outright refusal rather than a wait. A
// better-sqlite3 connection that has been closed, a server socket in its last tick, or
// an antivirus scanner that opened the file a moment ago are all enough to produce:
//
//   EPERM, Permission denied: \\?\C:\...\agent-ping-state-jvwGbm
//
// which the first run of the three-platform matrix reported as three failing tests in
// `tests/hub/server.test.ts` and one in `tests/cli/install.test.ts`, in the cleanup hook
// rather than in anything the test had asserted.
//
// The fix is the one Node documents for exactly this and that costs nothing elsewhere:
// `maxRetries` and `retryDelay`. They are inert on Linux and macOS, where an unlink of a
// closed file succeeds on the first attempt, and they turn a Windows timing problem into
// a short wait instead of a red cell. `force: true` is kept, because "already gone" is
// still the desired outcome and a second call must be harmless.
//
// WHAT THIS IS NOT
//
// A way to delete a directory that is genuinely still open. A handle held for the life
// of the process will exhaust the retries and this will still throw - which is correct.
// A test whose cleanup cannot delete its own state directory has a leak, and that leak
// is the finding. This widens the window for a handle that is on its way out; it does
// not paper over one that never closes.

import { rmSync } from 'node:fs'

/**
 * How many times to retry, and how long to wait between them.
 *
 * 40 attempts over 2 seconds. A released handle is a scheduling artefact, not a
 * millisecond-scale one: the runtime's own close path is synchronous, so what is being
 * waited for is the operating system's bookkeeping, and a few hundred milliseconds is
 * the usual worst case. This is a bound, not a delay - a delete that succeeds first time
 * is not held open for it.
 */
const RETRIES = 40
const RETRY_DELAY_MS = 50

/**
 * Remove a tree, tolerating a handle that is still being released.
 *
 * Throws if the tree is still there after the retries, which is a leak in the caller
 * rather than a platform problem.
 */
export function removeTree(target: string): void {
  rmSync(target, {
    recursive: true,
    force: true,
    maxRetries: RETRIES,
    retryDelay: RETRY_DELAY_MS,
  })
}
