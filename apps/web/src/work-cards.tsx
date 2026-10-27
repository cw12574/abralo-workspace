import { useEffect, useState } from 'react';
import { Check, ChevronDown, Circle, LoaderCircle } from 'lucide-react';
import { api } from './api';
import './work-cards.css';

type WorkItem = {
  id: string;
  title: string;
  effectiveStatus: string;
  summary: string;
  doneWhen: string[];
  proofPlan: string[];
  checks: { label: string; result: string; detail?: string }[];
};
export function WorkCards({
  conversationId,
  revision,
  fail,
}: {
  conversationId: string;
  revision: number;
  fail: (message: string) => void;
}) {
  const [items, setItems] = useState<WorkItem[]>([]);
  useEffect(() => {
    let active = true;
    api('/work?conversationId=' + encodeURIComponent(conversationId))
      .then((result) => {
        if (active) setItems(result);
      })
      .catch((error) => {
        if (active) fail(error.message);
      });
    return () => {
      active = false;
    };
  }, [conversationId, revision]);
  const visible = items
    .filter((item, index) => item.effectiveStatus !== 'complete' || index < 2)
    .slice(0, 4);
  return (
    <>
      {visible.map((item) => (
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
    </>
  );
}
