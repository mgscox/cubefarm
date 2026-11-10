import fs from 'node:fs';
import { images } from './attachments.ts';
import { recoverCliTurn } from './cliTranscript.ts';
import { HOME_DIR, WORKSPACE_ROOT } from './config.ts';
import { cliLabel, codexThread, readClaudeTurn } from './clis.ts';
import { adoptPty, discardPty, hooksReady, keeperHookUrl, keeperPid, leaveKeeper, spawnPty, startKeeper, terminalsAvailable } from './ptyClient.ts';
import { screenshotFile } from './agentRunner.ts';
import { BIN_DIR, prepareCliSession, removeSessionDir, SESSIONS_DIR, sessionShots, type CliLaunch } from './cliFiles.ts';
import type { CliHost, CliPlan, PreparedCli } from './machine.ts';
import { ACTIVE_REPO_SKILLS, pruneDeskSkills } from './repoSkills.ts';

// The office's own machine as a place to run CLIs: session files under <SWARM_HOME>/sessions, the helper scripts in
// <SWARM_HOME>/bin (cliFiles.ts), and the CLIs in the office's terminal keeper (ptyClient.ts).

function prepare(plan: CliPlan): PreparedCli | Promise<PreparedCli> {
  const label = cliLabel(plan.cli);
  if (!terminalsAvailable) throw new Error(`Could not start ${label}: the terminal module could not be loaded on this machine.`);
  // Through the keeper, a hook waits while the office restarts instead of failing.
  const keeper = keeperHookUrl();
  const launch = prepareCliSession({ ...plan, prompt: images.prompt(plan.prompt), systemAppend: images.prompt(plan.systemAppend) }, { url: keeper ?? plan.officeUrl, held: !!keeper });
  const ready = (launch: CliLaunch): PreparedCli => ({
    dir: launch.dir,
    jobScratch: !!launch.env.CUBEFARM_JOB_SCRATCH,
    prompt: launch.prompt,
    hookUrl: `${keeper ?? plan.officeUrl}/api/hooks`,
    start({ cols, rows }, meta) {
      try {
        return spawnPty(launch.file, launch.args, { cols, rows, cwd: launch.cwd, env: launch.env }, meta);
      } catch (err) {
        throw new Error(`Could not start ${label}: ${(err as Error).message}`);
      }
    },
  });
  return launch instanceof Promise ? launch.then(ready) : ready(launch);
}

export const localCliHost: CliHost = {
  preparePrompt: (text) => images.prompt(text),
  prepare,
  hasFile: (file) => fs.existsSync(file),
  claudeTurn: (cwd, sessionId) => readClaudeTurn(cwd, sessionId),
  recoverTurn: recoverCliTurn,
  newShots: sessionShots,
  savedShot: screenshotFile,
  codexThread,
  removeDir: removeSessionDir,
  reconnect: async (onHook) => {
    const held = await startKeeper(HOME_DIR, onHook);
    if (keeperPid()) pruneDeskSkills(ACTIVE_REPO_SKILLS, WORKSPACE_ROOT, held);
    return held;
  },
  adopt: adoptPty,
  discard: discardPty,
  hooksReady,
  leave: leaveKeeper,
  protect: () => ({ pids: [keeperPid()].filter((p) => p > 0), markers: [SESSIONS_DIR, BIN_DIR] }),
};
