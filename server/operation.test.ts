import { describe, expect, it } from 'vitest';
import { operationSignal, outsideOperation, withOperation } from './operation.ts';
import { run } from './exec.ts';

describe('desk operation cancellation', () => {
  it('settles a never-resolving operation and keeps its signal scoped', async () => {
    const c = new AbortController();
    let seen: AbortSignal | undefined;
    const pending = withOperation(c.signal, async () => {
      seen = operationSignal();
      return new Promise(() => {});
    });
    const rejected = expect(pending).rejects.toThrow('Desk timed out');
    expect(operationSignal()).toBeUndefined();
    c.abort(new Error('Desk timed out'));
    await rejected;
    expect(seen?.aborted).toBe(true);
  });

  it('terminates a running command when its desk is cancelled', async () => {
    const c = new AbortController();
    let command!: Promise<string>;
    const pending = withOperation(c.signal, () => {
      command = run(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
      return command;
    });
    const rejected = expect(pending).rejects.toThrow('Desk timed out');
    const stopped = expect(command).rejects.toThrow(/failed:/);
    c.abort(new Error('Desk timed out'));
    await rejected;
    await stopped;
  });

  it('keeps a long-lived resource\'s callbacks free of the operation that created it', async () => {
    const c = new AbortController();
    let later!: () => AbortSignal | undefined;
    await withOperation(c.signal, async () => {
      await outsideOperation(async () => {
        await Promise.resolve();
        later = () => operationSignal();
      });
      expect(operationSignal()).toBe(c.signal);
    });
    c.abort(new Error('Task replaced'));
    expect(later()).toBeUndefined();
  });
});
