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
| `CUBEFARM_TELEGRAM_TOKEN` | The bot token for [Telegram](telegram.md). |

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
- **Demo mode** (`--demo`) ignores it.
- **It stays out of agents' environments.** The server reads the values it needs and doesn't copy the file into its own environment, which agents, previews and their tools inherit. `CUBEFARM_TELEGRAM_TOKEN` is also removed from agent and preview environments when it comes from the shell.

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
