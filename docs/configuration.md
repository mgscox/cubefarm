# Configuration file

CubeFarm reads private settings, such as the Telegram bot token, from its config file when the server starts, so you don't have to export them in every shell that starts the office.

## Where it is

| Platform | Path |
| --- | --- |
| macOS, Linux | `~/.config/cubefarm/.env` |
| Windows | `%USERPROFILE%\.config\cubefarm\.env` |
| `XDG_CONFIG_HOME` set | `$XDG_CONFIG_HOME/cubefarm/.env` |

This is separate from `~/.cubefarm` (or `SWARM_HOME`), which holds the office's state, repo clones and agent worktrees. The config file is yours: CubeFarm never writes to it.

## Format

One `KEY=value` per line, in the usual `.env` style. Comments (`#`), quoted values, Windows line endings and a leading `export ` are all accepted. The `export ` form lets you `source` the same file in a shell.

```bash
# ~/.config/cubefarm/.env
export CUBEFARM_TELEGRAM_TOKEN=123456:ABC...
```

Keep it readable only by you, and out of version control:

```bash
mkdir -p ~/.config/cubefarm && chmod 700 ~/.config/cubefarm
chmod 600 ~/.config/cubefarm/.env
```

On Windows, keep it inside your user profile, which other accounts can't read by default.

## Settings

| Setting | What it does |
| --- | --- |
| `UPSTASH_BOX_API_KEY` | Fallback Box API key for disposable workers. A key saved in Settings takes precedence. |
| `ANTHROPIC_API_KEY` | Anthropic API billing for Claude Code workers on Upstash. Local Claude desks retain their subscription login. |
| `OPENAI_API_KEY` | OpenAI Platform API billing for Codex workers on Upstash; a ChatGPT subscription does not supply this key. |
| `OPENROUTER_API_KEY` | OpenRouter API billing for OpenCode workers on Upstash. |
| `CUBEFARM_TELEGRAM_TOKEN` | The bot token for [Telegram](telegram.md). |
| `CUBEFARM_MCP_TOKEN` | The fallback bearer token for the [manager MCP gateway](manager-mcp.md). A token saved in Settings takes precedence, and the Settings switch can disable access with either token source. |

The file only holds the settings listed here. `SWARM_HOME`, `SWARM_PORT`, `SWARM_HOST` and the other `SWARM_*` variables are read from the environment only.

Startup watchdogs also read the environment: `SWARM_DESK_START_TIMEOUT_MS` defaults to 900000 (15 minutes), and
`SWARM_CLI_START_TIMEOUT_MS` to 600000 (10 minutes). Each measures silence before a session reports its id; new log or
terminal output resets the quiet period. Set a positive number of milliseconds and restart the office to override.
Timed-out desk operations are cancelled, QA/fix work retains its preparation strikes, and explicit issue starts remain
requested. Remote desk RPCs additionally have their own deadlines (the desk timeout for preparation, 2 minutes for release).

## How it's read

- **At startup only.** After editing the file, restart the office.
- **The environment wins.** A setting already set in the server's environment overrides the file's value.
- **A missing or unreadable file** means no settings. CubeFarm starts as usual, and Telegram, for example, shows as unconfigured.
- **Demo mode** (`--demo`) ignores the file. An explicitly supplied `CUBEFARM_MCP_TOKEN` environment variable can enable MCP for testing in a demo office on branch `main`.
- **It stays out of agents' environments.** The server reads the values it needs and doesn't copy the file into its own environment, which agents, previews and their tools inherit. Gateway tokens are also removed from agent and preview environments when supplied by the shell.

## Disposable Upstash workers

In the terminal runtime, choose **Upstash · Small Box per task** when hiring a developer or QA worker,
on Team, or as a floor's machine in Fleet. Nothing is created until a task starts. The office supplies the
Box key, the selected CLI's API key and its GitHub login token; it sends no subscription token or unrelated
config values to the Box. Demo mode fakes this entire lifecycle without reading credentials.

Open **Manager console → Settings → Upstash Box** on localhost to save or clear the Box API key.
The saved key is stored privately on the office host. Saving takes effect immediately. Clearing restores
the startup `UPSTASH_BOX_API_KEY` from the process environment or this file. While the office owns Boxes, a replacement key must
be able to see all of them. If the saved key cannot be read, Upstash access pauses until the saved
key is repaired, replaced, or cleared.

Each task retains its worker, repository, CLI and Small Box across reconnects. At ten account Boxes (including
Boxes created outside CubeFarm), or a provider quota rejection, the task uses its floor's machine. An Upstash
floor falls back to the main office. If that machine lacks the selected CLI, the task stays queued.
Quota rejections pause new Box attempts for one minute; other provider failures stay visible for recovery.

On completion or clearing a task, CubeFarm stops the Box's terminal keeper and leftover desk processes, fetches
Git refs, and checks every worktree, local branch and stash. Dirty files, untracked files, unpushed commits,
unavailable GitHub, or an uncertain delete keep a cleanup record in Fleet. **Reconnect Box** lets the worker
resume to save its work; **Retry saved-work cleanup** checks again before deleting. There is no force-delete
control. A lost create response is recovered by the reservation's unique Box name without creating a second Box.

OpenCode on Upstash uses OpenRouter. Enter a model such as `openrouter/anthropic/claude-sonnet-4.6`;
CubeFarm adds `openrouter/` to a model without that prefix, and uses that example model when the field is empty.
Remote workers use the office's bundled worker code and dependencies installed from its npm release, plus the
selected CLI and GitHub CLI. An office restart reconnects to its existing keeper; it does not reinstall below a
running task. These workers require outbound access to npm, GitHub and their selected inference provider.
OpenCode Boxes install OpenCode v2 from `@opencode/cli`, pinned in `server/upstashProvider.ts`. A Box bootstrapped
with the v1 `opencode-ai` package has it removed when its runtime is next prepared.

## OpenCode desk models

Set an OpenCode desk's model to `provider/model`, matching the provider ID in your OpenCode config (for example,
`ollama/glm-5.3:cloud` or `openrouter/z-ai/glm-5.3`). Bare names such as `glm-5.3:cloud` are treated as Ollama models
and sent as `ollama/glm-5.3:cloud`. The `ollama` provider must already be configured in OpenCode; CubeFarm does not
create providers. Leave the model empty to use OpenCode's own default.

CubeFarm passes the model as `model` in `OPENCODE_CONFIG_CONTENT`, following the
[OpenCode config schema](https://opencode.ai/config.json). The interactive CLI does not accept `--model`
(verified with OpenCode v2.0.32); it accepts `--auto`, `--session` and `--prompt`.
CubeFarm passes `--standalone` so each desk's private server reads its own model, instructions, plugins and permissions
from the environment; OpenCode's shared background service keeps the config of the client that started it.

OpenCode integration targets v2 (verified against v2.0.32). CubeFarm writes a v2 notification plugin package on the
machine that owns the desk and points it at that machine's terminal keeper. Failed notifications retry with backoff;
exhausted retries are written to stderr and `<XDG_DATA_HOME>/opencode/log/cubefarm.log` (default
`~/.local/share/opencode/log/cubefarm.log`).

If notifications are lost, ten minutes without terminal output at an idle OpenCode prompt triggers recovery using
`opencode session list --format json --standalone` and `opencode session export <id> --standalone` on the desk's machine.
Only the current task's completed root session is accepted; ambiguous or unusable results follow the normal retry path.

## Adding a setting (contributors)

Read it with `readConfigEnv()` from `server/config.ts` where it's needed, let the environment win (`process.env.X || readConfigEnv().X`), keep the value out of `process.env`, logs and broadcasts if it's a secret, and add a row to the table above.
