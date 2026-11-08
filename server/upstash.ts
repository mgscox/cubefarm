// Durable task reservations: record intent before a provider write, and keep uncertain outcomes recoverable.
import crypto from 'node:crypto';
import type { AgentCli, UpstashTask } from '../shared/types.ts';
import type { BoxConnection, BoxOptions } from './machine.ts';

export const UPSTASH = 'upstash';
export const UPSTASH_CAP = 10;
export interface UpstashProvider {
  missing(cli: AgentCli): string | null;
  list(): Promise<{ id: string; name?: string }[]>;
  create(task: UpstashTask): Promise<string>;
  connect(task: UpstashTask, opts: BoxOptions): Promise<BoxConnection>;
  /** Throws unless every worktree is clean and every local commit is on a remote. */
  saved(task: UpstashTask): Promise<void>;
  delete(id: string): Promise<void>;
}

export const quotaRejection = (err: unknown) => {
  const e = err as { statusCode?: number; message?: string };
  return e.statusCode === 429 || e.statusCode === 402 || (e.statusCode === 403 && /quota|limit|capacity/i.test(e.message ?? ''));
};

export class UpstashTasks {
  private writes: Promise<unknown> = Promise.resolve();
  private quotaUntil = 0;
  constructor(readonly tasks: UpstashTask[], readonly provider: UpstashProvider, private readonly commit: () => Promise<void>) {}

  full() { return this.tasks.filter((t) => t.phase !== 'create-failed').length >= UPSTASH_CAP || Date.now() < this.quotaUntil; }
  private atCapacity(boxes: { id: string }[]) {
    return boxes.length + this.tasks.filter((t) => t.phase !== 'create-failed' && !boxes.some((b) => b.id === t.boxId)).length >= UPSTASH_CAP;
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.writes.then(fn);
    this.writes = next.catch(() => undefined);
    return next;
  }
  /** Reserve once per task; an uncertain create is found by its durable unique name, never repeated. */
  ensure(input: Pick<UpstashTask, 'agentId' | 'repo' | 'branch' | 'cli' | 'slug' | 'port'>, officeId: string): Promise<UpstashTask | null> {
    return this.serial(async () => {
      const existing = this.tasks.find((t) => t.agentId === input.agentId);
      if (existing) {
        if (existing.repo !== input.repo || existing.branch !== input.branch || existing.cli !== input.cli || existing.phase === 'deleting' || existing.phase === 'cleanup-blocked') {
          throw new Error('Previous Upstash task needs cleanup in Fleet before this worker can start another task.');
        }
        if (existing.phase === 'create-failed') {
          if (this.atCapacity(await this.provider.list())) return null;
          return this.create(existing);
        }
        return this.recoverCreate(existing);
      }
      if (this.full()) return null;
      const missing = this.provider.missing(input.cli);
      if (missing) throw new Error(missing);
      const boxes = await this.provider.list();
      // Count other applications' Boxes as well as reservations whose create response was lost.
      if (this.atCapacity(boxes)) return null;
      const id = `upstash-${crypto.randomUUID()}`;
      const task: UpstashTask = { ...input, id, name: `cf-${officeId}-${id.slice(8)}`, boxId: null, phase: 'creating', error: null };
      this.tasks.push(task);
      return this.create(task);
    });
  }
  private async create(task: UpstashTask): Promise<UpstashTask | null> {
    task.phase = 'creating';
    task.error = null;
    try { await this.commit(); }
    catch (err) {
      task.phase = 'create-failed';
      task.error = 'Could not save create intent; no Box was requested. Retry after fixing office storage.';
      throw err;
    }
    try {
      task.boxId = await this.provider.create(task);
      task.phase = 'active';
      await this.commit();
      return task;
    } catch (err) {
      if (quotaRejection(err)) {
        this.tasks.splice(this.tasks.indexOf(task), 1);
        this.quotaUntil = Date.now() + 60_000;
        await this.commit();
        return null;
      }
      const e = err as { statusCode?: number; notCreated?: boolean };
      const rejected = !task.boxId && (e.notCreated || [400, 401, 403, 404, 405, 422].includes(e.statusCode ?? 0));
      task.phase = rejected ? 'create-failed' : 'creating';
      task.error = rejected ? 'Create rejected before a Box existed. Fix host credentials/config, restart the office, then reconnect in Fleet.' : 'Create outcome uncertain; retry in Fleet to find the Box by name.';
      await this.commit();
      throw new Error(task.error);
    }
  }
  private async recoverCreate(task: UpstashTask) {
    if (task.boxId) return task;
    if (task.phase === 'create-failed') {
      if (this.atCapacity(await this.provider.list())) throw new Error('Upstash is at its ten-Box cap. Retry after a Box is released.');
      const created = await this.create(task);
      if (!created) throw new Error('Upstash quota reached.');
      return created;
    }
    const boxes = await this.provider.list();
    const box = boxes.find((b) => b.name === task.name);
    if (!box) throw new Error('Upstash create is still uncertain; no matching Box is visible yet. Retry in Fleet.');
    task.boxId = box.id;
    task.phase = 'active';
    task.error = null;
    await this.commit();
    return task;
  }
  recover(task: UpstashTask): Promise<UpstashTask> { return this.serial(() => this.recoverCreate(task)); }

  cleanup(task: UpstashTask, quiesce: () => Promise<void>): Promise<void> {
    return this.serial(async () => {
      if (!this.tasks.includes(task)) return;
      try {
        if (task.phase === 'create-failed') {
          this.tasks.splice(this.tasks.indexOf(task), 1);
          await this.commit();
          return;
        }
        await this.recoverCreate(task);
        // A durable deleting record means save was already confirmed, and its CLI was stopped.
        if (task.phase !== 'deleting') {
          task.phase = 'cleanup-blocked';
          task.error = 'Checking saved work before deletion.';
          await this.commit();
          await quiesce();
          await this.provider.saved(task);
          task.phase = 'deleting';
          task.error = null;
          await this.commit();
        }
        const exists = (await this.provider.list()).some((b) => b.id === task.boxId);
        if (exists) await this.provider.delete(task.boxId!);
        // Read back even a successful delete: accepted is not proof of deletion.
        if ((await this.provider.list()).some((b) => b.id === task.boxId)) throw new Error('Deletion is not confirmed yet.');
        this.tasks.splice(this.tasks.indexOf(task), 1);
        await this.commit();
      } catch (err) {
        if (task.phase !== 'deleting') task.phase = 'cleanup-blocked';
        task.error = task.phase === 'deleting' ? 'Delete outcome uncertain; retry in Fleet to confirm.' : 'Work is not confirmed saved. Keep this Box and retry cleanup in Fleet.';
        await this.commit();
        throw new Error(task.error, { cause: err });
      }
    });
  }
}
