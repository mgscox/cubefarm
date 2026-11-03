// Demo fixture for reviewing an Idea's proposal: a deterministic PRD and Issue Plan per revision, and scripted reviewers.
import type { IdeaRecordView, IdeaReviewCycleView, IdeaReviewFocus, IdeaReviewView, IdeaView } from '../shared/types.ts';

export type ReviewFixture = NonNullable<IdeaReviewCycleView['fixture']>;

export const isReviewFixture = (v: unknown): v is ReviewFixture => v === 'agree' || v === 'disagree';

/** The lead's PRD and paired Issue Plan at one revision, as read-only Idea records. */
export function demoProposalRecords(idea: IdeaView, revision: number, at: number): IdeaRecordView[] {
  const changed = revision > 1 ? `\n\n_Revised after round ${revision - 1} findings._` : '';
  return [
    {
      id: `demo-prd-r${revision}`, ideaId: idea.id, kind: 'proposal', title: `PRD r${revision} (demo fixture)`, createdAt: at,
      body: `**Problem.** ${idea.description}\n\n**Outcome.** The manager sees the change working in the demo office.\n\n` +
        `**Acceptance criteria.**\n- The change is visible from the manager's console.\n- No implementation issues are created before approval.${changed}`,
    },
    {
      id: `demo-plan-r${revision}`, ideaId: idea.id, kind: 'proposal', title: `Issue Plan r${revision} for PRD r${revision} (demo fixture)`, createdAt: at,
      body: `1. Add the server state and its demo fake.\n2. Show it in the manager's console (blocked by 1).${changed}`,
    },
  ];
}

/** What each scripted reviewer says: one joint endorsement, or a feasibility objection that never resolves. */
export function demoReview(fixture: ReviewFixture, focus: IdeaReviewFocus, round: number): Pick<IdeaReviewView, 'verdict' | 'findings'> {
  if (fixture === 'agree' || focus === 'evidence') return { verdict: 'endorse', findings: [] };
  const findings = ['Step 2 depends on a floor that has no QA tester yet.'];
  if (round === 1) findings.push("The plan doesn't say which floor step 2 runs on.");
  return { verdict: 'findings', findings };
}
