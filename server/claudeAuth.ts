// Phone sign-in uses only the official CLI in a private, bounded PTY; manual tokens are a fallback.
import express, { type Request, type Response, type NextFunction } from 'express';
import { isIP } from 'node:net';
import { randomUUID } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import { claudeAuthMetadata, saveClaudeToken, validClaudeToken } from '../bin/claudeAuth.js';
import { bundledClaude } from './clis.ts';
import { launchClaudeSetup, safeClaudeAuthorizationUrl, validClaudeCode, type AuthPtySpawner } from './claudeSetup.ts';
import type { ClaudeAuthenticationView } from '../shared/types.ts';

interface AuthOptions {
  home: string;
  env?: NodeJS.ProcessEnv;
  demo?: boolean;
  origin?: string;
  proxyAddress?: string;
  lifetimeMs?: number;
  spawnPty?: AuthPtySpawner;
}
interface Flow {
  id: string;
  expiresAt: number;
  session?: ReturnType<typeof launchClaudeSetup>;
  output: string;
  bytes: number;
  submitted: boolean;
  authorizationUrl: string | null;
  disposables: { dispose(): void }[];
}
const terminalText = (raw: string) => stripVTControlCharacters(raw.replace(/\x1b\[[0-9]*[CG]/g, ' '));
const demoUrl = 'https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG&code_challenge_method=S256&state=demo0123456789abcdef';

export class ClaudeAuthentication {
  private phase: ClaudeAuthenticationView['phase'] = 'idle';
  private mode: ClaudeAuthenticationView['mode'] = 'browser';
  private flow: Flow | null = null;
  private timer?: NodeJS.Timeout;
  private finishing?: Promise<void>;
  private closed = false;
  readonly demo: boolean;

  constructor(readonly options: AuthOptions) { this.demo = options.demo === true; }

  view(canManage = true): ClaudeAuthenticationView {
    let source: ClaudeAuthenticationView['source'];
    try { source = claudeAuthMetadata({ ...this.options.env, SWARM_HOME: this.options.home }, this.demo).source; }
    catch { source = 'unavailable'; }
    const file = this.demo ? null : bundledClaude();
    const quoted = file && (process.platform === 'win32' ? `& '${file.replaceAll("'", "''")}'` : `'${file.replaceAll("'", "'\\''")}'`);
    return {
      mode: this.mode, source, expiresAt: null, canManage, demo: this.demo, phase: this.phase,
      flowId: this.flow?.id ?? null, flowExpiresAt: this.flow?.expiresAt ?? null,
      setupCommand: this.demo ? 'Demo: no Claude process is launched' : quoted ? `${quoted} setup-token` : null,
      authorizationUrl: this.flow?.authorizationUrl ?? null,
    };
  }

  start(mode: ClaudeAuthenticationView['mode'] = 'browser') {
    if (this.flow || this.finishing || this.closed) return null;
    this.mode = mode;
    const flow: Flow = { id: randomUUID(), expiresAt: Date.now() + Math.max(1, Math.min(this.options.lifetimeMs ?? 600_000, 600_000)), output: '', bytes: 0, submitted: false, authorizationUrl: null, disposables: [] };
    this.flow = flow;
    this.phase = mode === 'manual-token' ? 'pending' : 'starting';
    this.timer = setTimeout(() => { void this.end('expired'); }, Math.max(1, flow.expiresAt - Date.now()));
    this.timer.unref();
    if (mode === 'browser') {
      if (this.demo) { flow.authorizationUrl = demoUrl; this.phase = 'awaiting-code'; }
      else {
        try {
          const file = bundledClaude();
          if (!file) throw new Error('Unavailable');
          flow.session = launchClaudeSetup(file, this.options.spawnPty);
          flow.disposables.push(flow.session.pty.onData((data) => this.output(flow, data)));
          flow.disposables.push(flow.session.pty.onExit(({ exitCode }) => { void this.exited(flow, exitCode); }));
        } catch { void this.end('failed'); }
      }
    }
    return this.view();
  }

  private output(flow: Flow, data: string) {
    if (this.flow !== flow || this.finishing) return;
    flow.bytes += Buffer.byteLength(data);
    if (flow.bytes > 65536) { void this.end('failed'); return; }
    flow.output += data;
    const text = terminalText(flow.output);
    if (/OAuth error:|Authentication failed|Error:/i.test(text)) { void this.end('failed'); return; }
    if (!flow.submitted) {
      // Wait for a delimiter: a URL split across PTY chunks must never be published partially.
      const links = [...text.matchAll(/https?:\/\/[^\s]+(?=\s)/g)];
      for (const [link] of links) {
        if (link.includes('/oauth/authorize')) {
          const safe = safeClaudeAuthorizationUrl(link);
          if (!safe) { void this.end('failed'); return; }
          if (flow.authorizationUrl && flow.authorizationUrl !== safe) { void this.end('failed'); return; }
          flow.authorizationUrl = safe;
        }
      }
      if (flow.authorizationUrl && /Paste code here if prompted/i.test(text)) this.phase = 'awaiting-code';
    }
  }

  private async exited(flow: Flow, exitCode: number) {
    if (this.flow !== flow || this.finishing) return;
    const text = terminalText(flow.output);
    const captured = text.match(/Long-lived authentication token created successfully![\s\S]*?Your OAuth token \(valid for [^\r\n]{1,80}\):?\s+(sk-ant-oat01-[A-Za-z0-9_-]{32,512})(?=\s)/)?.[1];
    if (exitCode !== 0 || !flow.submitted || !validClaudeToken(captured)) { await this.end('failed'); return; }
    await this.persist(flow, captured);
  }

  private matches(id: string) {
    if (this.flow && this.flow.expiresAt <= Date.now()) { void this.end('expired'); return false; }
    return !this.finishing && this.flow?.id === id;
  }

  async submitCode(id: string, code: string) {
    if (!validClaudeCode(code) || !this.matches(id) || this.mode !== 'browser' || this.phase !== 'awaiting-code') return null;
    const flow = this.flow!;
    flow.submitted = true;
    flow.authorizationUrl = null;
    flow.output = '';
    this.phase = 'exchanging';
    if (this.demo) { await this.end(code === 'demo-code-123' ? 'complete' : 'failed'); }
    else {
      try { flow.session!.pty.write(code + '\r'); }
      catch { await this.end('failed'); }
    }
    return this.view();
  }

  async complete(id: string, token: string) {
    if (!validClaudeToken(token) || !this.matches(id) || this.mode !== 'manual-token' || this.phase !== 'pending') return null;
    await this.persist(this.flow!, token);
    if (this.view().phase === 'failed') throw new Error('Could not save Claude subscription token.');
    return this.view();
  }

  private async persist(flow: Flow, token: string) {
    this.phase = 'saving';
    // Release the PTY before writing; a concurrent cancellation/close invalidates this flow.
    try {
      await flow.session?.close();
      if (this.flow !== flow) return;
      if (flow.expiresAt <= Date.now()) { await this.end('expired'); return; }
      if (!this.demo) await saveClaudeToken(this.options.home, token);
      await this.end('complete');
    } catch { await this.end('failed'); }
  }

  async cancel(id: string) {
    if (!this.matches(id)) return null;
    await this.end('cancelled');
    return this.view();
  }

  private end(phase: ClaudeAuthenticationView['phase']) {
    if (this.finishing) return this.finishing;
    clearTimeout(this.timer);
    this.timer = undefined;
    const flow = this.flow;
    this.flow = null;
    this.phase = phase;
    if (flow) {
      flow.output = '';
      flow.authorizationUrl = null;
      for (const disposable of flow.disposables) disposable.dispose();
    }
    this.finishing = (async () => {
      try { await flow?.session?.close(); } catch { this.phase = 'failed'; }
    })().finally(() => { this.finishing = undefined; });
    return this.finishing;
  }

  async close() { this.closed = true; await this.end('cancelled'); }
}

// The external HTTPS origin is configuration, not a value inferred from arbitrary forwarded headers.
// nginx must preserve Host and authenticate this route; only its explicitly trusted socket may reach it.
const loopback = (ip: string) => ip === '::1' || /^(?:::ffff:)?127\.\d+\.\d+\.\d+$/.test(ip);
export function canManageClaudeAuth(req: Request, options: AuthOptions) {
  const peer = req.socket.remoteAddress ?? '';
  const trustedPeer = options.proxyAddress
    ? isIP(options.proxyAddress) !== 0 && peer.replace(/^::ffff:/, '') === options.proxyAddress.replace(/^::ffff:/, '')
    : loopback(peer);
  if (!trustedPeer || req.get('X-CubeFarm-Claude-Auth') !== '1') return false;
  try {
    const configured = options.origin;
    const expected = configured ? new URL(configured) : new URL(`${req.protocol}://${req.get('Host')}`);
    const demoLocal = options.demo && !configured && expected.protocol === 'http:' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(expected.hostname);
    if ((!configured && !demoLocal) || (!demoLocal && expected.protocol !== 'https:') || expected.username || expected.password || expected.href !== expected.origin + '/') return false;
    return req.get('Host')?.toLowerCase() === expected.host && req.get('Origin') === expected.origin
      && (!req.get('Sec-Fetch-Site') || req.get('Sec-Fetch-Site') === 'same-origin');
  } catch { return false; }
}

export function claudeAuthRouter(auth: ClaudeAuthentication) {
  const router = express.Router();
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store').set('X-Content-Type-Options', 'nosniff'); next(); });
  router.use((req, res, next) => {
    if (req.method !== 'POST') return void res.status(404).json({ error: 'Unknown Claude authentication action.' });
    if (!canManageClaudeAuth(req, auth.options)) return void res.status(403).json({ error: 'Claude authentication requires the configured same-origin HTTPS office through its trusted authenticated proxy.' });
    if (!req.is('application/json')) return void res.status(415).json({ error: 'Send Claude authentication requests as JSON.' });
    express.json({ limit: '2kb' })(req, res, (error) => {
      if (error) return void res.status(400).json({ error: 'Invalid Claude authentication request.' });
      next();
    });
  });
  router.use((req, res, next) => {
    const fields = req.path === '/start' ? ['mode'] : req.path === '/code' ? ['flowId', 'code'] : req.path === '/complete' ? ['flowId', 'token'] : req.path === '/cancel' ? ['flowId'] : [];
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).some((key) => !fields.includes(key))) return void res.status(400).json({ error: 'Invalid Claude authentication request.' });
    next();
  });
  router.post('/status', (_req, res) => { res.json(auth.view()); });
  router.post('/start', (req, res) => {
    if (req.body.mode !== undefined && req.body.mode !== 'browser' && req.body.mode !== 'manual-token') return void res.status(400).json({ error: 'Invalid Claude authentication mode.' });
    const result = auth.start(req.body.mode);
    if (!result) return void res.status(409).json({ error: 'A Claude token replacement is already pending.' });
    res.json(result);
  });
  router.post('/cancel', async (req, res) => {
    const result = typeof req.body?.flowId === 'string' && req.body.flowId.length <= 64 ? await auth.cancel(req.body.flowId) : null;
    if (!result) return void res.status(auth.view().phase === 'expired' ? 410 : 409).json({ error: 'Claude token replacement is no longer pending.' });
    res.json(result);
  });
  router.post('/code', async (req, res) => {
    if (typeof req.body?.flowId !== 'string' || req.body.flowId.length > 64 || !validClaudeCode(req.body?.code)) return void res.status(400).json({ error: 'Enter the code returned by Claude sign-in.' });
    const result = await auth.submitCode(req.body.flowId, req.body.code);
    if (!result) return void res.status(auth.view().phase === 'expired' ? 410 : 409).json({ error: 'Claude sign-in is no longer waiting for a code.' });
    res.json(result);
  });
  router.post('/complete', async (req, res) => {
    if (typeof req.body?.flowId !== 'string' || req.body.flowId.length > 64 || !validClaudeToken(req.body?.token)) return void res.status(400).json({ error: 'Enter a Claude setup-token subscription token.' });
    try {
      const result = await auth.complete(req.body.flowId, req.body.token);
      if (!result) return void res.status(auth.view().phase === 'expired' ? 410 : 409).json({ error: 'Claude token replacement is no longer pending.' });
      res.json(result);
    } catch { res.status(500).json({ error: 'Could not save Claude subscription token.' }); }
  });
  // Keep Express and filesystem errors out of the global logger and its error response.
  router.use((_error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: 'Claude authentication action failed.' });
  });
  return router;
}
