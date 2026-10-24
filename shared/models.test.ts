import { describe, expect, it } from 'vitest';
import { applyDefaultModel, effectiveModel, isClaudeModel } from './models.ts';

const claudeOffice = { defaultCli: 'claude' as const, defaultModel: 'claude-sonnet-5' };
const codexOffice = { defaultCli: 'codex' as const, defaultModel: 'gpt-5.5-codex' };

describe('effectiveModel', () => {
  it("uses the worker's own model when it suits their agent", () => {
    expect(effectiveModel('opus', 'claude', claudeOffice, 'claude-opus-5-5')).toBe('opus');
    expect(effectiveModel('gpt-5.5', 'codex', claudeOffice, 'claude-opus-5-5')).toBe('gpt-5.5');
  });

  it("falls back to the office default only for the office's default agent", () => {
    expect(effectiveModel('', 'claude', claudeOffice, 'claude-opus-5-5')).toBe('claude-sonnet-5');
    expect(effectiveModel('', 'codex', codexOffice, 'claude-opus-5-5')).toBe('gpt-5.5-codex');
    expect(effectiveModel('', 'claude', codexOffice, 'claude-opus-5-5')).toBe('claude-opus-5-5');
    expect(effectiveModel('', 'opencode', claudeOffice, 'claude-opus-5-5')).toBe('');
  });

  it('never hands a model to an agent that would not understand it', () => {
    expect(effectiveModel('claude-opus-5-5', 'codex', claudeOffice, 'claude-opus-5-5')).toBe('');
    expect(effectiveModel('gpt-5.5', 'claude', claudeOffice, 'claude-opus-5-5')).toBe('claude-sonnet-5');
    expect(effectiveModel('', 'codex', { defaultCli: 'codex', defaultModel: 'claude-opus-5-5' }, 'claude-opus-5-5')).toBe('');
  });

  it("knows Claude Code's names and aliases", () => {
    expect(['claude-fable-5-1', 'Opus', 'sonnet', 'haiku', 'opusplan'].every(isClaudeModel)).toBe(true);
    expect(['gpt-5.5', 'opencode/big-pickle', 'o3', 'opencode/claude-sonnet-5'].some(isClaudeModel)).toBe(false);
  });
});

describe('applyDefaultModel', () => {
  const opus = 'claude-opus-5-5';

  it("restores an agent's default model when the default agent switches back to it", () => {
    let s = applyDefaultModel({ defaultCli: 'claude', defaultModel: opus }, { defaultCli: 'codex' }, opus);
    expect(s.defaultModel).toBe('');
    s = applyDefaultModel(s, { defaultModel: ' gpt-5.5-codex ' }, opus);
    expect(s.defaultModel).toBe('gpt-5.5-codex');
    s = applyDefaultModel(s, { defaultCli: 'opencode' }, opus);
    expect(s.defaultModel).toBe('');
    s = applyDefaultModel(s, { defaultModel: 'opencode/big-pickle' }, opus);
    s = applyDefaultModel(s, { defaultCli: 'codex' }, opus);
    expect(s).toMatchObject({ defaultCli: 'codex', defaultModel: 'gpt-5.5-codex' });
    s = applyDefaultModel(s, { defaultCli: 'opencode' }, opus);
    expect(s.defaultModel).toBe('opencode/big-pickle');
  });

  it("keeps Claude Code's chosen model too, and falls back to its default when cleared", () => {
    let s = applyDefaultModel({ defaultCli: 'claude', defaultModel: 'sonnet' }, { defaultCli: 'codex' }, opus);
    s = applyDefaultModel(s, { defaultCli: 'claude' }, opus);
    expect(s.defaultModel).toBe('sonnet');
    expect(applyDefaultModel(s, { defaultModel: '  ' }, opus).defaultModel).toBe(opus);
  });

  it('takes a model sent with the agent switch for the new agent', () => {
    const s = applyDefaultModel({ defaultCli: 'claude', defaultModel: opus }, { defaultCli: 'codex', defaultModel: 'gpt-5.5' }, opus);
    expect(s).toEqual({ defaultCli: 'codex', defaultModel: 'gpt-5.5', defaultModels: { claude: opus, codex: 'gpt-5.5' } });
  });
});
