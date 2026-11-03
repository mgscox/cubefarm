// Stores the manager gateway's switch and credential verifier separately from shared office state.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import express, { type Request } from 'express';
import { z } from 'zod';
import { run } from './exec.ts';
import type { ManagerMcpSettingsPatch, ManagerMcpSettingsView } from '../shared/types.ts';

/** Resolve the office's own checkout once, before reading any manager MCP configuration. */
export async function isMainMcpOffice(root: string, env = process.env) {
  if (env.SWARM_SUB_OFFICE === '1' || !existsSync(path.join(root, '.git'))) return false;
  const gitEnv = { ...env };
  delete gitEnv.GIT_DIR;
  delete gitEnv.GIT_WORK_TREE;
  delete gitEnv.GIT_COMMON_DIR;
  const branch = await run('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
    cwd: root, env: gitEnv, timeoutMs: 3000,
  }).catch(() => '');
  return branch === 'main';
}

const managerTokenPattern = /^[A-Za-z0-9._~-]{32,256}$/;
export const managerTokenDigest = (token: string) => createHash('sha256').update(token).digest('hex');
const savedSchema = z.object({ enabled: z.boolean().optional(), digest: z.string().regex(/^[a-f0-9]{64}$/).optional() });
const patchSchema = z.strictObject({
  enabled: z.boolean().optional(),
  token: z.string().trim().regex(managerTokenPattern).nullable().optional(),
});

export class ManagerMcpSettings {
  private saved: z.infer<typeof savedSchema>;
  private readonly startupDigest: string | undefined;
  private writes = Promise.resolve();

  constructor(private readonly file: string, startupToken: string | undefined) {
    if (startupToken && managerTokenPattern.test(startupToken)) this.startupDigest = managerTokenDigest(startupToken);
    else if (startupToken) console.warn('CUBEFARM_MCP_TOKEN must be 32–256 URL-safe characters.');
    try {
      this.saved = savedSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') this.saved = {};
      else {
        console.warn('Could not read saved manager MCP settings. The gateway is disabled.');
        this.saved = { enabled: false };
      }
    }
  }

  view(canManage: boolean): ManagerMcpSettingsView {
    const tokenSource = this.saved.digest ? 'settings' : this.startupDigest ? 'startup' : null;
    return { available: true, enabled: this.saved.enabled ?? (tokenSource !== null), tokenSource, canManage };
  }

  activeDigest() {
    const digest = this.saved.digest ?? this.startupDigest;
    return (this.saved.enabled ?? Boolean(digest)) ? digest : undefined;
  }

  update(patch: ManagerMcpSettingsPatch) {
    const write = this.writes.then(async () => {
      const next = { ...this.saved, enabled: patch.enabled ?? this.view(true).enabled };
      if (patch.token !== undefined) next.digest = patch.token === null ? undefined : managerTokenDigest(patch.token);
      await mkdir(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, JSON.stringify(next), { mode: 0o600, flag: 'wx' });
        await rename(temp, this.file);
      } catch (error) {
        await rm(temp, { force: true }).catch(() => undefined);
        throw error;
      }
      this.saved = next;
      return this.view(true);
    });
    this.writes = write.then(() => undefined, () => undefined);
    return write;
  }
}

const loopback = (address: string | undefined) => address === '::1' || /^(?:::ffff:)?127\.\d+\.\d+\.\d+$/.test(address ?? '');

function canManage(req: Request) {
  const host = req.get('Host')?.toLowerCase();
  const origin = req.get('Origin');
  const forwarded = req.get('X-Forwarded-For');
  return loopback(req.socket.remoteAddress)
    && /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host ?? '')
    && (!forwarded || forwarded.split(',').every((address) => loopback(address.trim())))
    && (origin === undefined || origin === `${req.protocol}://${host}`);
}

export function managerMcpSettingsRouter(settings: ManagerMcpSettings | null) {
  const router = express.Router();
  const parse = express.json({ limit: '2kb' });
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  if (!settings) {
    const unavailable: ManagerMcpSettingsView = { available: false, enabled: false, tokenSource: null, canManage: false };
    router.get('/', (_req, res) => { res.json(unavailable); });
    router.patch('/', (_req, res) => { res.status(404).json({ error: 'Manager MCP is only available in the main branch office.' }); });
    return router;
  }
  router.get('/', (req, res) => { res.json(settings.view(canManage(req))); });
  router.patch('/', (req, res, next) => {
    if (!canManage(req)) return void res.status(403).json({ error: 'Open CubeFarm through localhost to change MCP settings.' });
    if (!req.is('application/json')) return void res.status(415).json({ error: 'Send MCP settings as JSON.' });
    parse(req, res, (error) => {
      if (error) return void res.status(400).json({ error: 'Invalid MCP settings request.' });
      next();
    });
  }, async (req, res) => {
    const result = patchSchema.safeParse(req.body);
    if (!result.success || (result.data.enabled === undefined && result.data.token === undefined)) {
      return void res.status(400).json({ error: 'Enter a token of 32–256 letters, digits, or . _ ~ - characters, or change the switch.' });
    }
    try { res.json(await settings.update(result.data)); }
    catch { res.status(500).json({ error: 'Could not save MCP settings. Check the office state folder permissions.' }); }
  });
  return router;
}
