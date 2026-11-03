// Real atomic state writes and startup recovery, using only an isolated file and demo backend.
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Swarm } from './swarm.ts';
import { createDemoBackend } from './demo.ts';
import { STATE_FILE } from './config.ts';
import type { IdeaView, ServerEvent } from '../shared/types.ts';

type Harness = { broadcast(event: ServerEvent): void; writeState(): Promise<void> };
let folder: string;
let file: string;
let swarm: Swarm;
const read = fs.readFile.bind(fs);
const write = fs.writeFile.bind(fs);
const rename = fs.rename.bind(fs);
const rm = fs.rm.bind(fs);

beforeEach(async () => {
  vi.useFakeTimers();
  folder = await fs.mkdtemp(path.join(process.cwd(), '.idea-test-'));
  file = path.join(folder, 'demo-state.json');
  vi.spyOn(fs, 'readFile').mockImplementation((location, ...args) => read(location === STATE_FILE ? file : location, ...args));
  vi.spyOn(fs, 'writeFile').mockImplementation((location, ...args) => write(location === `${STATE_FILE}.tmp` ? `${file}.tmp` : location, ...args));
  vi.spyOn(fs, 'rename').mockImplementation((from, to) => rename(from === `${STATE_FILE}.tmp` ? `${file}.tmp` : from, to === STATE_FILE ? file : to));
  vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
  swarm = new Swarm(createDemoBackend());
});

afterEach(async () => {
  await swarm.shutdown();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  await rm(folder, { recursive: true, force: true, maxRetries: 5 });
});

it('acknowledges and broadcasts only after the queued Idea is durable, without creating GitHub issues', async () => {
  const backend = createDemoBackend();
  const createIssue = vi.spyOn(backend, 'createIssue');
  swarm = new Swarm(backend);
  const events: ServerEvent[] = [];
  vi.spyOn(swarm as unknown as Harness, 'broadcast').mockImplementation((event) => events.push(event));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const realWrite = (swarm as unknown as Harness).writeState.bind(swarm);
  vi.spyOn(swarm as unknown as Harness, 'writeState').mockImplementationOnce(async () => { await gate; await realWrite(); });
  const submissions = [swarm.submitIdea({ description: 'One' }), swarm.submitIdea({ description: 'Two' })];
  await Promise.resolve();
  expect(events).toEqual([]);
  release();
  const ideas = await Promise.all(submissions);
  const saved = JSON.parse(await read(file, 'utf8')) as { ideas: IdeaView[] };
  expect(saved.ideas).toEqual(ideas);
  expect(new Set(ideas.map((idea) => idea.id)).size).toBe(2);
  expect(events).toEqual(ideas.map((idea) => ({ type: 'idea', idea })));
  expect(createIssue).not.toHaveBeenCalled();
});

it('does not acknowledge a failed save and allows the next submission', async () => {
  const broadcast = vi.spyOn(swarm as unknown as Harness, 'broadcast');
  vi.spyOn(swarm as unknown as Harness, 'writeState').mockRejectedValueOnce(new Error('disk full'));
  await expect(swarm.submitIdea({ description: 'Unsaved' })).rejects.toThrow('disk full');
  expect(swarm.snapshot().ideas).toEqual([]);
  expect(broadcast).not.toHaveBeenCalled();
  const idea = await swarm.submitIdea({ description: 'Try again' });
  expect(swarm.snapshot().ideas).toEqual([idea]);
});

it('loads the same identity and queued state at startup and tolerates legacy state without Ideas', async () => {
  const idea = await swarm.submitIdea({ description: 'Survive a restart' });
  const saved = JSON.parse(await read(file, 'utf8'));
  const record = { id: 'research-1', ideaId: idea.id, kind: 'research', title: 'Independent evidence', body: 'A source', createdAt: 1 };
  saved.ideaRecords = [record];
  await write(file, JSON.stringify(saved));
  const backend = createDemoBackend();
  vi.spyOn(backend, 'listMyRepos').mockResolvedValue([]);
  swarm = new Swarm(backend);
  await swarm.init();
  expect(swarm.snapshot().ideas).toEqual([idea]);
  expect(swarm.snapshot().ideaRecords).toEqual([record]);
  await swarm.shutdown();
  await write(file, JSON.stringify({ officeHeld: true, settings: { ceoHeartbeatMin: 0 } }));
  swarm = new Swarm(backend);
  await swarm.init();
  expect(swarm.snapshot().ideas).toEqual([]);
});
