import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { HOME_DIR } from './config.ts';
import { projectEnv } from './projectEnv.ts';
import { cliLabel, CODEX_HOOK_SOURCE, commandFor, launchArgs, NOTIFY_SOURCE, OPENCODE_PLUGIN_SOURCE, STATUSLINE_SOURCE } from './clis.ts';
import { newScreenshots } from './agentRunner.ts';
import type { CliPlan } from './machine.ts';

// A CLI's session on the machine it runs on: its files under <SWARM_HOME>/sessions/<token>, the helper scripts in
// <SWARM_HOME>/bin, and its command line and environment. The office's own machine (localCliHost.ts) and a box
// (boxOps.ts) both start CLIs from here.

export const SESSIONS_DIR = path.join(HOME_DIR, 'sessions');
export const BIN_DIR = path.join(HOME_DIR, 'bin');
/** Prompts longer than this go in a file: Windows caps a command line at 32K characters. */
const INLINE_PROMPT_MAX = 8000;

const HOOK_EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'StopFailure', 'Notification'];

let helpersWritten = false;

/** The status line, notify and plugin scripts the CLIs run. Rewritten once per start, so updates reach them. */
function writeHelpers() {
  if (helpersWritten) return;
  fs.mkdirSync(BIN_DIR, { recursive: true });
  fs.writeFileSync(path.join(BIN_DIR, 'statusline.cjs'), STATUSLINE_SOURCE);
  fs.writeFileSync(path.join(BIN_DIR, 'notify.cjs'), NOTIFY_SOURCE);
  fs.writeFileSync(path.join(BIN_DIR, 'codex-hook.cjs'), CODEX_HOOK_SOURCE);
  fs.writeFileSync(path.join(BIN_DIR, 'opencode-plugin.mjs'), OPENCODE_PLUGIN_SOURCE);
  helpersWritten = true;
}

/** A command line for Claude Code's shell (Git Bash on Windows): forward slashes, quoted. */
const shellArg = (p: string) => `"${p.replaceAll('\\', '/')}"`;

/** The browser for a session. Its snapshots and unnamed screenshots go to the session's folder, not the worktree. */
function playwrightServer(outputDir: string) {
  const args = ['-y', '@playwright/mcp@latest', '--headless', '--isolated', '--output-dir', outputDir, '--init-script', path.join(import.meta.dirname, 'browser-init.js')];
  return process.platform === 'win32' ? { command: 'cmd', args: ['/c', 'npx', ...args] } : { command: 'npx', args };
}

/** A CLI ready to start: its session folder, its prompt as given, and what to spawn. */
export interface CliLaunch {
  dir: string;
  prompt: string;
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

/**
 * Write a CLI's session files and build its command line. hooks: where its hooks go (a keeper's own port waits for
 * the office through a restart, so the CLIs allow it longer: held). Throws, with a message for the manager.
 */
export function writeCliSession(plan: CliPlan, hooks: { url: string; held: boolean }): CliLaunch {
  const label = cliLabel(plan.cli);
  const cmd = commandFor(plan.cli);
  if (!cmd) throw new Error(`Could not start ${label}: ${label} isn't installed (no "${plan.cli}" on PATH).`);

  const hookUrl = `${hooks.url}/api/hooks/${plan.token}`;
  const dir = path.join(SESSIONS_DIR, plan.token);
  const browser = plan.browserTesting ? playwrightServer(path.join(dir, 'browser')) : null;
  let prompt = plan.prompt;
  let files: { settings: string; mcp: string | null; system: string };
  try {
    writeHelpers();
    fs.mkdirSync(dir, { recursive: true });
    const settings = {
      hooks: Object.fromEntries(HOOK_EVENTS.map((e) => [e, [{ hooks: [{ type: 'http', url: hookUrl, timeout: hooks.held ? 120 : 30 }] }]])),
      statusLine: { type: 'command', command: `${shellArg(process.execPath)} ${shellArg(path.join(BIN_DIR, 'statusline.cjs'))} ${shellArg(hookUrl)}`, padding: 0 },
    };
    const servers: Record<string, unknown> = {};
    if (browser) servers.playwright = browser;
    if (plan.officeTools) servers.office = { type: 'http', url: `${plan.officeUrl}/api/mcp/${plan.token}` };
    files = { settings: path.join(dir, 'settings.json'), mcp: Object.keys(servers).length ? path.join(dir, 'mcp.json') : null, system: path.join(dir, 'instructions.md') };
    fs.writeFileSync(files.settings, JSON.stringify(settings, null, 2));
    if (files.mcp) fs.writeFileSync(files.mcp, JSON.stringify({ mcpServers: servers }, null, 2));
    fs.writeFileSync(files.system, plan.systemAppend);
    if (prompt.length > INLINE_PROMPT_MAX) {
      const file = path.join(dir, 'task.md');
      fs.writeFileSync(file, prompt);
      prompt = `Your task is in ${file}. Read all of it first, then do what it says.`;
    }
  } catch (err) {
    throw new Error(`Could not prepare ${label}: ${(err as Error).message}`);
  }

  const launch = launchArgs(plan.cli, {
    prompt,
    systemAppend: plan.systemAppend,
    model: plan.model,
    effort: plan.effort,
    resumeId: plan.resumeId,
    sessionId: plan.sessionId,
    cwd: plan.cwd,
    name: plan.name,
    role: plan.role,
    additionalDirectories: plan.additionalDirectories,
    files,
    notify: { script: path.join(BIN_DIR, 'notify.cjs'), url: hookUrl },
    codexHook: path.join(BIN_DIR, 'codex-hook.cjs'),
    plugin: pathToFileURL(path.join(BIN_DIR, 'opencode-plugin.mjs')).href,
    browser,
  });

  // Each agent must be a clean instance on the account its CLI is logged into: no API keys (they would switch Claude
  // Code's billing to the API) and nothing inherited from a Claude Code session the office itself was started from.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(projectEnv(process.env))) {
    if (v === undefined) continue;
    if (/^(ANTHROPIC_|CLAUDE)/i.test(k) && k !== 'CLAUDE_CONFIG_DIR') continue;
    if (/^(NO_COLOR|FORCE_COLOR|TERM_PROGRAM|TERM_PROGRAM_VERSION|CODEX_THREAD_ID|OPENCODE_CONFIG_CONTENT)$/i.test(k)) continue;
    env[k] = v;
  }
  Object.assign(env, { TERM: 'xterm-256color', COLORTERM: 'truecolor' }, launch.env);

  return { dir, prompt, file: cmd.file, args: [...cmd.args, ...launch.args], cwd: plan.cwd, env };
}

/** Browser screenshots new in a session's folder, read, each then added to seen. */
export function sessionShots(dir: string, seen: Set<string>, now: number): { name: string; data: Buffer; mime: string }[] {
  const shots: { name: string; data: Buffer; mime: string }[] = [];
  for (const shot of newScreenshots(path.join(dir, 'browser'), seen, now)) {
    seen.add(shot.name);
    try {
      shots.push({ name: shot.name, data: fs.readFileSync(shot.file), mime: shot.mime });
    } catch {
      // removed before we got to it
    }
  }
  return shots;
}

export const removeSessionDir = (dir: string) => fs.rm(dir, { recursive: true, force: true, maxRetries: 5 }, () => undefined);
