// Subscription credentials stay separate from snapshots/config and are resolved afresh for each new session.
import os from 'node:os';
import path from 'node:path';
import { readOfficeCredential, writeOfficeCredential } from './officeCredentials.js';

const isDemo = (env) => env.SWARM_DEMO === '1' || env.SWARM_DEMO === 'true' || process.argv.includes('--demo');
const homeFor = (env) => env.SWARM_HOME || path.join(os.homedir(), '.cubefarm');
export const validClaudeToken = (token) => typeof token === 'string' && /^sk-ant-oat01-[A-Za-z0-9_-]{32,512}$/.test(token);
const filename = 'claude-subscription.json';

function savedCredential(home) {
  try { return readOfficeCredential(home, filename, validClaudeToken); }
  catch { throw new Error('Could not read Claude credential.'); }
}

/** Atomic replacement; callers never receive the token back. No writes at all in demo mode. */
export async function saveClaudeToken(home, token, demo = false) {
  if (demo) throw new Error('Demo does not save credentials.');
  if (!validClaudeToken(token)) throw new Error('Enter a Claude setup-token subscription token.');
  try {
    writeOfficeCredential(home, filename, token);
  } catch (error) {
    if (error.message === 'Credentials must be outside the repository.') throw new Error('Claude credentials must be outside the repository.');
    throw new Error('Could not save Claude credential.');
  }
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
