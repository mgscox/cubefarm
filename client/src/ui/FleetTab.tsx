import { useState } from 'react';
import { api } from '../api';
import { agentBox, boxName, boxNotes, busy, floorMove, floorMoveText, missingClis, movable } from '../fleet';
import { agentsOnRepo, useStore, type Agent } from '../store';
import type { BoxView, CliView, RepoView } from '../../../shared/types';
import { confirmDialog } from './Confirm';

// The manager console's Fleet tab: the machines agents work on (this one and the boxes reached over ssh), adding and
// removing boxes, and putting a whole floor on one. A change applies when each agent's next task starts.

async function attempt<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch {
    return undefined; // api() already toasted the error
  }
}

const STATUS_CLASS: Record<BoxView['status'], string> = { online: 'status-running', connecting: 'status-starting', offline: 'status-stopped' };

function Clis({ clis }: { clis: CliView[] }) {
  const installed = clis.filter((c) => c.installed);
  if (!installed.length) return <span className="muted small">no coding-agent CLIs found</span>;
  return (
    <span className="row wrap fleet-clis">
      {installed.map((c) => (
        <span key={c.id} className="chip" title={c.version ?? undefined}>
          {c.label}
        </span>
      ))}
    </span>
  );
}

/** Who works on a machine: agents whose next task starts there (all on the office's in the SDK runtime), and who is finishing one there. */
function Workers({ id, agents, repos }: { id: string; agents: Agent[]; repos: RepoView[] }) {
  const terminal = useStore((s) => s.settings.runtime === 'terminal');
  const next = (a: Agent) => (terminal ? agentBox(a, repos.find((r) => r.id === a.repoId)) : '');
  const here = agents.filter((a) => movable(a) && next(a) === id);
  const elsewhere = agents.filter((a) => movable(a) && a.deskBox === id && next(a) !== id && busy(a));
  if (!here.length && !elsewhere.length) return <div className="muted small">Nobody is assigned here.</div>;
  return (
    <div className="small">
      {here.length > 0 && <>👥 {here.map((a) => a.name).join(', ')}</>}
      {elsewhere.length > 0 && <div className="muted">Finishing here before they move: {elsewhere.map((a) => a.name).join(', ')}</div>}
    </div>
  );
}

function OfficeMachine({ agents, repos }: { agents: Agent[]; repos: RepoView[] }) {
  const clis = useStore((s) => s.clis);
  return (
    <div className="card fleet-card">
      <div className="row">
        <span className="floor-badge office-badge" aria-hidden>
          🏢
        </span>
        <div className="grow">
          <b>This machine</b> <span className="muted small">the office itself</span>
          <div>
            <Clis clis={clis} />
          </div>
        </div>
        <span className="status status-running">online</span>
      </div>
      <Workers id="" agents={agents} repos={repos} />
    </div>
  );
}

function BoxCard({ box, agents, repos }: { box: BoxView; agents: Agent[]; repos: RepoView[] }) {
  const { info, missing, hooks } = boxNotes(box);
  const [checking, setChecking] = useState(false);
  const check = () => {
    setChecking(true);
    void attempt(() => api.checkBox(box.id)).finally(() => setChecking(false));
  };
  const remove = () =>
    void confirmDialog({
      tone: 'danger',
      icon: '🖥',
      title: `Remove ${box.name}?`,
      body: `Nothing new starts there, and its agents go back to their floor's machine for their next task.${box.running ? ` The ${box.running} CLI${box.running === 1 ? '' : 's'} running there now finish${box.running === 1 ? 'es' : ''} first.` : ''} Nothing on the box is deleted.`,
      confirm: 'Remove',
    }).then((ok) => ok && attempt(() => api.removeBox(box.id)));
  return (
    <div className="card fleet-card" data-box={box.id}>
      <div className="row">
        <span className="floor-badge" aria-hidden>
          🖥
        </span>
        <div className="grow">
          <b>{box.name}</b> <code className="small">{box.destination}</code>
          {info && <div className="muted small">{info}</div>}
          {box.status === 'online' && (
            <div>
              <Clis clis={box.clis} />
            </div>
          )}
        </div>
        <span className={`status ${STATUS_CLASS[box.status]}`}>{box.status}</span>
      </div>
      {box.error && <div className="term-error small">{box.error}</div>}
      {box.sync && <div className={`small ${box.sync.failed ? 'term-error' : 'muted'}`}>⬆ {box.sync.text}</div>}
      {missing.length > 0 && <div className="small fleet-missing">⚠ Set up on the box: {missing.join(', ')}</div>}
      {hooks && <div className="small fleet-missing">⚠ {hooks}</div>}
      <Workers id={box.id} agents={agents} repos={repos} />
      <div className="row">
        <span className="muted small grow">{box.running ? `${box.running} CLI${box.running === 1 ? '' : 's'} running there` : 'Nothing running there'}</span>
        <button
          className="btn btn-small btn-ghost"
          disabled={checking || box.status === 'connecting'}
          title={box.status === 'online' ? 'Ask the box again what it has set up, after you changed something there' : 'Connect to it now instead of waiting for the next try'}
          onClick={check}
        >
          {checking ? 'Checking…' : 'Check again'}
        </button>
        <button className="btn btn-small btn-ghost" onClick={remove}>
          Remove
        </button>
      </div>
    </div>
  );
}

/** A floor's machine, and the one-click move of everyone on it. */
function FloorMachine({ repo, boxes, agents }: { repo: RepoView; boxes: BoxView[]; agents: Record<string, Agent> }) {
  const [to, setTo] = useState(repo.box);
  const terminal = useStore((s) => s.settings.runtime === 'terminal');
  const defaultCli = useStore((s) => s.settings.defaultCli);
  const clis = useStore((s) => s.clis);
  const team = agentsOnRepo(agents, repo.id).filter(movable);
  const target = boxes.some((b) => b.id === to) ? to : '';
  const text = floorMoveText(floorMove(repo, team, target), boxName(boxes, target));
  // Their next task there wouldn't start: the box hasn't got their coding agent.
  const lacking = missingClis(team, boxes.find((b) => b.id === target), defaultCli);
  const cliLabel = (a: Agent) => clis.find((c) => c.id === (a.cli || defaultCli))?.label ?? (a.cli || defaultCli);
  const blocked = !terminal ? 'Boxes need the terminal runtime' : lacking.length ? `${boxName(boxes, target)} hasn't got ${lacking.map((a) => `${cliLabel(a)} for ${a.name}`).join(', ')}` : null;
  const own = team.filter((a) => a.box !== null);
  const move = () =>
    void confirmDialog({ icon: '🖥', title: `Move floor ${repo.floor} to ${boxName(boxes, target)}?`, body: text ?? '', confirm: 'Move the floor' }).then(
      (ok) => ok && attempt(() => api.updateRepo(repo.id, { box: target, everyone: true })),
    );
  return (
    <div className="card floor-card" style={{ ['--accent' as string]: repo.color }}>
      <div className="row wrap">
        <span className="floor-badge">{repo.floor}</span>
        <div className="grow">
          <b>{repo.fullName}</b>
          <div className="muted small">
            Works on {boxName(boxes, terminal ? repo.box : '')} · {team.length} developer{team.length === 1 ? '' : 's'} and QA
          </div>
        </div>
        <select
          value={terminal ? target : ''}
          title="The machine for the whole floor"
          aria-label={`Machine for floor ${repo.floor}`}
          style={{ width: 'auto', minWidth: 150 }}
          disabled={!terminal}
          onChange={(e) => setTo(e.target.value)}
        >
          <option value="">This machine</option>
          {boxes.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
              {b.status === 'online' ? '' : ` (${b.status})`}
            </option>
          ))}
        </select>
        <button className="btn btn-small btn-good" disabled={!text || !!blocked} title={blocked ?? text ?? 'Everyone here already works there'} onClick={move}>
          Move the whole floor
        </button>
      </div>
      {terminal && lacking.length > 0 && (
        <div className="small fleet-missing">
          ⚠ {blocked}: install it there, or change their coding agent on the Team tab first.
        </div>
      )}
      {terminal && own.length > 0 && (
        <div className="muted small">
          Own box: {own.map((a) => `${a.name} on ${boxName(boxes, a.box ?? '')}`).join(', ')}
        </div>
      )}
    </div>
  );
}

function AddBox() {
  const [name, setName] = useState('');
  const [destination, setDestination] = useState('');
  const [adding, setAdding] = useState(false);
  const add = () => {
    setAdding(true);
    void attempt(() => api.addBox(name.trim(), destination.trim()))
      .then((b) => {
        if (!b) return;
        setName('');
        setDestination('');
      })
      .finally(() => setAdding(false));
  };
  return (
    <div className="card">
      <h3>➕ Add a box</h3>
      <form
        className="fleet-add"
        onSubmit={(e) => {
          e.preventDefault();
          if (destination.trim()) add();
        }}
      >
        <label className="small">
          How ssh reaches it
          <input value={destination} onChange={(e) => setDestination(e.target.value)} placeholder="me@studio.local, an ~/.ssh/config alias, or a Tailscale name" />
        </label>
        <label className="small">
          Name (optional)
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Studio Mac" maxLength={40} />
        </label>
        <button className="btn btn-good" type="submit" disabled={adding || !destination.trim()}>
          Add box
        </button>
      </form>
      <div className="muted small fleet-help">
        <p>
          The office connects with <code>ssh</code> in batch mode, so this machine must reach the box without a password prompt: an SSH key, or Tailscale SSH. Over
          the LAN or your tailnet, nothing on the box listens on a new port.
        </p>
        <p>Once on the box:</p>
        <ul>
          <li>Node 24 and git</li>
          <li>
            <code>gh auth login</code> (agents push their branches from there)
          </li>
          <li>each coding agent installed and signed in (you can sign in from an agent's terminal here)</li>
        </ul>
        <p>Adding, removing or reassigning never touches a running CLI: changes apply as each agent's next task starts.</p>
      </div>
    </div>
  );
}

export function FleetTab() {
  const boxes = useStore((s) => s.boxes);
  const repos = useStore((s) => s.repos);
  const agents = useStore((s) => s.agents);
  const terminal = useStore((s) => s.settings.runtime === 'terminal');
  const list = Object.values(agents);
  return (
    <div className="tab-grid">
      <div>
        {!terminal && (
          <div className="card fleet-missing small">
            Boxes run agents in the terminal runtime. With Claude Code through the SDK (⚙️ Settings), everyone works on this machine.
          </div>
        )}
        <h3 className="section">🖥 Machines</h3>
        <OfficeMachine agents={list} repos={repos} />
        {boxes.map((b) => (
          <BoxCard key={b.id} box={b} agents={list} repos={repos} />
        ))}
        {repos.length > 0 && <h3 className="section">🏢 Floors</h3>}
        {[...repos].sort((a, b) => a.floor - b.floor).map((r) => (
          <FloorMachine key={`${r.id}-${r.box}`} repo={r} boxes={boxes} agents={agents} />
        ))}
      </div>
      <AddBox />
    </div>
  );
}
