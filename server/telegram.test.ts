// Shared-conversation tests use the real orchestrator, fake sessions and an in-memory atomic state file.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Swarm } from './swarm.ts';
import { createDemoBackend, createDemoTelegram } from './demo.ts';
import { CEO_ID, type HireRequestView, type PhoneMessage, type ServerEvent } from '../shared/types.ts';
import { TelegramFailure, telegramParts, telegramToken, telegramTransport, TELEGRAM_PENDING_LIMIT, type TelegramState, type TelegramTransport, type TelegramUpdate } from './telegram.ts';
import type { SessionHandle } from './agentRunner.ts';

type TestState = {
  officeHeld: boolean;
  settings: { runtime: 'sdk' | 'terminal'; ceoHeartbeatMin: number };
  agents: { id: string; role: string; name: string; status: string; repoId: string }[];
  repos: { id: string; fullName: string; floor: number; autoAssign: boolean }[];
  requests: HireRequestView[];
  messages: PhoneMessage[];
  telegram: TelegramState;
  managerInputs: { id: number; text: string; status: 'pending' | 'sending' }[];
  ceo: { queue: { text?: string }[]; job: unknown };
};
type Harness = {
  backend: ReturnType<typeof createDemoBackend>;
  state: TestState;
  agentRt: Map<string, { log: unknown[]; pending: unknown[]; session: SessionHandle | null; terminal: null }>;
  repoRt: Map<string, unknown>;
  schedule(): void;
  save(): void;
  writeState(): Promise<void>;
  broadcast(ev: ServerEvent): void;
  postMessage(from: PhoneMessage['from'], text: string, requestId?: string): PhoneMessage;
  ensureCeo(interrupted: unknown[]): void;
  dispatchManagerInputs(): Promise<void>;
};
let swarm: Swarm;
let s: Harness;
let transport: ReturnType<typeof createDemoTelegram>;
let saved: TestState;
let events: ServerEvent[];
const peers = { userId: 71, chatId: 71 };
let updateId = 1;
const update = (text?: string, userId = 71, chatId = 71, type = 'private'): TelegramUpdate => ({
  update_id: updateId++, message: { message_id: updateId + 10, from: { id: userId }, chat: { id: chatId, type }, ...(text === undefined ? {} : { text }) },
});

async function setup(t?: TelegramTransport | null, restored?: TestState) {
  swarm = new Swarm(createDemoBackend(), t === undefined ? transport : t);
  s = swarm as unknown as Harness;
  s.state.agents.push({ id: CEO_ID, role: 'ceo', name: 'Joi', status: 'idle', repoId: '' });
  s.agentRt.set(CEO_ID, { log: [], pending: [], session: null, terminal: null });
  vi.spyOn(s, 'schedule').mockImplementation(() => undefined);
  vi.spyOn(s, 'save').mockImplementation(() => undefined);
  // Model the existing serialized temp-write/rename seam: tests can inspect the exact committed transition.
  vi.spyOn(s, 'writeState').mockImplementation(async () => { saved = structuredClone(s.state); });
  vi.spyOn(s, 'broadcast').mockImplementation((ev) => events.push(structuredClone(ev)));
  if (restored) Object.assign(s.state, restored);
  await swarm.telegram.start();
}
async function pair() {
  await swarm.telegram.command('pair');
  const code = swarm.telegram.view().pairing!.code;
  await swarm.telegram.receive(update(`/start ${code}`));
  expect(swarm.telegram.view().paired).toBeNull();
  await swarm.telegram.command('confirm', peers);
}
async function flush() { await swarm.telegram.flush(); }
const sent = () => transport.preview!().sent;

beforeEach(async () => {
  vi.useFakeTimers(); events = []; updateId = 1; transport = createDemoTelegram();
  await setup();
});
afterEach(async () => {
  await swarm.telegram.stop();
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
});

describe('one phone conversation through both transports', () => {
  it('accepts Telegram once, broadcasts the canonical manager identity, shares the queue, and never echoes', async () => {
    await swarm.messageCeo('Existing web conversation');
    await pair();
    expect(sent()).toEqual([]); // initial pairing never replays history
    const incoming = update('Continue that plan');
    await swarm.telegram.receive(incoming);
    await swarm.telegram.receive(incoming);
    await flush();
    expect(s.state.messages.map((m) => m.text)).toEqual(['Existing web conversation', 'Continue that plan']);
    expect(s.state.messages[1]).toMatchObject({ from: 'manager', origin: 'telegram', telegram: { updateId: incoming.update_id } });
    expect(swarm.snapshot().ceo.queue).toHaveLength(1);
    expect(s.state.ceo.queue[0].text).toBe('Existing web conversation\nContinue that plan');
    expect(events.filter((e) => e.type === 'message' && e.message.origin === 'telegram')).toHaveLength(1);
    expect(sent()).toEqual([]);
    await swarm.messageCeo('Web continuation');
    s.postMessage('ceo', 'Same Joi, same context');
    s.postMessage('office', 'An office notice');
    await flush();
    expect(sent().map((m) => m.text)).toEqual(['Manager (WebUI): Web continuation', 'Joi: Same Joi, same context', 'Office: An office notice']);
    expect(swarm.snapshot().phoneReadAt).toBe(0);
  });

  it('injects interleaved inputs into the existing busy CEO session after durable acceptance', async () => {
    await pair();
    const send = vi.fn(() => {
      expect(saved.messages.at(-1)?.text).toBe('Busy request');
      expect(saved.managerInputs).toMatchObject([{ text: 'Busy request', status: 'sending' }]);
      expect(saved.telegram.offset).toBeGreaterThan(incoming.update_id);
    });
    s.agentRt.get(CEO_ID)!.session = { send, stop: vi.fn() };
    const incoming = update('Busy request');
    await swarm.telegram.receive(incoming);
    await swarm.telegram.receive(incoming);
    expect(send).toHaveBeenCalledTimes(1);
    expect(saved.managerInputs).toEqual([]);
    expect(s.state.ceo.queue).toEqual([]);
  });

  it('rejects invalid text, unsupported media and closed-office work without a message or CEO submission', async () => {
    await pair();
    for (const text of [undefined, ' ', 'a'.repeat(4001)]) await swarm.telegram.receive(update(text));
    s.state.officeHeld = true;
    await swarm.telegram.receive(update('Work while closed'));
    await expect(swarm.messageCeo('a'.repeat(4001))).rejects.toThrow('4000');
    await flush();
    expect(s.state.messages).toEqual([]);
    expect(s.state.ceo.queue).toEqual([]);
    expect(sent().map((m) => m.text).join('\n')).toMatch(/Only text.*4000.*Reopen Office/s);
  });

  it('ignores strangers, groups and wrong private chat identities including callbacks', async () => {
    await pair();
    await swarm.telegram.receive(update('Stranger', 72));
    await swarm.telegram.receive(update('Wrong chat', 71, 72));
    await swarm.telegram.receive(update('Group', 71, 71, 'group'));
    await swarm.telegram.receive({ update_id: updateId++, callback_query: { id: 'forged', from: { id: 72 }, data: 'approve:any', message: { message_id: 1, chat: { id: 71, type: 'private' } } } });
    await flush();
    expect(s.state.messages).toEqual([]);
    expect(sent()).toEqual([]);
  });

  it('requires a live pairing code and exact local confirmation, and revocation discards the old backlog', async () => {
    await swarm.telegram.command('pair');
    const code = swarm.telegram.view().pairing!.code;
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
    await swarm.telegram.receive(update(`/start ${code}`));
    await expect(swarm.telegram.command('confirm', peers)).rejects.toThrow('expired');
    await pair();
    transport.offline = true;
    s.postMessage('ceo', 'Old recipient only');
    await flush();
    expect(swarm.telegram.view().pending).toBe(1);
    await swarm.telegram.command('revoke');
    transport.offline = false;
    await pair();
    await flush();
    expect(sent()).toEqual([]);
    await swarm.telegram.command('revoke');
    await swarm.telegram.receive(update('Former manager'));
    expect(s.state.messages.map((m) => m.text)).toEqual(['Old recipient only']);
  });
});

describe('delivery and restart boundaries', () => {
  it('commits message, offset and pending CEO work together before queueing, then survives replay', async () => {
    await pair();
    let acceptance!: TestState;
    const write = vi.mocked(s.writeState);
    write.mockImplementationOnce(async () => { acceptance = structuredClone(s.state); saved = acceptance; });
    const incoming = update('Durably accepted');
    await swarm.telegram.receive(incoming);
    expect(acceptance.managerInputs).toMatchObject([{ text: 'Durably accepted', status: 'pending' }]);
    expect(acceptance.messages).toHaveLength(1);
    expect(acceptance.telegram.offset).toBe(incoming.update_id + 1);
    await swarm.telegram.stop();
    await setup();
    Object.assign(s.state, acceptance);
    await s.dispatchManagerInputs();
    await swarm.telegram.receive(incoming);
    expect(s.state.messages).toHaveLength(1);
    expect(s.state.ceo.queue).toMatchObject([{ text: 'Durably accepted' }]);
    expect(saved.managerInputs).toEqual([]);
  });

  it('resumes known failed deliveries in order across restart independently of retained phone history', async () => {
    await pair(); transport.offline = true;
    s.postMessage('ceo', 'Pending first');
    s.postMessage('office', 'Pending second');
    await flush();
    const persisted = structuredClone(saved);
    persisted.messages = [];
    await swarm.telegram.stop();
    transport.offline = false;
    await setup(undefined, persisted);
    await flush();
    expect(sent().map((m) => m.text)).toEqual(['Joi: Pending first', 'Office: Pending second']);
    expect(saved.telegram.outbox).toEqual([]);
  });

  it('holds ambiguous sends and crash-in-flight sends without blind resends; explicit recovery never runs CEO work', async () => {
    await pair(); transport.ambiguous = true;
    await swarm.messageCeo('Web request');
    await flush();
    expect(swarm.telegram.view().uncertain).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent()).toEqual([]);
    const persisted = structuredClone(saved);
    persisted.telegram.outbox[0].status = 'sending';
    await swarm.telegram.stop();
    await setup(undefined, persisted); await flush();
    expect(swarm.telegram.view().uncertain).toBe(true);
    await swarm.telegram.command('retry'); await flush();
    expect(sent()).toMatchObject([{ text: 'Manager (WebUI): Web request' }]);
    expect(s.state.messages).toHaveLength(1);
    expect(s.state.ceo.queue).toHaveLength(1);
  });

  it('preserves Unicode in complete ordered parts and exposes storage saturation without discarding the pending prefix', async () => {
    await pair();
    const text = '😀'.repeat(5000);
    s.postMessage('ceo', text);
    await flush();
    expect(sent().map((m) => m.text).join('')).toBe(`Joi: ${text}`);
    expect(sent().every((m) => m.text.length <= 4000)).toBe(true);
    expect(telegramParts(text).join('')).toBe(text);
    transport.offline = true;
    for (let i = 0; i <= TELEGRAM_PENDING_LIMIT; i++) s.postMessage('office', `Pending ${i}`);
    expect(s.state.telegram.outbox).toHaveLength(TELEGRAM_PENDING_LIMIT);
    expect(swarm.telegram.view()).toMatchObject({ state: 'error' });
    expect(swarm.telegram.view().detail).toContain('storage filled');
    await swarm.telegram.receive(update('No room for accepted work'));
    expect(s.state.messages.some((m) => m.from === 'manager')).toBe(false);
  });

  it('uses atomic temp-file rename for the real persistence seam', async () => {
    const writeState = (Swarm.prototype as unknown as Harness).writeState;
    const write = vi.spyOn(fs, 'writeFile').mockResolvedValue();
    const rename = vi.spyOn(fs, 'rename').mockResolvedValue();
    vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
    await writeState.call(swarm);
    expect(write.mock.calls[0][0]).toMatch(/\.tmp$/);
    expect(rename.mock.calls[0][0]).toBe(write.mock.calls[0][0]);
    const persisted = JSON.parse(String(write.mock.calls[0][1]));
    expect(persisted).toHaveProperty('telegram');
    expect(persisted).toHaveProperty('managerInputs');
  });
});

function proposal(kind: HireRequestView['kind'] = 'hire'): HireRequestView {
  return { id: 'stable-proposal', kind, repoId: 'r1', role: 'dev', agentId: null, name: 'Demo Candidate', title: 'Developer', specialty: '', brief: '', reason: 'Test reason', model: '', effort: '', look: 'feminine', color: '#fff', hair: '#000', skin: '#fff', status: 'pending', note: '', createdAt: Date.now(), decidedAt: null, decidedBy: null };
}
function callback(approve = true, id = 'stable-proposal', messageId?: number): TelegramUpdate {
  return { update_id: updateId++, callback_query: { id: String(updateId), from: { id: 71 }, data: `${approve ? 'approve' : 'reject'}:${id}`, message: { message_id: messageId ?? s.state.telegram.proposals[id], chat: { id: 71, type: 'private' } } } };
}

describe('shared proposal commands', () => {
  it.each(['hire', 'let-go'] as const)('reflects WebUI rejection of %s and rejects repeated Telegram buttons', async (kind) => {
    await pair(); const req = proposal(kind); s.state.requests.push(req);
    s.postMessage('ceo', 'Please decide', req.id); await flush();
    expect(sent()[0].buttons).toEqual(['approve:stable-proposal', 'reject:stable-proposal']);
    const stale = callback();
    swarm.rejectRequest(req.id); await flush();
    expect(sent()[0]).toMatchObject({ text: expect.stringContaining('rejected'), buttons: [] });
    await swarm.telegram.receive(stale); await flush();
    expect(sent().at(-1)?.text).toContain('already rejected');
    expect(s.state.requests[0].status).toBe('rejected');
  });

  it('uses the existing approve command once and rejects forged card identities', async () => {
    await pair(); const req = proposal(); s.state.requests.push(req);
    s.state.repos.push({ id: 'r1', fullName: 'demo-co/test', floor: 1, autoAssign: false });
    s.repoRt.set('r1', { issues: [], pulls: [] });
    s.postMessage('ceo', 'Hire this candidate?', req.id); await flush();
    const hire = vi.spyOn(swarm, 'hireAgent');
    await swarm.telegram.receive(callback(true, req.id, 999));
    expect(hire).not.toHaveBeenCalled();
    await Promise.all([swarm.telegram.receive(callback()), swarm.telegram.receive(callback())]);
    await flush();
    expect(hire).toHaveBeenCalledTimes(1);
    expect(req.status).toBe('approved');
    expect(sent()[0].buttons).toEqual([]);
    expect(s.state.messages.filter((m) => m.from === 'office')).toHaveLength(1);
  });
});

it('never exposes bot credentials through status or network errors', async () => {
  await swarm.telegram.stop();
  const secret = '123:test-secret-value';
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error(`URL https://api.telegram.org/bot${secret}/sendMessage`));
  const real = telegramTransport(secret);
  await expect(real.call('sendMessage', {})).rejects.toMatchObject({ kind: 'uncertain', message: 'Telegram request interrupted. Check connectivity.' });
  expect(real.identity).not.toContain(secret);
  network.mockResolvedValue(new Response(JSON.stringify({ ok: false, error_code: 409, description: secret })));
  await expect(real.call('getUpdates', {})).rejects.toThrow('polling conflict');
  network.mockResolvedValue(new Response(JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 6 } })));
  await expect(real.call('sendMessage', {})).rejects.toEqual(new TelegramFailure('retry', 'Telegram rate limit; waiting before retry.', 6));
  expect(JSON.stringify(swarm.telegram.view())).not.toContain(secret);
});

it('changing bots clears the old authorization and pending content', async () => {
  await pair(); transport.offline = true;
  s.postMessage('ceo', 'Only for the old bot'); await flush();
  const persisted = structuredClone(saved);
  await swarm.telegram.stop();
  const replacement = createDemoTelegram(); replacement.identity = 'replacement';
  await setup(replacement, persisted); await flush();
  expect(swarm.telegram.view()).toMatchObject({ paired: null, pending: 0, state: 'unpaired' });
  expect(replacement.preview!().sent).toEqual([]);
});

it('an optional unconfigured mirror leaves normal WebUI commands usable', async () => {
  await swarm.telegram.stop(); await setup(null);
  expect(swarm.telegram.view().state).toBe('unconfigured');
  await swarm.messageCeo('WebUI without Telegram');
  expect(s.state.messages).toMatchObject([{ origin: 'web', text: 'WebUI without Telegram' }]);
  expect(s.state.ceo.queue).toMatchObject([{ text: 'WebUI without Telegram' }]);
});

it('does not authorize a message waiting behind a WebUI command after local revocation', async () => {
  await pair();
  let release!: () => void;
  vi.mocked(s.writeState).mockImplementationOnce(() => new Promise<void>((r) => { release = r; }));
  const web = swarm.messageCeo('In progress');
  await vi.advanceTimersByTimeAsync(0);
  const oldManager = swarm.telegram.receive(update('Old identity waiting'));
  await vi.advanceTimersByTimeAsync(0);
  await swarm.telegram.command('revoke');
  release(); await web; await oldManager;
  expect(s.state.messages.map((m) => m.text)).toEqual(['In progress']);
});

it('honors polling rate-limit backoff and cancels the single long poll on shutdown', async () => {
  await swarm.telegram.stop();
  let polls = 0;
  const call = vi.fn(async (_method: string, _body: Record<string, unknown>, signal?: AbortSignal) => {
    polls++;
    if (polls === 1) throw new TelegramFailure('retry', 'Rate limited', 6);
    return new Promise((_, reject) => signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  });
  await setup({ identity: 'fake-poller', call });
  await vi.advanceTimersByTimeAsync(0);
  expect(polls).toBe(1);
  expect(swarm.telegram.view().state).toBe('reconnecting');
  await vi.advanceTimersByTimeAsync(5999); expect(polls).toBe(1);
  await vi.advanceTimersByTimeAsync(1); expect(polls).toBe(2);
  expect(call.mock.calls[1][0]).toBe('getUpdates');
  await swarm.telegram.stop(); expect(polls).toBe(2);
});

it('surfaces consumer/webhook conflicts without changing bot configuration', async () => {
  await swarm.telegram.stop();
  const call = vi.fn(async (_method: string, _body: Record<string, unknown>, _signal?: AbortSignal) => { throw new TelegramFailure('fatal', 'Polling conflict: stop the other consumer and restart.'); });
  await setup({ identity: 'conflicting-poller', call });
  await vi.advanceTimersByTimeAsync(0);
  expect(swarm.telegram.view()).toMatchObject({ state: 'error', detail: expect.stringContaining('Polling conflict') });
  expect(call).toHaveBeenCalledTimes(1);
  expect(call.mock.calls[0][0]).toBe('getUpdates');
});

it('restarts from a disposable state file with the accepted offset, CEO queue and independent pending reply intact', async () => {
  const dir = await fs.mkdtemp(path.join(process.cwd(), '.telegram-restart-'));
  const file = path.join(dir, 'state.json');
  const originalWrite = fs.writeFile.bind(fs);
  const originalRename = fs.rename.bind(fs);
  const originalRead = fs.readFile.bind(fs);
  const originalRm = fs.rm.bind(fs);
  vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
  vi.spyOn(fs, 'writeFile').mockImplementation(async (_file, data) => originalWrite(`${file}.tmp`, data));
  vi.spyOn(fs, 'rename').mockImplementation(async () => originalRename(`${file}.tmp`, file));
  const realWrite = (Swarm.prototype as unknown as Harness).writeState;
  vi.mocked(s.writeState).mockImplementation(() => realWrite.call(swarm));
  try {
    await pair(); transport.offline = true;
    const incoming = update('Accepted before restart');
    await swarm.telegram.receive(incoming);
    s.postMessage('ceo', 'Reply pending before restart'); await flush();
    const persisted = JSON.parse(await originalRead(file, 'utf8')) as TestState;
    expect(persisted.telegram.offset).toBe(incoming.update_id + 1);
    expect(persisted.ceo.queue).toMatchObject([{ text: 'Accepted before restart' }]);
    expect(persisted.telegram.outbox).toMatchObject([{ text: 'Joi: Reply pending before restart', phoneId: expect.any(Number) }]);
    await swarm.telegram.stop(); transport.offline = false;
    await setup(undefined, persisted);
    vi.mocked(s.writeState).mockImplementation(() => realWrite.call(swarm));
    await swarm.telegram.receive(incoming); await flush();
    const restarted = JSON.parse(await originalRead(file, 'utf8')) as TestState;
    expect(restarted.messages.filter((m) => m.from === 'manager')).toHaveLength(1);
    expect(restarted.ceo.queue).toHaveLength(1);
    expect(sent().filter((m) => m.text === 'Joi: Reply pending before restart')).toHaveLength(1);
  } finally {
    await swarm.telegram.stop();
    await originalRm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

it('keeps fatal delivery errors actionable and resets delivery backoff when pairing is replaced', async () => {
  await pair();
  const call = vi.spyOn(transport, 'call');
  call.mockRejectedValueOnce(new TelegramFailure('fatal', 'Check access and restart.'));
  s.postMessage('ceo', 'Cannot send'); await flush();
  expect(swarm.telegram.view()).toMatchObject({ state: 'error', detail: 'Check access and restart.', pending: 1, uncertain: false });
  await swarm.telegram.command('revoke'); await pair();
  s.postMessage('ceo', 'New pairing can send'); await flush();
  expect(sent().at(-1)?.text).toBe('Joi: New pairing can send');
});

it('recovers a failed write-ahead commit before sending and a failed confirmed-progress commit without resending', async () => {
  await pair();
  s.postMessage('ceo', 'Persist before send');
  vi.mocked(s.writeState).mockRejectedValueOnce(new Error('disk unavailable'));
  await flush();
  expect(sent()).toEqual([]);
  expect(swarm.telegram.view().detail).toContain('local storage');
  await flush();
  expect(sent().filter((m) => m.text === 'Joi: Persist before send')).toHaveLength(1);
  s.postMessage('ceo', 'Persist confirmed progress');
  vi.mocked(s.writeState).mockImplementationOnce(async () => { saved = structuredClone(s.state); }).mockRejectedValueOnce(new Error('disk unavailable'));
  await flush();
  expect(swarm.telegram.view().detail).toContain('local storage');
  await flush();
  expect(sent().filter((m) => m.text === 'Joi: Persist confirmed progress')).toHaveLength(1);
  expect(saved.telegram.outbox).toEqual([]);
});

it.each([false, true])('submits an accepted Telegram update once after a failed idle handoff (restart: %s)', async (restart) => {
  s.state.settings.runtime = 'sdk';
  s.state.settings.ceoHeartbeatMin = 0;
  vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
  const starts: string[] = [];
  const enableScheduler = () => {
    vi.spyOn(s.backend, 'startSession').mockImplementation((opts) => {
      starts.push(opts.prompt);
      return { send: vi.fn(), stop: vi.fn() };
    });
    vi.mocked(s.schedule).mockRestore();
  };
  await pair();
  let accepted!: TestState;
  vi.mocked(s.writeState).mockImplementation(async () => {
    if (accepted) throw new Error('handoff disk failure');
    accepted = structuredClone(s.state);
    saved = accepted;
  });
  const incoming = update('One durable Telegram request');
  await expect(swarm.telegram.receive(incoming)).rejects.toThrow('handoff disk failure');
  expect(accepted.managerInputs).toMatchObject([{ text: 'One durable Telegram request', status: 'pending' }]);
  expect(accepted.ceo.queue).toEqual([]);
  enableScheduler();
  s.schedule();
  await vi.advanceTimersByTimeAsync(0);
  await expect(swarm.telegram.receive(incoming)).rejects.toThrow('handoff disk failure');
  s.schedule();
  await vi.advanceTimersByTimeAsync(0);
  const startsBeforeRecovery = starts.length;

  if (restart) {
    await swarm.telegram.stop();
    await setup(undefined, structuredClone(accepted));
    enableScheduler();
  } else {
    vi.mocked(s.writeState).mockImplementation(async () => { saved = structuredClone(s.state); });
  }
  // The polling/replay recovery command commits pending handoff state before permitting scheduling.
  await swarm.telegram.receive(incoming);
  s.schedule();
  await vi.advanceTimersByTimeAsync(0);
  expect(starts).toHaveLength(1);
  expect(startsBeforeRecovery).toBe(0);
  expect(starts[0]).toContain('One durable Telegram request');
  expect(saved.managerInputs).toEqual([]);
  expect(saved.messages.filter((m) => m.from === 'manager')).toHaveLength(1);
});

it('retries a failed idle handoff without Telegram or another manager message', async () => {
  await swarm.telegram.stop(); await setup(null);
  s.state.settings.runtime = 'sdk';
  s.state.settings.ceoHeartbeatMin = 0;
  vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
  const starts: string[] = [];
  vi.spyOn(s.backend, 'startSession').mockImplementation((opts) => {
    starts.push(opts.prompt);
    return { send: vi.fn(), stop: vi.fn() };
  });
  vi.mocked(s.schedule).mockRestore();
  let writes = 0;
  vi.mocked(s.writeState).mockImplementation(async () => {
    if (++writes === 2) throw new Error('handoff disk failure');
    saved = structuredClone(s.state);
  });
  await expect(swarm.messageCeo('Web request')).rejects.toThrow('handoff disk failure');
  s.schedule();
  await vi.advanceTimersByTimeAsync(0);
  expect(starts).toHaveLength(0);
  // Storage is healthy again; no further message arrives.
  await vi.advanceTimersByTimeAsync(20 * 60_000);
  expect(starts).toHaveLength(1);
  expect(starts[0]).toContain('Web request');
  expect(saved.managerInputs).toEqual([]);
  expect(s.state.ceo.queue).toEqual([]);
});

describe('bot token configuration', () => {
  it('prefers the server environment over the config file', () => {
    expect(telegramToken({ CUBEFARM_TELEGRAM_TOKEN: 'from-env' }, { CUBEFARM_TELEGRAM_TOKEN: 'from-file' })).toBe('from-env');
    expect(telegramToken({}, { CUBEFARM_TELEGRAM_TOKEN: 'from-file' })).toBe('from-file');
  });
  it('is not configured when neither has a token', () => {
    expect(telegramToken({}, {})).toBeNull();
    expect(telegramToken({ CUBEFARM_TELEGRAM_TOKEN: '' }, { CUBEFARM_TELEGRAM_TOKEN: '' })).toBeNull();
  });
});
