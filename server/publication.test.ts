import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandError } from './exec.ts';
import type { TrackedIssue } from './github.ts';
import {
  failure, heldTitle, loadPublications, planMarker, PublicationBlock, publishedBody, Publisher, snapshotProblem, verifyProblem,
  type PublicationHost, type PublicationTracker,
} from './publication.ts';
import { createDemoBackend, demoApprovedProposal, demoCrossFloorProposal } from './demo.ts';
import { Swarm } from './swarm.ts';
import { issueWaitReason, PUBLICATION_HOLD, schedulable } from '../shared/issues.ts';
import type { ApprovedSnapshot, PublicationView } from '../shared/types.ts';

const REPO = 'demo-co/app';

const approved = (over: Partial<ApprovedSnapshot['approval']> = {}): ApprovedSnapshot => ({
  approval: { decisionId: 'd1', proposalId: 'p1', ideaId: 'i1', prdRevision: 2, planRevision: 4, decidedAt: 1, source: 'fixture', ...over },
  issues: [{ entryId: 'e1', repo: REPO, title: 'Add a weekly summary', body: '## Scope\nA card.\n\n## Acceptance criteria\n- [ ] It shows.', specialty: 'frontend' }],
});

/** A stateful fake GitHub: what publication writes, it reads back. */
class FakeTracker implements PublicationTracker {
  issues: TrackedIssue[] = [];
  log: string[] = [];
  permission = 'WRITE';
  answersAs = REPO;
  lostCreates = 0;
  failedLookups = 0;
  async issueAccess(repo: string) {
    this.log.push('access');
    return { repo: repo === REPO ? this.answersAs : repo, issues: true, permission: this.permission };
  }
  async createIssue(repo: string, title: string, body: string, labels: string[] = []) {
    this.log.push('create');
    if (this.permission === 'READ') throw new CommandError('gh issue create failed', 'HTTP 403: Resource not accessible by integration', 1);
    const number = this.issues.length + 1;
    this.issues.push({ repo, number, url: `https://github.com/${repo}/issues/${number}`, title, body, labels: [...labels], state: 'OPEN' });
    if (this.lostCreates > 0) {
      this.lostCreates--;
      throw new Error('socket hang up');
    }
    return number;
  }
  async readIssue(repo: string, number: number) {
    this.log.push('read');
    const i = this.issues.find((x) => x.repo === repo && x.number === number);
    return i ? { ...i, labels: [...i.labels] } : null;
  }
  async findIssuesByMarker(repo: string, marker: string) {
    this.log.push('find');
    if (this.failedLookups > 0) {
      this.failedLookups--;
      throw new Error('gh api timed out');
    }
    return this.issues.filter((i) => i.repo === repo && i.body.includes(marker)).map((i) => ({ ...i, labels: [...i.labels] }));
  }
  async listIssues(repo: string) {
    return this.issues.filter((i) => i.repo === repo && i.state === 'OPEN').map((i) => ({ ...i, createdAt: '' }));
  }
  async editIssue(repo: string, number: number, edit: { title?: string; body?: string; removeLabels?: string[] }) {
    this.log.push('edit');
    const i = this.issues.find((x) => x.repo === repo && x.number === number)!;
    if (edit.title !== undefined) i.title = edit.title;
    if (edit.body !== undefined) i.body = edit.body;
    i.labels = i.labels.filter((l) => !edit.removeLabels?.includes(l));
  }
}

let tracker: FakeTracker;
let records: Record<string, PublicationView>;
let disk: string[]; // every committed state, oldest first
let host: PublicationHost & { released: ReturnType<typeof vi.fn>; notify: ReturnType<typeof vi.fn> };
let publisher: Publisher;

const makeHost = () => ({
  tracker,
  floors: () => [REPO],
  fixtures: true,
  records: () => records,
  commit: async () => {
    tracker.log.push('commit');
    disk.push(JSON.stringify(records));
  },
  emit: () => undefined,
  released: vi.fn(),
  notify: vi.fn(),
});

/** Run an attempt, and any retries due within `ms`, to the end. */
const settle = async (ms = 0) => {
  await publisher.settled('p1');
  if (ms) {
    await vi.advanceTimersByTimeAsync(ms);
    await publisher.settled('p1');
  }
};

beforeEach(() => {
  vi.useFakeTimers();
  tracker = new FakeTracker();
  records = {};
  disk = [];
  host = makeHost();
  publisher = new Publisher(host);
});

afterEach(() => {
  publisher.stop();
  vi.useRealTimers();
});

describe('approved snapshots', () => {
  it('accepts a fixture approval only where fixtures are allowed', () => {
    expect(snapshotProblem(approved(), true)).toBeNull();
    expect(snapshotProblem(approved(), false)).toMatch(/demo office and tests/);
    expect(snapshotProblem(approved({ source: 'manager' }), false)).toBeNull();
  });

  it('needs exact revisions and well-formed plan entries', () => {
    expect(snapshotProblem(approved({ planRevision: 0 }), true)).toMatch(/exact PRD and Issue Plan revisions/);
    expect(snapshotProblem({ ...approved(), approval: undefined }, true)).toMatch(/recorded approval/);
    const two = approved();
    two.issues.push({ ...two.issues[0], entryId: 'e2' });
    expect(snapshotProblem(two, true)).toBeNull();
    expect(snapshotProblem({ ...approved(), issues: [{ ...approved().issues[0], repo: 'nope' }] }, true)).toMatch(/owner\/name/);
    expect(snapshotProblem(approved({ proposalId: 'p1 -->' }), true)).toMatch(/ids/);
  });

  it('refuses a fixture in an office without fixtures before anything is written', async () => {
    publisher = new Publisher({ ...host, fixtures: false });
    await expect(publisher.publish(approved())).rejects.toMatchObject({ status: 400 });
    expect(tracker.log).toEqual([]);
    expect(records).toEqual({});
  });
});

describe('publishing one approved issue', () => {
  it('records the approval, creates the issue held, reads it back and then releases it', async () => {
    const view = await publisher.publish(approved());
    expect(disk[0]).toContain('"decisionId":"d1"'); // on disk before any tracker call
    expect(tracker.log[0]).toBe('commit');
    await settle();

    const [created] = tracker.issues;
    expect(tracker.issues).toHaveLength(1);
    expect(created.body).toContain(planMarker('p1', 'e1'));
    expect(created.body).toContain('## Acceptance criteria');
    expect(created).toMatchObject({ title: 'Add a weekly summary', labels: ['swarm:frontend'] });
    // The create request itself carried the hold: draft title and label.
    const createdAt = tracker.log.indexOf('create');
    expect(JSON.parse(disk[tracker.log.slice(0, createdAt).filter((x) => x === 'commit').length - 1]).p1.issues[0].step).toBe('creating');
    expect(tracker.log.indexOf('read')).toBeGreaterThan(createdAt);
    expect(tracker.log.indexOf('edit')).toBeGreaterThan(tracker.log.indexOf('read'));

    expect(view).toMatchObject({ status: 'complete', note: null, attempts: 1 });
    expect(view.issues[0]).toMatchObject({ step: 'released', number: 1, url: `https://github.com/${REPO}/issues/1` });
    expect(host.released).toHaveBeenCalledWith(REPO, 1);
    expect(publisher.issueOrigin('DEMO-CO/app', 1)).toEqual({ proposalId: 'p1', entryId: 'e1', step: 'released' });
    expect(schedulable(created.labels, created.title)).toBe(true);
  });

  it('creates with the hold in the request', async () => {
    const create = vi.spyOn(tracker, 'createIssue');
    await publisher.publish(approved());
    await settle();
    expect(create).toHaveBeenCalledWith(REPO, heldTitle('Add a weekly summary'), expect.stringContaining(planMarker('p1', 'e1')), [PUBLICATION_HOLD, 'swarm:frontend']);
    expect(schedulable([PUBLICATION_HOLD], heldTitle('x'))).toBe(false);
    expect(schedulable([], heldTitle('x'))).toBe(false); // the title holds even if GitHub drops the label
  });

  it('keeps one publication for a repeated or concurrent approval, and refuses a second decision', async () => {
    const [a, b] = await Promise.all([publisher.publish(approved()), publisher.publish(approved())]);
    expect(a).toBe(b);
    await settle();
    await publisher.publish(approved());
    await settle();
    expect(tracker.issues).toHaveLength(1);
    expect(tracker.log.filter((x) => x === 'create')).toHaveLength(1);
    await expect(publisher.publish(approved({ decisionId: 'd2', planRevision: 5 }))).rejects.toMatchObject({ status: 409 });
    expect(tracker.issues).toHaveLength(1);
  });

  it('forgets an approval it could not record, without touching GitHub', async () => {
    publisher = new Publisher({ ...host, commit: async () => { throw new Error('disk full'); } });
    await expect(publisher.publish(approved())).rejects.toThrow('disk full');
    expect(records).toEqual({});
    expect(tracker.log).toEqual([]);
  });

  it('makes concurrent repeats wait for the first write, and fails them all when it fails', async () => {
    let fail!: (err: Error) => void;
    const commit = vi.fn(() => new Promise<void>((_, reject) => { fail = reject; }));
    publisher = new Publisher({ ...host, commit });
    const first = publisher.publish(approved());
    const repeats = [publisher.publish(approved()), publisher.publish(approved())];
    await vi.advanceTimersByTimeAsync(0);
    expect(publisher.get('p1')).toBeNull(); // not accepted yet: no retry, list or kick reaches it
    expect(publisher.list()).toEqual([]);
    expect(() => publisher.retry('p1')).toThrow(/No publication/);
    publisher.resumeAll();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tracker.log).toEqual([]);

    fail(new Error('disk full'));
    await Promise.all([first, ...repeats].map((p) => expect(p).rejects.toThrow('disk full')));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(records).toEqual({});
    expect(tracker.log).toEqual([]);
    expect(host.released).not.toHaveBeenCalled();
  });

  it('lets concurrent repeats join a successful first write', async () => {
    let done!: () => void;
    const commit = vi.fn(() => new Promise<void>((resolve) => { done = resolve; }));
    publisher = new Publisher({ ...host, commit });
    const all = Promise.all([publisher.publish(approved()), publisher.publish(approved())]);
    const refused = expect(publisher.publish(approved({ decisionId: 'd2' }))).rejects.toMatchObject({ status: 409 });
    await vi.advanceTimersByTimeAsync(0);
    expect(tracker.log).toEqual([]);
    done();
    const [a, b] = await all;
    await refused;
    expect(a).toBe(b);
    publisher = new Publisher({ ...host, commit: async () => undefined }); // later saves succeed at once
    publisher.resumeAll();
    await settle();
    expect(records.p1.status).toBe('complete');
    expect(tracker.log.filter((x) => x === 'create')).toHaveLength(1);
  });
});

describe('prototype-safe records', () => {
  const KEYS = ['__proto__', 'constructor', 'toString', 'hasOwnProperty'];

  it.each(KEYS)('retrying %s is a 404 that changes nothing', (key) => {
    const emit = vi.spyOn(host, 'emit');
    publisher = new Publisher(host);
    expect(() => publisher.retry(key)).toThrow(expect.objectContaining({ status: 404 }));
    expect(publisher.get(key)).toBeNull();
    expect(emit).not.toHaveBeenCalled();
    expect(Object.keys(records)).toEqual([]);
    expect(({} as Record<string, unknown>).proposalId).toBeUndefined();
  });

  it.each(KEYS)('refuses %s as a proposal id', async (key) => {
    await expect(publisher.publish(approved({ proposalId: key }))).rejects.toMatchObject({ status: 400 });
    expect(Object.getPrototypeOf(records)).toBe(Object.prototype);
    expect(tracker.log).toEqual([]);
  });

  it('loads only own, well-formed records from the state file', async () => {
    await publisher.publish(approved());
    await settle();
    const raw = JSON.parse(`{"__proto__": {"proposalId": "__proto__", "issues": []}, "toString": 5, "x": {"proposalId": "y", "issues": [], "snapshot": {"approval": {}}}, "p1": ${JSON.stringify(records.p1)}}`);
    const loaded = loadPublications(raw);
    expect(Object.keys(loaded)).toEqual(['p1']);
    expect(Object.getPrototypeOf(loaded)).toBe(Object.prototype);
    expect(loadPublications(null)).toEqual({});
    expect(loadPublications([records.p1])).toEqual({});
    records = loaded;
    publisher = new Publisher(makeHost());
    expect(publisher.get('p1')?.status).toBe('complete');
    expect(publisher.get('__proto__')).toBeNull();
    expect(() => publisher.retry('toString')).toThrow(expect.objectContaining({ status: 404 }));
  });
});

describe('recovery', () => {
  it('finds the issue of a lost create response by its marker instead of creating another', async () => {
    tracker.lostCreates = 1;
    const view = await publisher.publish(approved());
    await settle();
    expect(view).toMatchObject({ status: 'publishing', needsManager: false });
    expect(view.note).toMatch(/looked up by its marker/);
    expect(view.retryAt).not.toBeNull();
    expect(tracker.issues[0].title).toBe(heldTitle('Add a weekly summary')); // still held

    await settle(15_000);
    expect(view.status).toBe('complete');
    expect(tracker.issues).toHaveLength(1);
    expect(tracker.log.filter((x) => x === 'create')).toHaveLength(1);
  });

  it('resumes from the state file after a restart mid-create', async () => {
    tracker.lostCreates = 1; // the office stops before the response: the record says "creating"
    await publisher.publish(approved());
    await settle();
    publisher.stop();
    const saved = JSON.parse(disk.at(-1)!) as Record<string, PublicationView>;
    expect(saved.p1.issues[0]).toMatchObject({ step: 'creating', number: null });

    records = saved;
    publisher = new Publisher(makeHost());
    publisher.resumeAll();
    await settle();
    expect(records.p1.status).toBe('complete');
    expect(records.p1.issues[0]).toMatchObject({ number: 1, step: 'released' });
    expect(tracker.issues).toHaveLength(1);
  });

  it('finishes a release that was interrupted after GitHub applied it', async () => {
    await publisher.publish(approved());
    await settle();
    records.p1.status = 'publishing';
    records.p1.issues[0].step = 'verified';
    tracker.log = [];
    publisher = new Publisher(makeHost());
    publisher.resumeAll();
    await settle();
    expect(records.p1).toMatchObject({ status: 'complete' });
    expect(tracker.log).not.toContain('create');
    expect(tracker.log).not.toContain('edit');
  });

  it('keeps work held and retries when a marker lookup fails', async () => {
    tracker.failedLookups = 1;
    const view = await publisher.publish(approved());
    await settle();
    expect(tracker.log).not.toContain('create');
    expect(view).toMatchObject({ status: 'publishing', needsManager: false });
    await settle(15_000);
    expect(view.status).toBe('complete');
  });

  it('holds everything and asks the manager when access is refused, then resumes once it is back', async () => {
    tracker.permission = 'READ';
    const view = await publisher.publish(approved());
    await settle();
    expect(view).toMatchObject({ status: 'blocked', needsManager: true });
    expect(view.note).toMatch(/permission: READ/);
    expect(tracker.log).not.toContain('create');
    expect(host.notify).toHaveBeenCalledWith('error', expect.stringContaining('held'));

    tracker.permission = 'TRIAGE';
    await settle(15_000);
    expect(view.status).toBe('complete');
    expect(tracker.issues).toHaveLength(1);
  });

  it('stops on duplicate markers rather than guessing', async () => {
    const marker = planMarker('p1', 'e1');
    for (const n of [1, 2]) tracker.issues.push({ repo: REPO, number: n, url: '', title: heldTitle('Add a weekly summary'), body: marker, labels: [PUBLICATION_HOLD], state: 'OPEN' });
    const view = await publisher.publish(approved());
    await settle();
    expect(view).toMatchObject({ status: 'blocked', needsManager: true, retryAt: null });
    expect(view.note).toMatch(/#1 and #2/);
    expect(tracker.log).not.toContain('create');
    expect(tracker.log).not.toContain('edit');
  });

  it('adopts the one open duplicate once the extras are closed', async () => {
    const plan = approved().issues[0];
    const marker = planMarker('p1', 'e1');
    for (const n of [1, 2]) tracker.issues.push({ repo: REPO, number: n, url: `https://github.com/${REPO}/issues/${n}`, title: heldTitle(plan.title), body: publishedBody(plan, marker), labels: [PUBLICATION_HOLD, 'swarm:frontend'], state: 'OPEN' });
    const view = await publisher.publish(approved());
    await settle();
    expect(view.status).toBe('blocked');

    tracker.issues[0].state = 'CLOSED';
    publisher.retry('p1');
    await settle();
    expect(view).toMatchObject({ status: 'complete', needsManager: false });
    expect(view.issues[0]).toMatchObject({ number: 2, step: 'released' });
    expect(tracker.issues).toHaveLength(2);
    expect(tracker.log).not.toContain('create');
    expect(tracker.issues[1]).toMatchObject({ title: plan.title, labels: ['swarm:frontend'] });
    expect(tracker.issues[0].labels).toContain(PUBLICATION_HOLD);
    expect(host.released).toHaveBeenCalledWith(REPO, 2);
  });

  it('does not create a replacement when every marker match is closed', async () => {
    const marker = planMarker('p1', 'e1');
    tracker.issues.push({ repo: REPO, number: 1, url: '', title: heldTitle('Add a weekly summary'), body: marker, labels: [PUBLICATION_HOLD], state: 'CLOSED' });
    const view = await publisher.publish(approved());
    await settle();
    expect(view).toMatchObject({ status: 'blocked', needsManager: true, retryAt: null });
    expect(view.note).toMatch(/#1 .*is closed\. Reopen one/);
    expect(tracker.log).not.toContain('create');
  });

  it('keeps the issue held when the read-back does not match', async () => {
    vi.spyOn(tracker, 'readIssue').mockImplementation(async (repo, number) => ({ repo, number, url: '', title: 'Someone renamed it', body: planMarker('p1', 'e1'), labels: [PUBLICATION_HOLD], state: 'OPEN' }));
    const view = await publisher.publish(approved());
    await settle();
    expect(view).toMatchObject({ status: 'blocked', needsManager: true });
    expect(view.issues[0].step).toBe('created');
    expect(tracker.log).not.toContain('edit');
    expect(tracker.issues[0].labels).toContain(PUBLICATION_HOLD);
  });

  it('blocks a target that is no longer a configured floor or answers as another repo', async () => {
    publisher = new Publisher({ ...host, floors: () => [] });
    const view = await publisher.publish(approved());
    await settle();
    expect(view.note).toMatch(/isn't a configured floor/);
    expect(tracker.log).not.toContain('create');

    records = {};
    publisher = new Publisher(makeHost());
    tracker.answersAs = 'other/app';
    const moved = await publisher.publish(approved());
    await settle();
    expect(moved.note).toMatch(/now answers as other\/app/);
    expect(tracker.log).not.toContain('create');
  });
});

describe('cross-floor plans', () => {
  const OTHER = 'demo-co/api';
  const plan = () => {
    const snapshot = demoCrossFloorProposal(REPO, OTHER);
    snapshot.approval = approved().approval;
    return snapshot;
  };
  beforeEach(() => {
    host.floors = () => [REPO, OTHER];
    tracker.issues.push({ repo: OTHER, number: 1, url: `https://github.com/${OTHER}/issues/1`, title: 'Existing work', body: 'Keep this exact brief.', labels: ['needs-human'], state: 'OPEN' });
  });

  it('stages and wires the whole plan before releasing independent leaves, leaving references untouched', async () => {
    const existing = structuredClone(tracker.issues[0]);
    const edit = tracker.editIssue.bind(tracker);
    vi.spyOn(tracker, 'editIssue').mockImplementation(async (repo, number, change) => {
      if (change.removeLabels) {
        expect(records.p1.issues.every((i) => ['verified', 'held', 'released', 'releasing', 'referenced'].includes(i.step))).toBe(true);
        expect(tracker.issues.filter((i) => i.body.includes('cubefarm:plan-entry'))).toHaveLength(4);
        for (const entry of records.p1.issues.filter((i) => i.step === 'held')) {
          expect(tracker.issues.find((i) => i.repo === entry.repo && i.number === entry.number)?.labels).toContain(PUBLICATION_HOLD);
        }
      }
      await edit(repo, number, change);
    });
    const view = await publisher.publish(plan());
    await settle();
    expect(view.status).toBe('complete');
    expect(view.issues.map((i) => i.step)).toEqual(['held', 'released', 'released', 'referenced', 'held']);
    expect(tracker.issues[0]).toEqual(existing);
    expect(publisher.issueOrigin(OTHER, 1)).toBeNull();
    expect(host.released).toHaveBeenCalledTimes(2);
    const parent = tracker.issues.find((i) => i.number === view.issues[0].number && i.repo === REPO)!;
    const panel = tracker.issues.find((i) => i.number === view.issues[4].number && i.repo === REPO)!;
    expect(parent.body).toContain(view.issues[2].url);
    expect(panel.body).toContain(`Parent: ${view.issues[0].url}`);
    expect(panel.body).toContain(`Depends on ${view.issues[2].url}`);
    expect(panel.body).toContain(`Depends on ${existing.url}`);
    expect(view.issues[4].holdReason).toMatch(/dispatch integration/);
  });

  it('keeps recorded links stable when read-back URL casing differs from the approved target', async () => {
    const read = tracker.readIssue.bind(tracker);
    vi.spyOn(tracker, 'readIssue').mockImplementation(async (repo, number) => {
      const got = await read(repo, number);
      return got && !(repo === OTHER && number === 1) ? { ...got, url: got.url.replace('demo-co', 'Demo-Co') } : got;
    });
    const view = await publisher.publish(plan());
    await settle();
    expect(view.status).toBe('complete');
    expect(view.issues[0].url).toContain('demo-co');
  });

  it('accepts an existing blocker that closes during access recovery without changing it', async () => {
    const create = tracker.createIssue.bind(tracker);
    let refuse = true;
    vi.spyOn(tracker, 'createIssue').mockImplementation(async (repo, ...args) => {
      if (repo === OTHER && refuse) throw new CommandError('refused', 'HTTP 403: Forbidden', 1);
      return create(repo, ...args);
    });
    const view = await publisher.publish(plan());
    await settle();
    tracker.issues[0].state = 'CLOSED';
    const closed = structuredClone(tracker.issues[0]);
    refuse = false;
    await settle(15_000);
    expect(view.status).toBe('complete');
    expect(tracker.issues[0]).toEqual(closed);
    expect(view.issues[4].step).toBe('held');
  });

  it('keeps A held when B refuses writes after preflight, then reuses the staged identities automatically', async () => {
    const create = tracker.createIssue.bind(tracker);
    let refuse = true;
    vi.spyOn(tracker, 'createIssue').mockImplementation(async (repo, ...args) => {
      if (repo === OTHER && refuse) throw new CommandError('refused', 'HTTP 403: Forbidden', 1);
      return create(repo, ...args);
    });
    const snapshot = plan();
    const view = await publisher.publish(snapshot);
    await settle();
    const staged = view.issues.slice(0, 2).map((i) => i.number);
    expect(view).toMatchObject({ status: 'blocked', needsManager: true });
    expect(staged.every((n) => n !== null)).toBe(true);
    expect(host.released).not.toHaveBeenCalled();
    expect(tracker.issues.slice(1).every((i) => i.title.startsWith('[Draft] ') && i.labels.includes(PUBLICATION_HOLD))).toBe(true);
    refuse = false;
    await settle(15_000);
    expect(view.status).toBe('complete');
    expect(view.issues.slice(0, 2).map((i) => i.number)).toEqual(staged);
    expect(tracker.issues).toHaveLength(5);
    expect(await publisher.publish(snapshot)).toBe(view);
  });

  it('preflights recorded holds before writing to another floor on retry', async () => {
    const create = tracker.createIssue.bind(tracker);
    let refuse = true;
    vi.spyOn(tracker, 'createIssue').mockImplementation(async (repo, ...args) => {
      if (repo === OTHER && refuse) throw new CommandError('refused', 'HTTP 403: Forbidden', 1);
      return create(repo, ...args);
    });
    const view = await publisher.publish(plan());
    await settle();
    tracker.issues[1].labels = [];
    refuse = false;
    await settle(15_000);
    expect(view.status).toBe('blocked');
    expect(view.note).toMatch(/hold/);
    expect(tracker.issues).toHaveLength(3); // only A's two staged issues and the existing reference
    expect(host.released).not.toHaveBeenCalled();
  });

  it('resumes a restart in per-issue release without duplicating a create or a completed release', async () => {
    const edit = tracker.editIssue.bind(tracker);
    let releases = 0;
    vi.spyOn(tracker, 'editIssue').mockImplementation(async (repo, number, change) => {
      await edit(repo, number, change);
      if (change.removeLabels && ++releases === 2) throw new Error('lost release response');
    });
    await publisher.publish(plan());
    await settle();
    expect(records.p1.issues.map((i) => i.step)).toEqual(['held', 'released', 'releasing', 'referenced', 'held']);
    publisher.stop();
    records = JSON.parse(disk.at(-1)!);
    publisher = new Publisher(host);
    publisher.resumeAll();
    await settle();
    expect(records.p1.status).toBe('complete');
    expect(records.p1.issues.map((i) => i.step)).toEqual(['held', 'released', 'released', 'referenced', 'held']);
    expect(tracker.issues).toHaveLength(5);
    expect(releases).toBe(2);
  });

  it('replays wiring after a lost write response and never edits an existing reference', async () => {
    const edit = tracker.editIssue.bind(tracker);
    let lose = true;
    vi.spyOn(tracker, 'editIssue').mockImplementation(async (repo, number, change) => {
      expect(`${repo}#${number}`).not.toBe(`${OTHER}#1`);
      await edit(repo, number, change);
      if (change.body && lose) { lose = false; throw new Error('lost wiring response'); }
    });
    const view = await publisher.publish(plan());
    await settle();
    expect(host.released).not.toHaveBeenCalled();
    await settle(15_000);
    expect(view.status).toBe('complete');
    expect(tracker.issues).toHaveLength(5);
  });

  it('waits for dispatch visibility before any release and retries temporary failures', async () => {
    const list = tracker.listIssues.bind(tracker);
    let stale = true;
    vi.spyOn(tracker, 'listIssues').mockImplementation(async (repo) => stale ? [] : list(repo));
    const view = await publisher.publish(plan());
    await settle();
    expect(view).toMatchObject({ status: 'publishing', needsManager: false });
    expect(host.released).not.toHaveBeenCalled();
    stale = false;
    await settle(15_000);
    expect(view.status).toBe('complete');
  });

  it('automatically retries dispatch metadata that has not loaded', async () => {
    const list = tracker.listIssues.bind(tracker);
    let loading = true;
    vi.spyOn(tracker, 'listIssues').mockImplementation(async (repo) => (await list(repo)).map((i) => ({ ...i, nativeBlockers: loading ? null : [] })));
    const view = await publisher.publish(plan());
    await settle();
    expect(view).toMatchObject({ status: 'publishing', needsManager: false });
    expect(host.released).not.toHaveBeenCalled();
    loading = false;
    await settle(15_000);
    expect(view.status).toBe('complete');
  });

  it('rechecks prior verified issues and blocks scope changes before releasing a sibling', async () => {
    const list = vi.spyOn(tracker, 'listIssues').mockRejectedValue(new Error('timeout'));
    const view = await publisher.publish(plan());
    await settle();
    records.p1.issues[1].step = 'verified';
    tracker.issues.find((i) => i.repo === REPO && i.number === view.issues[1].number)!.body += '\nUnapproved scope';
    list.mockRestore();
    await settle(15_000);
    expect(view.status).toBe('blocked');
    expect(host.released).not.toHaveBeenCalled();
  });

  it('refuses missing holds and changed approval targets or dependencies', async () => {
    const create = tracker.createIssue.bind(tracker);
    vi.spyOn(tracker, 'createIssue').mockImplementation(async (...args) => {
      const n = await create(...args);
      tracker.issues.at(-1)!.labels = [];
      return n;
    });
    const snapshot = plan();
    const view = await publisher.publish(snapshot);
    await settle();
    expect(view.status).toBe('blocked');
    expect(view.note).toMatch(/hold/);
    expect(host.released).not.toHaveBeenCalled();
    for (const change of ['target', 'scope', 'dependency']) {
      const changed = structuredClone(snapshot);
      if (change === 'target') changed.issues[1].repo = OTHER;
      if (change === 'scope') changed.issues[1].body += ' More work.';
      if (change === 'dependency') changed.issues[4].blockedBy = ['existing'];
      await expect(publisher.publish(changed)).rejects.toMatchObject({ status: 409 });
    }
  });

  it('preflights every reference and dependency before creating anything', async () => {
    tracker.issues = [];
    const view = await publisher.publish(plan());
    await settle();
    expect(view.status).toBe('blocked');
    expect(tracker.log).not.toContain('create');
    const unknown = plan(); unknown.issues[4].blockedBy = ['absent'];
    const self = plan(); self.issues[1].blockedBy = [self.issues[1].entryId];
    const cycle = plan(); cycle.issues[2].blockedBy = ['panel'];
    const hierarchy = plan(); hierarchy.issues[0].parent = 'parent';
    for (const snapshot of [unknown, self, cycle, hierarchy]) expect(snapshotProblem(snapshot, true)).not.toBeNull();
  });
});

describe('pure decisions', () => {
  const plan = approved().issues[0];
  const entry = { entryId: 'e1', repo: REPO, marker: planMarker('p1', 'e1'), step: 'created' as const, number: 3, url: null };
  const got = (over: Partial<TrackedIssue> = {}): TrackedIssue => ({ repo: REPO, number: 3, url: '', title: heldTitle(plan.title), body: `${plan.body.replace(/\n/g, '\r\n')}\n\n${entry.marker}`, labels: [], state: 'OPEN', ...over });

  it('verifies the expected repo, issue, marker, title and brief', () => {
    expect(verifyProblem(plan, entry, got())).toBeNull();
    expect(verifyProblem(plan, entry, got({ title: plan.title }))).toBeNull();
    expect(verifyProblem(plan, entry, null)).toMatch(/isn't on GitHub/);
    expect(verifyProblem(plan, entry, got({ repo: 'other/app' }))).toMatch(/answered as/);
    expect(verifyProblem(plan, entry, got({ body: plan.body }))).toMatch(/marker/);
    expect(verifyProblem(plan, entry, got({ state: 'CLOSED' }))).toMatch(/closed/);
    expect(verifyProblem(plan, entry, got({ body: entry.marker }))).toMatch(/approved brief/);
  });

  it('tells temporary failures from blocks', () => {
    expect(failure(new Error('timeout'), 1)).toMatchObject({ status: 'publishing', needsManager: false, retryIn: 15_000 });
    expect(failure(new Error('timeout'), 10).retryIn).toBe(600_000);
    expect(failure(new CommandError('x', 'HTTP 403: API rate limit exceeded', 1), 1)).toMatchObject({ status: 'publishing', needsManager: false, retryIn: 15_000 });
    expect(failure(new CommandError('x', 'HTTP 403: Forbidden', 1), 1)).toMatchObject({ status: 'blocked', needsManager: true, retryIn: 15_000 });
    expect(failure(new PublicationBlock('dupes', 'conflict'), 1)).toMatchObject({ status: 'blocked', retryIn: null });
  });
});

describe('the demo office', () => {
  type Internals = { state: { repos: { id: string; fullName: string; floor: number }[] }; writeState(): Promise<void>; syncRepo(id: string): Promise<void>; schedule(): void };
  const office = (backend = createDemoBackend()) => {
    const swarm = new Swarm(backend);
    const s = swarm as unknown as Internals;
    vi.spyOn(s, 'writeState').mockResolvedValue();
    vi.spyOn(s, 'syncRepo').mockResolvedValue();
    vi.spyOn(s, 'schedule').mockImplementation(() => {});
    s.state.repos.push({ id: 'r1', fullName: 'demo-co/pixel-todo', floor: 1 });
    return { swarm, backend, s };
  };

  it('publishes the seeded approved proposal through the fake tracker, recovering a lost create', async () => {
    const { swarm, backend } = office();
    const view = await swarm.publishDemoProposal('lost-create');
    await swarm.publisher.settled(view.proposalId);
    expect(view.status).toBe('publishing');
    await vi.advanceTimersByTimeAsync(15_000);
    await swarm.publisher.settled(view.proposalId);
    expect(view.status).toBe('complete');

    const marker = view.issues[0].marker;
    const published = (await backend.listIssues('demo-co/pixel-todo')).filter((i) => i.body.includes(marker));
    expect(published).toHaveLength(1);
    expect(issueWaitReason(published[0], new Set())).toBeNull(); // ordinary dispatch can take it
    expect(swarm.publisher.list()).toContainEqual(expect.objectContaining({ proposalId: view.proposalId, status: 'complete' }));
    swarm.publisher.stop();
  });

  it('exercises cross-floor staging, held dependencies and automatic recovery through the demo tracker', async () => {
    const { swarm, backend, s } = office();
    s.state.repos.push({ id: 'r2', fullName: 'demo-co/weather-api', floor: 2 });
    const before = await backend.readIssue('demo-co/weather-api', 1);
    const view = await swarm.publishDemoProposal('cross-floor-refused');
    await swarm.publisher.settled(view.proposalId);
    expect(view.status).toBe('blocked');
    const staged = view.issues.slice(0, 2).map((i) => i.number);
    expect(view.issues[2].number).toBeNull();
    expect(staged.every((i) => i !== null)).toBe(true);
    await vi.advanceTimersByTimeAsync(45_000);
    await swarm.publisher.settled(view.proposalId);
    expect(view.status).toBe('complete');
    expect(view.issues.map((i) => i.step)).toEqual(['held', 'released', 'released', 'referenced', 'held']);
    expect(view.issues.slice(0, 2).map((i) => i.number)).toEqual(staged);
    expect(await backend.readIssue('demo-co/weather-api', 1)).toEqual(before);
    for (const entry of view.issues.filter((i) => i.step !== 'referenced')) {
      const visible = (await backend.listIssues(entry.repo)).find((i) => i.number === entry.number)!;
      expect(issueWaitReason(visible, new Set())).toBe(entry.step === 'held' ? 'held for publication' : null);
    }
    swarm.publisher.stop();
  });

  it.each(['__proto__', 'constructor', 'toString'])('answers a retry of %s with 404 and leaves the office and its clients intact', async (key) => {
    const { swarm } = office();
    const broadcast = vi.spyOn(swarm as unknown as { broadcast(ev: unknown): void }, 'broadcast');
    const view = await swarm.publishDemoProposal('');
    await swarm.publisher.settled(view.proposalId);
    broadcast.mockClear();
    expect(() => swarm.retryPublication(key)).toThrow(expect.objectContaining({ status: 404 }));
    expect(broadcast).not.toHaveBeenCalled();
    expect(({} as Record<string, unknown>).proposalId).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'snapshot')).toBe(false);
    expect(swarm.publisher.list().map((p) => p.proposalId)).toEqual([view.proposalId]);
    expect(swarm.publisher.list().every((p) => Array.isArray(p.issues))).toBe(true);
    swarm.publisher.stop();
  });

  it('accepts no fixture approval outside the demo', async () => {
    const { swarm, backend } = office({ ...createDemoBackend(), demo: false });
    const before = (await backend.listIssues('demo-co/pixel-todo')).length;
    await expect(swarm.publishDemoProposal('')).rejects.toMatchObject({ status: 404 });
    await expect(swarm.publishApproved(demoApprovedProposal('demo-co/pixel-todo'))).rejects.toMatchObject({ status: 400 });
    expect(await backend.listIssues('demo-co/pixel-todo')).toHaveLength(before);
    expect(swarm.publisher.list()).toEqual([]);
  });
});
