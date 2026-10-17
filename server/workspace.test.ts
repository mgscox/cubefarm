import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// syncMain against real throwaway repos: a bare "origin", a clone of it as the floor's main checkout, and an
// "upstream" clone that pushes new work. Everything lives in one temp folder whose path has spaces in it.

const npmRuns = vi.hoisted(() => [] as { cmd: string; cwd?: string; env?: NodeJS.ProcessEnv }[]);

// npm install is stubbed: only what it was asked to do is recorded. git still runs for real.
vi.mock('./exec.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./exec.ts')>();
  return {
    ...actual,
    run: (cmd: string, args: string[], opts?: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv }) => {
      if (cmd === 'npm' || (cmd === 'cmd.exe' && args.join(' ').includes('npm install'))) {
        npmRuns.push({ cmd, cwd: opts?.cwd, env: opts?.env });
        return Promise.resolve('');
      }
      return actual.run(cmd, args, opts);
    },
  };
});

const savedEnv = { SWARM_HOME: process.env.SWARM_HOME, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL };
const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'office swarm sync '));
// Point the office at the temp folder before workspace.ts (and config.ts) load, so mainDir() resolves inside it.
process.env.SWARM_HOME = path.join(ROOT, 'swarm home');
// A known git setup, whoever runs the tests: an identity for test commits, and no user hooks or pull settings.
const gitConfig = path.join(ROOT, 'gitconfig');
await fs.writeFile(gitConfig, '[user]\n\tname = Sync Test\n\temail = sync-test@example.com\n[init]\n\tdefaultBranch = main\n');
process.env.GIT_CONFIG_GLOBAL = gitConfig;

const { git, run } = await import('./exec.ts');
const { branchHolder, deskDir, leftoversInDesk, mainDir, parseWorktrees, prepareDesk, realPath, repoDir, samePath, setLocalPath, syncMain: sync } =
  await import('./workspace.ts');
// Most tests only care about the status line.
const syncMain = async (...args: Parameters<typeof sync>) => (await sync(...args))?.status ?? null;

let seq = 0;
let edits = 0;

interface Repos {
  fullName: string;
  dir: string; // the floor's main checkout (mainDir)
  upstream: string; // someone else's clone, pushing to origin
}

async function commitFile(cwd: string, file: string, content: string, message = `change ${file}`) {
  await fs.mkdir(path.dirname(path.join(cwd, file)), { recursive: true });
  await fs.writeFile(path.join(cwd, file), content);
  await git(['add', '--', file], { cwd });
  await git(['commit', '-q', '-m', message], { cwd });
}

/** Push `n` new commits to origin's main from the upstream clone. */
async function pushUpstream(r: Repos, n = 1, file = 'notes.txt') {
  for (let i = 0; i < n; i++) await commitFile(r.upstream, file, `upstream edit ${++edits}\n`);
  await git(['push', '-q', 'origin', 'main'], { cwd: r.upstream });
}

async function makeRepos(cloneArgs: string[] = []): Promise<Repos> {
  const n = ++seq;
  const fullName = `sync-test/repo-${n}`;
  const origin = path.join(ROOT, 'origins', `repo ${n}.git`);
  const upstream = path.join(ROOT, 'upstream', `repo ${n}`);
  await fs.mkdir(origin, { recursive: true });
  await git(['init', '-q', '--bare', '--initial-branch=main', origin]);
  await git(['clone', '-q', origin, upstream]);
  await commitFile(upstream, 'README.md', '# Test\n', 'initial');
  await commitFile(upstream, 'package.json', '{ "name": "sync-test" }\n', 'add package.json');
  await git(['push', '-q', '-u', 'origin', 'main'], { cwd: upstream });
  const dir = mainDir(fullName);
  await fs.mkdir(path.dirname(dir), { recursive: true });
  await git(['clone', '-q', ...cloneArgs, origin, dir]);
  return { fullName, dir, upstream };
}

const head = (cwd: string) => git(['rev-parse', 'HEAD'], { cwd });
const originMain = (cwd: string) => git(['rev-parse', 'origin/main'], { cwd });

beforeEach(() => {
  npmRuns.length = 0;
});

afterEach(() => vi.unstubAllEnvs());

afterAll(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await fs.rm(ROOT, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
});

describe('syncMain', { timeout: 60_000 }, () => {
  beforeAll(() => {
    // The whole point: the floor's folder is under the temp SWARM_HOME, never a real office's.
    expect(mainDir('sync-test/repo-x').startsWith(path.join(ROOT, 'swarm home'))).toBe(true);
  });

  it('is null when there is no checkout yet', async () => {
    expect(await syncMain('sync-test/nothing-here', 'main', { touch: true })).toBeNull();
  });

  it('reports a checkout that is up to date', async () => {
    const r = await makeRepos();
    expect(await syncMain(r.fullName, 'main', { touch: true })).toBe('in sync');
  });

  it('fast-forwards a clean checkout that is behind', async () => {
    const r = await makeRepos();
    await pushUpstream(r, 2);
    const status = await syncMain(r.fullName, 'main', { touch: true });
    const short = await git(['rev-parse', '--short', 'HEAD'], { cwd: r.dir });
    expect(status).toBe(`updated to ${short}`);
    expect(await head(r.dir)).toBe(await head(r.upstream));
    expect(await fs.readFile(path.join(r.dir, 'notes.txt'), 'utf8')).toMatch(/^upstream/);
    expect(npmRuns).toEqual([]);
    expect(await syncMain(r.fullName, 'main', { touch: true })).toBe('in sync');
  });

  it('leaves local changes alone and reports them', async () => {
    const r = await makeRepos();
    await fs.writeFile(path.join(r.dir, 'README.md'), '# My work in progress\n');
    const before = await head(r.dir);
    await pushUpstream(r);
    expect(await syncMain(r.fullName, 'main', { touch: true })).toBe('1 behind: local changes');
    expect(await head(r.dir)).toBe(before);
    expect(await fs.readFile(path.join(r.dir, 'README.md'), 'utf8')).toBe('# My work in progress\n');
    expect(await git(['stash', 'list'], { cwd: r.dir })).toBe('');
  });

  it('leaves a checkout on another branch alone', async () => {
    const r = await makeRepos();
    await git(['checkout', '-q', '-b', 'my-feature'], { cwd: r.dir });
    const before = await head(r.dir);
    expect(await syncMain(r.fullName, 'main', { touch: true })).toBe('on branch my-feature');
    await pushUpstream(r, 3);
    expect(await syncMain(r.fullName, 'main', { touch: true })).toBe('on branch my-feature (main is 3 commits ahead)');
    expect(await head(r.dir)).toBe(before);
    expect(await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: r.dir })).toBe('my-feature');
  });

  it('leaves a detached HEAD alone', async () => {
    const r = await makeRepos();
    await git(['checkout', '-q', '--detach'], { cwd: r.dir });
    const before = await head(r.dir);
    await pushUpstream(r);
    expect(await syncMain(r.fullName, 'main', { touch: true })).toBe('on a detached HEAD (main is 1 commit ahead)');
    expect(await head(r.dir)).toBe(before);
  });

  it('leaves a diverged checkout alone', async () => {
    const r = await makeRepos();
    await commitFile(r.dir, 'mine.txt', 'local only\n');
    const before = await head(r.dir);
    await pushUpstream(r, 2);
    expect(await syncMain(r.fullName, 'main', { touch: true })).toBe('diverged: local commits, and 2 commits to pull');
    expect(await head(r.dir)).toBe(before);
    await expect(fs.access(path.join(r.dir, 'notes.txt'))).rejects.toThrow();
  });

  it('only reports an update with touch: false', async () => {
    const r = await makeRepos();
    const before = await head(r.dir);
    await pushUpstream(r, 1);
    expect(await syncMain(r.fullName, 'main', { touch: false })).toBe('update ready (1 commit)');
    await pushUpstream(r, 1);
    expect(await syncMain(r.fullName, 'main', { touch: false })).toBe('update ready (2 commits)');
    expect(await head(r.dir)).toBe(before);
    // It fetched, so the checkout knows about the update; it just didn't take it.
    expect(await originMain(r.dir)).toBe(await head(r.upstream));
  });

  it('returns how far behind it is, and whether a fast-forward would catch up', async () => {
    const r = await makeRepos();
    expect(await sync(r.fullName, 'main', { touch: false })).toEqual({ status: 'in sync', behind: 0, updatable: false });
    await pushUpstream(r, 2);
    expect(await sync(r.fullName, 'main', { touch: false })).toEqual({ status: 'update ready (2 commits)', behind: 2, updatable: true });
    await git(['checkout', '-q', '-b', 'my-feature'], { cwd: r.dir });
    expect(await sync(r.fullName, 'main', { touch: false })).toMatchObject({ behind: 2, updatable: false });
    await git(['checkout', '-q', 'main'], { cwd: r.dir });
    expect(await sync(r.fullName, 'main', { touch: true })).toMatchObject({ behind: 0, updatable: false });
  });

  it('installs dependencies when package.json changed', async () => {
    const r = await makeRepos();
    await commitFile(r.upstream, 'package.json', '{ "name": "sync-test", "version": "2.0.0" }\n');
    await git(['push', '-q', 'origin', 'main'], { cwd: r.upstream });
    const status = await syncMain(r.fullName, 'main', { touch: true });
    const short = await git(['rev-parse', '--short', 'HEAD'], { cwd: r.dir });
    expect(status).toBe(`updated to ${short} · dependencies installed`);
    expect(npmRuns).toMatchObject([{ cmd: process.platform === 'win32' ? 'cmd.exe' : 'npm', cwd: r.dir }]);
  });

  it.each(['npm_config_allow_scripts', 'NPM_CONFIG_ALLOW_SCRIPTS', 'NpM_cOnFiG_aLlOw_ScRiPtS'])('drops inherited %s before folder-sync installs', async (key) => {
    vi.stubEnv(key, 'esbuild');
    vi.stubEnv('npm_config_registry', 'https://registry.npmjs.org/');
    vi.stubEnv('npm_config_proxy', 'http://proxy.example:8080');
    vi.stubEnv('npm_config_cache', path.join(ROOT, 'npm cache'));
    const r = await makeRepos();
    await commitFile(r.upstream, 'package-lock.json', '{}\n');
    await git(['push', '-q', 'origin', 'main'], { cwd: r.upstream });
    expect(await syncMain(r.fullName, 'main', { touch: true })).toMatch(/^updated to \w+ · dependencies installed$/);
    expect(npmRuns).toHaveLength(1);
    const env = npmRuns[0]!.env;
    expect(env).toBeDefined();
    expect(Object.keys(env!).some((name) => name.toLowerCase() === 'npm_config_allow_scripts')).toBe(false);
    // Windows: a variable the runner already set (NPM_CONFIG_CACHE) keeps its own case when the test sets it.
    expect(Object.fromEntries(Object.entries(env!).map(([name, value]) => [name.toLowerCase(), value]))).toMatchObject({
      npm_config_registry: 'https://registry.npmjs.org/',
      npm_config_proxy: 'http://proxy.example:8080',
      npm_config_cache: path.join(ROOT, 'npm cache'),
    });
    expect(process.env[key]).toBe('esbuild');
  });

  it('installs dependencies when the lockfile changed', async () => {
    const r = await makeRepos();
    await commitFile(r.upstream, 'package-lock.json', '{}\n');
    await git(['push', '-q', 'origin', 'main'], { cwd: r.upstream });
    expect(await syncMain(r.fullName, 'main', { touch: true })).toMatch(/^updated to \w+ · dependencies installed$/);
    expect(npmRuns).toHaveLength(1);
  });

  it("doesn't install for a package.json in a subfolder", async () => {
    const r = await makeRepos();
    await commitFile(r.upstream, 'packages/app/package.json', '{}\n');
    await git(['push', '-q', 'origin', 'main'], { cwd: r.upstream });
    expect(await syncMain(r.fullName, 'main', { touch: true })).toMatch(/^updated to \w+$/);
    expect(npmRuns).toEqual([]);
  });

  it('fast-forwards a Windows-style checkout with CRLF line endings', async () => {
    // core.autocrlf=true: the working tree has CRLF while the repo has LF, which must not count as local changes.
    const r = await makeRepos(['-c', 'core.autocrlf=true']);
    expect(await fs.readFile(path.join(r.dir, 'README.md'), 'utf8')).toBe('# Test\r\n');
    await commitFile(r.upstream, 'lines.txt', 'one\ntwo\n');
    await git(['push', '-q', 'origin', 'main'], { cwd: r.upstream });
    expect(await syncMain(r.fullName, 'main', { touch: true })).toMatch(/^updated to \w+$/);
    expect(await head(r.dir)).toBe(await head(r.upstream));
    expect(await fs.readFile(path.join(r.dir, 'lines.txt'), 'utf8')).toBe('one\r\ntwo\r\n');
  });
});

describe('prepareDesk', { timeout: 60_000 }, () => {
  it.each([false, true])('prepares a PR takeover with the author branch occupied (existing desk: %s)', async (existingDesk) => {
    const r = await makeRepos();
    const branch = 'swarm/issue-120-barbara';
    const original = await prepareDesk(r.fullName, { defaultBranch: 'main' }, 'barbara-8528', branch);
    await git(['update-ref', 'refs/pull/120/head', 'HEAD'], { cwd: r.upstream });
    await git(['push', '-q', 'origin', 'refs/pull/120/head'], { cwd: r.upstream });
    const originalHead = await head(original);
    await fs.writeFile(path.join(original, 'README.md'), '# Author work in progress\n');
    if (existingDesk) await prepareDesk(r.fullName, { defaultBranch: 'main' }, 'ken-cfe2', 'swarm/issue-127-ken');
    const fixBranch = 'fix/pr-120-ken-cfe2';
    const takeover = await prepareDesk(r.fullName, { defaultBranch: 'main', pr: 120 }, 'ken-cfe2', fixBranch);
    expect(takeover).toBe(deskDir(r.fullName, 'ken-cfe2'));
    expect(await git(['branch', '--show-current'], { cwd: takeover })).toBe(fixBranch);
    expect(await head(takeover)).toBe(originalHead);
    expect(await head(original)).toBe(originalHead);
    expect(await fs.readFile(path.join(original, 'README.md'), 'utf8')).toBe('# Author work in progress\n');
    expect(await git(['branch', '--show-current'], { cwd: original })).toBe(branch);
  });

  it.each([['author', false], ['author', true], ['manager', false], ['manager', true]] as const)(
    'uses detached HEAD when the %s holds the PR branch (reused desk: %s)', async (holder, reused) => {
      const r = await makeRepos();
      const branch = 'swarm/shared-branch';
      const original = holder === 'author'
        ? await prepareDesk(r.fullName, { defaultBranch: 'main' }, 'author', branch)
        : r.dir;
      if (holder === 'manager') await git(['checkout', '-b', branch], { cwd: original });
      await commitFile(original, 'feature.txt', 'feature\n');
      await git(['push', 'origin', branch, 'HEAD:refs/pull/198/head'], { cwd: original });
      const before = await head(original);
      await fs.writeFile(path.join(original, 'README.md'), '# Work in progress\n');
      await fs.writeFile(path.join(original, 'untracked.txt'), 'untracked\n');
      if (reused) await prepareDesk(r.fullName, { defaultBranch: 'main' }, 'fixer', 'previous-task');
      // Both QA and fixes can request a branch held elsewhere.
      for (const slug of ['fixer', 'tester']) {
        const notes: string[] = [];
        const desk = await prepareDesk(r.fullName, { defaultBranch: 'main', pr: 198 }, slug, branch, (note) => notes.push(note));
        expect(await git(['branch', '--show-current'], { cwd: desk })).toBe('');
        expect(await head(desk)).toBe(await git(['rev-parse', `origin/${branch}`], { cwd: r.dir }));
        expect(notes).toEqual([expect.stringContaining(`git push origin HEAD:${branch}`)]);
        await commitFile(desk, `${slug}.txt`, 'fixed\n');
        await git(['push', 'origin', `HEAD:${branch}`, 'HEAD:refs/pull/198/head'], { cwd: desk });
        expect(await git(['ls-remote', 'origin', `refs/heads/${branch}`], { cwd: desk })).toContain(await head(desk));
      }
      expect(await head(original)).toBe(before);
      expect(await git(['rev-parse', branch], { cwd: r.dir })).toBe(before);
      expect(await git(['branch', '--show-current'], { cwd: original })).toBe(branch);
      expect(await fs.readFile(path.join(original, 'README.md'), 'utf8')).toBe('# Work in progress\n');
      expect(await fs.readFile(path.join(original, 'untracked.txt'), 'utf8')).toBe('untracked\n');
    },
  );

  it('reuses a desk after its workspace is relocated behind a symlink', async () => {
    const r = await makeRepos();
    const slug = 'barbara-8528';
    const branch = 'swarm/issue-120-barbara';
    const wt = await prepareDesk(r.fullName, { defaultBranch: 'main' }, slug, branch);
    // The main checkout stays in the user's projects folder; only the managed workspace moves.
    const main = path.join(ROOT, `project ${seq}`);
    await fs.rename(r.dir, main);
    setLocalPath(r.fullName, main);
    await git(['worktree', 'repair', wt], { cwd: main });
    const relocated = path.join(ROOT, `relocated workspace ${seq}`);
    await fs.rename(repoDir(r.fullName), relocated);
    await fs.symlink(relocated, repoDir(r.fullName), process.platform === 'win32' ? 'junction' : 'dir');

    expect(await prepareDesk(r.fullName, { defaultBranch: 'main' }, slug, branch)).toBe(deskDir(r.fullName, slug));
    expect(await git(['branch', '--show-current'], { cwd: wt })).toBe(branch);
  });

  it('keeps a desk on its own branch, with no note, when git spells its path differently', async () => {
    // The workspace sits behind a symlink (a junction on Windows), so git lists real paths the office never uses.
    const fullName = `sync-test/repo-${seq + 1}`;
    const real = path.join(ROOT, `aliased workspace ${seq + 1}`);
    await fs.mkdir(real, { recursive: true });
    await fs.mkdir(path.dirname(repoDir(fullName)), { recursive: true });
    await fs.symlink(real, repoDir(fullName), process.platform === 'win32' ? 'junction' : 'dir');
    const r = await makeRepos();
    expect(r.fullName).toBe(fullName);
    const slug = 'barbara-8528';
    const branch = 'swarm/issue-120-barbara';
    const wt = await prepareDesk(r.fullName, { defaultBranch: 'main' }, slug, branch);
    const listed = parseWorktrees(await git(['worktree', 'list', '--porcelain', '-z'], { cwd: r.dir }));
    expect(listed.find((w) => w.branch === branch)?.path).not.toBe(wt);

    const notes: string[] = [];
    expect(await prepareDesk(r.fullName, { defaultBranch: 'main' }, slug, branch, (note) => notes.push(note))).toBe(wt);
    expect(notes).toEqual([]);
    expect(await git(['branch', '--show-current'], { cwd: wt })).toBe(branch);
  });
});

describe('branch holders', () => {
  const listing = [
    'worktree /home/me/project', 'HEAD 1111', 'branch refs/heads/main', '',
    'worktree /home/me/.cubefarm/desks/ken cfe2', 'HEAD 2222', 'branch refs/heads/swarm/issue-120-ken', '',
    'worktree /home/me/.cubefarm/desks/tester', 'HEAD 3333', 'detached', '',
  ].join('\0');

  it('reads every worktree and its branch, keeping spaces in paths', () => {
    expect(parseWorktrees(listing)).toEqual([
      { path: '/home/me/project', branch: 'main' },
      { path: '/home/me/.cubefarm/desks/ken cfe2', branch: 'swarm/issue-120-ken' },
      { path: '/home/me/.cubefarm/desks/tester', branch: null },
    ]);
  });

  it('names a different holder, but never the desk itself', () => {
    const worktrees = parseWorktrees(listing);
    expect(branchHolder(worktrees, 'swarm/issue-120-ken', '/home/me/.cubefarm/desks/tester', 'linux')).toBe('/home/me/.cubefarm/desks/ken cfe2');
    expect(branchHolder(worktrees, 'swarm/issue-120-ken', '/home/me/.cubefarm/desks/ken cfe2/', 'linux')).toBeNull();
    expect(branchHolder(worktrees, 'swarm/unheld', '/home/me/.cubefarm/desks/tester', 'linux')).toBeNull();
  });

  it('compares Windows paths case-insensitively and with either slash, elsewhere exactly', () => {
    expect(samePath('C:\\Users\\Runner\\desks\\ken', 'c:/users/runner/DESKS/ken\\', 'win32')).toBe(true);
    expect(samePath('C:\\Users\\Runner\\desks\\ken', 'C:\\Users\\Runner\\desks\\barbara', 'win32')).toBe(false);
    expect(samePath('/home/me/desks/ken', '/home/me/desks/./ken/', 'linux')).toBe(true);
    expect(samePath('/Users/me/desks/ken', '/users/me/desks/ken', 'darwin')).toBe(false);
    const worktrees = [{ path: 'C:\\Users\\Runner\\.cubefarm\\desks\\ken', branch: 'b' }];
    expect(branchHolder(worktrees, 'b', 'c:\\users\\runner\\.cubefarm\\desks\\KEN', 'win32')).toBeNull();
    expect(branchHolder(worktrees, 'b', 'C:\\Users\\Runner\\.cubefarm\\desks\\tester', 'win32')).toBe(worktrees[0].path);
  });

  it('falls back to the path as given when it cannot be resolved', async () => {
    const missing = path.join(ROOT, 'no such desk');
    expect(await realPath(missing)).toBe(missing);
  });

  it('resolves a symlinked folder to the same real path as its target', async () => {
    const target = path.join(ROOT, 'link target');
    const alias = path.join(ROOT, 'link alias');
    await fs.mkdir(target, { recursive: true });
    await fs.symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
    expect(samePath(await realPath(alias), await realPath(target))).toBe(true);
  });

  it.runIf(process.platform === 'win32')('resolves a Windows 8.3 short name to the long one', async (ctx) => {
    const long = await realPath(ROOT);
    const short = await run('powershell.exe', ['-NoProfile', '-Command', '(New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:LONG_PATH).ShortPath'], {
      env: { ...process.env, LONG_PATH: long },
    }).then((out) => out.trim(), () => '');
    // 8.3 names can be turned off per volume; nothing to compare then.
    if (!short || samePath(short, long)) ctx.skip();
    expect(samePath(await realPath(short), long)).toBe(true);
  });
});

describe('leftoversInDesk', () => {
  const desk = '/Users/ada/.cubefarm/workspaces/me__app/desks/ada-01df';
  const keep = { pids: [300], markers: ['/Users/ada/.cubefarm/sessions', '/Users/ada/.cubefarm/bin'] };

  it("finds what an agent left running in its desk, but never an agent's own CLI or the office's processes", () => {
    const listing = [
      `  101 node ${desk}/node_modules/.bin/vite --port 5401`, // a dev server it left: a leftover
      `  102 /bin/zsh -c cd ${desk} && npm test`, // a command still running there
      `  103 node /opt/homebrew/bin/codex -c notify=["node","/Users/ada/.cubefarm/bin/notify.cjs"] -c developer_instructions="Your worktree: ${desk}"`,
      `  104 /opt/homebrew/lib/codex/codex -c notify=["node","/Users/ada/.cubefarm/bin/notify.cjs"] -c developer_instructions="Your worktree: ${desk}"`,
      `  300 node /Users/ada/project/${desk}`, // spared by pid
      '  105 node /somewhere/else/server.js',
    ].join('\n');
    expect(leftoversInDesk(listing, desk, keep)).toEqual([101, 102]);
  });

  it('recognises Windows paths as Codex escapes them in its command line', () => {
    const winDesk = String.raw`C:\Users\Ada\.cubefarm\workspaces\me__app\desks\ada-01df`;
    const winKeep = { pids: [], markers: [String.raw`C:\Users\Ada\.cubefarm\bin`] };
    const escaped = (s: string) => s.replaceAll('\\', '\\\\'); // how -c values carry a path (JSON strings)
    const listing = [
      `  7 codex.exe -c notify=["node","${escaped(String.raw`C:\Users\Ada\.cubefarm\bin\notify.cjs`)}"] -c developer_instructions="Your worktree: ${escaped(winDesk)}"`,
      `  8 node ${winDesk}\\server.js`,
    ].join('\n');
    expect(leftoversInDesk(listing, winDesk, winKeep)).toEqual([8]);
  });
});
