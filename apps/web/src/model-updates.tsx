import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { api } from './api';
import type { ProviderInfo } from '../../../packages/contracts/src/index';
import './model-updates.css';
const names: Record<string, string> = { codex: 'Codex', claude: 'Claude', opencode: 'OpenCode' };
type Status = {
  notices: { id: string; harness: string; models: { id: string; name: string }[]; at: number }[];
  notifications: boolean;
  selectionIssues?: { employee: string; model: string }[];
  providers: { harness: string; checkedAt?: number; error?: string; checking: boolean }[];
  updates: { enabled: boolean; checking: boolean; providers: { harness: string; checkedAt?: number; current?: string; available?: string; waitingForIdle?: boolean; error?: string }[] };
};
function useModels() {
  const [state, setState] = useState<Status>();
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => void api('/models').then(value => { if (!disposed) { setState(value); setLoadError(''); } }).catch(e => { if (!disposed) setLoadError(e.message); });
    const changed = (event: Event) => {
      if (!['models.changed', 'workspace.resync'].includes((event as CustomEvent).detail?.type)) return;
      clearTimeout(timer); timer = setTimeout(load, 200);
    };
    load(); window.addEventListener('workspace-event', changed);
    return () => { disposed = true; clearTimeout(timer); window.removeEventListener('workspace-event', changed); };
  }, []);
  return { state, setState, error: error || loadError, setError };
}
export function ModelNotice({ onOpen }: { onOpen: () => void }) {
  const { state, setState, error, setError } = useModels();
  const [saving, setSaving] = useState(false);
  if (!state?.notifications || !state.notices.length) return null;
  return <div className="model-notice" role="status">
    <button className="model-notice-open" onClick={onOpen}>New models available</button>
    <button className="icon" aria-label="Dismiss new models notification" disabled={saving} onClick={async () => {
      setSaving(true);
      const ids = state.notices.map(n => n.id);
      try {
        await api('/models/dismiss', { ids });
        setState(current => current && ({ ...current, notices: current.notices.filter(n => !ids.includes(n.id)) }));
      } catch (e: any) { setError(e.message); }
      finally { setSaving(false); }
    }}><X size={14} /></button>
    {error && <small role="alert">{error}</small>}
  </div>;
}
export function ModelSettings() {
  const { state, setState, error, setError } = useModels();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const save = async (key: 'notifications' | 'autoUpdate', value: boolean) => {
    setBusy(true); setError('');
    const previous = key === 'notifications' ? !!state?.notifications : !!state?.updates.enabled;
    const apply = (enabled: boolean) => setState(current => current && (key === 'notifications'
      ? { ...current, notifications: enabled } : { ...current, updates: { ...current.updates, enabled } }));
    apply(value);
    try { await api('/models/preferences', { [key]: value }, 'PUT'); }
    catch (e: any) { apply(previous); setError(e.message); }
    finally { setBusy(false); }
  };
  return <section className="settings-section model-settings" aria-label="Model updates">
    <div className="ui-field"><h3>Model updates</h3>
      <p className="caption">Model choices refresh quietly in the background. Employees keep the model you chose unless you select Follow provider recommendation.</p></div>
    {!state ? <p role="status">{error || 'Loading model updates...'}</p> : <>
      <label className="check-label"><input type="checkbox" checked={state.notifications} disabled={busy}
        onChange={e => void save('notifications', e.target.checked)} />Tell me when new models are available</label>
      <div className="ui-field">
        <label className="check-label"><input type="checkbox" checked={state.updates.enabled} disabled={busy}
          onChange={e => void save('autoUpdate', e.target.checked)} />Keep provider software up to date</label>
        <p className="caption">Checked daily. Updates download separately and take effect between jobs. Your current version stays available if a check fails.</p>
      </div>
      {state.notices.length > 0 && <div className="model-new-list ui-stack">
        <h4>New models available</h4>
        {state.notices.map(notice => <div className="ui-field" key={notice.id}>
          <strong>{names[notice.harness]}</strong>
          <ul>{notice.models.map(model => <li key={model.id}>{model.name}</li>)}</ul>
        </div>)}
        <button className="quiet-button" disabled={busy} onClick={async () => {
          setBusy(true); const ids = state.notices.map(n => n.id);
          try { await api('/models/dismiss', { ids }); setState(current => current && ({ ...current, notices: current.notices.filter(n => !ids.includes(n.id)) })); }
          catch (e: any) { setError(e.message); } finally { setBusy(false); }
        }}>Mark as seen</button>
      </div>}
      {!!state.selectionIssues?.length && <div className="ui-field">
        <h4>Saved model choices</h4>
        {state.selectionIssues.map(item => <p className="caption" key={item.employee + item.model}>{item.employee} uses {item.model}, which is not in the current model list. Your selection has been kept; you can change it in employee settings.</p>)}
      </div>}
      <div className="ui-stack">
        {state.providers.map(provider => {
          const update = state.updates.providers.find(u => u.harness === provider.harness);
          return <div className="ui-field" key={provider.harness}>
            <strong>{names[provider.harness]}</strong>
            <p className="caption">{provider.checkedAt ? 'Models checked ' + new Date(provider.checkedAt).toLocaleString() : 'Models will be checked when connected.'}</p>
            {provider.error && <p className="caption">{provider.error}</p>}
            {update?.waitingForIdle && <p className="caption">Software update ready. Waiting for current work to finish.</p>}
            {update?.error && <p className="caption">{update.error}</p>}
          </div>;
        })}
      </div>
      <div className="ui-actions"><button className="secondary" disabled={busy} onClick={async () => {
        setBusy(true); setError(''); setMessage('Checking models...');
        try { await api('/models/check', {}); setState(await api('/models')); setMessage('Check finished. Any connection issues are shown above.'); }
        catch (e: any) { setError(e.message); setMessage(''); } finally { setBusy(false); }
      }}>{busy ? 'Checking...' : 'Check now'}</button><span role="status">{message}</span></div>
      {error && <p role="alert">{error}</p>}
    </>}
  </section>;
}

export function ModelChoice({ provider, initialValue = '' }: { provider?: ProviderInfo; initialValue?: string }) {
  const [value, setValue] = useState(initialValue);
  const [custom, setCustom] = useState(false);
  const [customValue, setCustomValue] = useState(initialValue.startsWith('@') ? '' : initialValue);
  const models = provider?.models?.filter(m => m.id) || [];
  return <>
    <select aria-label="Model" name={custom ? undefined : 'model'} value={custom ? '@custom' : value} onChange={e => {
      setCustom(e.target.value === '@custom');
      if (e.target.value !== '@custom') setValue(e.target.value);
    }}>
      <option value="">Configured provider default</option>
      <option value="@recommended" disabled={value !== '@recommended' && models.filter(m => m.isDefault).length !== 1}>Follow provider recommendation</option>
      {value && value !== '@recommended' && !models.some(m => m.id === value) && <option value={value}>{value} (saved selection)</option>}
      {models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
      <option value="@custom">Custom model...</option>
    </select>
    {custom && <input name="model" aria-label="Custom model ID" value={customValue} onChange={e => setCustomValue(e.target.value)} required placeholder="Enter a model ID" />}
  </>;
}
