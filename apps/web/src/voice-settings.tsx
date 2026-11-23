import { useEffect, useState } from 'react';
import { api } from './api';

export function VoiceSettings({ onSaved }: { onSaved?: () => void }) {
  const [setup, setSetup] = useState<any>(null);
  const [key, setKey] = useState('');
  const [people, setPeople] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  useEffect(() => {
    void Promise.all([api('/briefings/voice'), api('/briefings/roster')])
      .then(([settings, roster]) => {
        setSetup(settings);
        setPeople(roster);
      })
      .catch((e) => setError(e.message));
  }, []);
  return (
    <form
      className="ui-stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        setStatus('');
        try {
          setSetup(
            await api(
              '/briefings/voice',
              {
                ...(key.trim() ? { key: key.trim() } : {}),
                model: setup.model,
                hostId: setup.hostId || undefined,
              },
              'PUT',
            ),
          );
          setKey('');
          setStatus('Voice settings saved.');
          window.dispatchEvent(new Event('briefing-voice-settings'));
          onSaved?.();
        } catch (e: any) {
          setError(e.message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <h3>Morning briefing voice</h3>
      {error && <p role="alert">{error}</p>}
      {!setup ? (
        <p>Loading voice settings…</p>
      ) : (
        <>
          <p>
            {setup.configured ? 'Voice is connected.' : 'Connect voice before your first call.'}
          </p>
          <label className="ui-field">
            Chief of Staff
            <select
              required
              value={setup.hostId || ''}
              onChange={(e) => setSetup({ ...setup, hostId: e.target.value })}
            >
              <option value="">Choose an employee</option>
              {people.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </select>
          </label>
          <label className="ui-field">
            {setup.configured ? 'Replace API key (optional)' : 'OpenAI API key'}
            <input
              type="password"
              autoComplete="off"
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
          </label>
          <p className="caption">
            Uses OpenAI API billing. Audio and briefing context are shared with OpenAI during calls.
            Your key is encrypted on this computer.
          </p>
          <div className="ui-actions">
            <button className="primary" disabled={busy || (!setup.configured && !key.trim())}>
              {busy ? 'Saving…' : 'Save voice settings'}
            </button>
            {status && <span role="status">{status}</span>}
          </div>
        </>
      )}
    </form>
  );
}
