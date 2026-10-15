import { useLayoutEffect, useRef, useState } from 'react';
import { api } from '../api';
import { isBusy, useStore } from '../store';
import { RESEARCHER_ID } from '../../../shared/types';
import { LiveTerminal } from './LiveTerminal';
import { MessageBox } from './MessageBox';
import { Panel } from './Overlays';
import { StatusPill } from './TerminalView';
import { toolVerb } from '../world/draw';

// The lobby researcher's desk: brief them (for the company, or for one floor), follow the research
// in their terminal, and see where recent docs were filed.

export function ResearchDesk() {
  const agent = useStore((s) => s.agents[RESEARCHER_ID]);
  const log = useStore((s) => s.logs[RESEARCHER_ID]) ?? [];
  const info = useStore((s) => s.research);
  const repos = useStore((s) => s.repos);
  const usage = useStore((s) => s.usage);
  const [brief, setBrief] = useState('');
  const [repoId, setRepoId] = useState('');
  const [busy, setBusy] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log.length]);
  if (!agent) {
    return (
      <Panel title="Research">
        <p className="muted">The research desk is empty.</p>
      </Panel>
    );
  }
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch {
      // api() already toasted
    } finally {
      setBusy(false);
    }
  };
  const working = isBusy(agent);
  return (
    <Panel
      wide
      accent={agent.color}
      title={
        <div className="term-title">
          <span className="avatar" style={{ background: agent.color }}>
            {agent.name[0]}
          </span>
          <span>{agent.name}</span>
          <span className="chip">📚 {agent.title || 'Researcher'}</span>
          <StatusPill status={agent.status} />
          {working && agent.currentTool && <span className="muted small">{toolVerb(agent.currentTool)}…</span>}
        </div>
      }
    >
      <div className="term-meta">
        <span>
          <b>Now:</b> {working ? (info.job?.label ?? agent.issueTitle) : 'free'}
          {info.queue.length > 0 && (
            <>
              {' '}
              · <b>Up next:</b> {info.queue.map((j) => j.label).join(' → ')}
            </>
          )}
        </span>
        {agent.prUrl && (
          <a href={agent.prUrl} target="_blank" rel="noreferrer" className="chip chip-good">
            PR #{agent.prNumber}
          </a>
        )}
      </div>
      {!working && info.queue.length > 0 && usage.state !== 'normal' && (
        <div className="muted small">⏸ Claude's usage is {usage.state === 'paused' ? 'at its limit' : 'running high'}, so new research waits, like new issues do.</div>
      )}
      {agent.lastError && agent.status !== 'working' && <div className="term-error">⚠️ {agent.lastError}</div>}
      {agent.terminal ? (
        <LiveTerminal agentId={agent.id} />
      ) : (
        <div className="term" ref={scroller}>
          {log.length === 0 && <div className="term-line term-system">(no research yet)</div>}
          {log.map((l) => (
            <div key={l.id} className={`term-line term-${l.kind}`}>
              {l.text || ' '}
            </div>
          ))}
        </div>
      )}

      <form
        className="term-input"
        onSubmit={(e) => {
          e.preventDefault();
          const t = brief.trim();
          if (!t) return;
          void run(async () => {
            await api.research(t, repoId || undefined);
            setBrief('');
          });
        }}
      >
        <MessageBox
          value={brief}
          onChange={setBrief}
          aria-label={`Brief ${agent.name}`}
          title="Enter sends · Shift+Enter adds a new line. The first line is the topic."
          placeholder={`What should ${agent.name} research? First line is the topic; add the questions below it…`}
        />
        <select value={repoId} onChange={(e) => setRepoId(e.target.value)} title="Where the doc is filed" style={{ width: 'auto' }}>
          <option value="">For the company</option>
          {repos.map((r) => (
            <option key={r.id} value={r.id}>
              For floor {r.floor} · {r.fullName.split('/')[1] ?? r.fullName}
            </option>
          ))}
        </select>
        <button className="btn" disabled={busy || !brief.trim()}>
          📚 Brief
        </button>
      </form>
      <p className="muted small">
        Company research is committed to the office's research folder, which the CEO reads. Research for a floor goes into its repo's <code>docs/research/</code> by pull request, without QA. Floors can have
        their own researchers too: they take <code>swarm:research</code> issues.
      </p>

      <div className="term-actions">
        {working ? (
          <button className="btn btn-bad" disabled={busy} onClick={() => run(() => api.stop(agent.id))}>
            ■ Stop
          </button>
        ) : (
          (agent.status === 'error' || agent.status === 'stopped') && (
            <button className="btn" disabled={busy} onClick={() => run(() => api.reset(agent.id))}>
              ↺ Clear desk
            </button>
          )
        )}
      </div>

      {info.done.length > 0 && (
        <>
          <h3>Filed lately</h3>
          <ul className="small">
            {[...info.done].reverse().map((d) => (
              <li key={`${d.at}-${d.topic}`}>
                <b>{d.topic}</b> · {new Date(d.at).toLocaleDateString()} ·{' '}
                {d.where.startsWith('https://') ? (
                  <a href={d.where} target="_blank" rel="noreferrer">
                    {d.where.replace('https://github.com/', '')} ↗
                  </a>
                ) : (
                  <code>{d.where}</code>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}
