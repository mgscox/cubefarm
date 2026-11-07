import { PrContributions } from './PrContributions';
import { PromptTextarea } from './PromptTextarea';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './prototype.css';
import { hasLabel, NEEDS_REVIEW, PROTOTYPE } from '../../../shared/issues';
import { api } from '../api';
import { agentsOnRepo, kanbanFor, useStore, type Agent, type KanbanCard } from '../store';
import { confirmDialog } from './Confirm';
import { Panel } from './Overlays';

function AgentChip({ agent }: { agent?: Agent }) {
  if (!agent) return null;
  return (
    <span className="agent-chip">
      <span className="dot" style={{ background: agent.color }} />
      {agent.name}
      {agent.role === 'qa' && <span className="chip">QA</span>}
    </span>
  );
}

export function IssueForm({ repoId, agents, onDone }: { repoId: string; agents: Agent[]; onDone?: () => void }) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [assignTo, setAssignTo] = useState('');
  const [prototype, setPrototype] = useState(false);
  const [busy, setBusy] = useState(false);
  const free = agents.filter((a) => (a.role === 'dev' || (!prototype && a.role === 'researcher')) && a.status !== 'working' && a.status !== 'preparing');
  return (
    <form
      className="issue-form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!title.trim()) return;
        setBusy(true);
        try {
          await api.createIssue(repoId, title, body, assignTo || undefined, prototype ? PROTOTYPE : undefined);
          setTitle('');
          setBody('');
          setAssignTo('');
          setPrototype(false);
          onDone?.();
        } catch {
          // toasted
        } finally {
          setBusy(false);
        }
      }}
    >
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Issue title, e.g. Add a dark mode toggle" autoFocus />
      <PromptTextarea value={body} onValueChange={setBody} placeholder="Describe what you want. Acceptance criteria help the developer and the QA tester a lot." rows={5} />
      <div className="row">
        <select aria-label="Work type" value={prototype ? PROTOTYPE : 'implementation'} onChange={(e) => { setPrototype(e.target.value === PROTOTYPE); setAssignTo(''); }}>
          <option value="implementation">Implementation</option>
          <option value={PROTOTYPE}>Prototype</option>
        </select>
        <select aria-label="Assign issue" value={assignTo} onChange={(e) => setAssignTo(e.target.value)}>
          <option value="">Leave in To do (auto-assign picks it up if enabled)</option>
          {free.map((a) => (
            <option key={a.id} value={a.id}>
              Give it to {a.name}{a.specialty ? ` · ${a.specialty}` : ''} right away
            </option>
          ))}
        </select>
        <button className="btn btn-good" disabled={busy || !title.trim()}>
          {busy ? 'Filing…' : 'File issue on GitHub'}
        </button>
      </div>
    </form>
  );
}

function QaLink({ card }: { card: KanbanCard }) {
  if (!card.qa?.commentUrl) return null;
  return (
    <a className="small" href={card.qa.commentUrl} target="_blank" rel="noreferrer" title={card.qa.summary ?? ''}>
      QA report ↗
    </a>
  );
}

function PrototypeDecision({ card, repoId, autoAssign }: { card: KanbanCard; repoId: string; autoAssign: boolean }) {
  const [decision, setDecision] = useState<'approve' | 'revise' | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (decision && dialog.current && !dialog.current.open) dialog.current.showModal();
  }, [decision]);
  if (!card.prototype || !card.prNumber) return null;
  const { head, issueNumber } = card.prototype;
  const prNumber = card.prNumber;
  if (!decision) return (
    <>
      <button className="btn btn-small btn-good" onClick={() => { setBody(''); setDecision('approve'); }}>Approve for implementation…</button>
      <button className="btn btn-small" onClick={() => { setBody(''); setDecision('revise'); }}>Send back…</button>
    </>
  );
  return createPortal(
    <dialog ref={dialog} className="prototype-dialog" aria-label={decision === 'approve' ? 'Approve prototype for implementation' : 'Send prototype feedback'}
      onCancel={(e) => { e.preventDefault(); if (!busy) setDecision(null); }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          if (!busy) setDecision(null);
        }
      }}>
    <h3>{decision === 'approve' ? 'Approve for implementation' : 'Send prototype back'}</h3>
    <p className="small"><a href={card.url} target="_blank" rel="noreferrer">Review prototype PR #{prNumber}</a></p>
    <form className="issue-form" onSubmit={async (e) => {
      e.preventDefault();
      setBusy(true);
      try {
        if (decision === 'approve') await api.approvePrototype(repoId, prNumber, head, title, body);
        else await api.revisePrototype(repoId, prNumber, head, body);
        setDecision(null);
      } catch {
        // The API already shows the error and keeps the input available.
      } finally {
        setBusy(false);
      }
    }}>
      {decision === 'approve' && (
        <>
          <p className="small">Issue #{issueNumber} becomes implementation work.{autoAssign && ' Auto-assign may start it immediately.'}</p>
          <label className="field">Implementation title<input value={title} onChange={(e) => setTitle(e.target.value)} required autoFocus /></label>
        </>
      )}
      <label className="field">
        {decision === 'approve' ? 'Implementation scope and acceptance criteria' : 'What should the developer change?'}
        <PromptTextarea value={body} onValueChange={setBody} required rows={4} autoFocus={decision === 'revise'} />
      </label>
      <div className="row">
        <button type="button" className="btn btn-small" disabled={busy} onClick={() => setDecision(null)}>Cancel</button>
        <button className="btn btn-small btn-good" disabled={busy || !body.trim() || (decision === 'approve' && !title.trim())}>
          {decision === 'approve' ? 'Approve and release issue' : 'Send feedback'}
        </button>
      </div>
    </form>
    </dialog>, document.body,
  );
}

export function KanbanView({ repoId, inline }: { repoId: string; inline?: boolean }) {
  const repo = useStore((s) => s.repos.find((r) => r.id === repoId));
  const allAgents = useStore((s) => s.agents);
  const qaRecords = useStore((s) => s.qa);
  const contributions = useStore((s) => s.prContributions);
  const openOverlay = useStore((s) => s.openOverlay);
  const agents = useMemo(() => agentsOnRepo(allAgents, repoId), [allAgents, repoId]);
  const cols = useMemo(() => (repo ? kanbanFor(repo, agents, qaRecords) : null), [repo, agents, qaRecords]);
  const [showForm, setShowForm] = useState(false);
  const [pending, setPending] = useState<string | null>(null);

  if (!repo || !cols) {
    return (
      <Panel title="Kanban" inline={inline}>
        <p className="muted">This floor no longer exists.</p>
      </Panel>
    );
  }

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setPending(key);
    try {
      await fn();
    } catch {
      // toasted
    } finally {
      setPending(null);
    }
  };
  const devs = agents.filter((a) => a.role === 'dev' || a.role === 'researcher');
  const free = devs.filter((a) => a.status === 'idle' || a.status === 'done' || a.status === 'stopped' || a.status === 'error');
  const merge = async (c: KanbanCard) => {
    const passed = c.qa?.status === 'passed';
    const ok = await confirmDialog(
      passed
        ? { icon: '🎉', title: `Merge PR #${c.number}?`, body: `“${c.title}” passed QA. It will be squash-merged into ${repo.defaultBranch}.`, confirm: 'Squash & merge' }
        : {
            tone: 'warn',
            title: `Merge PR #${c.number} without QA?`,
            body: `“${c.title}” has not passed QA yet. Merge it into ${repo.defaultBranch} anyway?`,
            confirm: 'Merge anyway',
          },
    );
    if (ok) void act(c.key, () => api.mergePull(repo.id, c.number));
  };
  const previewButton = (c: KanbanCard) => (
    <button
      className="btn btn-small"
      title={`Run PR #${c.number} and open it in the app viewer`}
      onClick={() => {
        openOverlay({ kind: 'app', repoId: repo.id });
        const already = repo.preview.pr === c.number && repo.preview.status !== 'stopped' && repo.preview.status !== 'error' && repo.preview.status !== 'unconfigured';
        if (!already) void api.startPreview(repo.id, c.number).catch(() => undefined);
      }}
    >
      Preview
    </button>
  );
  const terminalButton = (c: KanbanCard) =>
    c.agent && (
      <button className="btn btn-small" onClick={() => openOverlay({ kind: 'terminal', agentId: c.agent!.id })}>
        Terminal
      </button>
    );

  const column = (title: string, cls: string, cards: KanbanCard[], render: (c: KanbanCard) => React.ReactNode, empty: string) => (
    <div className={`kcol ${cls}`}>
      <div className="kcol-head">
        {title} <span className="count">{cards.length}</span>
      </div>
      <div className="kcol-body">
        {cards.length === 0 && <div className="muted small kempty">{empty}</div>}
        {cards.map((c) => (
          <div key={c.key} className={`kcard ${c.tone ? `kcard-${c.tone}` : ''}`}>
            <div className="kcard-title">
              {c.url ? (
                <a href={c.url} target="_blank" rel="noreferrer">
                  {c.prNumber ? 'PR ' : ''}#{c.number}
                </a>
              ) : (
                <b>#{c.number}</b>
              )}{' '}
              {c.title}
            </div>
            {render(c)}
            {c.prNumber && <PrContributions history={contributions.find((h) => h.repoId === repoId && h.prNumber === c.prNumber)} />}
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <Panel
      wide
      inline={inline}
      accent={repo.color}
      title={
        <span>
          📋 {repo.fullName}{' '}
          <a className="small" href={repo.url} target="_blank" rel="noreferrer">
            GitHub ↗
          </a>
        </span>
      }
    >
      <div className="kanban-toolbar">
        <button className="btn btn-good" onClick={() => setShowForm((v) => !v)}>
          {showForm ? 'Cancel' : '+ New issue'}
        </button>
        <label className="toggle">
          <input type="checkbox" checked={repo.autoAssign} onChange={(e) => void api.updateRepo(repo.id, { autoAssign: e.target.checked }).catch(() => undefined)} />
          ⚡ Auto-assign issues to free developers
        </label>
        <label className="toggle" title="Merge a PR after QA, green checks and any required review">
          <input type="checkbox" checked={repo.autoMerge} onChange={(e) => void api.updateRepo(repo.id, { autoMerge: e.target.checked }).catch(() => undefined)} />
          🔀 Auto-merge when ready
        </label>
        <span className="spacer" />
        <button className="btn" onClick={() => openOverlay({ kind: 'app', repoId: repo.id })} title="Open this floor's running app">
          🖥️ View app
        </button>
        <span className="muted small">{repo.lastSync ? `Synced ${new Date(repo.lastSync).toLocaleTimeString()}` : 'Syncing…'}</span>
        <button className="btn" disabled={pending === 'sync'} onClick={() => act('sync', () => api.syncRepo(repo.id))}>
          ⟳ Sync
        </button>
      </div>
      {repo.syncError && <div className="term-error">⚠️ {repo.syncError}</div>}
      {showForm && <IssueForm repoId={repo.id} agents={devs} onDone={() => setShowForm(false)} />}

      {contributions.some((h) => h.repoId === repoId && (h.state === 'CLOSED' || !repo.pulls.some((p) => p.number === h.prNumber))) && (
        <details>
          <summary>Archived PR contributions</summary>
          {contributions.filter((h) => h.repoId === repoId && (h.state === 'CLOSED' || !repo.pulls.some((p) => p.number === h.prNumber))).map((h) => (
            <div key={h.prNumber} className="kcard">
              <a href={h.url} target="_blank" rel="noreferrer">PR #{h.prNumber}: {h.title}</a> · {h.state.toLowerCase()}
              <PrContributions history={h} />
            </div>
          ))}
        </details>
      )}
      <div className="kanban">
        {column(
          '📋 Backlog',
          'kcol-backlog',
          cols.backlog,
          (c) => <div className="kcard-foot muted small">{c.note}</div>,
          'No issues waiting for triage.',
        )}
        {column(
          '📝 To do',
          'kcol-todo',
          cols.todo,
          (c) => (
            <div className="kcard-foot kcard-foot-wrap">
              {c.note && <span className="muted small">{c.note}</span>}
              <select
                value=""
                disabled={pending === c.key || free.length === 0}
                onChange={(e) => e.target.value && act(c.key, () => api.assign(e.target.value, c.number))}
              >
                <option value="">{free.length ? 'Assign to…' : 'Everyone is busy'}</option>
                {free.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>
          ),
          'No open issues. File one above!',
        )}
        {column(
          '🔨 In progress',
          'kcol-progress',
          cols.progress,
          (c) => (
            <div className="kcard-foot kcard-foot-wrap">
              <AgentChip agent={c.agent} />
              <span className="muted small">{c.note}</span>
              <span className="spacer" />
              {terminalButton(c)}
            </div>
          ),
          'Nobody is coding right now.',
        )}
        {column(
          '🔍 In QA',
          'kcol-qa',
          cols.qa,
          (c) => {
            const st = c.qa?.status;
            return (
              <div className="kcard-foot kcard-foot-wrap">
                <AgentChip agent={c.agent} />
                <span className="muted small">{c.note}</span>
                <span className="spacer" />
                <QaLink card={c} />
                {previewButton(c)}
                {(st === 'testing' || st === 'fixing') && terminalButton(c)}
                {!st && (
                  <button className="btn btn-small btn-good" disabled={pending === c.key} onClick={() => act(c.key, () => api.sendToQa(repo.id, c.number))}>
                    Send to QA
                  </button>
                )}
              </div>
            );
          },
          'Nothing waiting for testing.',
        )}
        {column(
          '👀 Review',
          'kcol-review',
          cols.review,
          (c) => (
            <div className="kcard-foot kcard-foot-wrap">
              <AgentChip agent={c.agent} />
              <span className="muted small">{c.note}. Remove needs-review on GitHub when approved.</span>
              <QaLink card={c} />
              {previewButton(c)}
            </div>
          ),
          'Nothing waiting for review.',
        )}
        {column(
          '✅ Ready to merge',
          'kcol-ready',
          cols.ready,
          (c) => {
            const pr = repo.pulls.find((p) => p.number === c.prNumber);
            return (
              <div className="kcard-foot kcard-foot-wrap">
                <AgentChip agent={c.agent} />
                <span className="muted small">
                  {c.note}
                  {pr ? ` · +${pr.additions} −${pr.deletions}` : ''}
                </span>
                <span className="spacer" />
                <QaLink card={c} />
                {previewButton(c)}
                <button className="btn btn-small btn-good" disabled={pending === c.key || pr?.isDraft} onClick={() => merge(c)}>
                  Merge
                </button>
                <button
                  className="btn btn-small btn-ghost"
                  disabled={pending === c.key}
                  onClick={async () => {
                    const ok = await confirmDialog({ tone: 'danger', title: `Close PR #${c.number}?`, body: `“${c.title}” will be closed without merging. The branch stays on GitHub.`, confirm: 'Close PR' });
                    if (ok) void act(c.key, () => api.closePull(repo.id, c.number));
                  }}
                >
                  Close
                </button>
              </div>
            );
          },
          'No tested pull requests yet.',
        )}
        {column(
          '🎉 Merged',
          'kcol-merged',
          cols.merged,
          (c) => (
            <div className="kcard-foot">
              <AgentChip agent={c.agent} />
            </div>
          ),
          'Nothing merged yet.',
        )}
        {column(
          '🚧 Blocked',
          'kcol-blocked',
          cols.blocked,
          (c) => (
            <div className="kcard-foot kcard-foot-wrap">
              <AgentChip agent={c.agent} />
              <span className="muted small">{c.note}{c.needsHumanLabel && ' · remove needs-human on GitHub to resume'}</span>
              <QaLink card={c} />
              {c.prNumber && previewButton(c)}
              {c.prototype && <PrototypeDecision key={c.prototype.head} card={c} repoId={repo.id} autoAssign={repo.autoAssign} />}
              {c.qa?.status === 'needs-human' && !c.needsHumanLabel && (
                <>
                  <button className="btn btn-small btn-good" disabled={pending === c.key} onClick={() => act(c.key, () => api.sendToQa(repo.id, c.number))}>
                    Retry QA
                  </button>
                  {!hasLabel(repo.pulls.find((p) => p.number === c.prNumber)?.labels, NEEDS_REVIEW) && (
                    <button className="btn btn-small btn-ghost" disabled={pending === c.key} onClick={() => merge(c)}>
                      Merge anyway
                    </button>
                  )}
                </>
              )}
            </div>
          ),
          'Nothing needs your intervention.',
        )}
      </div>
    </Panel>
  );
}
