// Checks the npm package the way a user gets it: packs it, installs it into an empty folder, runs the command
// and boots the office in demo mode (no GitHub, no Claude). Run `npm run build` first.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tsImport } from 'tsx/esm/api';

const root = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cubefarm-package-'));
// An agent's reserved port when it has one (CI sets SWARM_PORT=0).
const PORT = Number(process.env.SWARM_PORT) || 4456;
const sh = (cmd, cwd) => {
  const res = spawnSync(cmd, { cwd, shell: true, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`${cmd} failed:\n${res.stdout}\n${res.stderr}`);
  return res.stdout.trim();
};

let server;
try {
  const { ACTIVE_REPO_SKILLS, readRepoSkills } = await tsImport('../server/repoSkills.ts', import.meta.url);
  const tarball = path.join(root, sh('npm pack --silent', root).split(/\r?\n/).pop());
  sh('npm init -y', tmp);
  sh(`npm install --no-audit --no-fund "${tarball}"`, tmp);
  fs.rmSync(tarball);
  const version = sh('npx --no-install cubefarm --version', tmp);
  console.log(`cubefarm --version: ${version}`);

  const installed = path.join(tmp, 'node_modules', 'cubefarm');
  const packed = readRepoSkills(installed, version);
  const expected = ACTIVE_REPO_SKILLS.files;
  if (packed.files.length !== expected.length || packed.files.some((file, i) =>
    file.path !== expected[i].path || !file.content.equals(expected[i].content))) {
    throw new Error('npm package repo skills differ from the checkout');
  }
  console.log(`repo skills verified: ${packed.skills.length}`);

  for (const name of ['developer.md', 'prototype.md', 'qa.md']) {
    const specialism = path.join('docs', 'specialisms', name);
    if (!fs.readFileSync(path.join(installed, specialism)).equals(fs.readFileSync(path.join(root, specialism)))) {
      throw new Error(`npm package specialism differs from the checkout: ${name}`);
    }
  }

  const bin = path.join(installed, 'bin', 'cubefarm.js');
  server = spawn(process.execPath, [bin, '--demo', '--no-open', '--port', String(PORT)], {
    env: { ...process.env, SWARM_HOME: path.join(tmp, 'home') },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  let state = null;
  for (let i = 0; i < 120 && !state; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (server.exitCode !== null) throw new Error(`the office exited with code ${server.exitCode}`);
    state = await fetch(`http://127.0.0.1:${PORT}/api/state`)
      .then((r) => r.json())
      .catch(() => null);
  }
  if (!state || !Array.isArray(state.repos)) throw new Error('the office never answered /api/state');
  const page = await fetch(`http://127.0.0.1:${PORT}/`).then((r) => r.text());
  if (!page.includes('<title>cubefarm</title>')) throw new Error('the office does not serve the client');
  console.log(`demo office up: ${state.repos.length} floors, ${state.agents.length} agents, client served`);
} finally {
  server?.kill();
  // Windows keeps the folder locked until the office has exited.
  await new Promise((r) => setTimeout(r, 1000));
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
}
