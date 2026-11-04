import { describe, expect, it } from 'vitest';
import { parsePreviewPatch } from './previews.ts';

describe('parsePreviewPatch', () => {
  it('accepts more than 50 variables when their combined size is small', () => {
    const env = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`KEY_${i}`, 'value']));
    expect(parsePreviewPatch(undefined, env)).toEqual({ env });
  });

  it('accepts a value longer than 4,000 characters within the total limit', () => {
    const env = { KEY: 'x'.repeat(5000) };
    expect(parsePreviewPatch(undefined, env)).toEqual({ env });
  });

  it('accepts the exact total limit and rejects an extra character', () => {
    const env = { KEY: 'x'.repeat(15997) };
    expect(parsePreviewPatch(undefined, env)).toEqual({ env });
    expect(() => parsePreviewPatch(undefined, { KEY: `${env.KEY}x` })).toThrow('Preview environment exceeds 16000 characters across names and values.');
  });

  it('rejects a combined total over the limit even with small individual values', () => {
    const env = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`KEY_${i}`, 'x'.repeat(3200)]));
    expect(() => parsePreviewPatch(undefined, env)).toThrow('Preview environment exceeds 16000 characters across names and values.');
  });

  it.each(['ANTHROPIC_API_KEY', 'anthropic_token', 'CLAUDE_CODE', 'claudeAnything'])('still refuses %s', (key) => {
    expect(() => parsePreviewPatch(undefined, { [key]: 'secret' })).toThrow("can't be set on a preview: Claude credentials never reach the apps the office runs");
  });

  it('still checks types and variable names before measuring size', () => {
    expect(() => parsePreviewPatch(undefined, { KEY: 12 })).toThrow('previewEnv.KEY must be a string');
    expect(() => parsePreviewPatch(undefined, { 'BAD-KEY': 'value' })).toThrow('not a valid environment variable name');
  });
});
