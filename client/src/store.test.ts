import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore, type Agent } from './store';

// Audio is a browser boundary; these tests exercise incoming office events in Node.
vi.mock('./ui/sfx', () => ({ cue: vi.fn(), chirp: vi.fn() }));

const agent = { id: 'a1', role: 'dev', status: 'working', hasScreenshot: false, screenshotAt: null } as Agent;

beforeEach(() => useStore.setState({ agents: {}, screens: {}, loaded: false }));

describe('agent screenshot availability', () => {
  it('invalidates the previous session thumbnail when a handoff clears its screenshot', () => {
    const apply = useStore.getState().apply;
    apply({ type: 'agent', agent });
    apply({ type: 'screen', agentId: agent.id, at: 100, url: 'http://demo.invalid' });
    expect(useStore.getState().screens[agent.id]).toBe(100);

    apply({ type: 'agent', agent: { ...agent, status: 'preparing' } });
    expect(useStore.getState().screens[agent.id]).toBeUndefined();
    expect(useStore.getState().agents[agent.id].hasScreenshot).toBe(false);

    apply({ type: 'screen', agentId: agent.id, at: 200, url: null });
    expect(useStore.getState().screens[agent.id]).toBe(200);
  });

  it('takes availability from agent updates and removes it when an agent leaves', () => {
    const apply = useStore.getState().apply;
    apply({ type: 'agent', agent: { ...agent, hasScreenshot: true, screenshotAt: 100 } });
    expect(useStore.getState().screens[agent.id]).toBe(100);
    apply({ type: 'agentRemoved', agentId: agent.id });
    expect(useStore.getState().screens[agent.id]).toBeUndefined();
  });
});

describe('Idea state', () => {
  it('upserts intake and independent records by their stable identities', () => {
    useStore.setState({ ideas: [], ideaRecords: [] });
    const apply = useStore.getState().apply;
    const idea = { id: 'i1', description: 'An Idea', links: [], constraints: '', floorHints: [], status: 'queued' as const, createdAt: 1 };
    apply({ type: 'idea', idea });
    apply({ type: 'idea', idea: { ...idea, description: 'Updated context' } });
    expect(useStore.getState().ideas).toEqual([{ ...idea, description: 'Updated context' }]);
    const record = { id: 'r1', ideaId: idea.id, kind: 'research' as const, title: 'Evidence', body: 'Sources', createdAt: 2 };
    apply({ type: 'ideaRecord', record });
    apply({ type: 'ideaRecord', record: { ...record, body: 'More sources' } });
    apply({ type: 'ideaRecord', record: { ...record, kind: 'review' } });
    apply({ type: 'ideaRecord', record: { ...record, ideaId: 'i2' } });
    expect(useStore.getState().ideaRecords).toHaveLength(3);
    expect(useStore.getState().ideaRecords[0].body).toBe('More sources');
  });
});
