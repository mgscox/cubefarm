// Researchers: web research filed as Markdown docs. The lobby researcher works for the whole company from a queue of
// briefs (the CEO's request_research tool, the manager's messages); a floor's researchers take its swarm:research
// issues the way developers take the rest. A doc for a floor goes into docs/research/ of its repository by pull
// request, which skips QA. Company-wide briefs use a pull request to cubebase.

import { RESEARCH_BRANCH } from '../shared/issues.ts';
import { ONE_TURN } from './clis.ts';

export interface ResearchJob {
  ideaId?: string;
  ideaPhase?: 'plan' | 'review' | 'revise' | 'promote';
  reviewFocus?: 'evidence' | 'feasibility';
  requestId?: string;
  agentId?: string;
  topic: string;
  brief: string;
  repoId?: string; // file the doc on this floor by pull request; otherwise in cubebase
  requestedBy: 'ceo' | 'manager';
  at: number;
}

/** Where research docs live in a floor's repository. */
export const RESEARCH_DOCS = 'docs/research';
export const COMPANY_RESEARCH_DOCS = `${RESEARCH_DOCS}/company`;

export const isResearchBranch = (ref: string) => ref.startsWith(RESEARCH_BRANCH);

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

export function researchSlug(topic: string) {
  return (
    topic
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40)
      .replace(/-$/, '') || 'research'
  );
}

/** A floor researcher's branch for an issue. */
export const researchIssueBranch = (issue: number, who: string) => `${RESEARCH_BRANCH}${issue}-${who}`;

/** The lobby researcher's branch for a doc on a floor. "doc-" keeps it apart from issue branches. */
export const researchDocBranch = (job: Pick<ResearchJob, 'topic' | 'at'>) => `${RESEARCH_BRANCH}doc-${researchSlug(job.topic)}-${job.at.toString(36).slice(-4)}`;

/** A brief from the manager's message: its first line is the topic. */
export function jobFromMessage(text: string, at: number, repoId?: string): ResearchJob {
  const brief = text.trim().slice(0, 4000);
  const topic = clip(brief.split(/\r?\n/)[0].trim(), 120);
  return { topic, brief, requestedBy: 'manager', at, ...(repoId && { repoId }) };
}

export function researchJobLabel(job: ResearchJob, floor: { floor: number } | null) {
  const where = job.repoId ? (floor ? ` for floor ${floor.floor}` : ' for a removed floor') : '';
  return `Researching "${clip(job.topic, 60)}"${where}`;
}

export function researchPullUrl(text: string, fullName: string): string | undefined {
  const escaped = fullName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.match(new RegExp(`https://github\\.com/${escaped}/pull/\\d+`, 'i'))?.[0];
}

type ResearchCheckout = { repo: string; defaultBranch: string; cwd: string; branch: string; autoMerge: boolean };

export type ResearchPlace = ResearchCheckout & (
  | { kind: 'company' }
  | { kind: 'floor'; summary: string; mission: string }
);

/** The system prompt for every researcher session, in the lobby or on a floor. */
export function researcherSystemPrompt(o: { name: string; title: string; brief: string; company: string; today: string; companyFolder: string; place: ResearchPlace }) {
  const p = o.place;
  const floor = p.kind === 'floor';
  const dir = floor ? RESEARCH_DOCS : COMPANY_RESEARCH_DOCS;
  return [
    `You are ${o.name}, ${o.title ? `the ${o.title}` : 'a researcher'} at ${o.company || 'a company'} run as an office of AI agents ("cubefarm"). You research and write it up; you do not write product code. Nobody is watching live, so make sensible decisions yourself and note assumptions in the doc.`,
    o.brief ? `\nYour job description:\n${o.brief}` : '',
    `Today is ${o.today}. Prices, versions, rules and markets change: date what you report.`,
    '',
    `Repository: ${p.repo} (default branch: ${p.defaultBranch})`,
    floor && p.summary ? `Project: ${p.summary}` : '',
    floor && p.mission ? `What the team is building (the manager's brief): ${p.mission}` : '',
    `Your worktree: ${p.cwd}`,
    `Your branch: ${p.branch} (already checked out, created from origin/${p.defaultBranch})`,
    `Earlier company research is in ${floor ? o.companyFolder : `${dir}/`}${floor ? ` and this project's in ${dir}/` : ''}: read what's relevant first.`,
    '',
    'Workflow:',
    `1. Read the request and the context it needs${floor ? ' (README and the code it is about)' : ''}.`,
    '2. Research with WebSearch and WebFetch. Prefer primary sources (official docs, standards, filings, vendors\' own pricing pages), cross-check important claims, and say how sure you are.',
    `3. Write one Markdown doc, ${dir}/${o.today}-<short-slug>.md: title; the question; summary (the answer first, a few sentences); findings; what it means for ${floor ? 'this project' : 'the company'}, as recommendations; open questions; sources (numbered links, cited inline as [1]).`,
    `4. Add a line for it to ${dir}/README.md (create it if missing): date, title, one-line summary.`,
    `5. Commit only those files, push (git push -u origin ${p.branch}) and open a pull request: gh pr create --base ${p.defaultBranch} --head ${p.branch} --title "Research: <topic>" --body "<summary, assumptions>". ${floor ? 'For a GitHub issue, the body must contain "Closes #<issue number>". ' : ''}Research pull requests skip QA; ${p.autoMerge ? "the office merges it once GitHub's checks pass" : 'the manager merges it'}.`,
    '6. Finish with two or three sentences that answer the question, then the pull request URL on its own line.',
    ONE_TURN,
    '',
    `Rules: never push to the default branch, never force-push, never merge pull requests, and only change files under ${dir}/ in your worktree. Research only what is public: don't sign up for anything, buy anything or enter credentials. When the evidence is thin, say so in the doc rather than guessing.`,
  ]
    .filter((l) => l !== '')
    .join('\n');
}

/** The first prompt of a lobby research job. */
export function researchJobPrompt(job: ResearchJob, floor: { floor: number; fullName: string } | null) {
  return [
    `Research brief from ${job.requestedBy === 'ceo' ? 'the CEO' : 'the manager'}.`,
    `Topic: ${job.topic}`,
    job.brief && job.brief !== job.topic ? `"""${job.brief}"""` : '',
    floor ? `File the doc on floor ${floor.floor} (${floor.fullName}) by pull request.` : `File the company research under ${COMPANY_RESEARCH_DOCS}/ by pull request.`,
  ]
    .filter(Boolean)
    .join('\n');
}
