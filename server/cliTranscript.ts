// Read recovery evidence on the CLI's own machine, including rollouts whose id never reached the office.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeTurn, readClaudeTurn, type ClaudeTurn } from './clis.ts';
import type { AgentCli } from '../shared/types.ts';

export interface RecoveredTurn extends ClaudeTurn { sessionId?: string }

const LIMIT = 512 * 1024;
function read(file: string, tail: boolean): { text: string; bytes: number } {
  const fd = fs.openSync(file, 'r');
  try {
    const bytes = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(bytes, LIMIT));
    fs.readSync(fd, buf, 0, buf.length, tail ? bytes - buf.length : 0);
    return { text: buf.toString('utf8'), bytes };
  } finally { fs.closeSync(fd); }
}

/** Codex writes task_complete after its final reply; commentary and tool output never end a turn. */
export function codexTurn(tail: string, bytes: number): ClaudeTurn {
  let ended = false;
  let text = '';
  let mark = '';
  let completedAt: number | undefined;
  for (const line of tail.split('\n')) {
    try {
      const e = JSON.parse(line);
      const p = e.payload;
      if (e.type !== 'event_msg' || !p) continue;
      if (p.type === 'task_started' || p.type === 'user_message') { ended = false; text = ''; }
      if (p.type === 'agent_message' && typeof p.message === 'string') text = p.message;
      if (p.type === 'task_complete') {
        ended = true;
        mark = String(p.turn_id ?? e.timestamp ?? '');
        completedAt = Date.parse(String(e.timestamp ?? ''));
        if (typeof p.last_agent_message === 'string') text = p.last_agent_message;
      }
    } catch { /* A partial JSON line is not completion evidence. */ }
  }
  return { bytes, ended, mark, text: text.trim(), ...(Number.isFinite(completedAt) && { completedAt }) };
}

/** A conversation id can span tasks: only completion evidence from this task is safe to collect. */
export function currentTaskTurn<T extends ClaudeTurn>(turn: T | null, since: number): T | null {
  if (turn?.ended && (!(since > 0) || !Number.isFinite(turn.completedAt) || turn.completedAt! < since)) return null;
  return turn;
}

/** Ambiguous discoveries are left for the visible recovery failure, rather than collecting another session's reply. */
export function recoverCliTurn(cwd: string, cli: AgentCli, sessionId: string | null, since: number, home = os.homedir()): RecoveredTurn | null {
  if (cli === 'opencode') return null;
  if (cli === 'claude' && sessionId) return currentTaskTurn(readClaudeTurn(cwd, sessionId, home), since);
  const root = cli === 'claude' ? path.join(home, '.claude', 'projects', path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-')) : path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'sessions');
  const candidates: { file: string; id: string }[] = [];
  const visit = (dir: string, depth: number) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory() && depth > 0) { visit(file, depth - 1); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      if (cli === 'claude') {
        const first = read(file, false).text.split('\n')[0];
        let born = fs.statSync(file).birthtimeMs;
        try { born = Date.parse(JSON.parse(first).timestamp) || born; } catch { /* Fall back to creation time. */ }
        if (since > 0 && born >= since - 1000) candidates.push({ file, id: entry.name.slice(0, -6) });
        continue;
      }
      if (sessionId && !entry.name.endsWith(`-${sessionId}.jsonl`)) continue;
      if (!sessionId && fs.statSync(file).mtimeMs < since) continue;
      const first = read(file, false).text.split('\n')[0];
      try {
        const e = JSON.parse(first);
        const p = e.payload;
        if (e.type !== 'session_meta' || p?.source !== 'cli' || p.parent_thread_id || path.resolve(p.cwd) !== path.resolve(cwd)) continue;
        if (sessionId ? p.id !== sessionId : !(since > 0 && Date.parse(p.timestamp ?? e.timestamp) >= since - 1000)) continue;
        candidates.push({ file, id: p.id });
      } catch { /* Not a main CLI rollout. */ }
    }
  };
  try {
    visit(root, cli === 'claude' ? 0 : 3);
    if (candidates.length !== 1) return null;
    const { file, id } = candidates[0];
    const { text, bytes } = read(file, true);
    return currentTaskTurn({ ...(cli === 'claude' ? claudeTurn(text, bytes) : codexTurn(text, bytes)), sessionId: id }, since);
  } catch { return null; }
}
