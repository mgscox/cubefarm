import { describe, expect, it } from 'vitest';
import { isResearchBranch, jobFromMessage, researchDocBranch, researcherSystemPrompt, researchPullUrl, researchIssueBranch, researchJobLabel, researchJobPrompt, researchSlug } from './research.ts';

const base = { name: 'Hypatia', title: 'Head of Research', brief: '', company: 'Demo Co.', today: '2026-10-15', companyFolder: 'home/research' };
const floor = { kind: 'floor' as const, repo: 'demo-co/pixel-todo', defaultBranch: 'main', summary: 'Todo app', mission: '', cwd: 'desks/hypatia', branch: 'swarm/research-doc-x-ab12', autoMerge: true };

describe('research branches', () => {
  it('marks issue and brief branches as research, and keeps them apart', () => {
    expect(researchIssueBranch(7, 'darwin')).toBe('swarm/research-7-darwin');
    const doc = researchDocBranch({ topic: 'Pricing of hosted Postgres!', at: 1_700_000_000_000 });
    expect(doc).toMatch(/^swarm\/research-doc-pricing-of-hosted-postgres-[0-9a-z]{4}$/);
    expect(isResearchBranch(doc)).toBe(true);
    expect(isResearchBranch('swarm/issue-7-ada')).toBe(false);
  });

  it('slugs topics and falls back for empty ones', () => {
    expect(researchSlug('  What do users want?  ')).toBe('what-do-users-want');
    expect(researchSlug('???')).toBe('research');
    expect(researchSlug('a'.repeat(39) + ' b')).toBe('a'.repeat(39));
  });
});

describe('research briefs', () => {
  it("takes the first line of the manager's message as the topic", () => {
    const job = jobFromMessage('Competitors for pixel-todo\nWho are they, and what do they charge?', 5, 'r1');
    expect(job).toEqual({ topic: 'Competitors for pixel-todo', brief: 'Competitors for pixel-todo\nWho are they, and what do they charge?', requestedBy: 'manager', at: 5, repoId: 'r1' });
    expect(jobFromMessage('x', 1)).not.toHaveProperty('repoId');
  });

  it('labels where the doc goes', () => {
    expect(researchJobLabel({ topic: 'Pricing', brief: '', requestedBy: 'ceo', at: 0 }, null)).toBe('Researching "Pricing"');
    expect(researchJobLabel({ topic: 'Pricing', brief: '', requestedBy: 'ceo', at: 0, repoId: 'r1' }, { floor: 2 })).toBe('Researching "Pricing" for floor 2');
    expect(researchJobLabel({ topic: 'Pricing', brief: '', requestedBy: 'ceo', at: 0, repoId: 'gone' }, null)).toBe('Researching "Pricing" for a removed floor');
  });

  it('asks for a pull request on a floor and Cubebase otherwise', () => {
    const job = { topic: 'Pricing', brief: 'Compare the big three', requestedBy: 'ceo' as const, at: 0 };
    expect(researchJobPrompt(job, { floor: 1, fullName: 'demo-co/pixel-todo' })).toContain('File the doc on floor 1 (demo-co/pixel-todo) by pull request.');
    expect(researchJobPrompt(job, null)).toContain('docs/research/company/ by pull request');
    expect(researchJobPrompt(job, null)).toContain('"""Compare the big three"""');
    expect(researchJobPrompt({ ...job, brief: 'Pricing' }, null)).not.toContain('"""');
  });
});

describe('researcherSystemPrompt', () => {
  it('files floor research under docs/research by PR, without QA, and never touches code', () => {
    const p = researcherSystemPrompt({ ...base, place: floor });
    expect(p).toContain('docs/research/2026-10-15-<short-slug>.md');
    expect(p).toContain('gh pr create --base main --head swarm/research-doc-x-ab12');
    expect(p).toContain('skip QA');
    expect(p).toContain("the office merges it once GitHub's checks pass");
    expect(p).toContain('only change files under docs/research/');
    expect(p).toContain('WebSearch');
    expect(researcherSystemPrompt({ ...base, place: { ...floor, autoMerge: false } })).toContain('the manager merges it');
  });

  it('files company research by pull request under docs/research/company', () => {
    const p = researcherSystemPrompt({ ...base, place: {
      kind: 'company', repo: 'demo-manager/cubebase', defaultBranch: 'main', cwd: 'desks/hypatia',
      branch: 'swarm/research-doc-x-ab12', autoMerge: false,
    } });
    expect(p).toContain('Repository: demo-manager/cubebase');
    expect(p).toContain('docs/research/company/2026-10-15-<short-slug>.md');
    expect(p).toContain('only change files under docs/research/company/');
    expect(p).toContain('gh pr create --base main --head swarm/research-doc-x-ab12');
    expect(p).toContain('the manager merges it');
  });
});

describe('researchPullUrl', () => {
  it('only picks a pull request in the filing repository', () => {
    const url = 'https://github.com/demo-manager/cubebase/pull/12';
    const other = 'https://github.com/demo-co/pixel-todo/pull/12';
    expect(researchPullUrl(`Done. ${other} ${url}`, 'demo-manager/cubebase')).toBe(url);
    expect(researchPullUrl(other, 'demo-manager/cubebase')).toBeUndefined();
  });
});
