import { describe, expect, it } from 'vitest';
import { officeLifecycle } from './officeLifecycle.ts';

describe('officeLifecycle', () => {
  it('requires both idle work and recorded state for a safe closure', () => {
    expect(officeLifecycle(true, 0, false).state).toBe('closing');
    expect(officeLifecycle(true, 0, true).state).toBe('closed');
    expect(officeLifecycle(true, 1, true).state).toBe('closing');
    expect(officeLifecycle(false, 3, false)).toEqual({ state: 'open', running: 3 });
  });
});
