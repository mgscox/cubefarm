#!/usr/bin/env node
/** Retain CI files in the runner-provided local artifact directory. */
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import path from 'node:path';

const workspace = path.resolve(process.env.GITHUB_WORKSPACE ?? process.cwd());
const artifactRoot = process.env.RUNNER_ARTIFACTS_DIR;
const group = process.env.CI_ARTIFACT_NAME;
const retentionDays = Number(process.env.CI_ARTIFACT_RETENTION_DAYS);
const requiredValue = process.env.CI_ARTIFACT_REQUIRED;
const patterns = (process.env.CI_ARTIFACT_PATHS ?? '').split(/\r?\n/).map((value) => value.trim()).filter(Boolean);

if (!artifactRoot || !group || !patterns.length || !Number.isFinite(retentionDays) || retentionDays <= 0) {
  throw new Error('RUNNER_ARTIFACTS_DIR, CI_ARTIFACT_NAME, CI_ARTIFACT_PATHS, and positive CI_ARTIFACT_RETENTION_DAYS are required');
}
if (!['true', 'false'].includes(requiredValue)) throw new Error('CI_ARTIFACT_REQUIRED must be true or false');
if (path.basename(group) !== group || group === '.' || group === '..') throw new Error('CI_ARTIFACT_NAME must be a simple group name');

const files = new Set();
for (const pattern of patterns) {
  for (const match of globSync(pattern, { cwd: workspace })) {
    const source = path.resolve(workspace, match);
    if (!source.startsWith(`${workspace}${path.sep}`) || !existsSync(source) || !statSync(source).isFile()) continue;
    files.add(source);
  }
}

if (files.size === 0) {
  const message = `No files matched CI_ARTIFACT_PATHS for ${group}`;
  if (requiredValue === 'true') throw new Error(message);
  console.warn(`Warning: ${message}`);
  process.exitCode = 0;
} else {
  const root = path.resolve(artifactRoot);
  const groupRoot = path.join(root, group);
  mkdirSync(groupRoot, { recursive: true });
  const now = Date.now();
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  for (const entry of readdirSync(groupRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(groupRoot, entry.name);
    if (statSync(directory).mtimeMs < cutoff) rmSync(directory, { recursive: true, force: true });
  }

  const runId = process.env.GITHUB_RUN_ID ?? 'local';
  const attempt = process.env.GITHUB_RUN_ATTEMPT ?? '1';
  const output = path.join(groupRoot, `${runId}-${attempt}`);
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  const relativeFiles = [];
  for (const source of files) {
    const relative = path.relative(workspace, source);
    const destination = path.join(output, relative);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    relativeFiles.push(relative.split(path.sep).join('/'));
  }
  const manifest = {
    name: group,
    run: runId,
    ref: process.env.GITHUB_REF ?? '',
    sha: process.env.GITHUB_SHA ?? '',
    createdAt: new Date(now).toISOString(),
    files: relativeFiles.sort(),
  };
  writeFileSync(path.join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Retained ${files.size} file(s) at ${output}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### CI artifacts: ${group}\n\nLocal runner path: \`${output}\` (${files.size} files, ${retentionDays} day retention)\n`);
  }
}
