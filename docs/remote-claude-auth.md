# Remote Claude subscription authentication (personal office fork)

Settings → Claude authentication is available in the manager console and the phone's Settings tab. **Sign in with Claude** runs the installed official CLI's fixed `setup-token` command in a private PTY on the office computer. Open its sign-in link on your phone, approve access, return to Settings, and enter the returned code. No terminal access is needed on the phone. **Use manual token fallback** remains available when CLI UI automation is incompatible with a future version.

This fork preserves `CLAUDE_CODE_OAUTH_TOKEN` for new local Claude SDK/terminal sessions and doctor while removing other inherited `ANTHROPIC_*` / `CLAUDE*` overrides except `CLAUDE_CONFIG_DIR`. Interactive `cubefarm login` strips the token too. Codex and OpenCode do not receive Claude subscription tokens. Existing sessions retain their original environment.

## Trusted SSH workers

Set `CUBEFARM_CLAUDE_AUTH_BOXES=build-worker,operator@qa-worker` in the [office config file](configuration.md) or the office's startup environment. Use the exact SSH destination registered in Fleet for a direct SSH worker. Add only workers whose accounts and operators you trust with the office credential. Both the office and the worker bridge must support credential forwarding. The office requires a known SSH host key and opens a fresh SSH connection when it connects to an opted-in worker.

After adding a destination, restart the office or wait for the worker's next SSH connection. Each new Claude process receives the current office credential over the SSH link. Saving a replacement in Settings takes effect for new sessions without reconnecting or writing credential files on the worker. Workers use their own Claude authentication when forwarding is disabled, unsupported, or the office has no setup token. Removing a destination stops forwarding for new session preparations. Already running processes keep their environment until they exit.

## HTTPS and nginx boundary

Real auth actions are disabled until `CUBEFARM_AUTH_ORIGIN` is set to the exact external HTTPS origin, for example `https://office.example.com`. No paths, credentials, fragments or query parameters are accepted. The office must be reached through an authenticated nginx HTTPS virtual host preserving the external `Host` and `Origin`. Keep authentication on **all** `/api/settings/claude/*` routes; this feature relies on that existing access boundary.

The default trusted proxy socket is loopback. For a proxy on another machine, set `CUBEFARM_AUTH_PROXY_ADDRESS` to its literal IP and firewall the office listener to that proxy. Forwarded headers do not establish scheme, host, or peer trust. Every route, including status, requires POST, matching Host/Origin, the trusted socket, JSON, and `X-CubeFarm-Claude-Auth: 1`. There is no wildcard CORS, raw-output endpoint, token-read endpoint, or code/token broadcast. Responses disable caching. Demo allows same-origin loopback HTTP with synthetic state only.

No live nginx configuration, running office, or credentials were changed during implementation. The operator must supply the existing authenticated HTTPS boundary when adopting this feature. Do not put browser codes in chat or office messages: submit them only in the protected Settings password field.

## Official CLI flow

The installed bundled CLI is 2.1.283; its help supports `auth login --claudeai` and `setup-token`. The [official authentication instructions](https://code.claude.com/docs/en/authentication) describe opening the URL in another browser and returning a browser code to the CLI. This implementation relays that code to the CLI's paste prompt. It does not implement an OAuth HTTP exchange. `setup-token` is used because it prints a long-lived subscription token for server-side capture without importing a CLI credential store or checking `loggedIn`.

Each flow uses separate private temporary cwd, HOME, config and temp directories outside the checkout. Its environment is built from an allowlist, with no inherited credentials, proxy settings, parent session settings, Node options, or office variables. A harmless private `BROWSER` executable prevents automatic browser opening. Only the installed bundled executable is used; a missing binary fails safely rather than trying shell wrappers. The native PTY module is loaded only when browser sign-in starts; if it is missing or cannot load, browser sign-in fails safely while demo, manual-token fallback, and ordinary SDK startup remain usable. The isolated probe needed no initial menu choices. No arbitrary CLI args or terminal input are accepted.

Only exact HTTPS `claude.ai/oauth/authorize` and `claude.com/cai/oauth/authorize` URLs are exposed. The latter is emitted by this installed official CLI (and appears in [the provider's issue tracker](https://github.com/anthropics/claude-code/issues/47773)). Userinfo, ports, fragments, other paths/hosts/schemes, duplicate or unknown query keys, sensitive token values, and unexpected OAuth parameter shapes are rejected. Redirects are restricted to the known HTTPS platform/console code callback. The URL link uses a new tab with `noopener noreferrer`; it can also be copied on the phone.

The server allows one flow and one code submission at a time. Codes are bounded to 513 characters of letters, digits, underscore, dash and an optional single `#state` segment; controls, newlines, URLs and arbitrary terminal input are rejected. The UI clears the password value before making the request. It polls only protected metadata while a flow is active and stops polling on unmount. Only flows successfully started by that Settings instance are cancelled on unmount (including a start response arriving afterward); observing another client’s flow through status does not grant cleanup ownership.

Raw PTY output is never returned, logged, stored in office terminals, or broadcast. A 64 KiB cumulative output cap and ten-minute deadline bound the flow. Ink cursor-forward spacing is normalized internally before recognizing the paste prompt and the CLI's known successful token-output pattern. Completion requires the submitted code, a valid captured subscription token, and exit status zero. Nonzero exit, missing/malformed token, CLI error, overflow, cancellation, expiry and shutdown discard the output, kill the process tree, and remove private directories. Shutdown waits for auth cleanup. Cancellation/expiry during exit cleanup prevents saving. No automatic retry sends another code.

The resulting token is written through `saveClaudeToken` to `<SWARM_HOME>/credentials/claude-subscription.json`, atomically with private directory/file modes (0700/0600). The credential store must be outside the checkout. On Windows, the office user's ACLs must also protect it. Save failure preserves the previous credential; raw filesystem errors stay out of responses/logs. No token is sent to browser storage, snapshots or general Settings.

A saved token is credential metadata, not proof of model access. Expiry remains unknown for opaque tokens; no inference request or `auth status` health result is used to declare success. CLI output is an internal version-dependent seam: unknown future prompts/output fail safely and the explicit manual fallback remains available. This personal-fork functionality does not establish approval for third party subscription products.

## Manual token fallback

1. Choose **Use manual token fallback**. It starts a separate bounded replacement nonce, with no auth subprocess.
2. In a trusted terminal with auth/proxy/session overrides cleared, use temporary HOME/config directories and the fixed bundled `setup-token` command shown in Settings.
3. Open the CLI's URL on the phone. Paste any returned code into that terminal, then copy the printed subscription token into Settings and save.
4. Clean up the terminal directory yourself. Cancelling this fallback discards only the office nonce; it cannot stop a terminal you started separately.

## Return to startup-token or CLI-managed authentication

A saved office token takes precedence over `CLAUDE_CODE_OAUTH_TOKEN` supplied at startup and over CLI-managed authentication. To remove that override, cancel any pending sign-in/replacement first. From a trusted terminal on the office computer, as the office user, remove only `<SWARM_HOME>/credentials/claude-subscription.json` (the default `SWARM_HOME` is `~/.cubefarm`). Do not print or copy the file, and do not delete the whole credentials directory.

For an office using the default home, the command is:

```sh
rm -- "$HOME/.cubefarm/credentials/claude-subscription.json"
```

For a custom home, substitute the running office's actual `SWARM_HOME` path; a separate terminal may not inherit it. Subsequent local Claude sessions resolve the startup token again if one was supplied to the office process; otherwise they use the existing CLI-managed configuration without inspecting or importing it. To return specifically to CLI-managed auth, also remove `CLAUDE_CODE_OAUTH_TOKEN` from the office startup environment and restart the office through its normal operator procedure. Existing sessions keep their original credentials. Removing this file does not revoke the token at the provider or log the CLI out. There is no new remove-token endpoint or UI action.

## Verification boundary

Demo never resolves or starts an auth executable and never reads/writes a credential store. It has a deterministic supported URL and accepts `demo-code-123` for synthetic completion; other codes fail. Mobile tests intercept the provider link with a local fake page. Fake-PTY tests exercise the real manager, private-directory preparation, code write, output parsing, lifecycle cleanup, protected HTTP routes, atomic save, and next-session precedence using dummy credentials only. The `emulate` catalog has no Claude CLI/PTY protocol; the injected stateful PTY is the protocol emulator here, without an added dependency or a custom OAuth server.

The isolated real CLI probe stopped at the URL/paste prompt using a fresh HOME/config, a harmless browser executable, bounded output/time, and process-tree/temp cleanup. It submitted no code, read no real saved credentials, and started no inference. Real human OAuth approval/exchange and real inference remain unverified and cannot be completed unattended. See [REMOTE_AUTH_TEST_EVIDENCE.md](../REMOTE_AUTH_TEST_EVIDENCE.md) for preserved phase-one evidence and appended phase-two red/green results.
