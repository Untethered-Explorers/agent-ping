# CSP and the per-install token

> Load when the PixiJS bundle conflicts with the content-security-policy, when choosing the
> directive set, or when deciding where the write token lives and how it is sent.

## The policy is a constant, and it is narrow

One named constant, asserted on the real response. The test and the server must not be able to
disagree about what is sent.

```ts
export const DASHBOARD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join('; ');
```

No `unsafe-inline`. No `unsafe-eval`. No wildcard host. `frame-ancestors 'none'` matters more
than usual here: the hub is a local daemon, and a framed dashboard is a confused-deputy target.

## When the bundle conflicts, narrow the policy

A conflict is resolved by making the policy **more specific**, never by relaxing it. The
ladder, in order of preference:

1. **Fix the mechanism.** Inline a style that the policy forbids by moving it into a real
   stylesheet, or a dynamic script by moving it into a module the bundler emits.
2. **Add the exact origin.** `connect-src 'self'` plus the specific loopback origin beats
   `connect-src *`. For an Electron-served page the origin is usually already `self`.
3. **Use a hash.** For a genuinely unavoidable inline script, `script-src 'self' 'sha256-...'`
   with the hash of that one script. The hash changes when the script changes, so it cannot
   silently widen.
4. **Change the feature, not the policy.** If a dependency fundamentally requires
   `unsafe-eval`, that dependency does not belong behind this boundary.

**Never** add `unsafe-inline` or `unsafe-eval` to make a conflict disappear. A weakened policy
looks identical in review to a working one and is permanent in the shipped header.

## Common PixiJS-adjacent conflicts

| Symptom | Cause | Narrow fix |
|---------|-------|-----------|
| Styles ignored | Inline `style` attributes, which `style-src` without `unsafe-inline` blocks | Move to a stylesheet rule; `style-src-attr` stays disallowed |
| Renderer fails to start | A dependency evaluating a string at runtime | Hash or replace the dependency; do not add `unsafe-eval` |
| Asset 404s | Missing `img-src` scheme for a data URI or blob | Add the single scheme, not `*` |
| Stream connection refused | `connect-src` missing the hub origin | Add the exact origin; on the loopback page it is `self` |
| Worker blocked | `worker-src` absent, so it falls back to `default-src` | Add `worker-src 'self' blob:` if a worker is genuinely used |

Verify by loading the built dashboard and watching the console. A CSP that is technically
correct but blocks the renderer produces a blank page and no useful error.

## Asserting the policy

```ts
it('sends a strict CSP and no permissive cross-origin header', async () => {
  const res = await fetch(`${base}/`);
  const csp = res.headers.get('content-security-policy') ?? '';

  expect(csp).toContain("default-src 'self'");
  expect(csp).not.toMatch(/unsafe-inline/);
  expect(csp).not.toMatch(/unsafe-eval/);
  expect(csp).toMatch(/frame-ancestors 'none'/);
  expect(res.headers.get('access-control-allow-origin')).toBeNull();
});
```

The negative assertions are the point. A policy that silently lost `frame-ancestors` to a merge
still contains `default-src 'self'`.

## The per-install token

- Random value, written to a file with owner-only permissions in the state directory.
- Regenerated on reinstall.
- Required on the write route only. Read routes carry no content and stay unauthenticated.

Send it in a request header. **Not** in a query string: query strings land in access logs, in
browser history for any dashboard request, and in any copied URL.

Compare in constant time and never log it. A refused write's error body names the missing or
invalid token, never its value.

### Keeping the token out of the served page

A token readable by the served dashboard is a token any page in that origin can use, which
weakens the write boundary to "any script running on the loopback origin". Keep it out of the
bundle:

- Read it server-side and require the client to obtain it through a mechanism that does not
  embed it in static assets, or
- Have the write route accept a value the client obtains at runtime from a same-origin
  endpoint that is itself gated, or
- If the dashboard must send the token, ship it through the runtime file and an in-memory
  handshake rather than baking it into a build artefact.

## What this boundary does not do

It does not authenticate the local user. On a single-user machine, anything running as that
user can reach the loopback port; the boundary exists to stop the daemon becoming a remote
control and to keep unauthenticated reads from being usable cross-origin, not to defend against
local malware. Do not describe it as access control in a threat model that assumes otherwise.
