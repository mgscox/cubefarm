// A testing record belongs to a tester's exact task, regardless of its age.
import type { AgentView, QaView } from '../shared/types.ts';

export function orphanedQa(rec: Pick<QaView, 'status' | 'repoId' | 'prNumber' | 'qaAgentId'>,
  agents: Pick<AgentView, 'id' | 'repoId' | 'task' | 'prNumber'>[]) {
  return rec.status === 'testing' && !agents.some((a) =>
    a.id === rec.qaAgentId && a.repoId === rec.repoId && a.task === 'qa' && a.prNumber === rec.prNumber);
}
