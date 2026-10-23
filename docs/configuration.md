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

## How it's read

- **At startup only.** After editing the file, restart the office.
- **The environment wins.** A setting already set in the server's environment overrides the file's value.
- **A missing or unreadable file** means no settings. CubeFarm starts as usual, and Telegram, for example, shows as unconfigured.
- **Demo mode** (`--demo`) ignores it.
- **It stays out of agents' environments.** The server reads the values it needs and doesn't copy the file into its own environment, which agents, previews and their tools inherit. `CUBEFARM_TELEGRAM_TOKEN` is also removed from agent and preview environments when it comes from the shell.

## Adding a setting (contributors)

Read it with `readConfigEnv()` from `server/config.ts` where it's needed, let the environment win (`process.env.X || readConfigEnv().X`), keep the value out of `process.env`, logs and broadcasts if it's a secret, and add a row to the table above.
