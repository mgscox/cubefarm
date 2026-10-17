import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'vitest';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('./retain-ci-artifacts.mjs', import.meta.url));

test('copies matching files, writes provenance, and removes expired runs in the named group', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ci-retain-'));
  try {
    const workspace = path.join(root, 'workspace');
    const artifacts = path.join(root, 'artifacts');
    mkdirSync(path.join(workspace, '.tmp', 'ci'), { recursive: true });
    writeFileSync(path.join(workspace, '.tmp', 'ci', 'checks.log'), 'ok');
    mkdirSync(path.join(artifacts, 'checks', 'expired'), { recursive: true });
    const expired = path.join(artifacts, 'checks', 'expired');
    const old = new Date(Date.now() - 5 * 86400000);
    utimesSync(expired, old, old);
    const result = spawnSync(process.execPath, [helper], { cwd: workspace, encoding: 'utf8', env: {
      ...process.env, GITHUB_WORKSPACE: workspace, RUNNER_ARTIFACTS_DIR: artifacts,
      CI_ARTIFACT_NAME: 'checks', CI_ARTIFACT_PATHS: '.tmp/ci/**',
      CI_ARTIFACT_RETENTION_DAYS: '1', CI_ARTIFACT_REQUIRED: 'true',
      GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '2', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: 'abc123',
    } });
    assert.equal(result.status, 0, result.stderr);
    const output = path.join(artifacts, 'checks', '42-2');
    assert.equal(readFileSync(path.join(output, '.tmp', 'ci', 'checks.log'), 'utf8'), 'ok');
    const manifest = JSON.parse(readFileSync(path.join(output, 'manifest.json'), 'utf8'));
    assert.equal(manifest.run, '42');
    assert.equal(manifest.ref, 'refs/heads/main');
    assert.equal(manifest.sha, 'abc123');
    assert.equal(existsSync(expired), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('required missing files fail and optional missing files warn', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ci-retain-missing-'));
  try {
    const base = {
      ...process.env, GITHUB_WORKSPACE: root, RUNNER_ARTIFACTS_DIR: path.join(root, 'artifacts'),
      CI_ARTIFACT_NAME: 'missing', CI_ARTIFACT_PATHS: 'absent/**',
      CI_ARTIFACT_RETENTION_DAYS: '1',
    };
    const required = spawnSync(process.execPath, [helper], { cwd: root, encoding: 'utf8', env: { ...base, CI_ARTIFACT_REQUIRED: 'true' } });
    assert.notEqual(required.status, 0);
    const optional = spawnSync(process.execPath, [helper], { cwd: root, encoding: 'utf8', env: { ...base, CI_ARTIFACT_REQUIRED: 'false' } });
    assert.equal(optional.status, 0);
    assert.match(optional.stderr, /Warning: No files matched/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
