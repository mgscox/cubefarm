// Publication: an approved Proposal's Issue Plan onto its floors' GitHub repos. Each issue is created held (a draft
// title and the held-for-publication label), read back, and released into the ordinary issue workflow only once the
// whole plan is verified. Progress is committed to the state file before every tracker write, so a repeated request,
// a lost response or a restart resumes the recorded publication instead of creating another issue.
import type { Backend } from './backend.ts';
import type { TrackedIssue } from './github.ts';
import { CommandError } from './exec.ts';
import { HttpError } from './httpError.ts';
import { issueWaitReason, PUBLICATION_HOLD } from '../shared/issues.ts';
import type { ApprovedSnapshot, PlanIssue, PublicationView, PublishedIssue } from '../shared/types.ts';
import type { IdeaIssueOrigin } from './approvedBlockers.ts';

export type PublicationTracker = Pick<Backend, 'issueAccess' | 'createIssue' | 'readIssue' | 'findIssuesByMarker' | 'editIssue' | 'listIssues'>;

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

/** Bound the work accepted in one durable publication. */
export const MAX_PLAN_ISSUES = 100;
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
  if (issues.length > MAX_PLAN_ISSUES) return `An Issue Plan can contain at most ${MAX_PLAN_ISSUES} entries.`;
  const entries = new Set<string>();
  for (const i of issues) {
    if (typeof i?.entryId !== 'string' || !ID.test(i.entryId) || entries.has(i.entryId)) return 'Each planned issue needs its own entry id.';
    entries.add(i.entryId);
    if (typeof i.repo !== 'string' || !REPO.test(i.repo)) return `Plan entry ${i.entryId} needs an owner/name repo.`;
    if (typeof i.title !== 'string' || !i.title.trim() || i.title.length > 200) return `Plan entry ${i.entryId} needs a title (200 characters at most).`;
    if (typeof i.body !== 'string') return `Plan entry ${i.entryId} needs a body.`;
    if (i.specialty !== undefined && (typeof i.specialty !== 'string' || !/^[a-z0-9-]{1,40}$/.test(i.specialty))) return `Plan entry ${i.entryId} has an invalid specialty.`;
    if (i.tracking !== undefined && typeof i.tracking !== 'boolean') return `Plan entry ${i.entryId} has an invalid tracking flag.`;
  }
  for (const i of issues) {
    if (i.blockedBy === undefined) continue;
    if (!Array.isArray(i.blockedBy)) return `Plan entry ${i.entryId} needs a list of blockers.`;
    for (const b of i.blockedBy as unknown[]) {
      const ref = b as { entryId?: unknown; repo?: unknown; number?: unknown } | null;
      const entry = typeof ref?.entryId === 'string' && entries.has(ref.entryId) && ref.entryId !== i.entryId && ref.repo === undefined && ref.number === undefined;
      const tracked = typeof ref?.repo === 'string' && REPO.test(ref.repo) && Number.isInteger(ref.number) && (ref.number as number) > 0 && ref.entryId === undefined;
      if (!entry && !tracked) return `Plan entry ${i.entryId} has a blocker that is neither another plan entry nor an owner/name#number issue.`;
    }
  }
  const byId = new Map(issues.map((i) => [i.entryId, i]));
  const refs = new Set<string>();
  for (const i of issues) {
    if (i.blockedBy && new Set(i.blockedBy.map((b) => JSON.stringify(b))).size !== i.blockedBy.length) return `Invalid duplicate dependencies on ${i.entryId}.`;
    if (i.parent !== undefined && (typeof i.parent !== 'string' || !byId.get(i.parent)?.tracking || byId.get(i.parent)?.existing)) return `Invalid tracking Parent for ${i.entryId}.`;
    if (i.existing !== undefined && (!i.existing || typeof i.existing !== 'object' || Array.isArray(i.existing))) return `Invalid existing reference on ${i.entryId}.`;
    if (i.existing) {
      const ref = `${i.repo.toLowerCase()}#${i.existing.number}`;
      if (!Number.isInteger(i.existing.number) || i.existing.number < 1 || i.existing.url !== `https://github.com/${i.repo}/issues/${i.existing.number}` || refs.has(ref)) return `Invalid or duplicate existing reference on ${i.entryId}.`;
      if (i.parent || i.tracking || i.blockedBy?.length) return `Existing reference ${i.entryId} must remain untouched.`;
      refs.add(ref);
    }
  }
  const cyclic = (edges: (i: PlanIssue) => string[]) => {
    const visiting = new Set<string>(), done = new Set<string>();
    const visit = (id: string): boolean => {
      if (visiting.has(id)) return true;
      if (done.has(id)) return false;
      visiting.add(id);
      if (edges(byId.get(id)!).some(visit)) return true;
      visiting.delete(id); done.add(id);
      return false;
    };
    return issues.some((i) => visit(i.entryId));
  };
  if (cyclic((i) => (i.blockedBy ?? []).flatMap((b) => 'entryId' in b ? [b.entryId] : [])) || cyclic((i) => i.parent ? [i.parent] : [])) return 'The approved plan contains a dependency or hierarchy cycle.';
  return null;
}

/** The parts of a snapshot an approval authorizes: a repeat must match them exactly. */
const approved = (s: ApprovedSnapshot) =>
  JSON.stringify([s.approval.decisionId, s.approval.proposalId, s.approval.prdRevision, s.approval.planRevision, s.approval.ideaId, s.approval.source, s.approval.decidedAt,
    s.issues.map((i) => [i.entryId, i.repo, i.title, i.body, i.specialty ?? '', i.existing ? [i.existing.number, i.existing.url] : null, i.tracking ?? false, i.parent ?? null, i.blockedBy ?? []])]);
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
    issues: snapshot.issues.map((i) => ({ entryId: i.entryId, repo: i.repo, marker: planMarker(proposalId, i.entryId), step: i.existing ? 'referenced' : 'pending', number: i.existing?.number ?? null, url: i.existing?.url ?? null })),
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  };
}

/** Leaves use the approved-blocker guard on both start paths; tracking Parents remain held. */
export const holdReason = (plan: PlanIssue): string | null => plan.tracking ? 'Tracking Parent' : null;

/** Deterministic, replayable body wiring using full URLs across floors. */
export function wiredBody(rec: PublicationView, plan: PlanIssue): string {
  const url = (id: string) => rec.issues.find((i) => i.entryId === id)!.url!;
  const links: string[] = [];
  if (plan.parent) links.push(`Parent: ${url(plan.parent)}`);
  for (const b of plan.blockedBy ?? []) links.push(`Depends on ${'entryId' in b ? url(b.entryId) : `https://github.com/${b.repo}/issues/${b.number}`}`);
  for (const child of rec.snapshot.issues.filter((i) => i.parent === plan.entryId)) links.push(`- [ ] ${url(child.entryId)}`);
  return [publishedBody(plan, planMarker(rec.proposalId, plan.entryId)), ...links].join('\n\n');
}

/** Why a read-back doesn't match the issue publication created (null: it does). Released titles count too. */
export function verifyProblem(plan: PlanIssue, entry: PublishedIssue, got: TrackedIssue | null): string | null {
  const ref = `#${entry.number} on ${entry.repo}`;
  if (!got) return `${ref} isn't on GitHub any more.`;
  if (!sameRepo(got.repo, entry.repo) || got.number !== entry.number) return `${ref} answered as ${got.repo}#${got.number}.`;
  if (!got.body.includes(entry.marker)) return `${ref} no longer carries its plan-entry marker.`;
  if (got.state !== 'OPEN' && !(['verified', 'releasing'].includes(entry.step) && isReleased(plan, got))) return `${ref} was closed before its release.`;
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
  if (err instanceof CommandError && ACCESS.test(err.stderr) && !/rate limit|abuse detection/i.test(err.stderr)) {
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

  /**
   * The publication an issue came from, for dispatch: null when it wasn't published from an Idea. Its approved
   * blockers resolve to the issues publication recorded, never to what the issue body or native links say now.
   */
  issueOrigin(repo: string, number: number): IdeaIssueOrigin | null {
    for (const p of this.list()) {
      const i = p.issues.find((x) => x.step !== 'referenced' && x.number === number && sameRepo(x.repo, repo));
      if (!i) continue;
      const plan = this.plan(p, i);
      const blockers = (plan.blockedBy ?? []).map((b) => {
        if ('repo' in b) return { ref: `${b.repo}#${b.number}`, repo: b.repo, number: b.number };
        const dep = p.issues.find((x) => x.entryId === b.entryId);
        return dep?.number != null ? { ref: `${dep.repo}#${dep.number}`, repo: dep.repo, number: dep.number } : { ref: `plan entry ${b.entryId}`, repo: null, number: null };
      });
      return { proposalId: p.proposalId, entryId: i.entryId, step: i.step, tracking: !!plan.tracking, blockers };
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
      const held = rec.issues.filter((i) => i.step === 'held').length;
      Object.assign(rec, { status: 'complete', note: held ? `Plan verified; ${held} ${held === 1 ? 'entry stays' : 'entries stay'} held (tracking Parents).` : null, needsManager: false });
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
    // Older releases recorded 'verified' before their write. Reconcile delivered work before the open backlog.
    for (const entry of rec.issues.filter((i) => i.step === 'verified' || i.step === 'releasing')) {
      const got = await this.checked(rec, entry, entry.step === 'verified');
      if (isReleased(this.plan(rec, entry), got)) {
        entry.step = 'released';
        await this.save(rec);
        this.host.released(entry.repo, entry.number!);
      }
    }
    await this.preflight(rec);
    for (const entry of rec.issues) await this.place(rec, entry);
    // Wire only new issues; reference entries are never mutated, including their reciprocal links.
    for (const entry of rec.issues) {
      if (['released', 'referenced', 'releasing'].includes(entry.step)) continue;
      const got = await this.checked(rec, entry, true);
      const body = wiredBody(rec, this.plan(rec, entry));
      if (normalized(got.body) !== normalized(body)) {
        await this.save(rec);
        await this.host.tracker.editIssue(entry.repo, entry.number!, { body });
      }
    }
    // Read every remaining entry again on every attempt, even ones verified before an interruption.
    for (const entry of rec.issues) {
      if (['released', 'referenced'].includes(entry.step)) continue;
      const got = await this.checked(rec, entry);
      if (normalized(got.body) !== normalized(wiredBody(rec, this.plan(rec, entry)))) throw new Error(`Links for ${entry.entryId} are not visible yet.`);
    }
    await this.verifyDispatch(rec);
    for (const entry of rec.issues) {
      if (['released', 'referenced'].includes(entry.step)) continue;
      const reason = holdReason(this.plan(rec, entry));
      entry.holdReason = reason ?? undefined;
      if (reason) entry.step = 'held';
      else if (entry.step !== 'releasing') entry.step = 'verified';
    }
    await this.save(rec); // the whole-plan gate precedes every release
    for (const entry of rec.issues) if (entry.step === 'verified' || entry.step === 'releasing') await this.release(rec, entry);
  }

  private async checked(rec: PublicationView, entry: PublishedIssue, allowUnwired = false): Promise<TrackedIssue> {
    const got = await this.host.tracker.readIssue(entry.repo, entry.number!);
    const problem = verifyProblem(this.plan(rec, entry), entry, got);
    if (problem) throw new PublicationBlock(`${problem} The plan stays held; fix the issue, then retry.`, 'conflict');
    const plan = this.plan(rec, entry);
    const allowed = [wiredBody(rec, plan), ...(entry.step === 'created' || allowUnwired ? [publishedBody(plan, entry.marker)] : [])].map(normalized);
    if (!allowed.includes(normalized(got!.body))) throw new PublicationBlock(`${entry.entryId} no longer matches the approved scope or links. A changed plan needs a revised proposal.`, 'conflict');
    if (entry.step !== 'releasing' && entry.step !== 'verified' &&
        (got!.title !== heldTitle(plan.title) || !got!.labels.some((l) => l.toLowerCase() === PUBLICATION_HOLD))) {
      throw new PublicationBlock(`${entry.entryId} lost its publication hold before whole-plan verification. Restore it, then retry.`, 'conflict');
    }
    if (holdReason(plan) && (got!.title !== heldTitle(plan.title) || !got!.labels.includes(PUBLICATION_HOLD))) throw new PublicationBlock(`${entry.entryId} must stay held. Restore its publication hold.`, 'conflict');
    if (plan.specialty && !got!.labels.includes(`swarm:${plan.specialty}`)) throw new PublicationBlock(`${entry.entryId} lost its approved routing label. Restore it, then retry.`, 'conflict');
    return got!;
  }

  private async verifyDispatch(rec: PublicationView) {
    for (const repo of new Set(rec.issues.filter((i) => !['released', 'referenced'].includes(i.step)).map((i) => i.repo))) {
      const visible = await this.host.tracker.listIssues(repo);
      for (const entry of rec.issues.filter((i) => sameRepo(i.repo, repo) && !['released', 'referenced'].includes(i.step))) {
        const plan = this.plan(rec, entry);
        const got = visible.find((i) => i.number === entry.number);
        if (!got || normalized(got.body) !== normalized(wiredBody(rec, plan))) throw new Error(`${entry.entryId} is not visible to dispatch with its approved links yet.`);
        if (plan.specialty && !got.labels.includes(`swarm:${plan.specialty}`)) throw new Error(`${entry.entryId}'s routing is not visible to dispatch yet.`);
        if (!holdReason(plan)) {
          if (got.subIssues === null || got.nativeBlockers === null) throw new Error(`${entry.entryId}: dispatch metadata has not loaded yet.`);
          const reason = issueWaitReason({ ...got, title: plan.title, labels: got.labels.filter((l) => l.toLowerCase() !== PUBLICATION_HOLD) }, new Set(visible.map((i) => i.number)));
          if (reason && !(reason === 'open blockers' && plan.blockedBy?.length)) throw new PublicationBlock(`${entry.entryId} cannot enter ordinary dispatch: ${reason}. Resolve it or approve a revised proposal.`, 'conflict');
        } else if (got.title !== heldTitle(plan.title) || !got.labels.includes(PUBLICATION_HOLD)) throw new Error(`${entry.entryId}'s hold is not visible to dispatch yet.`);
      }
    }
  }

  private async preflight(rec: PublicationView) {
    const floors = this.host.floors();
    for (const repo of new Set(rec.issues.map((i) => i.repo))) {
      if (!floors.some((f) => sameRepo(f, repo))) throw new PublicationBlock(`${repo} isn't a configured floor. Connect it, or approve a revised proposal.`, 'conflict');
      const access = await this.host.tracker.issueAccess(repo);
      if (!sameRepo(access.repo, repo)) throw new PublicationBlock(`${repo} now answers as ${access.repo}. A changed target needs a revised proposal.`, 'conflict');
      if (!access.issues) throw new PublicationBlock(`Issues are turned off on ${repo}. Turn them on; publication resumes by itself.`, 'access');
      if (rec.snapshot.issues.some((i) => sameRepo(i.repo, repo) && !i.existing) && !WRITERS.includes(access.permission.toUpperCase())) {
        throw new PublicationBlock(`The office can't write issues on ${repo} (permission: ${access.permission || 'none'}). Grant triage or write access; publication resumes by itself.`, 'access');
      }
    }
    for (const plan of rec.snapshot.issues.filter((i) => i.existing)) {
      const got = await this.host.tracker.readIssue(plan.repo, plan.existing!.number);
      if (!got || !sameRepo(got.repo, plan.repo) || got.number !== plan.existing!.number || got.url !== plan.existing!.url) throw new PublicationBlock(`Existing reference ${plan.entryId} is unavailable or changed target. Restore access or approve a revised proposal.`, 'access');
    }
    for (const b of rec.snapshot.issues.flatMap((i) => i.blockedBy ?? [])) {
      if (!('repo' in b)) continue;
      const got = await this.host.tracker.readIssue(b.repo, b.number);
      if (!got || !sameRepo(got.repo, b.repo) || got.number !== b.number) throw new PublicationBlock(`Approved prerequisite ${b.repo}#${b.number} is unavailable. Restore access or approve a revised proposal.`, 'access');
    }
    for (const entry of rec.issues) {
      if (!['pending', 'creating', 'released', 'referenced'].includes(entry.step)) await this.checked(rec, entry, true);
    }
  }

  /** Find the entry's issue by its marker, or create it held. A failed create is looked up again before any retry. */
  private async place(rec: PublicationView, entry: PublishedIssue) {
    if (entry.step !== 'pending' && entry.step !== 'creating') return;
    const since = new Date(rec.createdAt - LOOKUP_SKEW_MS).toISOString();
    const found = (await this.host.tracker.findIssuesByMarker(entry.repo, entry.marker, since)).filter((i) => sameRepo(i.repo, entry.repo));
    // Closed matches are extras the manager closed, or an issue someone closed: never adopted, never recreated over.
    const open = found.filter((i) => i.state === 'OPEN');
    if (open.length > 1) {
      throw new PublicationBlock(`${open.map((i) => `#${i.number}`).join(' and ')} on ${entry.repo} all carry plan entry ${entry.entryId}. Close the extras, then retry.`, 'conflict');
    }
    if (open.length === 1) {
      Object.assign(entry, { number: open[0].number, url: open[0].url, step: 'created' });
      await this.save(rec);
      return;
    }
    if (found.length) {
      throw new PublicationBlock(`${found.map((i) => `#${i.number}`).join(' and ')} on ${entry.repo} carrying plan entry ${entry.entryId} ${found.length > 1 ? 'are' : 'is'} closed. Reopen one, then retry.`, 'conflict');
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
    const before = await this.checked(rec, entry);
    if (!isReleased(plan, before!)) {
      entry.step = 'releasing';
      await this.save(rec);
      const held = before!.labels.filter((l) => l.toLowerCase() === PUBLICATION_HOLD);
      await this.host.tracker.editIssue(entry.repo, entry.number!, { title: plan.title, ...(held.length ? { removeLabels: held } : {}) });
      const after = await this.host.tracker.readIssue(entry.repo, entry.number!);
      if (!after || verifyProblem(plan, entry, after) || normalized(after.body) !== normalized(wiredBody(rec, plan)) || !isReleased(plan, after)) throw new Error(`the release of #${entry.number} on ${entry.repo} doesn't show on GitHub yet.`);
    }
    entry.step = 'released';
    await this.save(rec);
    this.host.released(entry.repo, entry.number!);
  }
}
