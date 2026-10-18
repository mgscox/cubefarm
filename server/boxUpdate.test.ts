import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkoutCommit, releaseCommit, updateBox, updateRefusal } from './boxUpdate.ts';
import { createBoxOps } from './boxOps.ts';

// A box's info asks gh too: not in tests.
vi.mock('./exec.ts', async (actual) => {
  const exec = await actual<typeof import('./exec.ts')>();
  return { ...exec, run: (file: string, args: string[], opts?: Parameters<typeof exec.run>[2]) => (file === 'gh' ? Promise.reject(new Error('no gh here')) : exec.run(file, args, opts)) };
});

describe('updateRefusal', () => {
  const ok = { branch: 'main', defaultBranch: 'main', dirty: false, ahead: 0, behindOffice: true, office: 'abc1234def' };

  it("moves a clean checkout on the default branch that's behind the office", () => {
    expect(updateRefusal(ok)).toBeNull();
  });

  it("refuses what the launcher refuses, worded for the box, and a checkout past the office's commit", () => {
    expect(updateRefusal({ ...ok, dirty: true })).toBe("the box's cubefarm folder has local changes");
    expect(updateRefusal({ ...ok, branch: 'mine' })).toMatch(/on branch mine/);
    expect(updateRefusal({ ...ok, behindOffice: false })).toBe("the box's cubefarm has commits the office's abc1234 hasn't");
    expect(updateRefusal({ ...ok, behindOffice: false, office: '0.3.19' })).toBe("the box's cubefarm has commits the office's v0.3.19 hasn't");
  });
});

// A box's checkout of cubefarm, cloned from a bare origin; its "build" writes which commit it built.
describe('updateBox', () => {
  let tmp: string;
  let work: string;
  let box: string;
  const run = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const BUILD = "import fs from 'node:fs'; fs.mkdirSync('dist-server', { recursive: true }); fs.writeFileSync('dist-server/built.txt', fs.readFileSync('version.txt'));\n";
  const commit = (files: Record<string, string>) => {
    for (const [f, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(work, f)), { recursive: true });
      fs.writeFileSync(path.join(work, f), text);
    }
    run(work, 'add', '-A');
    run(work, 'commit', '-qm', 'change');
    run(work, 'push', '-q', 'origin', 'main');
    return run(work, 'rev-parse', 'HEAD');
  };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'box-update-'));
    work = path.join(tmp, 'work');
    box = path.join(tmp, 'box');
    run(tmp, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
    run(tmp, 'clone', '-q', path.join(tmp, 'origin.git'), work);
    run(work, 'checkout', '-q', '-b', 'main');
    commit({ 'version.txt': 'one', 'scripts/build-server.mjs': BUILD, '.gitignore': 'dist-server\n' });
    run(tmp, 'clone', '-q', path.join(tmp, 'origin.git'), box);
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }));

  it("fast-forwards to the office's commit and builds the server", async () => {
    const from = await checkoutCommit(box);
    const office = commit({ 'version.txt': 'two' });
    expect(await updateBox(office, box)).toEqual({ ok: true, checkout: true, from, to: office });
    expect(fs.readFileSync(path.join(box, 'dist-server', 'built.txt'), 'utf8')).toBe('two');
  });

  it('rolls back when the build fails', async () => {
    const from = await checkoutCommit(box);
    const office = commit({ 'scripts/build-server.mjs': 'process.exit(3);\n' });
    const r = await updateBox(office, box);
    expect(r).toMatchObject({ ok: false, checkout: true, from, to: from });
    expect(r.error).toMatch(/build-server\.mjs failed \(exit 3\)/);
  });

  it("refuses a checkout with local changes, and a commit the box's origin hasn't got", async () => {
    const office = commit({ 'version.txt': 'two' });
    fs.writeFileSync(path.join(box, 'version.txt'), 'mine');
    expect(await updateBox(office, box)).toMatchObject({ ok: false, error: "the box's cubefarm folder has local changes" });
    expect(await updateBox('f'.repeat(40), box)).toMatchObject({ ok: false, error: "the office's fffffff isn't on the box's origin" });
  });

  it("moves to the office's release when the office runs from npm: its tag", async () => {
    const release = commit({ 'version.txt': 'two' });
    run(work, 'tag', 'v0.4.0');
    run(work, 'push', '-q', 'origin', 'v0.4.0');
    commit({ 'version.txt': 'three' });
    expect(await updateBox('0.4.0', box)).toMatchObject({ ok: true, checkout: true, to: release });
    expect(fs.readFileSync(path.join(box, 'dist-server', 'built.txt'), 'utf8')).toBe('two');
    expect(await updateBox('9.9.9', box)).toMatchObject({ ok: false, to: release, error: "the office's v9.9.9 isn't on the box's origin" });
  });

  it("finds an untagged release by the commit that set package.json's version", async () => {
    commit({ 'package.json': '{ "version": "0.3.18" }\n' });
    const release = commit({ 'package.json': '{ "version": "0.3.19" }\n' });
    commit({ 'version.txt': 'two' });
    commit({ 'package.json': '{ "version": "0.3.19", "private": true }\n' });
    commit({ 'package.json': '{ "version": "0.3.20" }\n' });
    expect(await releaseCommit('0.3.19', 'main', work)).toBe(release);
    expect(await releaseCommit('0.3.17', 'main', work)).toBeNull();
  });

  it("reports the commit its host started on, not the checkout's HEAD after an update", async () => {
    const from = await checkoutCommit(box);
    const host = createBoxOps({ hookUrl: () => '', pids: () => [], root: box });
    const office = commit({ 'version.txt': 'two' });
    expect(await updateBox(office, box)).toMatchObject({ ok: true, to: office });
    // The office restarted before restarting the host: the host it finds still runs the old build, and says so.
    expect(await host.rpc('info', [])).toMatchObject({ commit: from, ghReady: false });
    expect(await createBoxOps({ hookUrl: () => '', pids: () => [], root: box }).rpc('info', [])).toMatchObject({ commit: office });
  });

  it("says when it isn't a checkout (run by npx)", async () => {
    const plain = path.join(tmp, 'plain');
    fs.mkdirSync(plain);
    expect(await updateBox('a'.repeat(40), plain)).toEqual({ ok: true, checkout: false, from: null, to: null });
  });
});
