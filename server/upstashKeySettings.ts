// Write-only Box credential storage, separate from office state and never inherited by workers.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { z } from 'zod';
import type { UpstashKeySettingsView, UpstashKeyStatus } from '../shared/types.ts';
import { HttpError } from './httpError.ts';
import { canManageLocalSettings } from './managerMcpSettings.ts';

const keySchema = z.string().trim().min(1).max(1024).regex(/^[\x21-\x7e]+$/);
const patchSchema = z.strictObject({ key: keySchema.nullable() });

export class UpstashKeySettings {
  private saved: string | undefined;
  private readonly file: string;

  constructor(home: string, private readonly startupKey: string | undefined, private readonly demo = false) {
    this.file = path.join(home, 'credentials', 'upstash-box.json');
    if (demo) return;
    try {
      this.checkDirectory();
      const stat = fs.lstatSync(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2048 || (process.getuid && stat.uid !== process.getuid()) || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error();
      this.saved = keySchema.parse(JSON.parse(fs.readFileSync(this.file, 'utf8')).key);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Could not read saved Upstash Box key. Check the private credentials folder.');
    }
  }

  private checkDirectory() {
    const stat = fs.lstatSync(path.dirname(this.file));
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) throw new Error();
  }

  activeKey() { return this.saved ?? this.startupKey; }
  fallbackKey() { return this.startupKey; }
  status(): UpstashKeyStatus {
    return { available: true, keySource: this.saved ? 'settings' : this.startupKey ? 'startup' : null };
  }
  view(canManage: boolean): UpstashKeySettingsView { return { ...this.status(), canManage }; }

  /** Called within the task queue, after the candidate's access has been verified. */
  async save(key: string | null) {
    if (key !== null) key = keySchema.parse(key);
    if (!this.demo) {
      const dir = path.dirname(this.file);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      this.checkDirectory();
      await chmod(dir, 0o700);
      if (key === null) await rm(this.file, { force: true, maxRetries: 5 });
      else {
        const temp = path.join(dir, `${randomUUID()}.tmp`);
        try {
          await writeFile(temp, JSON.stringify({ key }), { mode: 0o600, flag: 'wx' });
          await rename(temp, this.file);
        } finally { await rm(temp, { force: true, maxRetries: 5 }); }
      }
    }
    this.saved = key ?? undefined;
  }
}

export function upstashKeySettingsRouter(settings: UpstashKeySettings | null, update: (key: string | null) => Promise<void>) {
  const router = express.Router();
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.get('/', (req, res) => res.json(settings?.view(canManageLocalSettings(req)) ?? { available: false, keySource: null, canManage: false }));
  router.patch('/', (req, res, next) => {
    if (!settings) return void res.status(404).json({ error: 'Upstash Box key settings are only available in the main branch office.' });
    if (!canManageLocalSettings(req)) return void res.status(403).json({ error: 'Open CubeFarm through localhost to change the Box API key.' });
    if (!req.is('application/json')) return void res.status(415).json({ error: 'Send Box key settings as JSON.' });
    express.json({ limit: '2kb' })(req, res, (error) => {
      if (error) return void res.status(400).json({ error: 'Invalid Box key settings request.' });
      next();
    });
  }, async (req, res) => {
    const patch = patchSchema.safeParse(req.body);
    if (!patch.success) return void res.status(400).json({ error: 'Enter a Box API key of 1–1024 non-space ASCII characters, or clear the saved key.' });
    try {
      await update(patch.data.key);
      res.json(settings!.view(true));
    } catch (error) {
      res.status(error instanceof HttpError ? error.status : 500).json({ error: error instanceof HttpError ? error.message : 'Could not save the Box API key. Check the private credentials folder permissions.' });
    }
  });
  return router;
}
