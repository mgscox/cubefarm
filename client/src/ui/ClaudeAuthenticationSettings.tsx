import { useEffect, useRef, useState } from 'react';
import type { ClaudeAuthenticationView } from '../../../shared/types';
import { claudeAuthentication } from '../api';

/** Phone-first official CLI sign-in; only safe metadata is polled, never terminal output. */
export function ClaudeAuthenticationSettings() {
  const [view, setView] = useState<ClaudeAuthenticationView>();
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const flow = useRef<string | null>(null);
  // Status observes the office singleton; only a successful start grants cleanup ownership.
  const ownedFlow = useRef<string | null>(null);
  const mounted = useRef(false);
  const apply = (value: ClaudeAuthenticationView, started = false) => {
    if (started) ownedFlow.current = value.flowId;
    if (!mounted.current) {
      if (started && value.flowId) void claudeAuthentication('cancel', { flowId: value.flowId }).catch(() => undefined);
      return;
    }
    flow.current = value.flowId;
    setView(value);
  };
  useEffect(() => {
    mounted.current = true;
    void claudeAuthentication('status').then(apply, () => { if (mounted.current) setFailed(true); });
    return () => {
      mounted.current = false;
      if (ownedFlow.current) void claudeAuthentication('cancel', { flowId: ownedFlow.current }).catch(() => undefined);
      ownedFlow.current = null;
      flow.current = null;
    };
  }, []);
  useEffect(() => {
    if (!view?.flowId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await claudeAuthentication('status');
        if (stopped) return;
        apply(next);
        if (!next.flowId) { setSecret(''); return; }
      } catch { if (!stopped) setFailed(true); }
      if (!stopped) timer = setTimeout(() => void poll(), 1000);
    };
    timer = setTimeout(() => void poll(), 1000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [view?.flowId]);
  const act = async (action: 'start' | 'cancel' | 'complete' | 'code', mode?: ClaudeAuthenticationView['mode']) => {
    const next = action === 'complete' ? { flowId: flow.current ?? '', token: secret }
      : action === 'code' ? { flowId: flow.current ?? '', code: secret }
      : action === 'cancel' ? { flowId: flow.current ?? '' } : { mode };
    setSecret('');
    setCopied(false);
    setBusy(true);
    setFailed(false);
    try { apply(await claudeAuthentication(action, next), action === 'start'); }
    catch {
      if (mounted.current) setFailed(true);
      await claudeAuthentication('status').then(apply, () => undefined);
    } finally { if (mounted.current) setBusy(false); }
  };
  const copyUrl = async () => {
    if (!view?.authorizationUrl) return;
    try { await navigator.clipboard.writeText(view.authorizationUrl); if (mounted.current) setCopied(true); }
    catch { if (mounted.current) setFailed(true); }
  };
  const active = !!view?.flowId;
  const manual = view?.mode === 'manual-token';
  const source = view?.demo ? 'Demo: no real credentials are inspected or saved.'
    : view?.source === 'saved' ? 'Using the subscription token saved for this office.'
    : view?.source === 'startup' ? 'Using the subscription token supplied at startup.'
    : view?.source === 'unavailable' ? 'Saved credential unavailable. Check the private credential folder.'
    : 'CLI-managed login may be available; it has not been inspected.';
  return (
    <section className="claude-auth-settings" aria-label="Claude authentication">
      <h3>Claude authentication</h3>
      <p className="small" role="status">{view ? view.phase === 'complete' ? view.demo ? manual ? 'Demo replacement complete. No credentials saved.' : 'Demo sign-in complete. No credentials saved.' : 'Subscription token saved. New Claude sessions will use it.' : source : 'Loading authentication metadata…'}</p>
      <p className="muted small">Expiry unknown. Authentication metadata does not verify model access. Existing sessions keep their current credentials.</p>
      <p className="muted small">Personal office fork. Subscription auth here does not establish approval for third party products.</p>
      {failed && <p className="small" role="alert">Could not complete the action. Check the connection to your configured HTTPS office and try again.</p>}
      {view?.phase === 'failed' && <p className="small" role="alert">Sign-in failed. Start again, or use the manual token fallback.</p>}
      {view?.phase === 'expired' && <p className="small">Sign-in expired after ten minutes. Start a new sign-in.</p>}
      {view?.phase === 'cancelled' && <p className="small">{manual ? 'Replacement cancelled.' : 'Sign-in cancelled.'}</p>}
      {view && !active && <div className="row">
        <button className="btn btn-small" disabled={busy || !view.canManage} onClick={() => void act('start', 'browser')}>Sign in with Claude</button>
        <button className="btn btn-small" disabled={busy || !view.canManage} onClick={() => void act('start', 'manual-token')}>Use manual token fallback</button>
      </div>}
      {active && !manual && <>
        <p className="small">Open Claude sign-in on this phone, approve access, then return here with the code. A private official <code>setup-token</code> process runs on the office computer. Its token stays on the server.</p>
        {view.authorizationUrl && <>
          <p className="small"><a href={view.authorizationUrl} target="_blank" rel="noopener noreferrer">Open Claude sign-in</a></p>
          <p className="small claude-auth-url">{view.authorizationUrl}</p>
          <button className="btn btn-small" disabled={busy} onClick={() => void copyUrl()}>Copy sign-in URL</button>
          {copied && <p className="small">Sign-in URL copied.</p>}
        </>}
        {view.phase === 'starting' && <p className="small">Preparing Claude sign-in…</p>}
        {view.phase === 'awaiting-code' && <>
          {view.demo && <p className="small">Demo only: use demo-code-123. This sign-in link is a synthetic fixture.</p>}
          <form onSubmit={(event) => { event.preventDefault(); void act('code'); }} autoComplete="off">
            <label>Code from Claude sign-in
              <input aria-label="Code from Claude sign-in" type="password" value={secret} maxLength={513} autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={(event) => setSecret(event.target.value)} disabled={busy} />
            </label>
            <button className="btn btn-small" type="submit" disabled={busy || !secret}>Complete sign-in</button>
          </form>
        </>}
        {(view.phase === 'exchanging' || view.phase === 'saving') && <p className="small">Completing sign-in securely…</p>}
        <div className="row"><button className="btn btn-small" disabled={busy} onClick={() => void act('cancel')}>Cancel sign-in</button></div>
      </>}
      {active && manual && <>
        <p className="small">Manual fallback: no Claude login process runs here. Generate a token in a trusted terminal, then paste the token below within ten minutes.</p>
        <ol className="small">
          <li>Use a separate terminal with inherited Claude token, API key, proxy and session variables cleared. Set a temporary HOME and <code>CLAUDE_CONFIG_DIR</code> for this operation.</li>
          <li>Run the bundled CLI command below. Open the URL it displays on this phone. If the browser returns a code, paste that code into the terminal.</li>
          <li>Copy the subscription token printed by <code>setup-token</code> into the password field below. Clean up the temporary terminal directory afterward.</li>
        </ol>
        <pre className="claude-auth-command">{view.setupCommand ?? 'Bundled CLI unavailable. Restore the installed SDK before generating a token.'}</pre>
        <p className="small"><a href="https://code.claude.com/docs/en/authentication#generate-a-long-lived-token" target="_blank" rel="noreferrer noopener">Official Claude authentication instructions</a></p>
        {view.demo && <p className="small">Demo only: enter a dummy token beginning with sk-ant-oat01-.</p>}
        <form onSubmit={(event) => { event.preventDefault(); void act('complete'); }} autoComplete="off">
          <label>New subscription token
            <input aria-label="New subscription token" type="password" value={secret} maxLength={524} autoComplete="new-password" autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={(event) => setSecret(event.target.value)} disabled={busy} />
          </label>
          <div className="row">
            <button className="btn btn-small" type="submit" disabled={busy || !secret || !view.setupCommand}>Save subscription token</button>
            <button className="btn btn-small" type="button" disabled={busy} onClick={() => void act('cancel')}>Cancel replacement</button>
          </div>
        </form>
      </>}
    </section>
  );
}
