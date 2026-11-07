import { create } from 'zustand';
import { CEO_ID, type IdeaView, type IssuePlanView, type IdeaReviewCycleView, type IdeaRecordView, type ProposalView, type AgentView, type BoxView, type CeoInfo, type CliView, type ResearchInfo, type HireRequestView, type LogLine, type OfficeUpdateView, type OfficeLifecycleView, type PhoneMessage, type PublicationView, type QaView, type PrContributionView, type RepoView, type ServerEvent, type SwarmSettings, type TelegramView, type UsageView, type WorldSnapshot } from '../../shared/types';
import { appendPhoneMessage } from '../../shared/phone';
import { hasLabel, isPrototypeIssue, prototypeIssueNumber, issueBlockers, issueReadinessReason, issueWorkNote, NEEDS_HUMAN, NEEDS_REVIEW } from '../../shared/issues';
import { chirp, cue } from './ui/sfx';

export type Agent = Omit<AgentView, 'log'>;

/** A publication the Issues tab can draw: the server only sends these, but one bad event shouldn't crash the console. */
export const isPublication = (p: PublicationView | null | undefined): p is PublicationView =>
  !!p && typeof p.proposalId === 'string' && Array.isArray(p.issues) && Array.isArray(p.snapshot?.issues);

export type PhoneTab = 'chat' | 'hires' | 'company' | 'games' | 'settings';

export type Overlay =
  | { kind: 'terminal'; agentId: string }
  | { kind: 'kanban'; repoId: string }
  | { kind: 'app'; repoId: string }
  | { kind: 'elevator' }
  | { kind: 'manager'; tab?: ManagerTab; repoId?: string; ideaId?: string; prd?: string } // prd: a Proposal whose PRD revision to show
  | { kind: 'phone'; tab?: PhoneTab; requestId?: string }
  | { kind: 'help' };

export type ManagerTab = 'floors' | 'ceo' | 'team' | 'fleet' | 'issues' | 'ideas' | 'settings';

export interface Focus {
  id: string;
  label: string;
  action: Overlay | { kind: 'hire'; repoId: string; role: 'dev' | 'qa' } | { kind: 'pickup'; toyId: string } | { kind: 'poke'; toyId: string };
}

/** What the player is carrying. Other items (a blaster, say) join the union with their own kind. */
export type Held =
  | { kind: 'ball'; id: string }
  /** A foam blaster: darts left in the magazine, and performance.now() when a reload started (null when not reloading). */
  | { kind: 'blaster'; id: string; ammo: number; reloadAt: number | null };

export interface Toast {
  id: number;
  level: 'info' | 'success' | 'error';
  text: string;
}

interface State {
  connected: boolean;
  loaded: boolean;
  user: string | null;
  ghReady: boolean;
  ghError?: string;
  demo: boolean;
  workspaceRoot: string;
  settings: SwarmSettings;
  clis: CliView[]; // the coding-agent CLIs installed where the office runs
  boxes: BoxView[]; // other machines agents' desks and CLIs can run on
  officeTelemetry: WorldSnapshot['officeTelemetry'];
  officeCapacity: WorldSnapshot['officeCapacity'];
  repos: RepoView[];
  agents: Record<string, Agent>;
  logs: Record<string, LogLine[]>;
  screens: Record<string, number>; // agentId -> screenshot timestamp (cache buster)
  qaOutcomes: import('../../shared/types').QaOutcomeView[];
  lessons: import('../../shared/types').LessonView[];
  scoreEvents: import('../../shared/types').ScoreEventView[];
  prContributions: PrContributionView[];
  runAttempts: NonNullable<WorldSnapshot['runAttempts']>;
  qa: Record<string, QaView>; // `${repoId}#${prNumber}`
  requests: HireRequestView[];
  ceo: CeoInfo;
  research: ResearchInfo;
  ideas: IdeaView[];
  ideaRecords: IdeaRecordView[];
  issuePlans: IssuePlanView[];
  proposals: ProposalView[];
  ideaReviews: IdeaReviewCycleView[];
  messages: PhoneMessage[];
  phoneReadAt: number;
  telegram?: TelegramView;
  publications: PublicationView[]; // approved proposals' publications, oldest first
  officeCommit?: string | null; // undefined: the server can't update itself
  officeLifecycle: OfficeLifecycleView;
  officeUpdate?: OfficeUpdateView;
  usage: UsageView; // Claude's subscription usage: normal, pacing after a warning, or paused at the limit
  restarting: boolean; // the connection dropped because the office is restarting to update

  floor: number; // 0 = lobby
  travel: { to: number; phase: 'closing' | 'opening' } | null;
  overlay: Overlay | null;
  focus: Focus | null;
  locked: boolean;
  started: boolean;
  toasts: Toast[];
  held: Held | null;
  /** performance.now() when the player started charging a throw; null when they aren't. */
  chargeAt: number | null;

  apply(ev: ServerEvent): void;
  setConnected(v: boolean): void;
  setRestarting(v: boolean): void;
  setOfficeUpdate(u: OfficeUpdateView): void;
  openOverlay(o: Overlay | null): void;
  setFocus(f: Focus | null): void;
  /** Pick something up (or swap), or let go of it with null. Always ends a charge. */
  setHeld(h: Held | null): void;
  setCharge(at: number | null): void;
  setLocked(v: boolean): void;
  start(): void;
  goToFloor(n: number): void;
  finishTravel(phase: 'arrived' | 'done'): void;
  pushToast(level: Toast['level'], text: string): void;
  dismissToast(id: number): void;
}

let toastSeq = 1;

// Where the viewer was standing, so a refresh puts them back on the same floor and spot.
export interface SavedView {
  floor: number;
  x: number;
  z: number;
  yaw: number;
  pitch: number;
}
const VIEW_KEY = 'cubefarm:view';

export function loadView(): SavedView | null {
  try {
    const v = JSON.parse(localStorage.getItem(VIEW_KEY) ?? 'null') as SavedView | null;
    return v && [v.floor, v.x, v.z, v.yaw, v.pitch].every(Number.isFinite) ? v : null;
  } catch {
    return null;
  }
}

export function saveView(v: SavedView) {
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify(v));
  } catch {
    // storage may be unavailable (private mode); the view just won't be remembered
  }
}
const LOG_KEEP = 600;

export const useStore = create<State>((set, get) => ({
  connected: false,
  loaded: false,
  officeTelemetry: null,
  officeCapacity: 'unknown',
  publications: [],
  user: null,
  ghReady: true,
  demo: false,
  workspaceRoot: '',
  // Until the server's snapshot arrives; setupDone stays true so the wizard doesn't flash while loading.
  officeLifecycle: { state: 'open', running: 0 },
  settings: {
    sessionLimit: 0,
    defaultModel: 'claude-opus-5-5',
    defaultEffort: 'medium',
    runtime: 'terminal',
    defaultCli: 'claude',
    hiring: 'approve',
    teamCap: 6,
    ceoHeartbeatMin: 60,
    managerName: '',
    companyName: '',
    projectsDir: '',
    setupDone: true,
    tutorialStep: -1,
    pacingSessions: 3,
  },
  clis: [],
  boxes: [],
  repos: [],
  agents: {},
  logs: {},
  screens: {},
  qa: {},
  qaOutcomes: [],
  lessons: [],
  scoreEvents: [],
  prContributions: [],
  runAttempts: [],
  requests: [],
  ceo: { queue: [], job: null, lastReviewAt: null, nextReviewAt: null },
  research: { queue: [], job: null, done: [] },
  ideas: [],
  ideaRecords: [],
  issuePlans: [],
  proposals: [],
  ideaReviews: [],
  messages: [],
  phoneReadAt: 0,
  usage: { state: 'normal', until: null },
  restarting: false,

  floor: loadView()?.floor ?? 0,
  travel: null,
  overlay: null,
  focus: null,
  locked: false,
  started: false,
  toasts: [],
  held: null,
  chargeAt: null,

  apply(ev) {
    // Cues compare the old state with the new, so each change sounds once; snapshots (page load,
    // reconnect) never do, and nothing sounds before the first snapshot.
    const live = get().loaded;
    switch (ev.type) {
      case 'snapshot': {
        const d: WorldSnapshot = ev.data;
        const agents: Record<string, Agent> = {};
        const logs: Record<string, LogLine[]> = {};
        const screens: Record<string, number> = {};
        for (const { log, ...a } of d.agents) {
          agents[a.id] = a;
          logs[a.id] = log;
          if (a.screenshotAt) screens[a.id] = a.screenshotAt;
        }
        const qa: Record<string, QaView> = {};
        for (const q of d.qa) qa[qaKey(q.repoId, q.prNumber)] = q;
        // Stay on the current (or remembered) floor if it still exists; otherwise go to the lobby.
        const floorExists = d.repos.some((r) => r.floor === get().floor);
        set({
          loaded: true,
          user: d.user,
          ghReady: d.ghReady,
          ghError: d.ghError,
          demo: d.demo,
          workspaceRoot: d.workspaceRoot,
          settings: d.settings,
          repos: d.repos.sort((a, b) => a.floor - b.floor),
          agents,
          logs,
          screens,
          qa,
          qaOutcomes: d.qaOutcomes ?? [],
          lessons: d.lessons ?? [],
          scoreEvents: d.scoreEvents ?? [],
          prContributions: d.prContributions ?? [],
          runAttempts: d.runAttempts ?? [],
          requests: d.requests,
          ceo: d.ceo,
          research: d.research ?? { queue: [], job: null, done: [] },
          ideas: d.ideas ?? [],
          ideaRecords: d.ideaRecords ?? [],
          issuePlans: d.issuePlans ?? [],
          proposals: d.proposals ?? [],
          ideaReviews: d.ideaReviews ?? [],
          messages: d.messages,
          phoneReadAt: d.phoneReadAt,
          telegram: d.telegram,
          publications: (d.publications ?? []).filter(isPublication),
          officeCommit: d.officeCommit,
          officeLifecycle: d.officeLifecycle,
          officeUpdate: d.officeUpdate,
          usage: d.usage,
          clis: d.clis ?? [],
          boxes: d.boxes ?? [],
          officeTelemetry: d.officeTelemetry ?? null,
          officeCapacity: d.officeCapacity ?? 'unknown',
          restarting: false,
          floor: floorExists ? get().floor : 0,
        });
        break;
      }
      case 'repo': {
        const before = get().repos.find((r) => r.id === ev.repo.id);
        const wasOpen = new Set(before?.pulls.filter((p) => p.state === 'OPEN').map((p) => p.number));
        if (live && ev.repo.pulls.some((p) => p.state === 'MERGED' && wasOpen.has(p.number))) cue('merged');
        const repos = get().repos.filter((r) => r.id !== ev.repo.id);
        repos.push(ev.repo);
        set({ repos: repos.sort((a, b) => a.floor - b.floor) });
        break;
      }
      case 'repoRemoved': {
        const repos = get().repos.filter((r) => r.id !== ev.repoId);
        const floor = get().floor > repos.length ? 0 : get().floor;
        set({ repos, floor });
        break;
      }
      case 'agent': {
        const prev = get().agents[ev.agent.id];
        if (live && !prev && ev.agent.role !== 'ceo') cue('welcome');
        if (live && prev && prev.status !== 'error' && ev.agent.status === 'error') cue('error');
        const screens = { ...get().screens };
        if (ev.agent.hasScreenshot && ev.agent.screenshotAt !== null) screens[ev.agent.id] = ev.agent.screenshotAt;
        else delete screens[ev.agent.id];
        set({ agents: { ...get().agents, [ev.agent.id]: ev.agent }, screens });
        break;
      }
      case 'agentRemoved': {
        const { [ev.agentId]: _gone, ...agents } = get().agents;
        const { [ev.agentId]: _shot, ...screens } = get().screens;
        set({ agents, screens });
        break;
      }
      case 'log': {
        const prev = get().logs[ev.agentId] ?? [];
        const next = prev.concat(ev.lines);
        set({ logs: { ...get().logs, [ev.agentId]: next.length > LOG_KEEP ? next.slice(-LOG_KEEP) : next } });
        break;
      }
      case 'screen': {
        const a = get().agents[ev.agentId];
        set({
          screens: { ...get().screens, [ev.agentId]: ev.at },
          agents: a ? { ...get().agents, [ev.agentId]: { ...a, hasScreenshot: true, screenshotAt: ev.at, browserUrl: ev.url ?? a.browserUrl } } : get().agents,
        });
        break;
      }
      case 'qaOutcome': {
        set({ qaOutcomes: [...get().qaOutcomes.filter((o) => o.id !== ev.outcome.id), ev.outcome] });
        break;
      }
      case 'lesson': {
        const lessons = get().lessons;
        const index = lessons.findIndex((l) => l.id === ev.lesson.id);
        set({ lessons: index < 0 ? [...lessons, ev.lesson] : lessons.map((l, i) => i === index ? ev.lesson : l) });
        break;
      }
      case 'scoreEvents': {
        const known = new Set(get().scoreEvents.map((e) => e.id));
        set({ scoreEvents: [...get().scoreEvents, ...ev.events.filter((e) => !known.has(e.id))] });
        break;
      }
      case 'prContribution': {
        const h = ev.contribution;
        set({ prContributions: [...get().prContributions.filter((p) => p.repoId !== h.repoId || p.prNumber !== h.prNumber), h] });
        break;
      }
      case 'runAttempt': {
        const attempts = get().runAttempts;
        const index = attempts.findIndex((x) => x.id === ev.attempt.id);
        set({ runAttempts: index < 0 ? [...attempts, ev.attempt] : attempts.map((x, i) => i === index ? ev.attempt : x) });
        break;
      }
      case 'runAttemptsRemoved': {
        const ids = new Set(ev.ids);
        set({ runAttempts: get().runAttempts.filter((x) => !ids.has(x.id)) });
        break;
      }
      case 'qa': {
        const prev = get().qa[qaKey(ev.qa.repoId, ev.qa.prNumber)]?.status;
        const failed = (st?: QaView['status']) => st === 'failed' || st === 'needs-human';
        if (live && ev.qa.status === 'passed' && prev !== 'passed') cue('ready');
        if (live && failed(ev.qa.status) && !failed(prev)) cue('qaFailed');
        set({ qa: { ...get().qa, [qaKey(ev.qa.repoId, ev.qa.prNumber)]: ev.qa } });
        break;
      }
      case 'qaRemoved': {
        const { [qaKey(ev.repoId, ev.prNumber)]: _gone, ...qa } = get().qa;
        set({ qa });
        break;
      }
      case 'settings':
        set({ settings: ev.settings });
        break;
      case 'clis':
        set({ clis: ev.clis });
        break;
      case 'box': {
        const boxes = get().boxes;
        set({ boxes: boxes.some((b) => b.id === ev.box.id) ? boxes.map((b) => (b.id === ev.box.id ? ev.box : b)) : [...boxes, ev.box] });
        break;
      }
      case 'boxRemoved':
        set({ boxes: get().boxes.filter((b) => b.id !== ev.boxId) });
        break;
      case 'officeTelemetry':
        set({ officeTelemetry: ev.telemetry, officeCapacity: ev.capacity });
        break;
      case 'request': {
        const prev = get().requests.find((r) => r.id === ev.request.id);
        if (live && ev.request.kind === 'hire' && ev.request.status === 'approved' && prev?.status === 'pending') cue('welcome');
        const requests = get().requests.filter((r) => r.id !== ev.request.id);
        requests.push(ev.request);
        set({ requests: requests.sort((a, b) => a.createdAt - b.createdAt) });
        break;
      }
      case 'ceo':
        set({ ceo: ev.ceo });
        break;
      case 'idea':
        set({ ideas: [...get().ideas.filter((i) => i.id !== ev.idea.id), ev.idea] });
        break;
      case 'ideaRecord':
        set({ ideaRecords: [...get().ideaRecords.filter((r) => r.ideaId !== ev.record.ideaId || r.kind !== ev.record.kind || r.id !== ev.record.id), ev.record] });
        break;
      case 'issuePlan':
        set({ issuePlans: [...get().issuePlans.filter((p) => p.id !== ev.plan.id), ev.plan] });
        break;
      case 'proposal':
        set({ proposals: [...get().proposals.filter((p) => p.id !== ev.proposal.id), ev.proposal] });
        break;
      case 'ideaReview':
        set({ ideaReviews: [...get().ideaReviews.filter((r) => r.ideaId !== ev.review.ideaId), ev.review] });
        break;
      case 'research':
        set({ research: ev.research });
        break;
      case 'message': {
        const repeated = get().messages.some((m) => m.id === ev.message.id);
        set({ messages: appendPhoneMessage(get().messages, ev.message) });
        if (repeated) break;
        const o = get().overlay;
        const reading = o?.kind === 'phone' && (o.tab ?? 'chat') === 'chat';
        if (ev.message.from === 'ceo' && !reading) {
          chirp();
          const ceo = get().agents[CEO_ID]?.name ?? 'CEO';
          const text = ev.message.text.replace(/\s+/g, ' ');
          get().pushToast('info', `📱 ${ceo}: ${text.length > 110 ? `${text.slice(0, 109)}…` : text}`);
        }
        break;
      }
      case 'phoneRead':
        set({ phoneReadAt: Math.max(get().phoneReadAt, ev.at) });
        break;
      case 'telegram':
        set({ telegram: ev.telegram });
        break;
      case 'publication': {
        if (!isPublication(ev.publication)) break; // a malformed record must never blank the manager's console
        const publications = get().publications;
        const known = publications.some((p) => p.proposalId === ev.publication.proposalId);
        set({ publications: known ? publications.map((p) => (p.proposalId === ev.publication.proposalId ? ev.publication : p)) : [...publications, ev.publication] });
        break;
      }
      case 'toast':
        get().pushToast(ev.level, ev.text);
        break;
      case 'officeLifecycle':
        set({ officeLifecycle: ev.officeLifecycle });
        break;
      case 'officeUpdate':
        set({ officeUpdate: ev.officeUpdate });
        break;
      case 'usage':
        set({ usage: ev.usage });
        break;
    }
  },

  setConnected: (connected) => set({ connected }),
  setRestarting: (restarting) => set({ restarting }),
  setOfficeUpdate: (officeUpdate) => set({ officeUpdate }),
  openOverlay(overlay) {
    // Opening any panel drops whatever you're carrying, so nothing is left floating behind it.
    set(overlay ? { overlay, focus: null, held: null, chargeAt: null } : { overlay });
    if (overlay && document.pointerLockElement) document.exitPointerLock();
  },
  setFocus: (focus) => {
    const cur = get().focus;
    if (cur?.id === focus?.id && cur?.label === focus?.label) return;
    set({ focus });
  },
  setHeld: (held) => set({ held, chargeAt: null }),
  setCharge: (chargeAt) => set({ chargeAt }),
  setLocked: (locked) => set({ locked }),
  start: () => set({ started: true }),
  goToFloor(n) {
    if (n === get().floor || get().travel) {
      set({ overlay: null });
      return;
    }
    set({ overlay: null, held: null, chargeAt: null, travel: { to: n, phase: 'closing' } });
  },
  finishTravel(phase) {
    const t = get().travel;
    if (!t) return;
    if (phase === 'arrived') set({ floor: t.to, travel: { ...t, phase: 'opening' } });
    else set({ travel: null });
  },
  pushToast(level, text) {
    const id = toastSeq++;
    set({ toasts: [...get().toasts.slice(-4), { id, level, text }] });
    setTimeout(() => get().dismissToast(id), level === 'error' ? 9000 : 5000);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

// ---------- derived helpers ----------

export const qaKey = (repoId: string, prNumber: number) => `${repoId}#${prNumber}`;

export const repoOnFloor = (repos: RepoView[], floor: number) => repos.find((r) => r.floor === floor) ?? null;

export const agentsOnRepo = (agents: Record<string, Agent>, repoId: string) =>
  Object.values(agents)
    .filter((a) => a.repoId === repoId)
    .sort((a, b) => (a.role === b.role ? a.desk - b.desk : a.role === 'dev' ? -1 : 1));

/**
 * Panels that hide the whole office (the wide ones: Kanban, terminals and the manager's console), so the
 * 3D view can stop drawing behind them. The phone, help, elevator panel and confirm dialogs are see-through.
 */
export const coversView = (o: Overlay | null) => o?.kind === 'kanban' || o?.kind === 'terminal' || o?.kind === 'manager';

export const isBusy = (a: Agent) => a.status === 'preparing' || a.status === 'working';

/** CEO messages the manager hasn't seen yet (proposals are counted by pendingRequests instead). */
export const unreadMessages = (messages: PhoneMessage[], readAt: number) => messages.filter((m) => m.from === 'ceo' && !m.requestId && m.at > readAt).length;

export const pendingRequests = (requests: HireRequestView[]) => requests.filter((r) => r.status === 'pending');

/** The red dot on the phone: decisions waiting on the manager plus unread messages. */
export function usePhoneBadge() {
  const requests = useStore((s) => s.requests);
  const messages = useStore((s) => s.messages);
  const readAt = useStore((s) => s.phoneReadAt);
  return pendingRequests(requests).length + unreadMessages(messages, readAt);
}

export interface KanbanCard {
  key: string;
  number: number;
  title: string;
  url?: string;
  agent?: Agent;
  note?: string;
  tone?: 'warn' | 'bad' | 'good';
  prNumber?: number;
  qa?: QaView;
  needsHumanLabel?: boolean;
  prototype?: { issueNumber: number; head: string };
}

export interface KanbanColumns {
  backlog: KanbanCard[];
  todo: KanbanCard[];
  progress: KanbanCard[];
  qa: KanbanCard[];
  review: KanbanCard[];
  ready: KanbanCard[];
  merged: KanbanCard[];
  blocked: KanbanCard[];
}

/** Sort a floor's GitHub state and QA pipeline into the office Kanban columns. */
export function kanbanFor(repo: RepoView, agents: Agent[], qaRecords: Record<string, QaView>): KanbanColumns {
  const openPulls = repo.pulls.filter((p) => p.state === 'OPEN');
  const byId = new Map(agents.map((a) => [a.id, a]));
  const devs = agents.filter((a) => a.role === 'dev' || a.role === 'researcher');
  const authorOf = (n: number, head: string) => devs.find((a) => a.prNumber === n) ?? devs.find((a) => a.branch && a.branch === head);

  const progress: KanbanCard[] = [];
  const blocked: KanbanCard[] = [];
  const issuesByNumber = new Map(repo.issues.map((issue) => [issue.number, issue]));
  for (const a of devs) {
    if (a.issueNumber == null || a.task !== 'issue' || a.status === 'idle') continue;
    if (a.prNumber != null && openPulls.some((p) => p.number === a.prNumber) && !(a.branch && prototypeIssueNumber(a.branch) && isBusy(a))) continue;
    if (hasLabel(issuesByNumber.get(a.issueNumber)?.labels, NEEDS_HUMAN)) continue;
    const note =
      a.status === 'preparing' ? 'setting up' : a.status === 'working' ? 'working' : a.status === 'error' ? 'needs help' : a.status === 'stopped' ? 'stopped' : 'finished · no PR';
    progress.push({
      key: `a-${a.id}`,
      number: a.issueNumber,
      title: a.issueTitle ?? '',
      agent: a,
      note,
      tone: a.status === 'error' ? 'bad' : a.status === 'stopped' || a.status === 'done' ? 'warn' : undefined,
    });
  }

  const qa: KanbanCard[] = [];
  const review: KanbanCard[] = [];
  const ready: KanbanCard[] = [];
  const prototyped = new Set<number>();
  for (const p of openPulls) {
    const rec = qaRecords[qaKey(repo.id, p.number)];
    const dev = (rec?.devAgentId ? byId.get(rec.devAgentId) : undefined) ?? authorOf(p.number, p.headRefName);
    const tester = rec?.qaAgentId ? byId.get(rec.qaAgentId) : undefined;
    const base = { key: `pr-${p.number}`, number: p.number, prNumber: p.number, title: p.title, url: p.url, qa: rec };
    const prototype = prototypeIssueNumber(p.headRefName);
    if (prototype) {
      const issue = issuesByNumber.get(prototype);
      if (issue && isPrototypeIssue(issue.labels)) {
        prototyped.add(prototype);
        if (!progress.some((card) => card.number === prototype && card.agent && isBusy(card.agent))) {
          blocked.push({ ...base, qa: undefined, agent: dev, note: p.isDraft ? 'Awaiting prototype approval' : 'Reopen as a draft to review', tone: 'warn',
            ...(p.isDraft && { prototype: { issueNumber: prototype, head: p.headSha } }) });
        }
      }
      continue;
    }
    const humanLabel = hasLabel(p.labels, NEEDS_HUMAN);
    if (humanLabel || rec?.status === 'needs-human') {
      blocked.push({
        ...base,
        agent: rec?.status === 'testing' ? tester : dev,
        note: `⚠️ needs you${rec?.mergeNote ? ` · ${rec.mergeNote}` : ''}`,
        tone: 'bad',
        needsHumanLabel: humanLabel,
      });
      continue;
    }
    if (rec?.status === 'passed') {
      if (hasLabel(p.labels, NEEDS_REVIEW)) {
        review.push({ ...base, agent: dev, note: 'QA ✓ · waiting for review', tone: 'warn' });
        continue;
      }
      ready.push({
        ...base,
        agent: dev,
        note: p.checks === 'unavailable'
          ? 'QA ✓ · checks unavailable · merge blocked'
          : rec.mergeNote
          ? `QA ✓ · ${rec.mergeNote}`
          : p.mergeable === 'CONFLICTING'
            ? 'QA ✓ · conflicts'
            : p.checks === 'failing'
              ? 'QA ✓ · CI failing'
              : repo.autoMerge && p.checks === 'pending'
                ? 'QA ✓ · waiting for checks'
                : '✅ QA passed',
        tone: p.mergeable === 'CONFLICTING' || p.checks === 'failing' || p.checks === 'unavailable' ? 'warn' : 'good',
      });
      continue;
    }
    const status = rec?.status;
    qa.push({
      ...base,
      agent: status === 'testing' ? tester : dev,
      note:
        status === 'queued'
          ? `waiting for QA${rec && rec.round > 1 ? ` · round ${rec.round}` : ''}${rec?.mergeNote ? ` · ${rec.mergeNote}` : ''}`
          : status === 'testing'
            ? `🔍 testing · round ${rec!.round}`
            : status === 'failed'
              ? '❌ failed · back to dev'
              : status === 'fixing'
                ? `🔧 fixing · round ${rec!.round}`
                : p.isDraft
                  ? 'draft'
                  : 'not tested yet',
      tone: status === 'failed' ? 'bad' : status === 'fixing' || !status ? 'warn' : undefined,
    });
  }

  const claimed = new Set<number>([...progress.map((c) => c.number), ...prototyped, ...openPulls.filter((p) => !prototypeIssueNumber(p.headRefName)).flatMap((p) => p.closesIssues)]);
  const open = new Set(repo.issues.map((i) => i.number));
  const backlog: KanbanCard[] = [];
  const todo: KanbanCard[] = [];
  for (const i of repo.issues) {
    if (claimed.has(i.number)) continue;
    const waits = issueBlockers(i, open);
    const labels = i.labels.map((l) => l.replace(/^swarm:/i, '🎯 ')).slice(0, 2).join(', ');
    const card = { key: `i-${i.number}`, number: i.number, title: i.title, url: i.url, note: issueWorkNote(i) || (waits.length ? `⏳ after ${waits.map((n) => typeof n === 'number' ? `#${n}` : n).join(', ')}` : labels || undefined) };
    if (hasLabel(i.labels, NEEDS_HUMAN)) blocked.push({ ...card, note: '⚠️ needs you', tone: 'bad', needsHumanLabel: true });
    else if (issueReadinessReason(i)) backlog.push(card);
    else todo.push(card);
  }

  const merged: KanbanCard[] = repo.pulls
    .filter((p) => p.state === 'MERGED')
    .sort((a, b) => (b.mergedAt ?? '').localeCompare(a.mergedAt ?? ''))
    .map((p) => ({ key: `m-${p.number}`, number: p.number, prNumber: p.number, title: p.title, url: p.url, agent: authorOf(p.number, p.headRefName) }));

  return { backlog, todo, progress, qa, review, ready, merged, blocked };
}
