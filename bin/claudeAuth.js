// Subscription credentials stay separate from snapshots/config and are resolved afresh for each new session.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = fs.realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const isDemo = (env) => env.SWARM_DEMO === '1' || env.SWARM_DEMO === 'true' || process.argv.includes('--demo');
const homeFor = (env) => env.SWARM_HOME || path.join(os.homedir(), '.cubefarm');
export const validClaudeToken = (token) => typeof token === 'string' && /^sk-ant-oat01-[A-Za-z0-9_-]{32,512}$/.test(token);
const outside = (folder) => { const relative = path.relative(root, folder); return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative); };

function credentialDir(home, create = false) {
  const resolved = path.resolve(home);
  // Check existing ancestors too, so a symlink cannot redirect a private store into the checkout.
  let ancestor = resolved;
  while (!fs.existsSync(ancestor) && path.dirname(ancestor) !== ancestor) ancestor = path.dirname(ancestor);
  if (!outside(resolved) || !outside(fs.realpathSync(ancestor))) throw new Error('Claude credentials must be outside the repository.');
  const dir = path.join(resolved, 'credentials');
  if (create) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !outside(fs.realpathSync(dir)) || (process.getuid && stat.uid !== process.getuid())) throw new Error('Unsafe credential directory');
    if (create) fs.chmodSync(dir, 0o700);
  } catch (error) { if (error.code !== 'ENOENT') throw new Error('Could not access Claude credential directory.'); }
  return dir;
}

function savedCredential(home) {
  let fd;
  try {
    const file = path.join(credentialDir(home), 'claude-subscription.json');
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2048 || (process.platform !== 'win32' && (stat.mode & 0o077)) || (process.getuid && stat.uid !== process.getuid())) throw new Error('Unsafe credential file');
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const value = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (!validClaudeToken(value.token)) throw new Error('Invalid credential');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('Could not read Claude credential.');
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** Atomic replacement; callers never receive the token back. No writes at all in demo mode. */
export async function saveClaudeToken(home, token, demo = false) {
  if (demo) throw new Error('Demo does not save credentials.');
  if (!validClaudeToken(token)) throw new Error('Enter a Claude setup-token subscription token.');
  let temp;
  try {
    const dir = credentialDir(home, true);
    temp = path.join(dir, `${randomUUID()}.tmp`);
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ token }), 'utf8'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temp, path.join(dir, 'claude-subscription.json'));
  } catch (error) {
    if (error.message === 'Claude credentials must be outside the repository.') throw error;
    throw new Error('Could not save Claude credential.');
  } finally { if (temp) fs.rmSync(temp, { force: true }); }
}

/** Metadata only. Opaque tokens have no independently known expiry or inference-health guarantee. */
export function claudeAuthMetadata(env = process.env, demo = isDemo(env)) {
  if (demo) return { source: 'demo', expiresAt: null };
  return { source: savedCredential(homeFor(env)) ? 'saved' : env.CLAUDE_CODE_OAUTH_TOKEN ? 'startup' : 'cli', expiresAt: null };
}

export function claudeEnv(inherited = process.env, { login = false, demo = isDemo(inherited) } = {}) {
  const env = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (/^(ANTHROPIC_|CLAUDE)/i.test(key) && key !== 'CLAUDE_CONFIG_DIR' && (login || demo || key !== 'CLAUDE_CODE_OAUTH_TOKEN')) continue;
    if (value !== undefined) env[key] = value;
  }
  if (!login && !demo) {
    const saved = savedCredential(homeFor(inherited));
    if (saved) env.CLAUDE_CODE_OAUTH_TOKEN = saved.token;
  }
  return env;
}
