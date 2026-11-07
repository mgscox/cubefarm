// Account operations for disposable Upstash desks. Keep credentials on the office side until a Box is created.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Box, BoxError } from '@upstash/box';
import { UPSTASH, type AgentCli } from '../shared/types.ts';
import { sq } from './fleet.ts';
import { run } from './exec.ts';

const BOX_HOST = 'us-east-1.box.upstash.com';
const BOX_CAP = 10;
const OFFICE_ROOT = path.resolve(import.meta.dirname, '..');
const cliConfig = {
  claude: { key: 'ANTHROPIC_API_KEY', package: '@anthropic-ai/claude-code' },
  codex: { key: 'OPENAI_API_KEY', package: '@openai/codex' },
  opencode: { key: 'OPENROUTER_API_KEY', package: 'opencode-ai' },
} as const;

export function upstashConfig(env: NodeJS.ProcessEnv, file: NodeJS.ProcessEnv) {
  const get = (key: string) => (env[`CUBEFARM_UPSTASH_${key}`] ?? file[`CUBEFARM_UPSTASH_${key}`])?.trim() ?? '';
  return {
    apiKey: get('BOX_API_KEY'),
    github: get('GITHUB_TOKEN'),
    keys: {
      claude: get('ANTHROPIC_API_KEY'),
      codex: get('OPENAI_API_KEY'),
      opencode: get('OPENROUTER_API_KEY'),
    },
  };
}

export function upstashDestination(id: string) {
  if (!/^[\w-]+$/.test(id)) throw new Error('Upstash returned an invalid Box ID');
  return `${id}@${BOX_HOST}`;
}

export function upstashFallback(floor: string | undefined) {
  return floor && floor !== UPSTASH ? floor : '';
}

function quotaExceeded(err: unknown) {
  return err instanceof BoxError && (err.statusCode ?? 0) >= 400 && (err.statusCode ?? 0) < 500 &&
    (/too many boxes/i.test(err.message) || (/\b(quota|limit|max(?:imum)?)\b/i.test(err.message) &&
      /\b(concurrent|boxes|box count|box quota|box limit)\b/i.test(err.message)));
}

function apiError(err: unknown) {
  return new Error(err instanceof BoxError && err.statusCode
    ? `Upstash Box API returned HTTP ${err.statusCode}`
    : 'Upstash Box API could not complete the request');
}

export class UpstashCreateUncertain extends Error {}

export class UpstashBoxes {
  private options;
  // Count and create are serialized for this office. Upstash enforces the account quota across offices.
  private allocations: Promise<unknown> = Promise.resolve();

  constructor(private config: ReturnType<typeof upstashConfig>, baseUrl = `https://${BOX_HOST}`, private officeRoot = OFFICE_ROOT) {
    this.options = { apiKey: config.apiKey, baseUrl, enableTelemetry: false, timeout: 90_000 };
  }

  private async list() {
    if (!this.config.apiKey) throw new Error('Configure CUBEFARM_UPSTASH_BOX_API_KEY on the office host');
    try {
      return (await Box.list(this.options)).filter((box) => box.status !== 'deleted');
    } catch (err) { throw apiError(err); }
  }

  async find(name: string, label: string) {
    return (await this.list()).find((box) => box.name === name && box.labels?.includes(label))?.id ?? null;
  }

  allocate(name: string, label: string, cli: AgentCli, model: string, reserved = (): string[] => []): Promise<string | null> {
    const allocate = this.allocations.then(async () => {
      const boxes = await this.list();
      const existing = boxes.find((box) => box.name === name && box.labels?.includes(label));
      if (existing) return existing.id;
      const pending = reserved().filter((id) => id !== name && !boxes.some((box) => box.name === id && box.labels?.includes(label)));
      if (boxes.length + pending.length >= BOX_CAP) return null;
      if (cli === 'opencode' && !model.startsWith('openrouter/')) throw new Error('Select an openrouter/... model for OpenCode on Upstash');
      const key = this.config.keys[cli];
      if (!key || !this.config.github) throw new Error(`Configure CUBEFARM_UPSTASH_${cliConfig[cli].key} and CUBEFARM_UPSTASH_GITHUB_TOKEN on the office host`);
      try {
        const box = await Box.create({
          ...this.options, name, labels: [label], runtime: 'node', size: 'small',
          env: { CUBEFARM_UPSTASH_WORKER: cli, GH_TOKEN: this.config.github, [cliConfig[cli].key]: key },
        });
        return box.id;
      } catch (err) {
        if (quotaExceeded(err)) return null;
        const error = apiError(err);
        if (err instanceof BoxError && [400, 401, 403, 404, 422, 429].includes(err.statusCode ?? 0)) throw error;
        throw new UpstashCreateUncertain(error.message);
      }
    });
    this.allocations = allocate.catch(() => undefined);
    return allocate;
  }

  async bootstrap(id: string, cli: AgentCli) {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cubefarm-upstash-'));
    try {
      const archive = path.join(temp, 'runner.tar.gz');
      const entries = ['bin', 'dist-server', 'package.json', 'docs/specialisms', 'skills'];
      if (await fs.stat(path.join(this.officeRoot, 'package-lock.json')).catch(() => null)) entries.push('package-lock.json');
      try {
        await run('tar', ['-czf', archive, '-C', this.officeRoot, ...entries]);
      } catch { throw new Error('Build the office with npm run build before using Upstash Boxes'); }
      try {
        const box = await Box.get(id, this.options);
        await box.files.upload([{ path: archive, destination: 'cubefarm-runner.tar.gz' }]);
      } catch { throw new Error('Upstash could not receive the office runner'); }
    } finally {
      await fs.rm(temp, { recursive: true, force: true, maxRetries: 3 });
    }
    await this.exec(id, [
      'set -eu',
      'export PATH="$HOME/.local/bin:$PATH"',
      'if ! command -v gh >/dev/null; then sudo apt-get update -qq && sudo apt-get install -y -qq gh; fi',
      'gh auth setup-git --hostname github.com',
      'git config --global user.name "CubeFarm worker"',
      'git config --global user.email "cubefarm-worker@users.noreply.github.com"',
      `npm install -g --prefix "$HOME/.local" --no-fund --no-audit node@24 ${cliConfig[cli].package}`,
      'mkdir -p "$HOME/.cubefarm-runtime"',
      'tar -xzf /workspace/home/cubefarm-runner.tar.gz -C "$HOME/.cubefarm-runtime"',
      'rm /workspace/home/cubefarm-runner.tar.gz',
      'cd "$HOME/.cubefarm-runtime"',
      'if [ -f package-lock.json ]; then npm ci --omit=dev --no-audit --no-fund; else npm install --omit=dev --no-audit --no-fund; fi',
      ...(cli === 'claude' ? [`test -e "$HOME/.claude.json" || printf '%s' '{"hasCompletedOnboarding":true,"theme":"dark"}' >"$HOME/.claude.json"`] : []),
      ...(cli === 'codex' ? ['printenv OPENAI_API_KEY | codex login --with-api-key'] : []),
    ].join('\n'), 'Upstash could not set up its office runner, coding agent or GitHub CLI');
  }

  async safeToDelete(id: string, desk: string, main: string) {
    return (await this.exec(id, savedDeskCheck(desk, main), 'Upstash could not verify that the desk was saved')).trim() === 'clean';
  }

  async present(id: string) {
    try {
      await Box.get(id, this.options);
      return true;
    } catch (err) {
      if (err instanceof BoxError && err.statusCode === 404) return false;
      throw apiError(err);
    }
  }

  private async exec(id: string, script: string, error: string) {
    try {
      const box = await Box.get(id, this.options);
      const run = await box.exec.command(`sh -c ${sq(script)}`);
      if (run.status !== 'completed' || run.exitCode !== 0) throw new Error(error);
      return run.result ?? '';
    } catch { throw new Error(error); }
  }

  async remove(id: string) {
    try {
      const box = await Box.get(id, this.options);
      await box.delete();
    } catch (err) {
      if (!(err instanceof BoxError) || err.statusCode !== 404) throw apiError(err);
    }
  }
}

/** Compare the disposable checkout with fresh remote refs before allowing the Box to be deleted. */
export function savedDeskCheck(desk: string, main: string) {
  return [
    'set -eu',
    `if [ ! -e ${sq(desk)} ] && [ ! -e ${sq(main)} ]; then printf clean; exit 0; fi`,
    `cd ${sq(main)}`,
    'scratch=$(mktemp -d)',
    `trap 'rm -rf "$scratch"' EXIT`,
    'git worktree list --porcelain >"$scratch/worktrees"',
    'if [ "$(grep -c "^worktree " "$scratch/worktrees")" -gt 2 ]; then printf dirty; exit 0; fi',
    `for tree in ${sq(main)} ${sq(desk)}; do`,
    '  if [ ! -e "$tree" ]; then continue; fi',
    '  git -C "$tree" status --porcelain --untracked-files=normal >"$scratch/status"',
    '  if [ -s "$scratch/status" ]; then printf dirty; exit 0; fi',
    'done',
    'if git show-ref --verify --quiet refs/stash; then printf unpushed; exit 0; fi',
    'git fetch --quiet --prune --no-tags origin "+refs/heads/*:refs/remotes/origin/*" "+refs/tags/*:refs/cubefarm/saved-tags/*"',
    'git for-each-ref --format="%(objectname) %(refname:strip=2)" refs/tags >"$scratch/tags"',
    'while read -r hash tag; do',
    '  remote=$(git rev-parse --verify "refs/cubefarm/saved-tags/$tag" 2>/dev/null || true)',
    '  if [ "$hash" != "$remote" ]; then printf unpushed; exit 0; fi',
    'done <"$scratch/tags"',
    'git rev-list --max-count=1 HEAD --branches --not --remotes=origin --glob="refs/cubefarm/saved-tags/*" >"$scratch/commits"',
    `if [ -e ${sq(desk)} ]; then git -C ${sq(desk)} rev-list --max-count=1 HEAD --not --remotes=origin --glob="refs/cubefarm/saved-tags/*" >>"$scratch/commits"; fi`,
    'if [ -s "$scratch/commits" ]; then printf unpushed; else printf clean; fi',
  ].join('\n');
}
