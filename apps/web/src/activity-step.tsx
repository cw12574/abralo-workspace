import { useEffect, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { Activity } from '../../../packages/contracts/src/index';
import { api } from './api';

export function ActivityStep({
  activity,
  messageId,
  title,
  time,
}: {
  activity: Activity;
  messageId: string;
  title: string;
  time: string;
}) {
  const [open, setOpen] = useState(false);
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{ key: string; detail?: string; error?: string } | null>(
    null,
  );
  const key = JSON.stringify([messageId, activity.id, activity.updatedAt || activity.time, retry]);
  useEffect(() => {
    setResult(null);
    if (!open || !activity.hasDetail || activity.detail !== undefined) return;
    const controller = new AbortController();
    // Coalesce rapid live updates; abort stale requests on close, navigation or revision.
    const timer = setTimeout(() => {
      void api(
        `/messages/${encodeURIComponent(messageId)}/activities/${encodeURIComponent(activity.id)}`,
        undefined,
        undefined,
        controller.signal,
      )
        .then((value: Activity) => {
          if (!controller.signal.aborted) setResult({ key, detail: value.detail || '' });
        })
        .catch((error: Error) => {
          if (!controller.signal.aborted) setResult({ key, error: error.message });
        });
    }, 100);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, key, activity.hasDetail, activity.detail]);
  const current = result?.key === key ? result : null;
  const detail = activity.detail ?? current?.detail;
  return (
    <li
      className={`toolchain-step state-${activity.state || 'complete'} ${activity.state === 'failed' ? 'is-failed' : ''}`}
    >
      <span className="toolchain-node" aria-hidden="true" />
      <details className="tool-detail" onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary>
          <span>{title}</span>
          <time>{time}</time>
          <ChevronDown size={12} aria-hidden="true" />
        </summary>
        {open && (
          <>
            {activity.url && (
              <a className="tool-destination" href={activity.url}>
                View message ↗
              </a>
            )}
            {activity.hasDetail && detail === undefined && !current?.error && (
              <p role="status">Loading step details…</p>
            )}
            {current?.error && (
              <div className="ui-field" role="alert">
                <span>{current.error}</span>
                <button className="quiet-button" onClick={() => setRetry((value) => value + 1)}>
                  Retry step details
                </button>
              </div>
            )}
            {detail && (
              <pre className={activity.type === 'diff' ? 'diff' : ''}>
                {activity.type === 'diff'
                  ? detail.split('\n').map((line, index) => (
                      <span
                        className={
                          line.startsWith('+') ? 'added' : line.startsWith('-') ? 'removed' : ''
                        }
                        key={index}
                      >
                        {line + '\n'}
                      </span>
                    ))
                  : detail}
              </pre>
            )}
          </>
        )}
      </details>
    </li>
  );
}
