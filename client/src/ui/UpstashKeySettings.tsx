import { useEffect, useState } from 'react';
import type { UpstashKeySettingsView } from '../../../shared/types';
import { api } from '../api';

export function UpstashKeySettings() {
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
    try {
      setSettings(await api.updateUpstashKey(value));
      setKey('');
    } catch {
      // The API shows the save error. Leave the field available for a retry.
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="upstash-key-heading">
      <h3 id="upstash-key-heading">Upstash Box</h3>
      {!settings ? <p className="muted small">{loadFailed ? 'Could not load Upstash settings.' : 'Loading Upstash settings…'}</p> : (
        <>
          <p className="muted small" role="status">
            {settings.keySource === 'settings' ? 'Using the Box key saved in Settings.' :
              settings.keySource === 'startup' ? 'Using the Box key from startup configuration.' :
                settings.keySource === 'unreadable' ? 'The saved Box key could not be read. Replace it or check the office credential folder permissions.' : 'Set a Box API key to use Upstash workers.'}
          </p>
          {settings.canManage ? (
            <form onSubmit={(event) => { event.preventDefault(); void update(key.trim()); }}>
              <label className="field">
                <span>Upstash Box API key</span>
                <input type="password" autoComplete="new-password" spellCheck={false} value={key} maxLength={512}
                  required disabled={busy} onChange={(event) => setKey(event.target.value)} />
              </label>
              <div className="row">
                <button className="btn btn-small" type="submit" disabled={busy || !key.trim()}>Save key</button>
                {(settings.keySource === 'settings' || settings.keySource === 'unreadable') && (
                  <button className="btn btn-small" type="button" disabled={busy} onClick={() => void update(null)}>Clear saved key</button>
                )}
              </div>
            </form>
          ) : <p className="muted small">Open CubeFarm through localhost to change the Upstash Box key.</p>}
        </>
      )}
    </section>
  );
}
