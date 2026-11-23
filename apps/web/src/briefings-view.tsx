import { useEffect, useRef, useState } from 'react';
import { Mic, MicOff, MoreHorizontal } from 'lucide-react';
import { api } from './api';
import { BriefingVoice, type VoiceState } from './briefing-voice';
import { briefingCommand, briefBeforeFinish, nextQuestion, readback } from './briefing-controller';
import type { Briefing } from '../../service/src/briefings';
import './briefings.css';

type Person = { id: string; name: string; role: string };
export function BriefingsView({ conversationId, initialBriefingId }: { conversationId?: string; initialBriefingId?: string }) {
  const [roster, setRoster] = useState<Person[]>([]),
    [selected, setSelected] = useState<string[]>([]);
  const [history, setHistory] = useState<any[]>([]),
    [meeting, setMeeting] = useState<Briefing | null>(null);
  const [setup, setSetup] = useState({ configured: false, model: 'gpt-realtime-2.1' });
  const [setupOpen, setSetupOpen] = useState(false),
    [key, setKey] = useState('');
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [draft, setDraft] = useState(''),
    [answer, setAnswer] = useState(''),
    [caption, setCaption] = useState('');
  const [voiceState, setVoiceState] = useState<VoiceState>('off'),
    [muted, setMuted] = useState(false);
  const [automatic, setAutomatic] = useState(false),
    [typing, setTyping] = useState(false);
  const [activeQuestionId, setActiveQuestionId] = useState('');
  const current = useRef<Briefing | null>(null),
    draftRef = useRef(''),
    answerRef = useRef('');
  const voice = useRef<BriefingVoice | null>(null),
    alive = useRef(true),
    locked = useRef(false);
  const writes = useRef(Promise.resolve()),
    seen = useRef(new Set<string>()),
    readbackReady = useRef(false);
  const autoRef = useRef(false),
    connected = useRef(''),
    lastConnect = useRef(0);
  const question =
    meeting?.questions.find((q) => q.id === activeQuestionId && q.state === 'queued') ||
    (meeting ? nextQuestion(meeting) : undefined);
  const speaker = meeting?.participants.find((p) => p.id === question?.employeeId);
  const listening = ['listening', 'transcribing'].includes(voiceState);
  function update(b: Briefing) {
    current.current = b;
    setMeeting(b);
  }
  function changeDraft(text: string) {
    draftRef.current = text;
    setDraft(text);
  }
  function changeAnswer(text: string) {
    answerRef.current = text;
    setAnswer(text);
  }
  function stop() {
    voice.current?.close();
    voice.current = null;
    connected.current = '';
    setMuted(false);
    readbackReady.current = false;
  }
  function auto(value: boolean) {
    autoRef.current = value;
    setAutomatic(value);
  }
  async function act(work: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (e: any) {
      auto(false);
      stop();
      setError(e.message);
    } finally {
      locked.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function home() {
    const [people, meetings, settings] = await Promise.all([
      api('/briefings/roster'),
      api('/briefings'),
      api('/briefings/voice'),
    ]);
    if (!alive.current) return;
    setRoster(people);
    setSelected(people.map((p: Person) => p.id));
    setHistory(meetings);
    setSetup(settings);
  }
  useEffect(() => {
    alive.current = true;
    void home()
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
    return () => {
      alive.current = false;
      voice.current?.close();
    };
  }, []);
  useEffect(() => {
    if (initialBriefingId) void act(async () => load(await api(`/briefings/${initialBriefingId}`)));
  }, [initialBriefingId]);
  useEffect(() => {
    if (!meeting || meeting.phase !== 'questions') return;
    let active = true;
    const timer = setInterval(
      () =>
        void api(`/briefings/${meeting.id}`)
          .then((b) => {
            if (
              active &&
              !locked.current &&
              current.current?.id === b.id &&
              (current.current?.version || 0) <= b.version
            )
              update(b);
          })
          .catch((e) => {
            if (active) setError(e.message);
          }),
      1500,
    );
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [meeting?.id, meeting?.phase]);
  useEffect(() => {
    if (!meeting || meeting.phase !== 'brief' || draft === meeting.brief) return;
    const timer = setTimeout(() => {
      writes.current = writes.current
        .then(async () => {
          if (
            current.current?.id === meeting.id &&
            current.current.phase === 'brief' &&
            !locked.current
          )
            await api(`/briefings/${meeting.id}/brief`, { brief: draftRef.current }, 'PUT');
        })
        .catch((e) => setError(e.message));
    }, 500);
    return () => clearTimeout(timer);
  }, [draft, meeting?.id, meeting?.phase]);
  // The controller waits for preparation and chooses one speaker; the human never manages a queue.
  useEffect(() => {
    if (!automatic || !meeting || busy || locked.current || meeting.phase === 'complete') return;
    if (meeting.phase === 'questions' && !question) {
      if (meeting.participants.every((p) => !['waiting', 'preparing'].includes(p.state)))
        void finish();
      return;
    }
    const target = meeting.id + ':' + meeting.phase + ':' + (question?.id || '');
    if (connected.current === target) return;
    // Start immediately; only rapid handoffs need the server's reconnect cooldown.
    const delay = Math.max(0, 1600 - (Date.now() - lastConnect.current));
    const timer = setTimeout(() => connect(), delay);
    return () => clearTimeout(timer);
  }, [
    automatic,
    meeting?.id,
    meeting?.phase,
    question?.id,
    meeting?.participants.some((p) => ['waiting', 'preparing'].includes(p.state)),
    busy,
  ]);
  function load(b: Briefing) {
    auto(false);
    stop();
    update(b);
    changeDraft(b.brief);
    changeAnswer('');
    setActiveQuestionId('');
    setCaption('');
    seen.current.clear();
    setTyping(false);
  }
  function connect() {
    const b = current.current;
    if (!b || b.phase === 'complete') return;
    const q =
      b.questions.find((q) => q.id === activeQuestionId && q.state === 'queued') || nextQuestion(b);
    if (b.phase === 'questions' && !q) return;
    stop();
    setError('');
    setCaption('');
    setActiveQuestionId(q?.id || '');
    connected.current = b.id + ':' + b.phase + ':' + (q?.id || '');
    lastConnect.current = Date.now();
    const client = new BriefingVoice({
      state: (s) => {
        if (alive.current) setVoiceState(s);
      },
      error: (message) => {
        if (alive.current) {
          auto(false);
          setError(message);
        }
      },
      readbackDone: () => {
        if (voice.current === client) readbackReady.current = true;
      },
      transcript: (id, text, human) => {
        if (voice.current !== client || !text.trim() || seen.current.has(id)) return;
        seen.current.add(id);
        setCaption(
          `${human ? 'You' : b.participants.find((p) => p.id === q?.employeeId)?.name || 'Abralo'}: ${text}`,
        );
        const command = human ? briefingCommand(text) : null;
        const ending = human ? briefBeforeFinish(text) : null;
        if (human && b.phase === 'review' && command === 'confirm') {
          if (readbackReady.current) void send();
          else
            setError(
              'Let the full readback finish before saying “Go ahead”, or check the proposed work and use the button.',
            );
          return;
        }
        if (human && ending !== null && ['brief', 'questions'].includes(b.phase)) {
          if (ending) {
            if (b.phase === 'brief') changeDraft((draftRef.current + '\n' + ending).trim());
            else changeAnswer((answerRef.current + '\n' + ending).trim());
          }
          void finish();
          return;
        }
        if (human && b.phase === 'questions' && command === 'next' && q) {
          void recordAnswer(q.id, answerRef.current, !answerRef.current.trim());
          return;
        }
        if (human && b.phase === 'brief') {
          changeDraft((draftRef.current + '\n' + text).trim());
        }
        if (human && b.phase === 'questions')
          changeAnswer((answerRef.current + '\n' + text).trim());
        if (human && b.phase === 'review') readbackReady.current = false;
        writes.current = writes.current
          .then(async () => {
            await api(`/briefings/${b.id}/turns`, {
              id,
              text,
              speaker: human ? 'You' : q?.employeeId || 'Host',
              questionId: q?.id,
            });
          })
          .catch((e) => setError(e.message));
      },
      next: async (text, defer) => {
        if (voice.current === client && q) await recordAnswer(q.id, text, defer);
      },
      revise: async (actions) => {
        if (voice.current !== client) return;
        await act(async () => {
          stop();
          await writes.current;
          const fresh = await api(`/briefings/${b.id}`);
          update(
            await api(
              `/briefings/${b.id}/actions`,
              {
                version: fresh.version,
                actions: actions.map((a) => ({
                  ...a,
                  id:
                    fresh.actions.find((old: any) => old.employeeId === a.employeeId)?.id ||
                    crypto.randomUUID(),
                })),
              },
              'PUT',
            ),
          );
        });
      },
    });
    voice.current = client;
    void client
      .connect(
        b.id,
        b.phase === 'questions' ? q?.id : undefined,
        b.phase === 'review' ? readback(b) : undefined,
      )
      .then(() => {
        // Count the handoff cooldown after setup; microphone permission can take time.
        if (voice.current === client) lastConnect.current = Date.now();
      });
  }
  async function start(withVoice: boolean) {
    if (withVoice && !setup.configured) {
      setSetupOpen(true);
      return;
    }
    await act(async () => {
      const b = await api('/briefings', { employeeIds: selected, conversationId });
      load(b);
      setTyping(!withVoice);
      auto(withVoice);
    });
  }
  async function finish() {
    await act(async () => {
      const b = current.current;
      if (!b) return;
      stop();
      await writes.current;
      if (b.phase === 'brief') {
        update(await api(`/briefings/${b.id}/prepare`, { brief: draftRef.current }));
      } else if (b.phase === 'questions') {
        const q =
          b.questions.find((q) => q.id === activeQuestionId && q.state === 'queued') ||
          nextQuestion(b);
        if (q && answerRef.current.trim())
          await api(`/briefings/${b.id}/answer`, { questionId: q.id, answer: answerRef.current });
        let reviewed = await api(`/briefings/${b.id}/review`, {});
        // Everything in this list is still only a proposal until the single explicit confirmation.
        reviewed = await api(
          `/briefings/${b.id}/actions`,
          {
            version: reviewed.version,
            actions: reviewed.actions.map((a: any) => ({ ...a, selected: true })),
          },
          'PUT',
        );
        update(reviewed);
        changeAnswer('');
      }
    });
  }
  async function recordAnswer(qid: string, text: string, defer: boolean) {
    await act(async () => {
      const b = current.current;
      if (!b || b.phase !== 'questions') return;
      stop();
      await writes.current;
      const original = b.questions.find((q) => q.id === qid);
      const normalize = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
      let updated = b;
      for (const q of b.questions.filter(
        (q) => q.state === 'queued' && normalize(q.text) === normalize(original?.text || ''),
      ))
        updated = await api(`/briefings/${b.id}/answer`, { questionId: q.id, answer: text, defer });
      update(updated);
      changeAnswer('');
      setActiveQuestionId('');
      setCaption('');
    });
  }
  async function saveActions(actions: Briefing['actions']) {
    await act(async () => {
      const b = current.current!;
      stop();
      await writes.current;
      const fresh = await api(`/briefings/${b.id}`);
      update(await api(`/briefings/${b.id}/actions`, { version: fresh.version, actions }, 'PUT'));
    });
  }
  async function send() {
    await act(async () => {
      const b = current.current;
      if (!b || b.phase !== 'review') return;
      auto(false);
      stop();
      await writes.current;
      const fresh = await api(`/briefings/${b.id}`);
      // Do not approve changes made by another tab after this readback.
      if (JSON.stringify(fresh.actions) !== JSON.stringify(b.actions)) {
        update(fresh);
        throw new Error('The proposed work changed. Please review it again.');
      }
      update(
        await api(`/briefings/${b.id}/dispatch`, {
          version: fresh.version,
          actions: b.actions.filter((a) => a.text.trim()),
        }),
      );
      setCaption('');
    });
  }
  const status = muted
    ? 'Microphone muted'
    : {
        off: 'Microphone off',
        connecting: 'Connecting…',
        ready: 'Listening',
        listening: 'Listening…',
        transcribing: 'Finishing your thought…',
        speaking: 'Speaking · you can interrupt',
      }[voiceState];
  const title = !meeting
    ? 'What matters today?'
    : meeting.phase === 'brief'
      ? voiceState === 'off'
        ? 'Your brief.'
        : 'Your team is listening.'
      : meeting.phase === 'questions'
        ? speaker
          ? `${speaker.name} has a question.`
          : 'Your team is thinking.'
        : meeting.phase === 'review'
          ? 'Here’s what happens next.'
          : 'Everyone has the brief.';
  return (
    <section className="briefings-view">
      <div className="briefing-scroll ui-stack">
        <header className="briefing-heading">
          <details className="briefing-options">
            <summary aria-label="Briefing options">
              <MoreHorizontal size={20} />
            </summary>
            <div className="ui-stack">
              <span className="briefing-experiment">Experimental</span>
              {automatic && (
                <button
                  className="quiet-button"
                  onClick={(e) => {
                    auto(false);
                    stop();
                    e.currentTarget.closest('details')?.removeAttribute('open');
                  }}
                >
                  Pause
                </button>
              )}
              <button className="quiet-button" onClick={() => setSetupOpen(!setupOpen)}>
                Voice setup
              </button>
              {meeting && meeting.phase !== 'complete' && (
                <button
                  className="quiet-button"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      auto(false);
                      stop();
                      await writes.current;
                      if (meeting.phase === 'brief')
                        await api(
                          `/briefings/${meeting.id}/brief`,
                          { brief: draftRef.current },
                          'PUT',
                        );
                      current.current = null;
                      setMeeting(null);
                      await home();
                    })
                  }
                >
                  Save and leave
                </button>
              )}
            </div>
          </details>
        </header>
        {error && (
          <div className="briefing-error ui-stack" role="alert">
            <span>{error}</span>
            <button className="quiet-button" onClick={() => setError('')}>
              Dismiss
            </button>
          </div>
        )}
        {setupOpen && (
          <form
            className="briefing-panel ui-stack"
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                setSetup(await api('/briefings/voice', { key, model: setup.model }, 'PUT'));
                setKey('');
                setSetupOpen(false);
              });
            }}
          >
            <h3>Connect voice once</h3>
            <p>
              Uses OpenAI API billing. Your key is encrypted on this computer. Audio and briefing
              context are shared with OpenAI while connected.
            </p>
            <label className="ui-field">
              OpenAI API key
              <input
                type="password"
                autoComplete="off"
                value={key}
                onChange={(e) => setKey(e.target.value)}
              />
            </label>
            <details>
              <summary>Advanced</summary>
              <label className="ui-field">
                Voice model
                <select
                  value={setup.model}
                  onChange={(e) => setSetup({ ...setup, model: e.target.value })}
                >
                  <option value="gpt-realtime-2.1">GPT Realtime 2.1</option>
                  <option value="gpt-realtime-2">GPT Realtime 2</option>
                  <option value="gpt-realtime">GPT Realtime</option>
                </select>
              </label>
            </details>
            <div className="ui-actions">
              <button className="primary" disabled={busy || !key.trim()}>
                Save voice connection
              </button>
              <button
                type="button"
                className="quiet-button"
                onClick={() => {
                  setKey('');
                  setSetupOpen(false);
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        )}
        <div className="briefing-stage ui-stack">
          <div className={`briefing-orb ${voiceState}`} aria-hidden="true">
            <Mic size={28} strokeWidth={1.3} />
          </div>
          <h2>{title}</h2>
          {meeting?.phase === 'questions' && question && (
            <p className="briefing-subtitle">{question.text}</p>
          )}
          {meeting?.phase === 'complete' && (
            <p className="briefing-subtitle">Your recap is saved.</p>
          )}
          {!meeting && !loading && (
            <details className="briefing-team">
              <summary>
                {selected.length === roster.length
                  ? 'Your whole team'
                  : `${selected.length} employees`}{' '}
                · {roster.length} employees
              </summary>
              <div className="briefing-roster">
                {roster.map((p) => (
                  <label className="briefing-person" key={p.id}>
                    <input
                      type="checkbox"
                      checked={selected.includes(p.id)}
                      onChange={(e) =>
                        setSelected((ids) =>
                          e.target.checked ? [...ids, p.id] : ids.filter((id) => id !== p.id),
                        )
                      }
                    />
                    <span>
                      <strong>{p.name}</strong>
                      <small>{p.role}</small>
                    </span>
                  </label>
                ))}
              </div>
            </details>
          )}
          {loading && <p role="status">Loading your team…</p>}
          {meeting && ['review', 'complete'].includes(meeting.phase) && (
            <div className="briefing-recap ui-stack">
              {meeting.actions
                .filter((a) => a.selected)
                .map((a) => (
                  <div key={a.id}>
                    <strong>{meeting.participants.find((p) => p.id === a.employeeId)?.name}</strong>
                    <p>{a.text}</p>
                  </div>
                ))}
              {!meeting.actions.some((a) => a.selected) && (
                <p>Share the brief for awareness. No new assignments.</p>
              )}
              {meeting.questions.some((q) => q.state === 'deferred') && (
                <p>
                  {meeting.questions.filter((q) => q.state === 'deferred').length} questions left
                  for follow-up.
                </p>
              )}
              {meeting.participants.some((p) => p.state === 'unavailable') && (
                <p>
                  {meeting.participants.filter((p) => p.state === 'unavailable').length} employees
                  could not prepare in this session.
                </p>
              )}
            </div>
          )}
          {meeting && meeting.phase !== 'complete' && (
            <span role="status">{busy ? 'Saving…' : status}</span>
          )}
        </div>
        {meeting && (
          <details className="briefing-details" open={typing || undefined}>
            <summary onClick={() => setTyping(false)}>
              {meeting.phase === 'review' ? 'Edit proposed work' : 'Transcript & details'}
            </summary>
            <div className="ui-stack">
              {caption && (
                <p className="briefing-caption" aria-live="polite">
                  {caption}
                </p>
              )}
              {meeting.phase === 'brief' ? (
                <label className="ui-field">
                  Your briefing
                  <textarea
                    rows={5}
                    maxLength={20000}
                    value={draft}
                    onChange={(e) => changeDraft(e.target.value)}
                  />
                </label>
              ) : (
                <p className="briefing-text">{meeting.brief}</p>
              )}
              {meeting.phase === 'questions' && question && (
                <>
                  <label className="ui-field">
                    Your answer
                    <textarea
                      rows={3}
                      maxLength={6000}
                      value={answer}
                      onChange={(e) => changeAnswer(e.target.value)}
                    />
                  </label>
                  <div className="ui-actions">
                    <button
                      className="secondary"
                      disabled={busy || listening || !answer.trim()}
                      onClick={() => void recordAnswer(question.id, answerRef.current, false)}
                    >
                      Answer & next
                    </button>
                    <button
                      className="quiet-button"
                      disabled={busy || listening}
                      onClick={() => void recordAnswer(question.id, '', true)}
                    >
                      Ask me later
                    </button>
                  </div>
                </>
              )}
              {meeting.phase === 'review' && (
                <>
                  <p>Edit an instruction or remove it from this briefing.</p>
                  {meeting.actions.map((a) => (
                    <div key={a.id} className="ui-stack">
                      <label className="ui-field">
                        {meeting.participants.find((p) => p.id === a.employeeId)?.name}
                        <textarea
                          aria-label={`Assignment for ${meeting.participants.find((p) => p.id === a.employeeId)?.name}`}
                          rows={3}
                          value={a.text}
                          maxLength={3000}
                          onChange={(e) => {
                            auto(false);
                            stop();
                            update({
                              ...meeting,
                              actions: meeting.actions.map((old) =>
                                old.id === a.id ? { ...old, text: e.target.value } : old,
                              ),
                            });
                          }}
                          onBlur={() => void saveActions(current.current!.actions)}
                        />
                      </label>
                      <button
                        className="quiet-button"
                        disabled={busy}
                        onClick={() =>
                          void saveActions(meeting.actions.filter((old) => old.id !== a.id))
                        }
                      >
                        Remove {meeting.participants.find((p) => p.id === a.employeeId)?.name}’s
                        assignment
                      </button>
                    </div>
                  ))}
                  <label className="ui-field">
                    Add an assignment
                    <select
                      value=""
                      onChange={(e) => {
                        if (e.target.value) {
                          auto(false);
                          void saveActions([
                            ...meeting.actions,
                            {
                              id: crypto.randomUUID(),
                              employeeId: e.target.value,
                              text: '',
                              selected: true,
                            },
                          ]);
                        }
                      }}
                    >
                      <option value="">Choose an employee</option>
                      {meeting.participants
                        .filter((p) => !meeting.actions.some((a) => a.employeeId === p.id))
                        .map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                    </select>
                  </label>
                </>
              )}
              {meeting.turns.map((t) => (
                <p key={t.id}>
                  <strong>
                    {t.speaker === 'You'
                      ? 'You'
                      : meeting.participants.find((p) => p.id === t.speaker)?.name || 'Abralo'}
                    :
                  </strong>{' '}
                  {t.text}
                </p>
              ))}
            </div>
          </details>
        )}
        {!meeting && history.length > 0 && (
          <details className="briefing-details">
            <summary>Previous briefings</summary>
            <div className="ui-stack">
              {history.map((b) => (
                <button
                  className="briefing-history"
                  key={b.id}
                  onClick={() => void act(async () => load(await api(`/briefings/${b.id}`)))}
                >
                  {new Date(b.createdAt).toLocaleDateString()} · {b.count} employees ·{' '}
                  {b.phase === 'complete' ? 'View recap' : 'Resume'}
                </button>
              ))}
            </div>
          </details>
        )}
      </div>
      <footer
        className={`briefing-footer${meeting && meeting.phase !== 'complete' && voiceState !== 'off' ? ' has-live-voice' : ''}`}
      >
        <div className="ui-actions">
          {!meeting ? (
            <>
              <button
                className="primary"
                disabled={busy || loading || !selected.length}
                onClick={() => void start(true)}
              >
                <Mic size={16} />
                {setup.configured ? 'Start briefing' : 'Connect voice to begin'}
              </button>
              <button
                className="quiet-button"
                disabled={busy || loading || !selected.length}
                onClick={() => void start(false)}
              >
                Type instead
              </button>
            </>
          ) : meeting.phase === 'complete' ? (
            <button
              className="primary"
              onClick={() =>
                void act(async () => {
                  current.current = null;
                  setMeeting(null);
                  await home();
                })
              }
            >
              Done
            </button>
          ) : (
            <>
              {voiceState !== 'off' ? (
                <button
                  className="quiet-button briefing-mute"
                  aria-label={muted ? 'Unmute' : 'Mute'}
                  title={muted ? 'Unmute' : 'Mute'}
                  aria-pressed={muted}
                  onClick={() => {
                    voice.current?.mute(!muted);
                    setMuted(!muted);
                  }}
                >
                  {muted ? <MicOff size={16} /> : <Mic size={16} />}
                </button>
              ) : (
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() => {
                    if (!setup.configured) setSetupOpen(true);
                    else {
                      auto(true);
                      connect();
                    }
                  }}
                >
                  {setup.configured ? 'Resume voice' : 'Connect voice'}
                </button>
              )}
              <button
                className="primary"
                disabled={
                  busy ||
                  listening ||
                  (meeting.phase === 'brief' && !draft.trim()) ||
                  (meeting.phase === 'review' &&
                    meeting.actions.some((a) => a.selected && !a.text.trim()))
                }
                onClick={() => void (meeting.phase === 'review' ? send() : finish())}
              >
                {meeting.phase === 'brief'
                  ? 'Take questions'
                  : meeting.phase === 'questions'
                    ? 'That’s everything'
                    : 'Go ahead'}
              </button>
            </>
          )}
        </div>
      </footer>
    </section>
  );
}
