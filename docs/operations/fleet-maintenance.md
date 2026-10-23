# Fleet maintenance

The office starts workers over SSH using `cubefarm box --stdio --office <id>`. It retries a lost connection after 2, 5, 10 and 30 seconds, then every minute. Enable SSH and the network connection at boot on each worker. A worker reboot ends its old terminals; reconnecting makes it available for new tasks.

Fork checkouts with the same package version as upstream must point `SWARM_BOX_COMMAND` at the fork. Upstream npm `cubefarm@0.3.19` has no `box` command. For the current LAN installation, both workers have a checkout at `~/.local/share/cubefarm-worker`, with dependencies for rebuilding (including esbuild) and the server bundle built from the office's commit. The office launcher exports:

```sh
export SWARM_BOX_COMMAND='node "$HOME/.local/share/cubefarm-worker/bin/cubefarm.js" box'
```

Run the office under a persistent supervisor. On the primary Mac, `com.mgscox.cubefarm.office` is a user LaunchAgent with RunAtLoad and KeepAlive. Its launcher is `~/.local/bin/cubefarm-office`; logs are in `~/Library/Logs/cubefarm-office*.log`. It starts at user login. Once the office is running, rebooted workers reconnect over SSH without logging into their desktop sessions. Preboot disk unlocking and network availability remain operating-system prerequisites.

## Scheduled checks

From the office checkout, run:

```sh
node scripts/install-maintenance-cron.mjs
```

This installs a standalone checker in `~/.local/lib/cubefarm/` and adds one tagged entry to the current user's crontab, every 15 minutes. It preserves other jobs and replaces its own entry when rerun. On macOS the log is `~/Library/Logs/cubefarm-maintenance.log`; on Linux it is `~/.cubefarm/maintenance.log`. Rerun the installer after changing the checker itself. To remove the schedule, remove the `# cubefarm-maintenance` line using `crontab -e`.

The checker calls the running office's existing APIs. With Automatic updates enabled, it refreshes the configured office floor's local folder; the office's existing coordinator decides when to drain, install and restart. Workers follow the office's commit, update their checkouts and reconnect. Their terminal keepers restart after busy agents finish. The checker also refreshes every worker report, including restart notices. A closed office may upgrade automatically once its work is finished and saved; the closed state persists through the restart and no agents are started. An office that is still closing waits without consuming the update timeout. The checker does not force Update now, clear a postponement or failed-update hold, reopen the office, install OS updates, or reboot machines.

The defaults are `http://127.0.0.1:4317` and floor `mgscox/cubefarm`. For a different office, set `CUBEFARM_OFFICE_URL`, `CUBEFARM_OFFICE_REPO` in the cron environment. Keep the office floor's local folder pointed at the running office checkout. Failed checks return a nonzero exit and record the error in the log. Each check retries transient connection failures for up to 30 seconds so a supervised office restart can finish. Runs have a 12-minute budget, shorter than the schedule interval; all API operations are idempotent checks, so a manual repeat is safe.

## Fleet warnings

Each Fleet card distinguishes a **CubeFarm worker restart** from an **OS restart**. A worker restart warning is driven by the reported keeper build and pending restart step, including a failed restart; it clears when a fresh report confirms the keeper is current.

Ubuntu reports an OS reboot request through `/run/reboot-required` (also `/var/run/reboot-required`). See [Ubuntu's reboot check](https://ubuntu.com/server/docs/how-to-upgrade-your-release/).

macOS uses only the cached `softwareupdate --list --no-scan` output. A restart/shutdown action is shown as an update requiring a restart **to install**, rather than claiming that the update is already installed. An empty list cannot establish that no reboot is pending; the UI reports that OS restart status is unavailable. Apple distinguishes update detection, preparation and installation in its [software update process](https://support.apple.com/en-asia/guide/deployment/dep02c211f3e/web). A failed probe, unsupported OS or older worker also reports unknown status. These checks neither fetch nor install OS updates.
