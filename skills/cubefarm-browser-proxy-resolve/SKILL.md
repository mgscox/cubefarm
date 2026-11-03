---
name: cubefarm-browser-proxy-resolve
description: Restore Chrome or Playwright navigation to a CubeFarm desk's local or LAN preview when a proxy returns HTTP 407 or 405, or the browser shows a blank page or times out.
---

# Resolve a CubeFarm browser proxy failure

## Check the route from the browser host

Identify the preview URL, reserved port, and machine that runs Chrome or the Playwright MCP server. If the preview is on that same machine, try its loopback URL (`http://127.0.0.1:<port>`). Confirm the server is listening on that address. If the browser is on another machine, use the preview's reachable hostname or IP.

From the browser host, compare the preview's response with and without the proxy. Use the exact hostname or IP in the URL for the direct probe. If the failing browser has an explicit proxy, pass that proxy as `--proxy` to the first probe. Keep proxy credentials out of logs.

```sh
curl -sS --max-time 8 --noproxy '' -o /dev/null -w '%{http_code}\n' "$preview_url"
curl -sS --max-time 8 --noproxy "$preview_host" -o /dev/null -w '%{http_code}\n' "$preview_url"
```

A `407` is a proxy authentication challenge. OpenCode sessions using `llm-capture` may inherit a per-session proxy on `127.0.0.1` that accepts HTTPS CONNECT and returns `405` for plain HTTP proxy requests. Discover the active proxy from the failing session. A blank page or timeout needs a comparison before assigning a cause. If the direct probe fails too, check the preview process, bind address, port, and reachability before changing browser settings.

## Apply the bypass to one browser session

Use loopback if it reaches the same preview. For a LAN preview, add only its literal hostname or IP to `NO_PROXY` and `no_proxy` for the test process, preserving existing exclusions. If the browser uses an explicit proxy, add the exception at launch as well.

- **Chrome with a manual proxy**. Add the preview host to `--proxy-bypass-list=<preview-host>`.
- **Playwright MCP with an explicit proxy**. Keep the session's existing arguments, including its output directory, and add `--proxy-bypass <preview-host>` alongside `--proxy-server <active-proxy-url>`. Start a fresh browser session so the launch settings take effect.
- **Playwright launches but a click fails validation**. Read the installed MCP tool schema. When `browser_click` requires `target`, pass the element ID from a fresh snapshot as `{"target":"e3"}`. Use the field the installed version declares.

Keep the exception scoped to the preview and test browser. Preserve capture for the agent and follow the worker's network policy.

## Verify the original test

Check that the main document reaches the expected page, including any expected redirect, and that the expected UI renders. Rerun the original browser assertions and collect the usual evidence. A curl response or a fixture smoke test establishes reachability only. If the original test still fails, report the direct HTTP result and the browser launch, navigation, or tool error separately.
