import { useEffect, useState } from 'react';
import { ArrowRight, Check, Pause, Play, Plus, Target } from 'lucide-react';
import { api } from './api';
import './goals.css';

type Step = { id: string; title: string; doneWhen: string; status: string; evidence: string };
type Goal = {
  id: string;
  conversationId: string;
  leadAgentId: string | null;
  leadAgentName: string | null;
  leadAgentActive: boolean;
  title: string;
  success: string;
  current: string;
  nextStep: string;
  status: 'active' | 'paused' | 'complete';
  version: number;
  steps: Step[];
  updates: { id: string; summary: string; evidence: string; createdAt: string }[];
};

function useGoals(
  conversationId: string | undefined,
  revision: number,
  fail: (message: string) => void,
) {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [loading, setLoading] = useState(true);
  const refresh = async () => {
    const query = conversationId ? '?conversationId=' + encodeURIComponent(conversationId) : '';
    setGoals(await api('/goals' + query));
    setLoading(false);
  };
  useEffect(() => {
    void refresh().catch((error) => {
      setLoading(false);
      fail(error.message);
    });
  }, [conversationId, revision]);
  return { goals, loading, refresh };
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
  const active = goals.filter((goal) => goal.status === 'active');
  if (!active.length) return null;
  return (
    <button
      className="conversation-goals"
      onClick={onOpen}
      aria-label="Open goals for this conversation"
    >
      <Target size={16} aria-hidden="true" />
      <span>
        <strong>{active[0].title}</strong>
        <small>{active[0].nextStep || active[0].success}</small>
      </span>
      {active.length > 1 && <em>+{active.length - 1}</em>}
      <ArrowRight size={15} aria-hidden="true" />
    </button>
  );
}

export function GoalsView({
  conversationId,
  conversations,
  employees,
  revision,
  onOpenConversation,
  fail,
}: {
  conversationId: string;
  conversations: any[];
  employees: { id: string; name: string; dmId: string }[];
  revision: number;
  onOpenConversation: (id: string) => void;
  fail: (message: string) => void;
}) {
  const { goals, loading, refresh } = useGoals(undefined, revision, fail);
  const [selectedId, setSelectedId] = useState<string>('');
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState('');
  const [success, setSuccess] = useState('');
  const [next, setNext] = useState('');
  const [newLeadId, setNewLeadId] = useState('');
  const [update, setUpdate] = useState('');
  const [evidence, setEvidence] = useState('');
  const selected = goals.find((goal) => goal.id === selectedId) || goals[0];
  const availableLeads = employees.filter((agent) =>
    conversations.some((conversation) => conversation.id === agent.dmId),
  );
  const initialLeadId =
    availableLeads.find((agent) => agent.dmId === conversationId)?.id ||
    availableLeads[0]?.id ||
    '';
  const leadConversation = availableLeads.find((agent) => agent.id === selected?.leadAgentId)?.dmId;
  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (!conversationId) return fail('Open a conversation to start a goal.');
    setBusy(true);
    try {
      const goal = await api('/goals', {
        conversationId,
        title,
        success,
        nextStep: next,
        ...(newLeadId || initialLeadId ? { leadAgentId: newLeadId || initialLeadId } : {}),
      });
      await refresh();
      setSelectedId(goal.id);
      setCreating(false);
      setTitle('');
      setSuccess('');
      setNext('');
      setNewLeadId('');
    } catch (error: any) {
      fail(error.message);
    } finally {
      setBusy(false);
    }
  }
  async function changeLead(leadAgentId: string) {
    if (!selected || !leadAgentId) return;
    setBusy(true);
    try {
      await api('/goals/' + selected.id, { leadAgentId, version: selected.version }, 'PATCH');
      await refresh();
    } catch (error: any) {
      fail(error.message);
      await refresh().catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  async function status(value: Goal['status']) {
    if (!selected) return;
    setBusy(true);
    try {
      await api('/goals/' + selected.id, { status: value, version: selected.version }, 'PATCH');
      await refresh();
    } catch (error: any) {
      fail(error.message);
      await refresh().catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  async function saveUpdate(event: React.FormEvent) {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    try {
      await api('/goals/' + selected.id + '/updates', { summary: update, evidence });
      await refresh();
      setUpdate('');
      setEvidence('');
    } catch (error: any) {
      fail(error.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="goals-view">
      <div className="goals-heading">
        <div>
          <h2>Goals</h2>
          <p>Keep the destination clear. Work out the next step together in the conversation.</p>
        </div>
        <button className="primary" onClick={() => setCreating(!creating)}>
          <Plus size={16} /> New goal
        </button>
      </div>
      {creating && (
        <form className="goal-create ui-stack" onSubmit={create}>
          <label className="ui-field">
            What do you want to achieve?
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={240}
              required
              placeholder="Grow PollyTalks to $10K in monthly revenue"
            />
          </label>
          <label className="ui-field">
            How will you know it worked?
            <input
              value={success}
              onChange={(e) => setSuccess(e.target.value)}
              maxLength={240}
              required
              placeholder="Monthly revenue reaches $10K"
            />
          </label>
          <label className="ui-field">
            What should happen first? <span className="quiet">Optional</span>
            <input
              value={next}
              onChange={(e) => setNext(e.target.value)}
              maxLength={2000}
              placeholder="Establish the starting revenue and customer mix"
            />
          </label>
          {!!availableLeads.length && (
            <label className="ui-field">
              Who will keep this moving?
              <select
                value={newLeadId || initialLeadId}
                onChange={(event) => setNewLeadId(event.target.value)}
              >
                {availableLeads.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="ui-actions">
            <button className="primary" disabled={busy}>
              Save goal
            </button>
            <button type="button" className="quiet-button" onClick={() => setCreating(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {loading ? (
        <p className="quiet">Loading goals…</p>
      ) : !goals.length ? (
        <div className="goal-empty">
          <Target size={25} />
          <h3>Start with an outcome</h3>
          <p>
            Tell an agent what you want to achieve, or add a goal here. Smaller tasks can stay in
            the conversation.
          </p>
        </div>
      ) : (
        <div className="goals-layout">
          <div className="goals-list" aria-label="Goals">
            {goals.map((goal) => (
              <button
                key={goal.id}
                className={`goal-list-item${selected?.id === goal.id ? ' selected' : ''}`}
                onClick={() => setSelectedId(goal.id)}
              >
                <span className={`goal-status ${goal.status}`} />
                <span>
                  <strong>{goal.title}</strong>
                  <small>
                    {goal.status === 'complete'
                      ? 'Complete'
                      : goal.status === 'paused'
                        ? 'Paused'
                        : goal.nextStep || 'Ready for the next step'}
                  </small>
                </span>
              </button>
            ))}
          </div>
          {selected && (
            <article className="goal-detail">
              <div className="goal-detail-top">
                <span className="goal-eyebrow">
                  {selected.status === 'active' ? 'In progress' : selected.status}
                </span>
                <div className="goal-actions">
                  {selected.status === 'active' && (
                    <button
                      className="quiet-button"
                      disabled={busy}
                      onClick={() => status('paused')}
                    >
                      <Pause size={14} /> Pause
                    </button>
                  )}
                  {selected.status !== 'active' && (
                    <button
                      className="quiet-button"
                      disabled={busy}
                      onClick={() => status('active')}
                    >
                      <Play size={14} /> Resume
                    </button>
                  )}
                  {selected.status !== 'complete' && (
                    <button
                      className="quiet-button"
                      disabled={busy}
                      onClick={() => status('complete')}
                    >
                      <Check size={14} /> Complete
                    </button>
                  )}
                </div>
              </div>
              <h3>{selected.title}</h3>
              <div className="goal-facts">
                <label className="ui-field goal-lead-field">
                  Lead agent
                  <select
                    value={selected.leadAgentId || ''}
                    onChange={(event) => void changeLead(event.target.value)}
                    disabled={busy || !availableLeads.length}
                  >
                    {!selected.leadAgentId && <option value="">Choose an agent</option>}
                    {selected.leadAgentId &&
                      !availableLeads.some((agent) => agent.id === selected.leadAgentId) && (
                        <option value={selected.leadAgentId} disabled>
                          {selected.leadAgentName || 'Previous agent'} (unavailable)
                        </option>
                      )}
                    {availableLeads.map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.name}
                      </option>
                    ))}
                  </select>
                </label>
                <div>
                  <span>What success looks like</span>
                  <p>{selected.success}</p>
                </div>
                <div>
                  <span>Where things stand</span>
                  <p>{selected.current || 'We have not established the starting point yet.'}</p>
                </div>
                <div>
                  <span>Next step</span>
                  <p>{selected.nextStep || 'Decide on the first useful step together.'}</p>
                </div>
              </div>
              {!!selected.steps.length && (
                <section className="goal-section">
                  <h4>Steps and checks</h4>
                  <ol>
                    {selected.steps.map((step) => (
                      <li key={step.id}>
                        <span className={`goal-step-mark ${step.status}`}>
                          {step.status === 'done' ? <Check size={13} /> : null}
                        </span>
                        <div>
                          <strong>{step.title}</strong>
                          {step.doneWhen && <small>Done when: {step.doneWhen}</small>}
                          {step.evidence && <small>Result: {step.evidence}</small>}
                        </div>
                      </li>
                    ))}
                  </ol>
                </section>
              )}
              <section className="goal-section">
                <h4>Progress</h4>
                {selected.updates.length ? (
                  selected.updates.map((item) => (
                    <div className="goal-update" key={item.id}>
                      <time>{new Date(item.createdAt).toLocaleDateString()}</time>
                      <p>{item.summary}</p>
                      {item.evidence && <small>{item.evidence}</small>}
                    </div>
                  ))
                ) : (
                  <p className="quiet">The first update will appear here.</p>
                )}
                <form className="goal-update-form ui-stack" onSubmit={saveUpdate}>
                  <label className="ui-field">
                    Add an update
                    <textarea
                      value={update}
                      onChange={(e) => setUpdate(e.target.value)}
                      maxLength={2000}
                      required
                      placeholder="What changed or what did we learn?"
                    />
                  </label>
                  <label className="ui-field">
                    Result or evidence <span className="quiet">Optional</span>
                    <input
                      value={evidence}
                      onChange={(e) => setEvidence(e.target.value)}
                      maxLength={2000}
                      placeholder="A number, check, or link"
                    />
                  </label>
                  <div className="ui-actions">
                    <button disabled={busy || !update.trim()} className="quiet-button">
                      Save update
                    </button>
                  </div>
                </form>
              </section>
              <button
                className="goal-conversation-link quiet-button"
                onClick={() => onOpenConversation(leadConversation || selected.conversationId)}
              >
                Continue in{' '}
                {(selected.leadAgentActive && selected.leadAgentName) ||
                  conversations.find((item) => item.id === selected.conversationId)?.name ||
                  'conversation'}{' '}
                <ArrowRight size={15} />
              </button>
            </article>
          )}
        </div>
      )}
    </section>
  );
}
