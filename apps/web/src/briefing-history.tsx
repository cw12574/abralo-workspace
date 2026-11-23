import { useEffect, useState } from 'react';
import { api } from './api';

export function BriefingHistory({ onOpen }: { onOpen: (id: string) => void }) {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    void api('/briefings')
      .then(setItems)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);
  return (
    <div className="ui-stack">
      {error && <p role="alert">{error}</p>}
      {loading ? (
        <p>Loading briefings…</p>
      ) : !items.length ? (
        <p>Your morning briefings will appear here.</p>
      ) : (
        items.map((item) => (
          <button className="briefing-history" key={item.id} onClick={() => onOpen(item.id)}>
            {new Date(item.createdAt).toLocaleString([], {
              dateStyle: 'medium',
              timeStyle: 'short',
            })}
            {' · '}
            {item.phase === 'complete' ? 'View recap' : 'Resume conversation'}
          </button>
        ))
      )}
    </div>
  );
}
