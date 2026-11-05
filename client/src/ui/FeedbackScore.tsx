import type { AgentView } from '../../../shared/types';

// The same developer feedback badge in the team and terminal headers.
export function FeedbackScore({ agent }: { agent: Pick<AgentView, 'role' | 'score'> }) {
  if (agent.role !== 'dev') return null;
  return <span className="chip nowrap" title="+2 per merged PR, -1 per QA send-back">Score {agent.score > 0 ? `+${agent.score}` : agent.score}</span>;
}
