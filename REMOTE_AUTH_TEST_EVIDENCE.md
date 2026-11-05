# Remote Claude subscription auth — local evidence

Scope: personal office fork, fix/remote-claude-auth. No commit/push/deploy or office restart. Dummy credentials only. Public seams authorized by task: session env, private credential persistence, auth HTTP lifecycle/security, mobile Settings demo.

## CLI capability inspection (2026-11-05)
Resolved via server/clis.ts commandFor('claude') to SDK platform binary (not shell wrapper). Ran only --version, --help, auth login --help, setup-token --help with temporary HOME/CLAUDE_CONFIG_DIR and minimal env. All exit 0. Version 2.1.283. Login flags: --claudeai (default), --console, --email, --sso; setup-token flags: --help only. No documented machine-readable OAuth exchange. No real login/status/inference attempted, no existing credentials read.
Official references: https://code.claude.com/docs/en/authentication and https://code.claude.com/docs/en/cli-reference (read 2026-11-05). Docs describe URL in another browser, returned code pasted into CLI, and setup-token printing a subscription token without saving. Fallback selected: guided manual setup-token plus protected replacement, no server auth subprocess or invented OAuth. CLI UI/output automation is unverified and deliberately unsupported. Expiry is unknown for opaque supplied tokens; no inferred inference health.

## Slice 1 — SDK and Claude CLI preserve token; strip other auth/proxy/session variables

RED: `npm test -- server/sessionEnv.test.ts` (exit 1)
```text
 FAIL  server/sessionEnv.test.ts > preserves subscription auth for SDK and CLI while stripping key, proxy and parent session overrides
AssertionError: expected false to be true // Object.is equality
- true
+ false
 Test Files  1 failed (1)
      Tests  1 failed | 12 passed (13)
   Start at  12:04:29
```

GREEN: `npm test -- server/sessionEnv.test.ts` (exit 0)
```text
 Test Files  1 passed (1)
      Tests  13 passed (13)
   Start at  12:04:42
   Duration  286ms (import 58%, transform 36%, tests 6%, worker 1%)
```

## Slice 2 — Doctor honors token; interactive login strips it

RED: `npm test -- server/claudeEnv.test.ts` (exit 1)
```text
 FAIL  server/claudeEnv.test.ts [ server/claudeEnv.test.ts ]
Error: Cannot find module '../bin/claudeAuth.js' imported from /Volumes/M2_2TB/develop/cubefarm-remote-claude-auth/server/claudeEnv.test.ts
 Test Files  1 failed (1)
      Tests  no tests
   Start at  12:04:57
```

GREEN: `npm test -- server/claudeEnv.test.ts server/sessionEnv.test.ts` (exit 0)
```text
 Test Files  2 passed (2)
      Tests  14 passed (14)
   Start at  12:05:20
   Duration  355ms (import 57%, transform 35%, tests 5%, worker 3%)
```

## Slice 3 — Private persistence; next-session precedence; demo does not read/write store

RED: `npm test -- server/claudeEnv.test.ts` (exit 1)
```text
 FAIL  server/claudeEnv.test.ts > privately persists a replacement across new sessions/reloads with precedence over startup; demo never reads or writes it
TypeError: auth.saveClaudeToken is not a function
 Test Files  1 failed (1)
      Tests  1 failed | 1 passed (2)
   Start at  12:06:00
```

GREEN: `npm test -- server/claudeEnv.test.ts server/sessionEnv.test.ts` (exit 0)
```text
 Test Files  2 passed (2)
      Tests  15 passed (15)
   Start at  12:06:37
   Duration  337ms (import 55%, transform 35%, tests 9%, worker 2%)
```

## Slice 4 — Singleton manual-replacement HTTP lifecycle and safe metadata

RED: `npm test -- server/claudeAuth.test.ts` (exit 1)
```text
 FAIL  server/claudeAuth.test.ts [ server/claudeAuth.test.ts ]
Error: Cannot find module './claudeAuth.ts' imported from /Volumes/M2_2TB/develop/cubefarm-remote-claude-auth/server/claudeAuth.test.ts
 Test Files  1 failed (1)
      Tests  no tests
   Start at  12:07:16
```

GREEN: `npm test -- server/claudeAuth.test.ts` (exit 0)
```text
 Test Files  1 passed (1)
      Tests  1 passed (1)
   Start at  12:07:58
   Duration  219ms (import 50%, tests 26%, transform 22%, worker 2%)
```

## Slice 5 — Same-origin HTTPS/proxy boundary; bounded malformed input; no input echo

RED: `npm test -- server/claudeAuth.test.ts` (exit 1)
```text
 FAIL  server/claudeAuth.test.ts > rejects cross-origin, forwarded-header spoofing, wrong content/header, malformed/oversized JSON and arbitrary fields without disclosing input
AssertionError: expected 200 to be 403 // Object.is equality
- 403
+ 200
 Test Files  1 failed (1)
      Tests  1 failed | 1 passed (2)
   Start at  12:08:32
```

GREEN: `npm test -- server/claudeAuth.test.ts` (exit 0)
```text
 Test Files  1 passed (1)
      Tests  2 passed (2)
   Start at  12:09:22
   Duration  167ms (tests 41%, import 30%, transform 27%, worker 1%)
```

## Slice 6 — Cancel, expire, clear nonce; reject replay

RED: `npm test -- server/claudeAuth.test.ts` (exit 1)
```text
 FAIL  server/claudeAuth.test.ts > cancel/expiry discard the nonce, allow a fresh flow, and never mutate credentials
AssertionError: expected 409 to be 410 // Object.is equality
- 410
+ 409
 Test Files  1 failed (1)
      Tests  1 failed | 2 passed (3)
   Start at  12:10:22
```

GREEN: `npm test -- server/claudeAuth.test.ts` (exit 0)
```text
 Test Files  1 passed (1)
      Tests  3 passed (3)
   Start at  12:10:37
   Duration  256ms (tests 67%, import 17%, transform 15%, worker 1%)
```

## Slice 7 — Truthful demo completion without touching credentials

RED: `npm test -- server/claudeAuth.test.ts` (exit 1)
```text
 FAIL  server/claudeAuth.test.ts > demo fakes replacement without inspecting credentials or resolving/launching a Claude auth process
AssertionError: expected { mode: 'manual-token', …(8) } to match object { source: 'demo', phase: 'complete' }
-   "source": "demo",
+   "source": "saved",
 Test Files  1 failed (1)
      Tests  1 failed | 3 passed (4)
   Start at  12:10:37
```

GREEN: `npm test -- server/claudeAuth.test.ts` (exit 0)
```text
 Test Files  1 passed (1)
      Tests  4 passed (4)
   Start at  12:10:55
   Duration  277ms (tests 65%, import 19%, transform 15%, worker 1%)
```

## Slice 8 — Mobile phone Settings demo save/cancel and non-disclosure

RED: `E2E_PORT=4479 E2E_SKIP_BUILD=1 npm run test:e2e -- e2e/claude-auth.spec.ts` (exit 1)
```text
    TimeoutError: locator.click: Timeout 5000ms exceeded.
      - waiting for locator('.phone-tabs').getByRole('button', { name: /Settings/ })
  1 failed
```

GREEN: `E2E_PORT=4479 E2E_SKIP_BUILD=1 npm run test:e2e -- e2e/claude-auth.spec.ts` (exit 0)
```text
  1 passed (5.8s)
```

## Slice 9 — Claude token never reaches Codex/OpenCode

RED: `npm test -- server/sessionEnv.test.ts` (exit 1)
```text
 FAIL  server/sessionEnv.test.ts > does not hand the Claude subscription token to codex
 FAIL  server/sessionEnv.test.ts > does not hand the Claude subscription token to opencode
AssertionError: expected 'dummy-claude-only' to be undefined
"dummy-claude-only"
 Test Files  1 failed (1)
      Tests  2 failed | 13 passed (15)
   Start at  12:15:21
```

GREEN: `npm test -- server/sessionEnv.test.ts` (exit 0)
```text
 Test Files  1 passed (1)
      Tests  15 passed (15)
   Start at  12:15:30
   Duration  196ms (import 46%, transform 45%, tests 8%, worker 1%)
```

## Slice 10 — Missing bundled executable never falls back to broken wrapper

RED: `npm test -- server/claudeAuth.test.ts` (exit 1)
```text
 FAIL  server/claudeAuth.test.ts > never guides the user through a broken shell wrapper when the bundled executable is missing
AssertionError: expected '\'broken-claude-wrapper\' setup-token' to be null
"'broken-claude-wrapper' setup-token"
 Test Files  1 failed (1)
      Tests  1 failed | 5 passed (6)
   Start at  12:20:33
```

GREEN: `npm test -- server/claudeAuth.test.ts` (exit 0)
```text
 Test Files  1 passed (1)
      Tests  6 passed (6)
   Start at  12:20:40
   Duration  269ms (tests 68%, import 16%, transform 15%, worker 1%)
```

## Supplemental verification and infrastructure notes

The failed-write HTTP check is supplemental coverage of the implemented error boundary: deterministic rename failure returns only a fixed 500 message, clears the flow, removes temporary files, and leaves no token in metadata. No new behavior was added after this check.

- A shared node_modules symlink hit Vite EPERM attempting its config cache. Replaced it with a private APFS copy (`cp -cR`); shared dependencies were not changed. Startup failure excluded from RED.
- Sandboxed Chrome aborted before opening a page. Excluded from RED; slice 8 records the actual missing Settings-tab failure from Chrome outside the sandbox. Both RED/GREEN used demo mode on 4479 with Playwright-managed temporary SWARM_HOME. Playwright stopped the demo server.
- The first full suite hit sandbox `spawn EPERM` in existing process cancellation; stopped that run and reran unchanged outside sandbox. No real auth/session process was used by these regressions.
- Slice 5 used node:http because Node fetch rewrites Host; this reproduces nginx preserving the external Host without relaxing the guard.

## Exact changed files

- `REMOTE_AUTH_TEST_EVIDENCE.md`
- `bin/claudeAuth.d.ts`
- `bin/claudeAuth.js`
- `bin/cubefarm.js`
- `client/src/api.ts`
- `client/src/store.ts`
- `client/src/styles.css`
- `client/src/ui/ClaudeAuthenticationSettings.tsx`
- `client/src/ui/ManagerConsole.tsx`
- `client/src/ui/Phone.tsx`
- `docs/remote-claude-auth.md`
- `e2e/claude-auth.spec.ts`
- `server/agentRunner.ts`
- `server/claudeAuth.test.ts`
- `server/claudeAuth.ts`
- `server/claudeEnv.test.ts`
- `server/cliFiles.ts`
- `server/clis.ts`
- `server/index.ts`
- `server/sessionEnv.test.ts`
- `shared/types.ts`

## Final checks (2026-11-05)

`npm test` — exit 0
```text
 Test Files  102 passed (102)
      Tests  1799 passed | 2 skipped | 1 todo (1802)
   Start at  12:21:16
   Duration  65.33s (tests 95%, import 3%, transform 2%)
```

`npm run typecheck` — exit 0
```text
npm notice run cubefarm@0.3.19 typecheck
npm notice run tsc --noEmit -p tsconfig.json
```

`npm run build` — exit 0
```text
✓ 939 modules transformed.
✓ built in 329ms
(!) Some chunks are larger than 2000 kB after minification. Consider:
built dist-server/index.js
```

`E2E_PORT=4479 E2E_SKIP_BUILD=1 npm run test:e2e -- e2e/claude-auth.spec.ts` — exit 0
```text
  ✓  1 [chromium] › e2e/claude-auth.spec.ts:4:1 › mobile phone Settings safely replaces a demo subscription token and cancels a pending replacement (4.1s)
  1 passed (5.9s)
```

`git diff --check`, `node --check bin/claudeAuth.js`, and `node --check bin/cubefarm.js` also exited 0. Build retains the existing large-chunk warning. Two pre-existing skipped tests and one todo remain; they are not counted as passes.

Screenshots inspected: `test-results/claude-auth-mobile-phone-S-7396f-ncels-a-pending-replacement-chromium/claude-auth-mobile-pending.png` (390×844 phone with scrollable instructions) and `claude-auth-mobile.png` (safe completion state in the same directory). Browser storage, office snapshot, page text and cancelled requests contained no submitted dummy token.

Unverified by design: real provider login/code exchange, token acceptance for inference, Windows ACL acceptance, and actual nginx Basic-auth deployment. The human runs official setup-token in a trusted isolated terminal and pastes the resulting subscription token via the configured HTTPS office. Settings cannot cancel that independently started terminal CLI. No auth subprocess exists in this server, so subprocess timeout/output/tree cleanup is inapplicable; replacement nonces expire and are cleared on cancel/close. No API endpoint/client secret was invented.

Cleanup: final task-runner/demo/keeper process inspection returned no matching worktree processes. A direct TCP check of 127.0.0.1:4479 returned `ECONNREFUSED`. Branch rechecked as `fix/remote-claude-auth`; work remains uncommitted. No push, deploy, real login, live-credential update, office restart, main-checkout edit or release-directory edit was performed.


## Phase 2 — phone-first official setup-token subprocess (2026-11-05)

This section supersedes the phase-one statements that terminal automation is unsupported/inapplicable and that only manual replacement exists. All previous red/green records above are preserved. Current primary flow: **Sign in with Claude**, official bundled `setup-token` in an isolated PTY → strict authorization URL → one protected code submission → internal token capture → successful subprocess exit → atomic store. **Use manual token fallback** is optional.

Seams authorized by the task: injected stateful fake PTY at the real auth manager/isolated launcher; protected HTTP lifecycle/security; demo mobile Settings. No custom OAuth HTTP. The service-emulation catalog has no Claude CLI/PTY emulator; tests use a stateful injected PTY with controllable output, writes, exit and stop, not a canned successful HTTP response. Tests cover subsequent credential resolution after save. No dependency installation or shared node_modules changes.

### Isolated CLI observations

Installed CLI 2.1.283 uses `https://claude.com/cai/oauth/authorize`, callback `https://platform.claude.com/oauth/code/callback`, scope `user:inference`, with code=true, client_id UUID, response_type=code, 43-character PKCE challenge/state and S256. This exact host/path and legacy `https://claude.ai/oauth/authorize` are allowlisted with strict query validation. No initial selection was needed. The CLI renders prompt spaces as ANSI cursor-forward sequences: stripping controls alone produced `Pastecodehereifprompted>`; a failing regression test precedes internal cursor-spacing normalization. The installed binary's known output template contains the success banner, `Your OAuth token (valid for …):`, and token on a separate line; tests reproduce that pattern with dummy credentials and ANSI spacing.

Probes used separate private temp HOME/config/cwd, a minimal environment with no inherited secrets/proxies, a harmless BROWSER executable, a bounded process/output lifetime, and group kill/temp cleanup. They never submitted human auth or started inference. No real credential store was read. Only structural observations were printed, never raw terminal output, codes, tokens, state or challenge values. The integrated launcher/parser probe cancelled as soon as a complete validated URL appeared (phase `starting`, before requiring a later prompt chunk):

```json
{"validAuthorizationUrl":true,"phase":"starting","host":"claude.com","path":"/cai/oauth/authorize","queryKeys":["code","client_id","response_type","redirect_uri","scope","code_challenge","code_challenge_method","state"],"noCredentialsSaved":true}
{"newTempRootsRemaining":0,"noCredentialsSaved":true}
```

Official references re-opened: https://code.claude.com/docs/en/authentication and https://code.claude.com/docs/en/cli-reference. Provider issue corroborating the exact emitted URL/paste prompt: https://github.com/anthropics/claude-code/issues/47773. No OAuth HTTP endpoints were called by custom code.

### Vertical red/green slices

Each slice's failing test ran before its corresponding implementation. Supplemental passing tests extend the same seams without a new implementation slice. Commands below use dummy credentials and isolated homes exclusively.

#### Phase 2 slice 1: Isolated official PTY, code → captured token → successful exit → next-session save

`npm test -- server/claudeSetup.test.ts`

RED:
```text
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯
 FAIL  server/claudeSetup.test.ts > phone flow isolates official setup-token, accepts one code, and saves only a captured token after successful exit for the next session
AssertionError: expected { mode: 'manual-token', …(8) } to match object { mode: 'browser', …(2) }
 Test Files  1 failed (1)
      Tests  1 failed (1)
   Start at  12:28:32
   Duration  191ms (import 65%, transform 28%, tests 5%, worker 2%)
```
GREEN:
```text
 Test Files  1 passed (1)
      Tests  1 passed (1)
   Start at  12:30:22
   Duration  257ms (import 46%, tests 31%, transform 22%, worker 1%)
```

#### Phase 2 slice 2: Singleton, cancel/replay, expiry/shutdown, errors/nonzero/no token/overflow cleanup

`npm test -- server/claudeSetup.test.ts`

RED:
```text
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯
 FAIL  server/claudeSetup.test.ts > fails closed on cli-error without writing credentials or leaking output
AssertionError: expected 'exchanging' to be 'failed' // Object.is equality
Expected: "failed"
Received: "exchanging"
 Test Files  1 failed (1)
      Tests  1 failed | 8 passed (9)
   Start at  12:31:22
   Duration  1.60s (tests 95%, import 3%, transform 2%)
```
GREEN:
```text
 Test Files  1 passed (1)
      Tests  9 passed (9)
   Start at  12:31:56
   Duration  695ms (tests 79%, import 14%, transform 7%)
```

#### Phase 2 slice 3: Exact installed authorization URL and rejected evil URLs/query parameters

`npm test -- server/claudeSetup.test.ts`

RED:
```text
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯
 FAIL  server/claudeSetup.test.ts > accepts the exact installed CLI authorization host/path and rejects evil destinations and sensitive query values
AssertionError: expected null to be 'https://claude.com/cai/oauth/authoriz…' // Object.is equality
- Expected:
+ Received:
 Test Files  1 failed (1)
      Tests  1 failed | 10 passed (11)
   Start at  12:32:23
   Duration  669ms (tests 80%, import 12%, transform 7%)
```
GREEN:
```text
 Test Files  1 passed (1)
      Tests  11 passed (11)
   Start at  12:32:59
   Duration  683ms (tests 80%, import 13%, transform 7%)
```

#### Phase 2 slice 4: Protected browser/code routes and explicit manual mode

`npm test -- server/claudeAuth.test.ts server/claudeSetup.test.ts`

RED:
```text
 FAIL  server/claudeAuth.test.ts > cancel/expiry discard the nonce, allow a fresh flow, and never mutate credentials
AssertionError: expected 409 to be 200 // Object.is equality
 FAIL  server/claudeAuth.test.ts > demo fakes replacement without inspecting credentials or resolving/launching a Claude auth process
AssertionError: expected 400 to be 200 // Object.is equality
 FAIL  server/claudeAuth.test.ts > sanitizes a failed private write and removes its temporary file
AssertionError: expected 400 to be 500 // Object.is equality
 FAIL  server/claudeAuth.test.ts > protects the phone code route, validates its input, and runs a deterministic demo browser lifecycle
AssertionError: expected 400 to be 409 // Object.is equality
 Test Files  1 failed (1)
      Tests  6 failed | 1 passed (7)
   Start at  12:33:38
   Duration  179ms (tests 39%, import 31%, transform 29%, worker 1%)
```
GREEN:
```text
 Test Files  2 passed (2)
      Tests  18 passed (18)
   Start at  12:35:22
   Duration  636ms (tests 73%, import 18%, transform 9%, worker 1%)
```

#### Phase 2 slice 5: Phone open/copy URL, code completion/cancel/unmount, explicit manual fallback

`E2E_PORT=4479 E2E_SKIP_BUILD=1 npm run test:e2e -- e2e/claude-auth.spec.ts`

RED:
```text
2 failed (real Chrome run against the previous built UI):
locator.click: waiting for button "Use manual token fallback"
locator.click: waiting for button "Sign in with Claude"
Both failed before the new UI was implemented.
```
GREEN:
```text
  2 passed (8.0s)
```

#### Phase 2 slice 6: Installed Ink cursor spacing and split ANSI prompt/token output

`npm test -- server/claudeSetup.test.ts server/claudeAuth.test.ts`

RED:
```text
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯
 FAIL  server/claudeSetup.test.ts > recognizes the installed Ink PTY cursor spacing and split ANSI sequences without exposing a terminal
AssertionError: expected 'starting' to be 'awaiting-code' // Object.is equality
Expected: "awaiting-code"
Received: "starting"
 Test Files  1 failed (1)
      Tests  1 failed | 11 passed (12)
   Start at  12:37:26
   Duration  653ms (tests 81%, import 13%, transform 6%)
```
GREEN:
```text
 Test Files  2 passed (2)
      Tests  19 passed (19)
   Start at  12:37:52
   Duration  643ms (tests 82%, import 10%, transform 8%)
```

#### Phase 2 slice 7: Reject checkout temp root/hidden tokens, preserve deadline and cancellation during exit cleanup

`npm test -- server/claudeSetup.test.ts server/claudeAuth.test.ts`

RED:
```text
 FAIL  server/claudeSetup.test.ts > rejects a token hidden in otherwise allowed authorization query fields
AssertionError: expected 'https://claude.ai/oauth/authorize?cod…' to be null
- Expected:
+ Received:
 FAIL  server/claudeSetup.test.ts > keeps the ten-minute deadline active while a successful exit is being cleaned up
AssertionError: expected 'saving' to be 'expired' // Object.is equality
Expected: "expired"
Received: "saving"
 Test Files  1 failed (1)
      Tests  3 failed | 13 passed (16)
   Start at  12:40:27
   Duration  868ms (tests 91%, transform 4%, import 4%)
```
GREEN:
```text
 Test Files  2 passed (2)
      Tests  23 passed (23)
   Start at  12:40:54
   Duration  825ms (tests 86%, import 7%, transform 7%)
```

#### Phase 2 slice 8: Bound hung Windows taskkill; native PTY fallback and late helper errors

`npm test -- server/claudeSetup.test.ts server/claudeAuth.test.ts`

RED:
```text
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯
 FAIL  server/claudeSetup.test.ts > bounds a hung Windows taskkill and still closes the native PTY without exposing errors
TypeError: stopClaudeAuthPty is not a function
 Test Files  1 failed (1)
      Tests  1 failed | 16 passed (17)
   Start at  12:45:01
   Duration  811ms (tests 84%, import 10%, transform 6%)
```
GREEN:
```text
 Test Files  2 passed (2)
      Tests  25 passed (25)
   Start at  12:45:37
   Duration  847ms (tests 81%, import 12%, transform 6%)
```

The route integration supplement uses the real manager with an injected fake PTY over HTTP, accepts one code, waits for successful exit/captured token, then verifies the next session resolves the saved dummy token. Demo tests additionally verify no real store read/write, no executable launch, cross-origin code rejection, bounded/control-free code validation, no nonce replay, and metadata non-disclosure. Mobile tests intercept all external provider navigation, use a fake approval page, check link target/rel and URL copying, clear password input on submit/cancel, cancel on unmount, and inspect browser storage/snapshot/responses for dummy-code/token leakage.

The read-only review found an unbounded Windows taskkill helper wait; slice 8 reproduces and fixes it with a two-second deadline, helper termination and native PTY fallback. Actual Windows ACL/process behavior remains unverified on this macOS host.

Initial sandboxed full-suite/Chrome attempts hit host subprocess permission errors (spawn EPERM / Chrome abort); these were infrastructure failures, not passes. Unsandboxed Chrome then established the actual UI red failures shown above. One overlapping full-suite retry wrote to the same temporary log as the earlier restricted run; that mixed log is excluded from final evidence. The final suite runs separately after both ended, with a unique output file.

### Phase 2 final verification

`npm test (separate unrestricted final run)` — exit 0

```text
 Test Files  103 passed (103)
      Tests  1818 passed | 2 skipped | 1 todo (1821)
   Start at  12:46:18
   Duration  66.54s (tests 94%, import 3%, transform 3%)
```

`npm run typecheck` — exit 0

```text
npm notice run cubefarm@0.3.19 typecheck
npm notice run tsc --noEmit -p tsconfig.json
```

`npm run build` — exit 0

```text
✓ 939 modules transformed.
(!) Some chunks are larger than 2000 kB after minification. Consider:
✓ built in 508ms
built dist-server/index.js
```

`E2E_PORT=4479 E2E_SKIP_BUILD=1 npm run test:e2e -- e2e/claude-auth.spec.ts` — exit 0

```text
  ✓  1 [chromium] › e2e/claude-auth.spec.ts:4:1 › mobile phone Settings safely replaces a demo subscription token and cancels a pending replacement (4.5s)
  ✓  2 [chromium] › e2e/claude-auth.spec.ts:96:1 › mobile phone opens official demo sign-in, returns one code, clears it, and cancels a second flow (1.7s)
  2 passed (8.7s)
```

`git diff --check`, `node --check bin/claudeAuth.js`, and `node --check bin/cubefarm.js` also exit 0. The existing large-bundle warning remains. Two skipped tests and one todo are excluded from the 1,818 passing-test count.

Final mobile screenshot artifacts (390×844 viewport, phone/card scroll clipping is expected; submit controls scroll into view):
- `test-results/claude-auth-mobile-phone-o-39446-t-and-cancels-a-second-flow-chromium/claude-browser-mobile-pending.png`
- `test-results/claude-auth-mobile-phone-o-39446-t-and-cancels-a-second-flow-chromium/claude-browser-mobile-complete.png`
- `test-results/claude-auth-mobile-phone-S-7396f-ncels-a-pending-replacement-chromium/claude-auth-mobile-pending.png`
- `test-results/claude-auth-mobile-phone-S-7396f-ncels-a-pending-replacement-chromium/claude-auth-mobile.png`

Pending/completed browser-flow images were visually inspected; link, copy control and masked code field fit the phone width. The mobile tests scroll to submit/cancel and cover both primary and fallback paths.

Final process inventory: no matching worktree test/probe processes. Port 127.0.0.1:4479 returns ECONNREFUSED. The integrated real startup probe reports zero new remaining auth temp roots. Final diff includes only this feature and the pre-existing phase-one auth changes in this worktree; branch remains `fix/remote-claude-auth`. No commits, pushes, deployment, main/release edits, live office/CEO actions, or shared dependency installations.

Unresolved acceptance boundary: real human OAuth approval/code exchange cannot complete unattended and was not attempted. No real saved credentials were inspected or changed and no real inference was started. Actual Windows process/ACL behavior and production HTTPS/nginx authentication remain unverified. No deployment or inference success is claimed.


### Independent final verification

Hermes independently reran the complete final worktree after the implementation process exited:

`npm test && npm run typecheck && npm run build && E2E_PORT=4479 E2E_SKIP_BUILD=1 npm run test:e2e -- e2e/claude-auth.spec.ts && git diff --check` — exit 0.

```text
Test Files 103 passed (103)
Tests 1818 passed | 2 skipped | 1 todo (1821)
Start at 12:50:59
Duration 64.94s
Typecheck: exit 0
Build: built dist-server/index.js; existing large-chunk warning
Mobile Playwright: 2 passed (8.0s)
```

The full test run emits existing expected failure-path logs and an xterm disposable warning; there are no failed tests. Final git status remains confined to the feature files listed above. Development and release checkouts both report clean status. Worktree HEAD remains 55f6009b2b9dc107efe2623210e6e5ea6c3235f0 on fix/remote-claude-auth. No matching worktree node/Claude/Playwright/Vitest processes remained; the isolated demo port 4479 refused connection. Independently inspected the mobile pending screenshot: fields and link fit phone width; submit/cancel are in the scrollable card and exercised by Playwright.


## Independent review follow-up — two scoped regressions

Worktree only, branch `fix/remote-claude-auth`, HEAD unchanged at `55f6009b2b9dc107efe2623210e6e5ea6c3235f0`. No commits, pushes, deployment, real authentication, live credentials, main/release or running-office changes.

### Native PTY availability: RED → GREEN

Added `server/claudeSetupMissing.test.ts` before the production fix. It simulates a missing native module on both the former eager-import path and the lazy CommonJS-load path. `npm test -- server/claudeSetupMissing.test.ts` failed at the explicit assertion that importing the auth manager resolves: the eager native import rejected with `private native dependency missing` (1 failed).

Changed `server/claudeSetup.ts` to type-only import PTY types and load the native implementation via `createRequire` inside the default spawner. Existing launcher error handling sanitizes errors and removes private directories. The test initially needed its `createRequire` mock narrowed to preserve real SDK executable resolution; the first post-fix run caught that fixture issue (expected native load call, got zero). After preserving the real resolver, the native test plus existing auth/setup tests passed: 3 files, 26 tests.

The regression verifies no native load during module import, idle metadata, demo sign-in or startup-token SDK environment resolution; browser start fails safely; manual fallback still saves a dummy token and subsequent session environment resolves it. No real CLI login or native process is used by this test.

### Flow cleanup ownership: RED → GREEN

Added three mobile two-client regressions before changing the UI: an observer unmounting after seeing the owner's flow; its initial status arriving after unmount; and an in-flight polling status arriving after unmount. Build succeeded, then `E2E_PORT=4479 E2E_SKIP_BUILD=1 npm run test:e2e -- e2e/claude-auth.spec.ts --grep "mobile observer"` failed all three: each observer issued an unexpected cancel request containing the owner's flow ID.

Changed `client/src/ui/ClaudeAuthenticationSettings.tsx` to retain `ownedFlow` separately from the displayed/action-target flow. Only successful start responses establish cleanup ownership. Status responses cannot acquire it, and late status responses cannot cancel observed flows. A successful start arriving after unmount still cancels that exact owned flow.

After the fix, all existing and observer tests passed (5 mobile tests). Added a supplemental sixth test holding a successful start response across unmount; it verifies cancellation uses that exact returned ID and reads back the server's cancelled phase. Each observer test reads back that the owner's flow remains active, then verifies owner unmount cleans it up.

### Final scoped verification

- `npm test -- server/claudeAuth.test.ts server/claudeSetup.test.ts server/claudeSetupMissing.test.ts server/claudeEnv.test.ts server/sessionEnv.test.ts`: **5 files, 43 tests passed** (exit 0).
- `npm run typecheck`: **exit 0**.
- `npm run build`: **exit 0** after both production fixes; existing large-chunk warning remains.
- `E2E_PORT=4479 E2E_SKIP_BUILD=1 npm run test:e2e -- e2e/claude-auth.spec.ts`: **6 passed (15.7s)**, exit 0, against the updated build.
- `git diff --check`: **exit 0**.

Changed only the two production files above, added `server/claudeSetupMissing.test.ts`, extended `e2e/claude-auth.spec.ts`, updated `docs/remote-claude-auth.md` and appended this evidence. Documentation explains exact saved-office-token removal, custom/default home, startup-token precedence, CLI fallback and existing-session behavior; no removal feature/API was added. The earlier full-suite evidence remains above; this follow-up reran the requested focused suite, not the entire suite. Real provider auth/inference and Windows native behavior remain unverified by design.
