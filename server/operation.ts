// Carry cancellation through desk helpers and their nested git/gh commands without changing each helper's API.
import { AsyncLocalStorage } from 'node:async_hooks';

const operation = new AsyncLocalStorage<AbortSignal>();
export const operationSignal = () => operation.getStore();

export function withOperation<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  return operation.run(signal, async () => {
    signal.throwIfAborted();
    let abort!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
    });
    try { return await Promise.race([fn(), cancelled]); }
    finally { signal.removeEventListener('abort', abort); }
  });
}
