#!/usr/bin/env node
// Install the standalone maintenance checker in the current Unix user's crontab, preserving unrelated entries.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (process.platform === 'win32') throw new Error('Use Task Scheduler to run cron-office-update.mjs on Windows.');
const home = os.homedir();
const destination = path.join(home, '.local', 'lib', 'cubefarm', 'cron-office-update.mjs');
const log = path.join(home, 'Library', 'Logs', 'cubefarm-maintenance.log');
const logFile = process.platform === 'darwin' ? log : path.join(home, '.cubefarm', 'maintenance.log');
const quote = (value) => `'${value.replaceAll("'", "'\\''").replaceAll('%', '\\%')}'`;
let current;
try { current = execFileSync('crontab', ['-l'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
catch (err) {
  if (err.status === 1 && /no crontab for/i.test(String(err.stderr))) current = '';
  else throw new Error(`Cannot read crontab: ${String(err.stderr || err.message).trim()}`);
}
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.mkdirSync(path.dirname(logFile), { recursive: true });
fs.copyFileSync(path.join(import.meta.dirname, 'cron-office-update.mjs'), destination);
fs.chmodSync(destination, 0o700);
const marker = '# cubefarm-maintenance';
const kept = current.split('\n').filter((line) => !line.endsWith(marker)).join('\n').trimEnd();
const entry = `*/15 * * * * ${quote(process.execPath)} ${quote(destination)} >> ${quote(logFile)} 2>&1 ${marker}`;
execFileSync('crontab', ['-'], { input: `${kept ? `${kept}\n` : ''}${entry}\n`, stdio: ['pipe', 'pipe', 'pipe'] });
console.log(`Installed a 15-minute maintenance check. Script: ${destination}. Log: ${logFile}`);
