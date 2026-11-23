import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowRight, MoreHorizontal, Plus, Target, Trash2 } from 'lucide-react';
import { api } from './api';
import './goals.css';
import { goalPresentation } from './goal-presentation';

type Goal = {
  id: string;
  title: string;
  conversationId: string;
  leadAgentId: string;
  leadAgentName: string;
  leadAgentActive: boolean;
  status: 'active' | 'paused' | 'complete';
  version: number;
  success: string;
  current: string;
  nextStep: string;
  updatedAt: string;
  execution: {
    state: string;
    question: string;
    reason: string;
    conversationId?: string;
    review?: {
      verdict: string;
      checks: { criterion: string; evidence: string; passed: boolean }[];
    };
  };
  steps: { id: string; title: string; doneWhen: string; status: string; evidence: string }[];
  updates: { id: string; summary: string; createdAt: string }[];
};

function useGoals(
  conversationId: string | undefined,
  revision: number,
  fail: (message: string) => void,
) {
  const [result, setResult] = useState<{ conversationId?: string; goals: Goal[] }>({ goals: [] });
  const request = useRef(0);
  const [loading, setLoading] = useState(true);
  const refresh = async () => {
    const query = conversationId ? '?conversationId=' + encodeURIComponent(conversationId) : '';
    const sequence = ++request.current;
    const goals = await api('/goals' + query);
    if (sequence !== request.current) return;
    setResult({ conversationId, goals });
    setLoading(false);
  };
  const shown = useRef<string | undefined | null>(null);
  useEffect(() => {
    // Only a different list shows the loading state. Background refreshes keep
    // rows mounted so open details, expanded text and confirmations stay put.
    if (shown.current !== (conversationId ?? '')) setLoading(true);
    shown.current = conversationId ?? '';
    void refresh().catch((error) => {
      setLoading(false);
      fail(error.message);
    });
    return () => {
      request.current++;
    };
  }, [conversationId, revision]);
  useEffect(() => {
    const timer = window.setInterval(() => void refresh().catch(() => {}), 10000);
    return () => window.clearInterval(timer);
  }, [conversationId]);
  const goals = result.conversationId === conversationId ? result.goals : [];
  return { goals, loading, refresh };
}

/** One line by default; offers Show more only when the text is actually cut off. */
function OneLine({ text, className }: { text: string; className: string }) {
  const [expanded, setExpanded] = useState(false);
  const [clipped, setClipped] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || expanded) return;
    const measure = () => setClipped(element.scrollWidth > element.clientWidth + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text, expanded]);
  return (
    <div className={'goal-one-line' + (expanded ? ' expanded' : '')}>
      <p ref={ref} className={className}>
        {text}
      </p>
      {(clipped || expanded) && (
        <button
          type="button"
          className="goal-more"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}

export function ConversationGoals({
  conversationId,
  revision,
  onOpen,
  fail,
}: {
  conversationId: string;
  revision: number;
  onOpen: () => void;
  fail: (message: string) => void;
}) {
  const { goals } = useGoals(conversationId, revision, fail);
  const goal = goals.find((item) => goalPresentation(item).showInConversation);
  if (!goal) return null;
  const presentation = goalPresentation(goal);
  return (
    <button
      className="conversation-goals"
      onClick={onOpen}
      aria-label="Open goals for this conversation"
    >
      <Target size={16} aria-hidden="true" />
      <span>
        <strong>{goal.title}</strong>
        <small>
          {presentation.label} &middot; {presentation.progress}
        </small>
      </span>
      <ArrowRight size={15} aria-hidden="true" />
    </button>
  );
}

const needsYou = (goal: Goal) =>
  goal.status === 'active' && ['needs_input', 'needs_permission'].includes(goal.execution.state);

/** Where the goal is, at a glance: done, current and ahead. */
function StepTrail({ steps }: { steps: Goal['steps'] }) {
  if (!steps.length) return null;
  const done = steps.filter((step) => step.status === 'done').length;
  const current = steps.findIndex((step) => step.status !== 'done');
  return (
    <span className="goal-trail" role="img" aria-label={`${done} of ${steps.length} steps done`}>
      <span className="goal-trail-marks" aria-hidden="true">
        {steps.map((step, index) => (
          <span
            key={step.id}
            title={step.title}
            className={
              'goal-trail-mark ' +
              (step.status === 'done'
                ? 'done'
                : step.status === 'blocked'
                  ? 'blocked'
                  : index === current
                    ? 'current'
                    : 'ahead')
            }
          />
        ))}
      </span>
      <span className="goal-trail-count" aria-hidden="true">
        {done}/{steps.length}
      </span>
    </span>
  );
}

export function GoalsView({
  employees,
  conversations,
  revision,
  onOpenConversation,
  avatar,
  fail,
}: {
  conversationId: string;
  conversations: any[];
  employees: { id: string; name: string; dmId: string }[];
  revision: number;
  onOpenConversation: (id: string) => void;
  avatar?: (id: string, name: string) => React.ReactNode;
  fail: (message: string) => void;
}) {
  const { goals, loading, refresh } = useGoals(undefined, revision, fail);
  const [creating, setCreating] = useState(false);
  const [choosingLead, setChoosingLead] = useState(false);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState('');
  const [leadId, setLeadId] = useState('');
  const [formError, setFormError] = useState('');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [confirmDelete, setConfirmDelete] = useState('');
  const active = goals.filter((goal) => goal.status !== 'complete');
  const waiting = active.filter(needsYou);
  const others = active.filter((goal) => !needsYou(goal));
  const completed = goals.filter((goal) => goal.status === 'complete');
  const available = employees.filter((employee) =>
    conversations.some((c) => c.id === employee.dmId),
  );
  const free = available.filter(
    (employee) => !active.some((goal) => goal.leadAgentId === employee.id),
  );
  const open = (goal: Goal) =>
    onOpenConversation(
      available.find((employee) => employee.id === goal.leadAgentId)?.dmId || goal.conversationId,
    );
  function closeCreate() {
    setCreating(false);
    setChoosingLead(false);
    setTitle('');
    setLeadId('');
    setFormError('');
  }
  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setFormError('');
    try {
      await api('/goals', { title, start: true, ...(leadId ? { leadAgentId: leadId } : {}) });
      await refresh();
      closeCreate();
    } catch (error: any) {
      setFormError(error.message);
    } finally {
      setBusy(false);
    }
  }
  async function change(goal: Goal, patch: object) {
    setBusy(true);
    try {
      await api('/goals/' + goal.id, { ...patch, version: goal.version }, 'PATCH');
      await refresh();
    } catch (error: any) {
      fail(error.message);
      await refresh().catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  async function remove(goal: Goal) {
    setBusy(true);
    try {
      await api('/goals/' + goal.id, {}, 'DELETE');
      setConfirmDelete('');
      await refresh();
    } catch (error: any) {
      fail(error.message);
      await refresh().catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  async function reply(goal: Goal) {
    const answer = (answers[goal.id] || '').trim();
    if (!answer) return;
    setBusy(true);
    try {
      await api('/goals/' + goal.id + '/reply', { answer });
      setAnswers(({ [goal.id]: _sent, ...rest }) => rest);
      await refresh();
    } catch (error: any) {
      fail(error.message);
    } finally {
      setBusy(false);
    }
  }
  function card(goal: Goal) {
    const presentation = goalPresentation(goal);
    const update = goal.updates[0];
    const asking = needsYou(goal);
    const question = goal.execution.state === 'needs_input' ? goal.execution.question.trim() : '';
    const lead = goal.leadAgentName || 'Employee unavailable';
    return (
      <li className={'goal-card' + (asking ? ' needs-you' : '')} key={goal.id}>
        <div className="goal-card-top">
          <button className="goal-title" onClick={() => open(goal)}>
            {goal.title}
          </button>
          <div className="goal-row-controls">
            {/* The Needs you group already says it; repeating it on the card is noise. */}
            {!asking && (
              <span className={`goal-state ${presentation.state}`}>{presentation.label}</span>
            )}
            <button
              type="button"
              className="goal-delete icon"
              disabled={busy}
              aria-label={`Delete ${goal.title}`}
              title="Delete goal"
              onClick={() => setConfirmDelete(confirmDelete === goal.id ? '' : goal.id)}
            >
              <Trash2 size={16} />
            </button>
            <details className="goal-row-menu">
              <summary aria-label={`Manage ${goal.title}`}>
                <MoreHorizontal size={18} />
              </summary>
              <div className="goal-row-options ui-stack">
                <label className="ui-field">
                  Lead
                  <select
                    aria-label={`Lead for ${goal.title}`}
                    value={goal.leadAgentId}
                    disabled={busy}
                    onChange={(event) => void change(goal, { leadAgentId: event.target.value })}
                  >
                    <option value={goal.leadAgentId}>{lead}</option>
                    {(goal.status === 'complete' ? available : free)
                      .filter((employee) => employee.id !== goal.leadAgentId)
                      .map((employee) => (
                        <option key={employee.id} value={employee.id}>
                          {employee.name}
                        </option>
                      ))}
                  </select>
                </label>
                {goal.status === 'active' && goal.execution.state === 'sequenced' ? (
                  <button disabled={busy} onClick={() => void change(goal, { status: 'active' })}>
                    Start now
                  </button>
                ) : goal.status === 'active' && goal.execution.state !== 'saved' ? (
                  <button disabled={busy} onClick={() => void change(goal, { status: 'paused' })}>
                    Pause
                  </button>
                ) : (
                  <button disabled={busy} onClick={() => void change(goal, { status: 'active' })}>
                    {goal.status === 'complete'
                      ? 'Reopen'
                      : goal.execution.state === 'saved'
                        ? 'Start goal'
                        : 'Resume'}
                  </button>
                )}
                {goal.status !== 'complete' && (
                  <button disabled={busy} onClick={() => void change(goal, { status: 'complete' })}>
                    Check completion
                  </button>
                )}
              </div>
            </details>
          </div>
        </div>
        <div className="goal-meta">
          <button
            type="button"
            className="goal-lead"
            onClick={() => open(goal)}
            aria-label={`Talk to ${lead}`}
            title={`Talk to ${lead}`}
          >
            {avatar && goal.leadAgentId && (
              <span className="goal-lead-portrait" aria-hidden="true">
                {avatar(goal.leadAgentId, lead)}
              </span>
            )}
            <span>{lead}</span>
          </button>
          <StepTrail steps={goal.steps} />
        </div>
        {asking ? (
          question ? (
            <form
              className="goal-answer"
              onSubmit={(event) => {
                event.preventDefault();
                void reply(goal);
              }}
            >
              <p className="goal-question">{question}</p>
              <div className="goal-answer-row">
                <textarea
                  rows={1}
                  aria-label={`Answer for ${goal.title}`}
                  placeholder="Your answer"
                  maxLength={4000}
                  value={answers[goal.id] || ''}
                  disabled={busy}
                  onChange={(event) =>
                    setAnswers((current) => ({ ...current, [goal.id]: event.target.value }))
                  }
                  onInput={(event) => {
                    const input = event.currentTarget;
                    input.style.height = 'auto';
                    input.style.height = Math.min(input.scrollHeight, 160) + 'px';
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      void reply(goal);
                    }
                  }}
                />
                <button
                  className="primary"
                  disabled={busy || !(answers[goal.id] || '').trim()}
                >
                  Send
                </button>
              </div>
            </form>
          ) : (
            <div className="goal-answer">
              <p className="goal-question">
                {goal.execution.state === 'needs_permission'
                  ? 'An approval is waiting in the conversation.'
                  : 'A decision is waiting in the conversation.'}
              </p>
              <div>
                <button className="primary" onClick={() => open(goal)}>
                  Open conversation
                </button>
              </div>
            </div>
          )
        ) : (
          <OneLine className="goal-progress-copy" text={presentation.progress} />
        )}
        <details className="goal-evidence">
          <summary>
            Details
            {update && (
              <time className="quiet" dateTime={update.createdAt}>
                {' '}
                &middot; Updated {new Date(update.createdAt).toLocaleDateString()}
              </time>
            )}
          </summary>
          <div className="ui-stack">
            {(goal.current || update?.summary) && <p>{goal.current || update?.summary}</p>}
            <div className="ui-field">
              <strong>Complete when</strong>
              <p>{goal.success || goal.title}</p>
            </div>
            {goal.steps.length > 0 && (
              <ol className="goal-step-list">
                {goal.steps.map((step) => (
                  <li key={step.id} className={step.status}>
                    <strong>{step.title}</strong>
                    {step.doneWhen && <p>{step.doneWhen}</p>}
                    <small className="quiet">
                      {step.status === 'done' && step.evidence.trim()
                        ? 'Step checked: ' + step.evidence
                        : step.status === 'blocked'
                          ? 'Step waiting'
                          : 'Step not yet verified'}
                    </small>
                  </li>
                ))}
              </ol>
            )}
            {goal.status === 'complete' && goal.execution.review?.verdict === 'passed' && (
              <div className="ui-field">
                <strong>Independently checked</strong>
                <ul>
                  {goal.execution.review.checks.map((check) => (
                    <li key={check.criterion}>{check.evidence}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </details>
        {confirmDelete === goal.id && (
          <div
            className="goal-delete-confirm"
            role="alertdialog"
            aria-label={`Delete ${goal.title}?`}
          >
            <p>
              <strong>Delete this goal?</strong>{' '}
              {goal.status === 'active' && !['saved', 'sequenced'].includes(goal.execution.state)
                ? 'Its work stops now and its progress history is removed.'
                : 'Its progress history is removed.'}{' '}
              Conversations stay.
            </p>
            <div className="ui-actions">
              <button
                className="danger-button"
                autoFocus
                disabled={busy}
                onClick={() => void remove(goal)}
              >
                {busy ? 'Deleting…' : 'Delete goal'}
              </button>
              <button type="button" disabled={busy} onClick={() => setConfirmDelete('')}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </li>
    );
  }
  return (
    <section className="goals-view" aria-label="Goals">
      <div className="goals-heading">
        {creating ? (
          <form className="goal-create" onSubmit={create} aria-label="New goal">
            <div className="goal-create-row">
              <input
                autoFocus
                aria-label="What do you want to achieve?"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape' && !busy) closeCreate();
                }}
                maxLength={240}
                required
                disabled={busy}
                placeholder="What do you want to achieve?"
              />
              <button className="primary" disabled={busy || !title.trim()}>
                {busy ? 'Creating…' : 'Create goal'}
              </button>
              <button type="button" disabled={busy} onClick={closeCreate}>
                Cancel
              </button>
            </div>
            {choosingLead ? (
              <label className="goal-create-lead">
                Led by
                <select
                  value={leadId}
                  onChange={(event) => setLeadId(event.target.value)}
                  disabled={busy}
                >
                  <option value="">Chief of Staff chooses</option>
                  {free.map((employee) => (
                    <option key={employee.id} value={employee.id}>
                      {employee.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <button
                type="button"
                className="goal-create-lead-toggle"
                onClick={() => setChoosingLead(true)}
              >
                The Chief of Staff chooses who leads it · Choose yourself
              </button>
            )}
            {formError && <p role="alert">{formError}</p>}
          </form>
        ) : (
          <button
            className="primary"
            onClick={() => {
              setCreating(true);
              setFormError('');
            }}
          >
            <Plus size={16} /> New goal
          </button>
        )}
      </div>
      {loading ? (
        <p className="quiet goal-empty">Loading goals…</p>
      ) : !goals.length ? (
        <p className="quiet goal-empty">No goals yet. What do you want to achieve?</p>
      ) : (
        <div className="goal-sections">
          {waiting.length > 0 && (
            <section className="goal-section needs-you" aria-labelledby="goals-needs-you">
              <h3 id="goals-needs-you">
                Needs you <span>{waiting.length}</span>
              </h3>
              <ul className="goal-projects" aria-label="Goals that need you">
                {waiting.map(card)}
              </ul>
            </section>
          )}
          {others.length > 0 && (
            <section className="goal-section" aria-labelledby="goals-in-motion">
              <h3 id="goals-in-motion">
                {waiting.length ? 'Everything else' : 'In progress'} <span>{others.length}</span>
              </h3>
              <ul className="goal-projects" aria-label="Other open goals">
                {others.map(card)}
              </ul>
            </section>
          )}
          {completed.length > 0 && (
            <details className="goal-section completed-goals">
              <summary id="completed-goals-heading">
                Completed <span>{completed.length}</span>
              </summary>
              <ul className="goal-projects" aria-label="Completed goals">
                {completed.map(card)}
              </ul>
            </details>
          )}
        </div>
      )}
    </section>
  );
}
