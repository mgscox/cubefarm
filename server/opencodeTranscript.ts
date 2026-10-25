// OpenCode's projected export is read on the owning machine, without depending on its plugin.
import path from 'node:path';
import { commandFor } from './clis.ts';
import { run } from './exec.ts';
import { operationSignal, withOperation } from './operation.ts';
import type { RecoveredTurn } from './cliTranscript.ts';

interface Message {
  id?: string;
  type?: string;
  outcome?: string;
  time?: { created?: number };
  content?: { type?: string; text?: string }[];
}
interface Session {
  id?: string;
  parentID?: string;
  location?: { directory?: string };
  created?: number;
  directory?: string;
}

/** Only an idle success marker after the final assistant message proves that tools and queued input settled. */
export function opencodeTurn(value: unknown, cwd: string, since: number, sessionId: string): RecoveredTurn | null {
  const data = value as { info?: Session; messages?: Message[] } | null;
  const info = data?.info;
  if (info?.id !== sessionId || info.parentID || !info.location?.directory || path.resolve(info.location.directory) !== path.resolve(cwd)) return null;
  if (!Array.isArray(data?.messages)) return null;
  const messages = data.messages.filter((m) => ['user', 'synthetic', 'assistant', 'idle'].includes(m.type ?? ''));
  const idle = messages.at(-1);
  if (idle?.type !== 'idle' || idle.outcome !== 'succeeded' || !idle.id || !(since > 0) || !Number.isFinite(idle.time?.created) || idle.time!.created! < since) return null;
  const boundary = messages.slice(0, -1).findLastIndex((m) => ['user', 'synthetic', 'idle'].includes(m.type ?? ''));
  const reply = messages.slice(boundary + 1, -1).findLast((m) => m.type === 'assistant');
  const text = (reply?.content ?? []).filter((c) => c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n').trim();
  if (!text) return null;
  return { sessionId, bytes: Buffer.byteLength(JSON.stringify(data)), ended: true, mark: idle.id, text, completedAt: idle.time!.created };
}

export async function recoverOpencodeTurn(cwd: string, sessionId: string | null, since: number): Promise<RecoveredTurn | null> {
  const cmd = commandFor('opencode');
  if (!cmd || !(since > 0)) return null;
  const invoke = async (args: string[]) => {
    const parent = operationSignal();
    const signal = AbortSignal.any([AbortSignal.timeout(25_000), ...(parent ? [parent] : [])]);
    // A standalone export can own a server child: scoped commands kill the whole tree on their deadline.
    return JSON.parse(await withOperation(signal, () => run(cmd.file, [...cmd.args, ...args, '--standalone'], {
      cwd, timeoutMs: 20_000, env: { ...process.env, CUBEFARM_NOTIFY_URL: '' },
    })));
  };
  try {
    if (!sessionId) {
      const sessions: Session[] = await invoke(['session', 'list', '--format', 'json']);
      const candidates = sessions.filter((s) => !s.parentID && s.directory && path.resolve(s.directory) === path.resolve(cwd) && Number(s.created) >= since - 1000);
      if (candidates.length !== 1 || !candidates[0].id) return null;
      sessionId = candidates[0].id;
    }
    return opencodeTurn(await invoke(['session', 'export', sessionId]), cwd, since, sessionId);
  } catch { return null; }
}
