import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultProjectsDir, readConfigEnv } from './config.ts';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cubefarm-config-'));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('defaultProjectsDir', () => {
  it('is the folder a checkout sits in', () => {
    expect(defaultProjectsDir(path.join(tmp, 'Projects', 'cubefarm'), tmp)).toBe(path.join(tmp, 'Projects'));
  });

  it('is a projects folder in your home when installed from npm', () => {
    const installed = path.join(tmp, 'npm', 'node_modules', 'cubefarm');
    expect(defaultProjectsDir(installed, tmp)).toBe(path.join(tmp, 'Projects'));
    fs.mkdirSync(path.join(tmp, 'code'));
    expect(defaultProjectsDir(installed, tmp)).toBe(path.join(tmp, 'code'));
  });
});

describe('readConfigEnv', () => {
  it('reads KEY=value lines, with export, comments, quotes and CRLF', () => {
    const file = path.join(tmp, '.env');
    fs.writeFileSync(file, '# office\r\nexport CUBEFARM_TELEGRAM_TOKEN=1:abc\r\nOTHER="x y"\r\n');
    expect(readConfigEnv(file)).toEqual({ CUBEFARM_TELEGRAM_TOKEN: '1:abc', OTHER: 'x y' });
  });
  it('has nothing when the file is missing, and leaves process.env alone', () => {
    expect(readConfigEnv(path.join(tmp, 'missing.env'))).toEqual({});
    fs.writeFileSync(path.join(tmp, '.env'), 'CUBEFARM_CONFIG_TEST=1\n');
    readConfigEnv(path.join(tmp, '.env'));
    expect(process.env.CUBEFARM_CONFIG_TEST).toBeUndefined();
  });
});
