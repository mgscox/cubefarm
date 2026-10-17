import { useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';

/** Connection and pairing controls for the phone's optional Telegram bridge. */
export function TelegramSettings() {
  const telegram = useStore((s) => s.telegram);
  const demo = useStore((s) => s.demo);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (action: string, extra: Record<string, unknown> = {}) => {
    setBusy(true);
    try {
      await api.telegramCommand(action, extra);
    } catch {
      // api() already reports command failures in the phone toast.
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="telegram-settings">
      <summary>Telegram · {telegram?.state ?? 'loading'}</summary>
      {!telegram ? (
        <p className="muted small">Waiting for Telegram status from the server…</p>
      ) : (
        <div className="small" style={{ display: 'grid', gap: 7, paddingTop: 8 }}>
          <div><b>{telegram.state}</b>{telegram.detail ? ` · ${telegram.detail}` : ''}</div>
          <div>Pending deliveries: {telegram.pending}{telegram.uncertain ? ' · delivery status uncertain' : ''}</div>
          {!telegram.configured && <p className="muted">Set CUBEFARM_TELEGRAM_TOKEN in the server environment and restart the server. The bot token is never entered or shown here.</p>}
          {telegram.pairing && (
            <div>
              <p>Pairing code: <b>{telegram.pairing.code}</b> (expires {new Date(telegram.pairing.expiresAt).toLocaleTimeString()})</p>
              <button className="btn btn-small" disabled={busy} onClick={() => void run('pair')}>Create new code</button>{' '}
              <button className="btn btn-small" disabled={busy} onClick={() => void run('revoke')}>Cancel pairing</button>
              {telegram.pairing.candidate ? (
                <>
                  <p>Confirm this Telegram identity: user {telegram.pairing.candidate.userId}, chat {telegram.pairing.candidate.chatId}</p>
                  <button className="btn btn-small btn-good" disabled={busy} onClick={() => void run('confirm', telegram.pairing!.candidate!)}>Confirm pairing</button>
                </>
              ) : <p className="muted">Send <code>/start {telegram.pairing.code}</code> to your bot, then confirm the identity here.</p>}
            </div>
          )}
          {!telegram.pairing && !telegram.paired && <button className="btn btn-small" disabled={busy || !telegram.configured} onClick={() => void run('pair')}>Create pairing code</button>}
          {telegram.paired && <div>Connected to user {telegram.paired.userId}, chat {telegram.paired.chatId}. <button className="btn btn-small" disabled={busy} onClick={() => void run('revoke')}>Revoke pairing</button></div>}
          {telegram.uncertain && (
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="btn btn-small" disabled={busy} title="Retry may deliver a duplicate message" onClick={() => void run('retry')}>Retry (may duplicate)</button>
              <button className="btn btn-small" disabled={busy} onClick={() => void run('skip')}>Skip uncertain delivery</button>
            </div>
          )}
          {demo && telegram.demo && (
            <div style={{ borderTop: '1px solid #aaa5', paddingTop: 7 }}>
              <b>Demo simulator</b> · {telegram.demo.offline ? 'offline' : 'online'}
              <form onSubmit={(e) => { e.preventDefault(); if (text.trim()) { void run('demo', { text: text.trim() }); setText(''); } }} style={{ display: 'flex', gap: 5, marginTop: 5 }}>
                <input aria-label="Simulate Telegram message" value={text} onChange={(e) => setText(e.target.value)} placeholder="/start CODE, /reply TEXT…" />
                <button className="btn btn-small" disabled={busy || !text.trim()}>Send</button>
              </form>
              <p className="muted">Try /reply TEXT, /notice TEXT, /proposal, /offline, or /online.</p>
              {telegram.demo.sent.length > 0 && <div>Last fake sent: {telegram.demo.sent.slice(-3).map((m, i) => <div key={`${i}-${m.text}`} style={{ marginTop: 6 }}>{m.text}{m.buttons?.map((callback) => <button key={callback} className="btn btn-small" disabled={busy} onClick={() => void run('demo', { text: callback })}>{callback.startsWith('approve:') ? 'Approve proposal' : 'Reject proposal'}</button>)}</div>)}</div>}
              {telegram.demo.offline && <button className="btn btn-small" disabled={busy} onClick={() => void run('demo', { text: '/online' })}>Bring demo online</button>}
            </div>
          )}
          <p className="muted">CubeFarm must remain running to receive messages. Telegram delivery confirms server handoff only; it is not a WebUI read receipt.</p>
        </div>
      )}
    </details>
  );
}
