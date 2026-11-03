// The browser dashboard shares the office's live data, terminals and management panels.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CEO_ID, RESEARCHER_ID, type AgentRole } from '../../../shared/types';
import { agentsOnRepo, isBusy, pendingRequests, repoOnFloor, unreadMessages, usePhoneBadge, useStore, type Agent } from '../store';
import { isConfirmOpen } from './Confirm';
import { KanbanView } from './KanbanView';
import { LiveTerminal } from './LiveTerminal';
import { SettingsTab } from './ManagerConsole';
import { Overlays } from './Overlays';
import { StatusPill } from './TerminalView';
import './dashboard.css';

const ROLES: Record<AgentRole, string> = {
  ceo: 'CEO',
  researcher: 'Researcher',
  dev: 'Developer',
  qa: 'QA tester',
};

function AgentLog({ agentId, expanded }: { agentId: string; expanded: boolean }) {
  const log = useStore((s) => s.logs[agentId]);
  const scroller = useRef<HTMLDivElement>(null);
  const following = useRef(true);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && following.current) el.scrollTop = el.scrollHeight;
  }, [log, expanded]);

  return (
    <div
      className="term dashboard-log"
      ref={scroller}
      tabIndex={0}
      aria-label="Agent output"
      onScroll={({ currentTarget: el }) => {
        following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      {log?.length ? log.map((line) => (
        <div className={`term-line term-${line.kind}`} key={line.id}>{line.text}</div>
      )) : <div className="term-line term-system">No terminal output yet.</div>}
    </div>
  );
}

function AgentTile({ agent, expanded, toggle }: { agent: Agent; expanded: boolean; toggle: () => void }) {
  const openOverlay = useStore((s) => s.openOverlay);
  const overlay = useStore((s) => s.overlay);
  const inDetails = overlay?.kind === 'terminal' && overlay.agentId === agent.id;
  return (
    <section className="dashboard-agent" aria-label={`${agent.name} terminal`}>
      <header className="dashboard-agent-head">
        <span className="dashboard-agent-dot" style={{ background: agent.color }} />
        <div className="dashboard-agent-name">
          <h2>{agent.name}</h2>
          <span>{ROLES[agent.role]}</span>
        </div>
        <StatusPill status={agent.status} />
        <button className="dashboard-action" onClick={() => openOverlay({ kind: 'terminal', agentId: agent.id })} aria-label={`Open ${agent.name} details`}>
          Details
        </button>
        <button className="dashboard-action" onClick={toggle} aria-expanded={expanded} aria-label={expanded ? 'Back to terminal grid' : `Expand ${agent.name} terminal`}>
          {expanded ? 'Back to grid' : 'Expand'}
        </button>
      </header>
      {agent.terminal && !inDetails
        ? <LiveTerminal agentId={agent.id} idleHint="Not running · open Details to send a message" />
        : <AgentLog agentId={agent.id} expanded={expanded} />}
    </section>
  );
}

function DashboardPhoneButton() {
  const badge = usePhoneBadge();
  const openOverlay = useStore((s) => s.openOverlay);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.code !== 'KeyP' || event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target.matches('input, textarea, select'))) return;
      const state = useStore.getState();
      if (state.overlay || isConfirmOpen()) return;
      event.preventDefault();
      const pending = pendingRequests(state.requests).length;
      const unread = unreadMessages(state.messages, state.phoneReadAt);
      openOverlay({ kind: 'phone', tab: pending && !unread ? 'hires' : 'chat' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openOverlay]);

  return (
    <button className="dashboard-action dashboard-phone" onClick={() => openOverlay({ kind: 'phone' })} title="Your phone (P)">
      Phone {badge > 0 && <span className="dashboard-phone-badge" aria-label={`${badge} waiting`}>{badge}</span>}
    </button>
  );
}

function FloorButton({ floor, name, color, active, selected, onSelect }: {
  floor: number;
  name: string;
  color?: string;
  active: number;
  selected: boolean;
  onSelect: (floor: number) => void;
}) {
  const activity = `${active} active agent${active === 1 ? '' : 's'}`;
  return (
    <button className="dashboard-floor" aria-current={selected || undefined} aria-label={`${floor} ${name}, ${activity}`} title={`${name} · ${activity}`} onClick={() => onSelect(floor)}>
      <span className="dashboard-floor-number" style={{ borderColor: color }}>{floor}</span>
      <span className="dashboard-floor-summary">
        <span className="dashboard-floor-name">{name}</span>
        <span className="dashboard-floor-active">{active}</span>
      </span>
    </button>
  );
}

export function Dashboard({ onOffice }: { onOffice: () => void }) {
  const [floor, setFloor] = useState(0);
  const [view, setView] = useState<'agents' | 'kanban' | 'settings'>('agents');
  const [expanded, setExpanded] = useState<string | null>(null);
  const repos = useStore((s) => s.repos);
  const agents = useStore((s) => s.agents);
  const company = useStore((s) => s.settings.companyName);
  const connected = useStore((s) => s.connected);
  const demo = useStore((s) => s.demo);
  const repo = repoOnFloor(repos, floor);
  const lobby = [agents[CEO_ID], agents[RESEARCHER_ID]].filter((agent): agent is Agent => !!agent);
  const activeByRepo = new Map<string, number>();
  for (const agent of Object.values(agents)) {
    if (isBusy(agent)) activeByRepo.set(agent.repoId, (activeByRepo.get(agent.repoId) ?? 0) + 1);
  }
  const team = repo ? agentsOnRepo(agents, repo.id) : lobby;
  const focused = team.find((agent) => agent.id === expanded);
  const pane = view === 'kanban' && !repo ? 'agents' : view;

  const selectFloor = (next: number) => {
    setFloor(next);
    setExpanded(null);
    if (view === 'settings' || next === 0) setView('agents');
  };

  const visitFloor = (next: number) => {
    selectFloor(next);
    setView('agents');
    useStore.getState().openOverlay(null);
  };

  return (
    <div className="dashboard">
      <aside className="dashboard-sidebar">
        <div className="dashboard-brand">
          <span aria-hidden="true">✻</span>
          <strong>{company || 'CubeFarm'}</strong>
        </div>
        <nav className="dashboard-floors" aria-label="Floors">
          <p className="dashboard-label">Floors</p>
          <FloorButton floor={0} name="Lobby" active={lobby.filter(isBusy).length} selected={!repo} onSelect={selectFloor} />
          {[...repos].sort((a, b) => a.floor - b.floor).map((item) => (
            <FloorButton key={item.id} floor={item.floor} name={item.fullName} color={item.color} active={activeByRepo.get(item.id) ?? 0} selected={item.id === repo?.id} onSelect={selectFloor} />
          ))}
        </nav>
        <div className="dashboard-connection" role="status">
          <span className={`dashboard-connection-dot${connected ? ' is-live' : ''}`} />
          {connected ? (demo ? 'Demo office' : 'Connected') : 'Reconnecting'}
        </div>
      </aside>

      <main className="dashboard-main">
        <header className="dashboard-toolbar">
          <div className="dashboard-heading">
            <p className="dashboard-label">{pane === 'settings' ? 'Dashboard' : `Floor ${repo?.floor ?? 0}`}</p>
            <h1>{pane === 'settings' ? 'Settings' : (repo?.fullName ?? 'Lobby')}</h1>
          </div>
          <nav className="dashboard-nav" aria-label="Dashboard views">
            <button className="dashboard-action" aria-pressed={pane === 'agents'} onClick={() => setView('agents')}>Agents</button>
            {repo && <button className="dashboard-action" aria-pressed={pane === 'kanban'} onClick={() => setView('kanban')}>Kanban</button>}
            <button className="dashboard-action" aria-pressed={pane === 'settings'} onClick={() => setView('settings')}>Settings</button>
            <DashboardPhoneButton />
            <button className="dashboard-action dashboard-office" onClick={onOffice}>3D Office</button>
          </nav>
        </header>

        {pane === 'settings' ? (
          <div className="dashboard-settings"><SettingsTab /></div>
        ) : pane === 'kanban' && repo ? (
          <KanbanView key={repo.id} repoId={repo.id} inline />
        ) : team.length ? (
          <div className={`dashboard-terminals${focused ? ' dashboard-expanded' : ''}`}>
            {(focused ? [focused] : team).map((agent) => (
              <AgentTile key={agent.id} agent={agent} expanded={focused?.id === agent.id} toggle={() => setExpanded(focused ? null : agent.id)} />
            ))}
          </div>
        ) : (
          <p className="dashboard-empty">No agents on this floor yet.</p>
        )}
      </main>
      <Overlays onFloor={visitFloor} />
    </div>
  );
}
