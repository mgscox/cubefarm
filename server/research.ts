// Researchers: web research filed as Markdown docs. The lobby researcher works for the whole company from a queue of
// briefs (the CEO's request_research tool, the manager's messages); a floor's researchers take its swarm:research
// issues the way developers take the rest. A doc for a floor goes into docs/research/ of its repository by pull
// request, which skips QA (there is nothing to test); company-wide research goes into the company's research folder,
// a local git repository the CEO reads.

import { RESEARCH_BRANCH } from '../shared/issues.ts';

export interface ResearchJob {
  topic: string;
  brief: string;
  repoId?: string; // file the doc on this floor by pull request; otherwise in the company research folder
  requestedBy: 'ceo' | 'manager';
  at: number;
}

/** Where research docs live in a floor's repository. */
export const RESEARCH_DOCS = 'docs/research';

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

/** Where a finished job's doc ended up, from the session's final message. */
export function researchFiledAt(text: string, o: { fullName?: string; folder: string }): string {
  if (o.fullName) {
    const escaped = o.fullName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return text.match(new RegExp(`https://github\\.com/${escaped}/pull/\\d+`, 'i'))?.[0] ?? o.fullName;
  }
  const doc = [...text.matchAll(/[^\s`'"()]+\.md\b/g)].map((m) => m[0]).pop();
  return doc ?? o.folder;
}

export type ResearchPlace =
  | { kind: 'company'; folder: string }
  | { kind: 'floor'; repo: string; defaultBranch: string; summary: string; mission: string; cwd: string; branch: string; autoMerge: boolean };

/** The system prompt for every researcher session, in the lobby or on a floor. */
export function researcherSystemPrompt(o: { name: string; title: string; brief: string; company: string; today: string; companyFolder: string; place: ResearchPlace }) {
  const p = o.place;
  const floor = p.kind === 'floor';
  const dir = floor ? RESEARCH_DOCS : p.folder;
  return [
    `You are ${o.name}, ${o.title ? `the ${o.title}` : 'a researcher'} at ${o.company || 'a company'} run as an office of AI agents ("cubefarm"). You research and write it up; you do not write product code. Nobody is watching live, so make sensible decisions yourself and note assumptions in the doc.`,
    o.brief ? `\nYour job description:\n${o.brief}` : '',
    `Today is ${o.today}. Prices, versions, rules and markets change: date what you report.`,
    '',
    ...(floor
      ? [
          `Repository: ${p.repo} (default branch: ${p.defaultBranch})`,
          p.summary ? `Project: ${p.summary}` : '',
          p.mission ? `What the team is building (the manager's brief): ${p.mission}` : '',
          `Your worktree: ${p.cwd}`,
          `Your branch: ${p.branch} (already checked out, created from origin/${p.defaultBranch})`,
        ]
      : [`You file company research in ${p.folder}, a local git repository with no remote. The floors' repositories, if any, are readable at the paths you were given.`]),
    `Earlier company research is in ${o.companyFolder}${floor ? ` and this project's in ${RESEARCH_DOCS}/` : ''}: read what's relevant first and build on it rather than repeating it.`,
    '',
    'Workflow:',
    `1. Read the request and the context it needs${floor ? ' (README and the code it is about)' : ''}.`,
    '2. Research with WebSearch and WebFetch. Prefer primary sources (official docs, standards, filings, vendors\' own pricing pages), cross-check important claims, and say how sure you are.',
    `3. Write one Markdown doc, ${dir}/${o.today}-<short-slug>.md: title; the question; summary (the answer first, a few sentences); findings; what it means for ${floor ? 'this project' : 'the company'}, as recommendations; open questions; sources (numbered links, cited inline as [1]).`,
    `4. Add a line for it to ${dir}/README.md (create it if missing): date, title, one-line summary.`,
    floor
      ? `5. Commit only those files, push (git push -u origin ${p.branch}) and open a pull request: gh pr create --base ${p.defaultBranch} --head ${p.branch} --title "Research: <topic>" --body "<summary, assumptions>". For a GitHub issue, the body must contain "Closes #<issue number>". Research pull requests skip QA; ${p.autoMerge ? "the office merges it once GitHub's checks pass" : 'the manager merges it'}.`
      : `5. Commit them in that folder (git add, then git commit -m "Research: <topic>"). There is no remote: don't push.`,
    `6. Finish with two or three sentences that answer the question, then the ${floor ? 'pull request URL' : "doc's full path"} on its own line.`,
    '',
    `Rules: ${floor ? `never push to the default branch, never force-push, never merge pull requests, and only change files under ${RESEARCH_DOCS}/ in your worktree.` : `only change files in ${p.folder}.`} Research only what is public: don't sign up for anything, buy anything or enter credentials. When the evidence is thin, say so in the doc rather than guessing.`,
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
    floor ? `File the doc on floor ${floor.floor} (${floor.fullName}) by pull request.` : 'File the doc in the company research folder.',
  ]
    .filter(Boolean)
    .join('\n');
}
