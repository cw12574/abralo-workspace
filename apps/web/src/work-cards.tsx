import { useEffect, useState } from 'react';
import { Check, ChevronDown, Circle, LoaderCircle } from 'lucide-react';
import { api } from './api';
import './work-cards.css';

type WorkItem = {
  id: string;
  requestMessageId: string;
  title: string;
  effectiveStatus: string;
  summary: string;
  doneWhen: string[];
  proofPlan: string[];
  checks: { label: string; result: string; detail?: string }[];
};
export function useConversationWork(
  conversationId: string,
  messageIds: string[],
  revision: number,
  fail: (message: string) => void,
) {
  const [result, setResult] = useState<{ conversationId: string; items: WorkItem[] }>();
  const messageKey = messageIds.join(',');
  useEffect(() => {
    if (!messageKey) return;
    let active = true;
    const query = new URLSearchParams({ conversationId, messageIds: messageKey });
    api('/work?' + query)
      .then((items) => {
        if (active) setResult({ conversationId, items });
      })
      .catch((error) => {
        if (active) fail(error.message);
      });
    return () => {
      active = false;
    };
  }, [conversationId, messageKey, revision]);
  return result?.conversationId === conversationId ? result.items : [];
}

export function WorkCards({ items }: { items: WorkItem[] }) {
  if (!items.length) return null;
  return (
    <div className="message-work-cards ui-stack">
      {items.map((item) => (
        <article className="work-card" key={item.id}>
          <div className="work-card-head">
            {item.effectiveStatus === 'complete' ? (
              <Check size={16} />
            ) : item.effectiveStatus === 'working' || item.effectiveStatus === 'checking' ? (
              <LoaderCircle size={16} className="work-spin" />
            ) : (
              <Circle size={16} />
            )}
            <div>
              <strong>{item.title}</strong>
              <small>
                {item.effectiveStatus === 'complete'
                  ? 'Checked and complete'
                  : item.effectiveStatus === 'checking'
                    ? 'Checking the result'
                    : item.effectiveStatus === 'waiting'
                      ? 'Ready to continue'
                      : 'Working on it'}
              </small>
            </div>
          </div>
          {item.summary && <p>{item.summary}</p>}
          <details>
            <summary>
              What counts as done and how it was checked <ChevronDown size={14} />
            </summary>
            <div className="work-card-detail">
              <strong>Done when</strong>
              <ul>
                {item.doneWhen.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
              <strong>Checks</strong>
              {item.checks.length ? (
                <ul>
                  {item.checks.map((check, i) => (
                    <li key={i}>
                      <b>
                        {check.result === 'passed'
                          ? 'Passed'
                          : check.result === 'failed'
                            ? 'Failed'
                            : 'Pending'}
                        :
                      </b>{' '}
                      {check.label}
                      {check.detail ? ' — ' + check.detail : ''}
                    </li>
                  ))}
                </ul>
              ) : (
                <ul>
                  {item.proofPlan.map((line, i) => (
                    <li key={i}>{line} (planned)</li>
                  ))}
                </ul>
              )}
            </div>
          </details>
        </article>
      ))}
    </div>
  );
}
