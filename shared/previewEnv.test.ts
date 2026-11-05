import { describe, expect, it } from 'vitest';
import { previewEnvTooBig } from './previewEnv.ts';

describe('previewEnvTooBig', () => {
  it('accepts an empty environment', () => {
    expect(previewEnvTooBig({})).toBe(false);
  });

  it('accepts exactly 16,000 characters across names and values', () => {
    expect(previewEnvTooBig({ KEY: 'x'.repeat(15997) })).toBe(false);
  });

  it('rejects one character over the budget, counting the name', () => {
    expect(previewEnvTooBig({ KEY: 'x'.repeat(15998) })).toBe(true);
  });

  it('adds every name and value to the total', () => {
    expect(previewEnvTooBig({ A: 'x'.repeat(7999), B: 'x'.repeat(7999) })).toBe(false);
    expect(previewEnvTooBig({ A: 'x'.repeat(7999), BB: 'x'.repeat(7999) })).toBe(true);
  });
});
