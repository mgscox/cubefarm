import { useEffect, useState } from 'react';
import type { UpstashKeySettingsView } from '../../../shared/types';
import { api } from '../api';
import { useStore } from '../store';

export function UpstashKeySettings() {
  const status = useStore((s) => s.upstashKey);
  const demo = useStore((s) => s.demo);
  const [settings, setSettings] = useState<UpstashKeySettingsView>();
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  useEffect(() => {
    let current = true;
    void api.upstashKeySettings().then(
      (value) => { if (current) setSettings(value); },
      () => { if (current) setLoadFailed(true); },
    );
    return () => { current = false; };
  }, []);

  const update = async (value: string | null) => {
    setBusy(true);
    try { setSettings(await api.updateUpstashKey(value)); setKey(''); }
    catch { /* The API shows the error; retain the typed key for a retry. */ }
    finally { setBusy(false); }
  };
  const source = status ? status.keySource : settings?.keySource;
  if (settings && !settings.available) return null;
  return (
    <section aria-labelledby="upstash-key-heading">
      <h3 id="upstash-key-heading">Upstash Box</h3>
      {!settings ? <p className="muted small">{loadFailed ? 'Could not load Box key settings.' : 'Loading Box key settings…'}</p> : (
        <>
          <p className="muted small" role="status">{source === 'settings' ? 'Using the key saved in Settings.' : source === 'startup' ? 'Using the key from startup configuration.' : 'No Box API key configured.'}</p>
          {demo && <p className="muted small">Demo: no real credentials are inspected or saved.</p>}
          {settings.canManage ? (
            <form onSubmit={(event) => { event.preventDefault(); void update(key.trim()); }}>
              <label className="field">
                <span>Upstash Box API key</span>
                <input type="password" autoComplete="new-password" spellCheck={false} value={key} maxLength={1024} required disabled={busy}
                  onChange={(event) => setKey(event.target.value)} />
              </label>
              <p className="muted small">Changes apply immediately. A replacement must access every Box the office still owns. Clearing restores the startup configuration, if available.</p>
              <div className="row">
                <button className="btn btn-small" type="submit" disabled={busy || !key.trim()}>Save key</button>
                {source === 'settings' && <button className="btn btn-small" type="button" disabled={busy} onClick={() => void update(null)}>Clear saved key</button>}
              </div>
            </form>
          ) : <p className="muted small">Open CubeFarm through localhost to change the Box API key.</p>}
        </>
      )}
    </section>
  );
}
