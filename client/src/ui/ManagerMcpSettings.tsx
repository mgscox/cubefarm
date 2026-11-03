import { useEffect, useState } from 'react';
import type { ManagerMcpSettingsPatch, ManagerMcpSettingsView } from '../../../shared/types';
import { api } from '../api';

export function ManagerMcpSettings() {
  const [settings, setSettings] = useState<ManagerMcpSettingsView>();
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let current = true;
    void api.managerMcpSettings().then(
      (value) => { if (current) setSettings(value); },
      () => { if (current) setLoadFailed(true); },
    );
    return () => { current = false; };
  }, []);

  const update = async (patch: ManagerMcpSettingsPatch) => {
    setBusy(true);
    try {
      setSettings(await api.updateManagerMcpSettings(patch));
      if (patch.token !== undefined) setToken('');
    } catch {
      // The API shows the save error. Keep the typed token available for a retry.
    } finally {
      setBusy(false);
    }
  };

  if (settings && !settings.available) return null;

  return (
    <section aria-labelledby="manager-mcp-heading">
      <h3 id="manager-mcp-heading">Manager MCP</h3>
      {!settings ? <p className="muted small">{loadFailed ? 'Could not load MCP settings.' : 'Loading MCP settings…'}</p> : (
        <>
          <label className="toggle block">
            <input type="checkbox" role="switch" checked={settings.enabled} disabled={busy || !settings.canManage}
              onChange={(event) => void update({ enabled: event.target.checked })} />
            <span>Enable manager MCP gateway</span>
          </label>
          <p className="muted small" role="status">
            {settings.tokenSource === 'settings' ? 'Using the token saved in Settings.' :
              settings.tokenSource === 'startup' ? 'Using the token from startup configuration.' : 'Set a token to allow MCP clients to connect.'}
          </p>
          {settings.canManage ? (
            <form onSubmit={(event) => { event.preventDefault(); void update({ token: token.trim() }); }}>
              <label className="field">
                <span>MCP token</span>
                <input type="password" autoComplete="new-password" spellCheck={false} value={token} minLength={32} maxLength={256}
                  pattern="[A-Za-z0-9._~\-]{32,256}" title="Use 32–256 URL-safe characters." required disabled={busy}
                  onChange={(event) => setToken(event.target.value)} />
              </label>
              <div className="row">
                <button className="btn btn-small" type="submit" disabled={busy || !token.trim()}>Save token</button>
                {settings.tokenSource === 'settings' && (
                  <button className="btn btn-small" type="button" disabled={busy} onClick={() => void update({ token: null })}>Clear saved token</button>
                )}
              </div>
            </form>
          ) : <p className="muted small">Open CubeFarm through localhost to change MCP settings.</p>}
        </>
      )}
    </section>
  );
}
