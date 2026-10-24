import type { AgentCli } from './types.ts';

// Which model an agent's session asks for. The office's default model belongs to its default coding agent, and each
// worker can name their own; a model only goes to an agent that understands it (no Claude model for Codex).

/** Claude Code's model names and aliases. */
export const isClaudeModel = (model: string) => /^(claude|opus|sonnet|haiku|fable|default|best|opusplan)\b/i.test(model.trim());

/**
 * The model for a worker on `cli`: their own if it suits that agent, else the office default when `cli` is the
 * default agent, else `claudeDefault` for Claude Code, or '' to let any other agent use its own default.
 */
export function effectiveModel(own: string, cli: AgentCli, office: { defaultCli: AgentCli; defaultModel: string }, claudeDefault: string): string {
  const suits = (m: string) => m.trim() !== '' && (cli === 'claude') === isClaudeModel(m);
  if (suits(own)) return own.trim();
  if (cli === office.defaultCli && suits(office.defaultModel)) return office.defaultModel.trim();
  return cli === 'claude' ? claudeDefault : '';
}

type DefaultModelSettings = { defaultCli: AgentCli; defaultModel: string; defaultModels?: Partial<Record<AgentCli, string>> };

/**
 * The office's default agent and model after the manager changes either. Each agent's last default model is kept in
 * `defaultModels`, so switching the default agent away and back restores it rather than starting over.
 */
export function applyDefaultModel(s: DefaultModelSettings, patch: { defaultCli?: AgentCli; defaultModel?: string }, claudeDefault: string): Required<DefaultModelSettings> {
  const models = { ...s.defaultModels, [s.defaultCli]: s.defaultModel };
  const cli = patch.defaultCli ?? s.defaultCli;
  const fallback = cli === 'claude' ? claudeDefault : '';
  const model = patch.defaultModel !== undefined ? String(patch.defaultModel).trim() || fallback : cli !== s.defaultCli ? models[cli] || fallback : s.defaultModel;
  return { defaultCli: cli, defaultModel: model, defaultModels: { ...models, [cli]: model } };
}
