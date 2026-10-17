import { describe, expect, it } from 'vitest';
import { agentBox, boxName, boxNotes, floorMove, floorMoveText } from './fleet';
import type { AgentStatus, BoxView } from '../../shared/types';

const boxes = [{ id: 'b1', name: 'Tower' }];
const dev = (box: string | null, status: AgentStatus = 'idle') => ({ role: 'dev' as const, box, status });

describe('boxName', () => {
  it("names the office's machine, a box, and a box that's gone", () => {
    expect(boxName(boxes, '')).toBe('this machine');
    expect(boxName(boxes, 'b1')).toBe('Tower');
    expect(boxName(boxes, 'b9')).toBe('a removed box');
  });
});

describe('agentBox', () => {
  it("is the agent's own box, else the floor's", () => {
    expect(agentBox({ box: null }, { box: 'b1' })).toBe('b1');
    expect(agentBox({ box: '' }, { box: 'b1' })).toBe('');
    expect(agentBox({ box: null }, undefined)).toBe('');
  });
});

describe('floorMove', () => {
  it('counts who moves, who is mid-task, and the own boxes it clears', () => {
    const team = [dev(null), dev(null, 'working'), dev('b1'), dev('', 'preparing'), { role: 'ceo' as const, box: null, status: 'idle' as const }];
    expect(floorMove({ box: '' }, team, 'b1')).toEqual({ moving: 3, busy: 2, overrides: 2 });
  });

  it('says nothing when everyone already works there', () => {
    const move = floorMove({ box: 'b1' }, [dev(null), dev(null)], 'b1');
    expect(floorMoveText(move, 'Tower')).toBeNull();
  });

  it('says what happens, mid-task agents and cleared settings included', () => {
    const move = floorMove({ box: '' }, [dev(null, 'working'), dev('')], 'b1');
    expect(floorMoveText(move, 'Tower')).toBe("2 agents move to Tower as their next task starts. 1 of them is mid-task and moves once that task is done. Clears 1 agent's own box, so the whole floor follows it.");
  });
});

describe('boxNotes', () => {
  const box: Pick<BoxView, 'status' | 'platform' | 'version' | 'git' | 'ghReady' | 'clis'> = {
    status: 'online', platform: 'darwin', version: '0.3.19', git: '2.47', ghReady: true,
    clis: [{ id: 'claude', label: 'Claude Code', installed: true, version: '2.1', integrated: true }],
  };

  it('lists what the box runs', () => {
    expect(boxNotes(box)).toEqual({ info: 'darwin · cubefarm 0.3.19 · git 2.47', missing: [] });
    expect(boxNotes({ ...box, git: 'git version 2.47.0' }).info).toBe('darwin · cubefarm 0.3.19 · git version 2.47.0');
  });

  it("names what's missing on an online box", () => {
    expect(boxNotes({ ...box, git: null, ghReady: false, clis: [] }).missing).toEqual(['git', 'gh auth login', 'a coding-agent CLI']);
  });

  it("doesn't guess while it's offline", () => {
    expect(boxNotes({ ...box, status: 'offline', ghReady: false }).missing).toEqual([]);
  });
});
