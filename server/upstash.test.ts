import { describe, expect, it } from 'vitest';
import { UpstashTasks, quotaRejection, type UpstashProvider } from './upstash.ts';
import type { UpstashTask } from '../shared/types.ts';

// Stateful provider emulator: accepted writes can lose their responses, while Boxes survive a new office controller.
function emulator() {
  const boxes = new Map<string, { id: string; name: string }>();
  const dirty = new Set<string>();
  let creates = 0;
  let loseCreate = false;
  let loseDelete = false;
  let quota = false;
  const provider: UpstashProvider = {
    missing: () => null,
    list: async () => [...boxes.values()],
    create: async (t) => {
      if (quota) throw Object.assign(new Error('quota exceeded'), { statusCode: 429 });
      const id = `box-${++creates}`;
      boxes.set(id, { id, name: t.name });
      if (loseCreate) throw new Error('response lost');
      return id;
    },
    connect: async () => { throw new Error('transport tested in provider rehearsal'); },
    saved: async (t) => { if (dirty.has(t.id)) throw new Error('dirty or unpushed'); },
    delete: async (id) => { boxes.delete(id); if (loseDelete) throw new Error('response lost'); },
  };
  return { provider, boxes, dirty, creates: () => creates, loseCreate: () => { loseCreate = true; }, loseDelete: () => { loseDelete = true; }, quota: () => { quota = true; } };
}
const input = (agentId = 'ada', cli: UpstashTask['cli'] = 'claude') => ({ agentId, cli, slug: 'ada-0000', port: 5324, repo: 'team/app', branch: `swarm/task-${agentId}` });

describe('disposable Upstash task lifecycle', () => {
  it('persists the reservation before creating and reconnects the same worker, repo and CLI after a lost response', async () => {
    const emu = emulator(); emu.loseCreate();
    const records: UpstashTask[] = [];
    let saved: UpstashTask[] = [];
    const commit = async () => { saved = structuredClone(records); };
    const first = new UpstashTasks(records, emu.provider, commit);
    await expect(first.ensure(input(), 'office')).rejects.toThrow('uncertain');
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ agentId: 'ada', repo: 'team/app', cli: 'claude', phase: 'creating', boxId: null });
    const restarted = new UpstashTasks(saved, emu.provider, async () => {});
    const task = await restarted.ensure(input(), 'office');
    expect(task).toMatchObject({ phase: 'active', boxId: 'box-1' });
    expect(emu.creates()).toBe(1);
    await expect(restarted.ensure({ ...input(), repo: 'other/repo' }, 'office')).rejects.toThrow('Previous');
    await expect(restarted.ensure(input('ada', 'codex'), 'office')).rejects.toThrow('Previous');
  });

  it('serializes concurrent reservations at ten Boxes, including other applications and uncertain creates', async () => {
    const emu = emulator();
    emu.boxes.set('external', { id: 'external', name: 'another app' });
    const records: UpstashTask[] = [];
    const office = new UpstashTasks(records, emu.provider, async () => {});
    const tasks = await Promise.all(Array.from({ length: 12 }, (_, n) => office.ensure(input(String(n)), 'office')));
    expect(tasks.filter(Boolean)).toHaveLength(9);
    expect(emu.boxes.size).toBe(10);
    expect(await office.ensure(input('0'), 'office')).toBe(records[0]);
  });

  it('serializes a key change with Box creation and only accepts a replacement that can see owned Boxes', async () => {
    const emu = emulator();
    const office = new UpstashTasks([], emu.provider, async () => {});
    let changed = false;
    const creating = office.ensure(input(), 'office');
    await expect(office.changeKey(() => { changed = true; }, async () => [])).rejects.toMatchObject({ status: 409 });
    expect(changed).toBe(false);

    const task = await creating;
    await office.changeKey(() => { changed = true; }, emu.provider.list);
    expect(changed).toBe(true);
    await office.cleanup(task!, async () => {});
    await office.changeKey(() => { changed = false; }, async () => { throw new Error('No Box lookup needed'); });
    expect(changed).toBe(false);
  });

  it('uses fallback only for quota rejection, holding other provider errors for recovery', async () => {
    const emu = emulator(); emu.quota();
    const office = new UpstashTasks([], emu.provider, async () => {});
    expect(await office.ensure(input(), 'office')).toBeNull();
    expect(office.full()).toBe(true);
    expect(office.tasks).toEqual([]);
    expect(quotaRejection({ statusCode: 403, message: 'Invalid API key' })).toBe(false);
    expect(quotaRejection({ statusCode: 403, message: 'Box limit reached' })).toBe(true);
  });

  it('keeps unsaved work visible and blocks deletion until a later saved-work check succeeds', async () => {
    const emu = emulator(); const records: UpstashTask[] = [];
    const office = new UpstashTasks(records, emu.provider, async () => {});
    const task = (await office.ensure(input(), 'office'))!;
    emu.dirty.add(task.id);
    await expect(office.cleanup(task, async () => {})).rejects.toThrow('not confirmed saved');
    expect(task).toMatchObject({ phase: 'cleanup-blocked' });
    expect(emu.boxes.size).toBe(1);
    await expect(office.ensure(input('ada', 'codex'), 'office')).rejects.toThrow('Previous');
    emu.dirty.clear();
    await office.cleanup(task, async () => {});
    expect(records).toEqual([]);
    expect(emu.boxes.size).toBe(0);
  });

  it('recovers a delete whose response was lost without requiring the already deleted disk', async () => {
    const emu = emulator(); emu.loseDelete();
    const office = new UpstashTasks([], emu.provider, async () => {});
    const task = (await office.ensure(input(), 'office'))!;
    await expect(office.cleanup(task, async () => {})).rejects.toThrow('uncertain');
    expect(task.phase).toBe('deleting');
    const restarted = new UpstashTasks(structuredClone(office.tasks), emu.provider, async () => {});
    await restarted.cleanup(restarted.tasks[0], async () => { throw new Error('disk gone'); });
    expect(restarted.tasks).toEqual([]);
  });


  it('retries a definite create rejection after configuration is repaired, without confusing it with a lost response', async () => {
    const emu = emulator();
    const create = emu.provider.create;
    emu.provider.create = async () => { throw Object.assign(new Error('invalid API key'), { statusCode: 401 }); };
    const office = new UpstashTasks([], emu.provider, async () => {});
    await expect(office.ensure(input(), 'office')).rejects.toThrow('rejected');
    expect(office.tasks[0].phase).toBe('create-failed');
    expect(emu.boxes.size).toBe(0);
    emu.provider.create = create;
    const task = await office.ensure(input(), 'office');
    expect(task).toMatchObject({ phase: 'active', boxId: 'box-1' });
    expect(office.tasks).toHaveLength(1);
  });

  it('can retry after a failed intent write without requesting an unrecorded Box', async () => {
    const emu = emulator(); let writable = false;
    const office = new UpstashTasks([], emu.provider, async () => { if (!writable) throw new Error('disk full'); });
    await expect(office.ensure(input(), 'office')).rejects.toThrow('disk full');
    expect(emu.creates()).toBe(0);
    expect(office.tasks[0].phase).toBe('create-failed');
    writable = true;
    expect(await office.ensure(input(), 'office')).toMatchObject({ phase: 'active', boxId: 'box-1' });
    expect(emu.creates()).toBe(1);
  });

  it('does not delete when the saved intent cannot be persisted', async () => {
    const emu = emulator(); let fail = false;
    const office = new UpstashTasks([], emu.provider, async () => { if (fail) throw new Error('disk full'); });
    const task = (await office.ensure(input(), 'office'))!;
    fail = true;
    await expect(office.cleanup(task, async () => {})).rejects.toThrow('disk full');
    expect(emu.boxes.size).toBe(1);
  });
});
