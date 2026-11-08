// Keep the Box API key separate from office state and expose only its source to clients.
import express from 'express';
import { z } from 'zod';
import { readOfficeCredential, writeOfficeCredential } from '../bin/officeCredentials.js';
import type { UpstashKeySettingsView } from '../shared/types.ts';
import { HttpError } from './httpError.ts';
import { canManageOfficeSettings } from './managerMcpSettings.ts';

const filename = 'upstash-box.json';
const key = z.string().trim().regex(/^[!-~]{1,512}$/);
const patch = z.strictObject({ key: key.nullable() });

export class UpstashKeySettings {
  private saved: string | undefined;
  private unreadable = false;

  /** An undefined home keeps demo changes in memory. */
  constructor(private readonly home: string | undefined, private readonly fallback: string | undefined) {
    if (home) {
      try { this.saved = readOfficeCredential(home, filename, (value: unknown) => key.safeParse(value).success)?.token; }
      catch {
        this.unreadable = true;
        console.warn('Could not read the saved Upstash Box key. Upstash Box access is paused.');
      }
    }
  }

  activeKey() {
    // An explicit empty key also prevents the SDK from trying its own process environment fallback.
    return this.unreadable ? '' : this.saved ?? this.fallback;
  }

  keyAfter(value: string | null) { return value ?? this.fallback; }

  view(canManage: boolean): UpstashKeySettingsView {
    return { keySource: this.unreadable ? 'unreadable' : this.saved ? 'settings' : this.fallback ? 'startup' : null, canManage };
  }

  update(value: string | null) {
    if (this.home) writeOfficeCredential(this.home, filename, value);
    this.saved = value ?? undefined;
    this.unreadable = false;
  }
}

export function upstashKeySettingsRouter(settings: UpstashKeySettings, change: (key: string | null) => Promise<void>) {
  const router = express.Router();
  const parse = express.json({ limit: '2kb' });
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.get('/', (req, res) => { res.json(settings.view(canManageOfficeSettings(req))); });
  router.patch('/', (req, res, next) => {
    if (!canManageOfficeSettings(req)) return void res.status(403).json({ error: 'Open CubeFarm through localhost to change the Upstash Box key.' });
    if (!req.is('application/json')) return void res.status(415).json({ error: 'Send Upstash settings as JSON.' });
    parse(req, res, (error) => {
      if (error) return void res.status(400).json({ error: 'Invalid Upstash settings request.' });
      next();
    });
  }, async (req, res) => {
    const result = patch.safeParse(req.body);
    if (!result.success) return void res.status(400).json({ error: 'Enter a valid Upstash Box API key or clear the saved key.' });
    try {
      await change(result.data.key);
      res.json(settings.view(true));
    } catch (error) {
      if (error instanceof HttpError) res.status(error.status).json({ error: error.message });
      else res.status(500).json({ error: 'Could not save the Upstash Box key. Check the office credential folder permissions.' });
    }
  });
  return router;
}
