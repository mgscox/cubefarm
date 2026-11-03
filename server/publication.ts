// Publication: an approved Proposal's Issue Plan onto its floors' GitHub repos. Each issue is created held (a draft
// title and the held-for-publication label), read back, and released into the ordinary issue workflow only once the
// whole plan is verified. Progress is committed to the state file before every tracker write, so a repeated request,
// a lost response or a restart resumes the recorded publication instead of creating another issue.
import type { Backend } from './backend.ts';
import type { TrackedIssue } from './github.ts';
import { CommandError } from './exec.ts';
import { HttpError } from './httpError.ts';
import { PUBLICATION_HOLD } from '../shared/issues.ts';
import type { ApprovedSnapshot, PlanIssue, PublicationView, PublishedIssue } from '../shared/types.ts';

export type PublicationTracker = Pick<Backend, 'issueAccess' | 'createIssue' | 'readIssue' | 'findIssuesByMarker' | 'editIssue'>;

export interface PublicationHost {
  tracker: PublicationTracker;
  /** The configured floors' owner/name: the only publication targets. */
  floors(): string[];
  /** Whether fixture approvals are accepted: the demo office and tests only. */
  fixtures: boolean;
  /** The persisted publications by proposal id (mutated in place). */
  records(): Record<string, PublicationView>;
  /** Write the state file; resolves once it is on disk. */
  commit(): Promise<void>;
  emit(view: PublicationView): void;
  /** A released issue: let dispatch see it. */
  released(repo: string, number: number): void;
  notify(level: 'success' | 'error', text: string): void;
}

/** This release publishes single-issue plans; cross-floor plans come with hierarchy and dependency wiring. */
export const MAX_PLAN_ISSUES = 1;
export const DRAFT_PREFIX = '[Draft] ';
/** GitHub's clock and ours can disagree: marker lookups reach this far before the approval was recorded. */
const LOOKUP_SKEW_MS = 10 * 60_000;
const RETRY_MIN_MS = 15_000;
const RETRY_MAX_MS = 10 * 60_000;
const WRITERS = ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE'];
const ID = /^[\w.-]{1,80}$/;
const REPO = /^[\w.-]+\/[\w.-]+$/;

/** The stable plan-entry marker an issue carries in its body. */
export const planMarker = (proposalId: string, entryId: string) => `<!-- cubefarm:plan-entry ${proposalId}/${entryId} -->`;
export const heldTitle = (title: string) => `${DRAFT_PREFIX}${title}`;
export const publishedBody = (issue: PlanIssue, marker: string) => `${issue.body.trim()}\n\n${marker}`;
export const issueLabels = (issue: PlanIssue) => [PUBLICATION_HOLD, ...(issue.specialty ? [`swarm:${issue.specialty}`] : [])];
const sameRepo = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const normalized = (text: string) => text.replace(/\r\n/g, '\n').trim();

/** Why an approved snapshot can't be published (null: it can). */
export function snapshotProblem(input: unknown, fixtures: boolean): string | null {
  const s = input as Partial<ApprovedSnapshot> | null;
  const a = s?.approval;
  if (!a || typeof a !== 'object') return 'A publication needs a recorded approval.';
  if (![a.decisionId, a.proposalId, a.ideaId].every((x) => typeof x === 'string' && ID.test(x) && !(x in Object.prototype))) {
    return 'The approval needs decision, proposal and Idea ids (letters, digits, . _ -).';
  }
  if (![a.prdRevision, a.planRevision].every((r) => Number.isInteger(r) && (r as number) > 0)) return 'The approval must name the exact PRD and Issue Plan revisions.';
  if (!Number.isFinite(a.decidedAt)) return 'The approval needs the time of the decision.';
  if (a.source !== 'manager' && a.source !== 'fixture') return 'The approval must come from the manager.';
  if (a.source === 'fixture' && !fixtures) return 'Fixture approvals are only accepted by the demo office and tests.';
  const issues = s?.issues;
  if (!Array.isArray(issues) || issues.length === 0) return 'The approved Issue Plan has no issues.';
  if (issues.length > MAX_PLAN_ISSUES) return `This release publishes single-issue plans; this one has ${issues.length} issues.`;
  const entries = new Set<string>();
  for (const i of issues) {
    if (typeof i?.entryId !== 'string' || !ID.test(i.entryId) || entries.has(i.entryId)) return 'Each planned issue needs its own entry id.';
    entries.add(i.entryId);
    if (typeof i.repo !== 'string' || !REPO.test(i.repo)) return `Plan entry ${i.entryId} needs an owner/name repo.`;
    if (typeof i.title !== 'string' || !i.title.trim() || i.title.length > 200) return `Plan entry ${i.entryId} needs a title (200 characters at most).`;
    if (typeof i.body !== 'string') return `Plan entry ${i.entryId} needs a body.`;
    if (i.specialty !== undefined && (typeof i.specialty !== 'string' || !/^[a-z0-9-]{1,40}$/.test(i.specialty))) return `Plan entry ${i.entryId} has an invalid specialty.`;
  }
  return null;
}

/** The parts of a snapshot an approval authorizes: a repeat must match them exactly. */
const approved = (s: ApprovedSnapshot) =>
  JSON.stringify([s.approval.decisionId, s.approval.proposalId, s.approval.prdRevision, s.approval.planRevision,
    s.issues.map((i) => [i.entryId, i.repo, i.title, i.body, i.specialty ?? ''])]);
export const sameApproval = (a: ApprovedSnapshot, b: ApprovedSnapshot) => approved(a) === approved(b);

/** Publications from the state file: own, well-formed records keyed by their proposal id, whatever the key. */
export function loadPublications(raw: unknown): Record<string, PublicationView> {
  const out: Record<string, PublicationView> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, p] of Object.entries(raw as Record<string, unknown>)) {
    const rec = p as PublicationView | null;
    if (!rec || typeof rec !== 'object' || rec.proposalId !== id || !Array.isArray(rec.issues) || !rec.snapshot?.approval) continue;
    Object.defineProperty(out, id, { value: rec, writable: true, enumerable: true, configurable: true });
  }
  return out;
}

export function newPublication(snapshot: ApprovedSnapshot, now: number): PublicationView {
  const { proposalId } = snapshot.approval;
  return {
    proposalId,
    snapshot,
    status: 'publishing',
    note: null,
    needsManager: false,
    retryAt: null,
    issues: snapshot.issues.map((i) => ({ entryId: i.entryId, repo: i.repo, marker: planMarker(proposalId, i.entryId), step: 'pending', number: null, url: null })),
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  };
}

/** Why a read-back doesn't match the issue publication created (null: it does). Released titles count too. */
export function verifyProblem(plan: PlanIssue, entry: PublishedIssue, got: TrackedIssue | null): string | null {
  const ref = `#${entry.number} on ${entry.repo}`;
  if (!got) return `${ref} isn't on GitHub any more.`;
  if (!sameRepo(got.repo, entry.repo) || got.number !== entry.number) return `${ref} answered as ${got.repo}#${got.number}.`;
  if (!got.body.includes(entry.marker)) return `${ref} no longer carries its plan-entry marker.`;
  if (got.state !== 'OPEN') return `${ref} was closed before its release.`;
  if (got.title !== heldTitle(plan.title) && got.title !== plan.title) return `${ref} has a different title: "${got.title}".`;
  if (!normalized(got.body).includes(normalized(plan.body))) return `${ref} no longer matches the approved brief.`;
  return null;
}

/** Whether a read-back shows the issue released: approved title, no hold. */
export const isReleased = (plan: PlanIssue, got: TrackedIssue) => got.title === plan.title && !got.labels.some((l) => l.toLowerCase() === PUBLICATION_HOLD);

/** A stop that keeps the plan held. access: the manager can fix it and attempts carry on; conflict: only the manager. */
export class PublicationBlock extends Error {
  constructor(message: string, public kind: 'access' | 'conflict') { super(message); }
}

const ACCESS = /\bHTTP (?:401|403|404)\b|Resource not accessible|Could not resolve to a Repository|must have (?:push|triage|admin)|permission/i;

/** How a failed attempt shows and when it runs again. Anything unrecognized is temporary: retried, still held. */
export function failure(err: unknown, attempts: number): Pick<PublicationView, 'status' | 'note' | 'needsManager'> & { retryIn: number | null } {
  const backoff = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** Math.max(0, attempts - 1));
  const message = (err as Error)?.message ?? String(err);
  if (err instanceof PublicationBlock) {
    return err.kind === 'conflict'
      ? { status: 'blocked', note: message, needsManager: true, retryIn: null }
      : { status: 'blocked', note: message, needsManager: true, retryIn: backoff };
  }
  if (err instanceof CommandError && ACCESS.test(err.stderr)) {
    return { status: 'blocked', note: `GitHub refused: ${err.stderr.trim().split('\n')[0]}. Publication resumes once access is restored.`, needsManager: true, retryIn: backoff };
  }
  return { status: 'publishing', note: `Retrying: ${message}`, needsManager: false, retryIn: backoff };
}

export class Publisher {
  private running = new Map<string, Promise<void>>();
  private timers = new Map<string, NodeJS.Timeout>();
  /** Approvals whose first write to the state file is under way: repeats wait for it, and nothing publishes yet. */
  private accepting = new Map<string, Promise<PublicationView>>();

  constructor(private host: PublicationHost) {}

  list() {
    return Object.values(this.host.records()).filter((p) => !this.accepting.has(p.proposalId)).sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Own records only: an id like __proto__ or toString never reaches inherited properties. */
  get(proposalId: string): PublicationView | null {
    const records = this.host.records();
    return Object.hasOwn(records, proposalId) && !this.accepting.has(proposalId) ? records[proposalId] : null;
  }

  /** The publication an issue came from, for dispatch: null when it wasn't published from an Idea. */
  issueOrigin(repo: string, number: number): { proposalId: string; entryId: string; step: PublishedIssue['step'] } | null {
    for (const p of this.list()) {
      const i = p.issues.find((x) => x.number === number && sameRepo(x.repo, repo));
      if (i) return { proposalId: p.proposalId, entryId: i.entryId, step: i.step };
    }
    return null;
  }

  /**
   * Accept a recorded approval and start publishing it. The record is on disk before the first tracker write. A
   * repeat of the same approval resumes and returns the recorded publication; a different one for the same Proposal
   * is refused: a Proposal authorizes one publication.
   */
  async publish(snapshot: ApprovedSnapshot): Promise<PublicationView> {
    const problem = snapshotProblem(snapshot, this.host.fixtures);
    if (problem) throw new HttpError(400, problem);
    const id = snapshot.approval.proposalId;
    const pending = this.accepting.get(id);
    if (pending) return this.repeat(await pending, snapshot);
    const existing = this.get(id);
    if (existing) return this.repeat(existing, snapshot);
    const records = this.host.records();
    const rec = newPublication(structuredClone(snapshot), Date.now());
    Object.defineProperty(records, id, { value: rec, writable: true, enumerable: true, configurable: true });
    const accept = this.host.commit().then(
      () => rec,
      (err: unknown) => {
        if (Object.hasOwn(records, id) && records[id] === rec) delete records[id];
        throw err;
      },
    ).finally(() => this.accepting.delete(id));
    this.accepting.set(id, accept);
    await accept;
    this.host.emit(rec);
    this.kick(id);
    return rec;
  }

  /** The same approval again resumes its publication; another decision for the Proposal is refused. */
  private repeat(rec: PublicationView, snapshot: ApprovedSnapshot) {
    if (!sameApproval(rec.snapshot, snapshot)) {
      throw new HttpError(409, `Proposal ${rec.proposalId} was already approved (decision ${rec.snapshot.approval.decisionId}) and can't authorize another publication. A changed plan needs a revised proposal.`);
    }
    this.kick(rec.proposalId);
    return rec;
  }

  /** The manager's retry, e.g. after granting access or closing a duplicate. */
  retry(proposalId: string): PublicationView {
    const rec = this.get(proposalId);
    if (!rec) throw new HttpError(404, `No publication for proposal ${proposalId}.`);
    this.kick(proposalId);
    return rec;
  }

  /** After a restart: carry on with every unfinished publication from its recorded progress. */
  resumeAll() {
    for (const p of this.list()) if (p.status !== 'complete') this.kick(p.proposalId);
  }

  /** Resolves when the publication's current attempt has ended (tests). */
  settled(proposalId: string) {
    return this.running.get(proposalId) ?? Promise.resolve();
  }

  stop() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /** One attempt at a time per publication: a repeat while one runs joins it. */
  private kick(id: string) {
    const rec = this.get(id); // null while its approval is still being recorded
    if (!rec || rec.status === 'complete' || this.running.has(id)) return;
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    const run = this.attempt(rec).finally(() => this.running.delete(id));
    this.running.set(id, run);
  }

  private async save(rec: PublicationView) {
    rec.updatedAt = Date.now();
    this.host.emit(rec);
    await this.host.commit();
  }

  private async attempt(rec: PublicationView) {
    rec.attempts++;
    rec.retryAt = null;
    try {
      await this.advance(rec);
      Object.assign(rec, { status: 'complete', note: null, needsManager: false });
      await this.save(rec);
      const links = rec.issues.map((i) => `${i.repo}#${i.number}`).join(', ');
      this.host.notify('success', `Published ${links} from an approved proposal.`);
    } catch (err) {
      const wasBlocked = rec.status === 'blocked';
      const f = failure(err, rec.attempts);
      Object.assign(rec, { status: f.status, note: f.note, needsManager: f.needsManager, retryAt: f.retryIn === null ? null : Date.now() + f.retryIn });
      if (f.retryIn !== null) this.timers.set(rec.proposalId, setTimeout(() => this.kick(rec.proposalId), f.retryIn));
      if (f.status === 'blocked' && !wasBlocked) this.host.notify('error', `Publication of proposal ${rec.proposalId} is held: ${f.note}`);
      await this.save(rec).catch((e) => console.warn('could not save a publication', e));
    }
  }

  private plan(rec: PublicationView, entry: PublishedIssue) {
    return rec.snapshot.issues.find((i) => i.entryId === entry.entryId)!;
  }

  /** Preflight, create or find each issue held, verify the whole plan, then release it issue by issue. */
  private async advance(rec: PublicationView) {
    if (rec.issues.some((i) => i.step !== 'released')) await this.preflight(rec);
    for (const entry of rec.issues) await this.place(rec, entry);
    for (const entry of rec.issues) {
      if (entry.step !== 'created') continue;
      const got = await this.host.tracker.readIssue(entry.repo, entry.number!);
      const problem = verifyProblem(this.plan(rec, entry), entry, got);
      if (problem) throw new PublicationBlock(`${problem} The plan stays held; fix or close that issue, then retry.`, 'conflict');
      entry.url = got!.url;
      entry.step = 'verified';
      await this.save(rec);
    }
    for (const entry of rec.issues) if (entry.step === 'verified') await this.release(rec, entry);
  }

  private async preflight(rec: PublicationView) {
    const floors = this.host.floors();
    for (const repo of new Set(rec.issues.filter((i) => i.step !== 'released').map((i) => i.repo))) {
      if (!floors.some((f) => sameRepo(f, repo))) throw new PublicationBlock(`${repo} isn't a configured floor. Connect it, or approve a revised proposal.`, 'conflict');
      const access = await this.host.tracker.issueAccess(repo);
      if (!sameRepo(access.repo, repo)) throw new PublicationBlock(`${repo} now answers as ${access.repo}. A changed target needs a revised proposal.`, 'conflict');
      if (!access.issues) throw new PublicationBlock(`Issues are turned off on ${repo}. Turn them on; publication resumes by itself.`, 'access');
      if (!WRITERS.includes(access.permission.toUpperCase())) {
        throw new PublicationBlock(`The office can't write issues on ${repo} (permission: ${access.permission || 'none'}). Grant triage or write access; publication resumes by itself.`, 'access');
      }
    }
  }

  /** Find the entry's issue by its marker, or create it held. A failed create is looked up again before any retry. */
  private async place(rec: PublicationView, entry: PublishedIssue) {
    if (entry.step !== 'pending' && entry.step !== 'creating') return;
    const since = new Date(rec.createdAt - LOOKUP_SKEW_MS).toISOString();
    const found = (await this.host.tracker.findIssuesByMarker(entry.repo, entry.marker, since)).filter((i) => sameRepo(i.repo, entry.repo));
    if (found.length > 1) {
      throw new PublicationBlock(`${found.map((i) => `#${i.number}`).join(' and ')} on ${entry.repo} all carry plan entry ${entry.entryId}. Close the extras, then retry.`, 'conflict');
    }
    if (found.length === 1) {
      Object.assign(entry, { number: found[0].number, url: found[0].url, step: 'created' });
      await this.save(rec);
      return;
    }
    const plan = this.plan(rec, entry);
    entry.step = 'creating';
    await this.save(rec);
    let number: number;
    try {
      number = await this.host.tracker.createIssue(entry.repo, heldTitle(plan.title), publishedBody(plan, entry.marker), issueLabels(plan));
    } catch (err) {
      if (err instanceof CommandError && ACCESS.test(err.stderr)) throw err;
      throw new Error(`creating the issue on ${entry.repo} failed (${(err as Error).message}); it is looked up by its marker before another create.`);
    }
    Object.assign(entry, { number, url: `https://github.com/${entry.repo}/issues/${number}`, step: 'created' });
    await this.save(rec);
  }

  /** Lift the draft title and the hold, then read the release back. Safe to repeat after an interruption. */
  private async release(rec: PublicationView, entry: PublishedIssue) {
    const plan = this.plan(rec, entry);
    const before = await this.host.tracker.readIssue(entry.repo, entry.number!);
    const problem = verifyProblem(plan, entry, before);
    if (problem) throw new PublicationBlock(`${problem} The plan stays held; fix or close that issue, then retry.`, 'conflict');
    if (!isReleased(plan, before!)) {
      const held = before!.labels.filter((l) => l.toLowerCase() === PUBLICATION_HOLD);
      await this.host.tracker.editIssue(entry.repo, entry.number!, { title: plan.title, ...(held.length ? { removeLabels: held } : {}) });
      const after = await this.host.tracker.readIssue(entry.repo, entry.number!);
      if (!after || !isReleased(plan, after)) throw new Error(`the release of #${entry.number} on ${entry.repo} doesn't show on GitHub yet.`);
    }
    entry.step = 'released';
    await this.save(rec);
    this.host.released(entry.repo, entry.number!);
  }
}
