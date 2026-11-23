import { useEffect, useRef, useState } from 'react';
import { Mic, MicOff, PhoneOff } from 'lucide-react';
import { ChiefPresence, type PresenceHandle } from './chief-presence';
import { api } from './api';
import { briefingWrite } from './briefing-write';
import { LiveThought, type CaptionEntry } from './live-thought';
import { ConversationTranscript } from './conversation-transcript';
import { BriefingVoice, type VoiceState } from './briefing-voice';
import { briefingCommand } from './briefing-controller';
import { PlanChecklist } from './plan-checklist';
import { BriefingsView as PreviousBriefings } from './briefings-view';
import type { Briefing } from '../../service/src/briefings';
import './briefings.css';
import './chief-presence.css';

type Person = { id: string; name: string; role: string };
function recapText(b: Briefing) {
  return [
    b.recap,
    ...b.actions
      .filter((a) => a.selected)
      .map((a) => `${b.participants.find((p) => p.id === a.employeeId)?.name}: ${a.text}`),
    b.actions.some((a) => a.selected)
      ? 'Say “Go ahead” to send these assignments, or tell me what to change.'
      : 'No new assignments. Say “Go ahead” to save this recap, or tell me what to change.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function BriefingsView({
  conversationId,
  initialBriefingId,
  onOpenVoiceSettings,
}: {
  conversationId?: string;
  initialBriefingId?: string;
  onOpenVoiceSettings: () => void;
}) {
  const [people, setPeople] = useState<Person[]>([]),
    [hostId, setHostId] = useState('');
  const [meeting, setMeeting] = useState<Briefing | null>(null);
  const [setup, setSetup] = useState({ configured: false, model: 'gpt-realtime-2.1' });
  const [state, setState] = useState<VoiceState>('off'),
    [muted, setMuted] = useState(false);
  const [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  const [notes, setNotes] = useState(''),
    [typing, setTyping] = useState(false),
    [legacy, setLegacy] = useState(false);
  const [captions, setCaptions] = useState<CaptionEntry[]>([]);
  const presence = useRef<PresenceHandle>(null),
    ending = useRef(false);
  const current = useRef<Briefing | null>(null),
    voice = useRef<BriefingVoice | null>(null);
  const alive = useRef(true),
    lock = useRef(false),
    heard = useRef(false),
    writeError = useRef('');
  const writes = useRef(Promise.resolve()),
    seen = useRef(new Set<string>());
  const failedWrites = useRef(new Map<string, () => Promise<void>>());
  function update(b: Briefing) {
    if (current.current?.id === b.id && current.current.version > b.version) return;
    current.current = b;
    if (alive.current) setMeeting(b);
  }
  function stop() {
    const v = voice.current;
    voice.current = null;
    v?.close();
    ending.current = false;
    heard.current = false;
    setMuted(false);
  }
  async function home() {
    const [roster, settings] = await Promise.all([
      api('/briefings/roster'),
      api('/briefings/voice'),
    ]);
    if (!alive.current) return;
    setPeople(roster);
    setSetup(settings);
    setHostId(
      settings.hostId ||
        roster.find((p: Person) => /\bchief of staff\b/i.test(p.name + ' ' + p.role))?.id ||
        '',
    );
  }
  useEffect(() => {
    alive.current = true;
    void home()
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
    return () => {
      alive.current = false;
      voice.current?.close();
      voice.current = null;
    };
  }, []);
  useEffect(() => {
    const refresh = () => void home().catch((e) => setError(e.message));
    window.addEventListener('briefing-voice-settings', refresh);
    return () => window.removeEventListener('briefing-voice-settings', refresh);
  }, []);
  useEffect(() => {
    if (initialBriefingId)
      void act(async () => {
        const b = await api(`/briefings/${initialBriefingId}`);
        if (b.mode !== 'chief') setLegacy(true);
        else load(b);
      });
  }, [initialBriefingId]);
  async function flush() {
    await writes.current;
    for (const retry of [...failedWrites.current.values()]) await retry();
    if (!failedWrites.current.size) {
      writeError.current = '';
      setError('');
    }
    if (writeError.current) throw new Error(writeError.current);
  }
  async function act(fn: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e: any) {
      if (alive.current) setError(writeError.current || e.message);
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  }
  function load(b: Briefing) {
    stop();
    update(b);
    setCaptions(
      b.turns
        .filter((turn) => turn.speaker !== 'You')
        .map(({ id, text, delivery, heardText }) => ({
          id,
          text: delivery === 'interrupted' ? heardText || '' : text,
          interrupted: delivery === 'interrupted',
        })),
    );
    setNotes(b.brief);
    seen.current = new Set(b.turns.map((t) => t.id));
    writeError.current = '';
    failedWrites.current.clear();
    setTyping(false);
  }
  async function saveRecap(summary: string, actions: { employeeId: string; text: string }[]) {
    await flush();
    const b = current.current!;
    const fresh: Briefing = await api(`/briefings/${b.id}`);
    if (
      fresh.phase !== b.phase ||
      JSON.stringify(fresh.actions) !== JSON.stringify(b.actions) ||
      fresh.recap !== b.recap
    )
      throw new Error('This recap changed in another window. Reopen it before confirming.');
    const saved = await api(`/briefings/${b.id}/recap`, {
      version: fresh.version,
      summary,
      actions,
    });
    update(saved);
    heard.current = false;
    return saved as Briefing;
  }
  /** The work was agreed during the call; ending it records the recap and sends it. */
  async function completeBriefing(saved: Briefing) {
    const done: Briefing = await api(`/briefings/${saved.id}/dispatch`, {
      version: saved.version,
      actions: saved.actions,
    });
    update(done);
    return done;
  }
  async function send() {
    await act(async () => {
      const b = current.current;
      if (!b || b.phase !== 'review') return;
      stop();
      await flush();
      const fresh: Briefing = await api(`/briefings/${b.id}`);
      if (fresh.recap !== b.recap || JSON.stringify(fresh.actions) !== JSON.stringify(b.actions)) {
        update(fresh);
        throw new Error('The proposed work changed. Please review it again.');
      }
      update(
        await api(`/briefings/${b.id}/dispatch`, { version: fresh.version, actions: b.actions }),
      );
    });
  }
  async function connect(b: Briefing) {
    stop();
    setError('');
    const client = new BriefingVoice({
      state: (s) => {
        if (alive.current) setState(s);
      },
      playback: (id, heardText, captionId) => {
        setCaptions((entries) =>
          entries.map((entry) =>
            entry.id === (captionId || id) ? { ...entry, interrupted: true } : entry,
          ),
        );
        const persist = async () => {
          const saved = await briefingWrite(`/briefings/${b.id}/playback`, { id, heardText });
          failedWrites.current.delete('playback:' + id);
          if (!failedWrites.current.size) writeError.current = '';
          if (current.current?.id === b.id) update(saved);
        };
        writes.current = writes.current.then(persist).catch(() => {
          failedWrites.current.set('playback:' + id, persist);
          writeError.current =
            'Your conversation is still here. Retry saving to keep the interrupted reply.';
          setError(writeError.current);
        });
      },
      levels: (levels) => presence.current?.update(levels),
      readableCaption: (id, text) => {
        if (alive.current && voice.current === client)
          setCaptions((entries) => {
            const index = entries.findIndex((entry) => entry.id === id);
            return index < 0
              ? [...entries, { id, text }]
              : entries.map((entry, i) => (i === index ? { id, text } : entry));
          });
      },
      error: (message) => {
        if (alive.current && voice.current === client) {
          if (ending.current) stop();
          setBusy(false);
          setError(writeError.current || message);
        }
      },
      next: async () => {},
      interrupted: () => {
        heard.current = false;
      },
      readbackDone: () => {
        if (voice.current === client) heard.current = true;
      },
      transcript: (id, text, human) => {
        if (voice.current !== client || !text.trim() || seen.current.has(id)) return;
        const priorHeard = heard.current;
        const active = current.current!;
        if (human && active.phase === 'review' && briefingCommand(text) === 'confirm') {
          // Speech-start invalidates readback only while it is playing, not after it ended.
          if (priorHeard) void send();
          else setError('Listen to the recap first, or review it and use the confirmation button.');
          return;
        }
        if (human) heard.current = false;
        const persist = async () => {
          const saved = await briefingWrite(`/briefings/${b.id}/turns`, {
            id,
            text,
            speaker: human ? 'You' : b.hostId,
          });
          seen.current.add(id);
          failedWrites.current.delete(id);
          if (!failedWrites.current.size) writeError.current = '';
          if (current.current?.id === b.id) update(saved);
        };
        const write = writes.current.then(persist);
        writes.current = write.catch((e) => {
          failedWrites.current.set(id, persist);
          writeError.current = 'Your words are still here. Retry saving to keep this conversation.';
          setError(writeError.current);
        });
        return write;
      },
      action: async (name, callId, args, sourceTurnId) => {
        // BriefingVoice waits for this specific input turn to commit. The model
        // supplies the proposed work; the transport supplies its provenance.
        if (voice.current !== client) throw new Error('This voice session has closed.');
        const outcome = await briefingWrite(
          `/briefings/${b.id}/act`,
          { name, callId, args, sourceTurnId },
          () => {
            if (sourceTurnId) client.assertActionSource(sourceTurnId);
          },
        );
        update(outcome.briefing);
        setPeople(outcome.briefing.participants);
        // A failed context refresh must not disguise a successfully committed action.
        void api(`/briefings/${b.id}/voice-context`)
          .then((context) => {
            if (voice.current === client) client.updateContext(context);
          })
          .catch(() => {});
        return outcome.result;
      },
      recap: async (summary, actions) => {
        if (voice.current !== client) throw new Error('This voice session has closed.');
        setBusy(true);
        try {
          const saved = await saveRecap(summary, actions);
          await completeBriefing(saved);
          stop();
          return recapText(saved);
        } finally {
          if (alive.current) setBusy(false);
        }
      },
    });
    voice.current = client;
    await client.connect(b.id, undefined, b.phase === 'review' ? recapText(b) : undefined, true);
  }
  async function start(withVoice: boolean) {
    if (withVoice && !setup.configured) {
      onOpenVoiceSettings();
      return;
    }
    await act(async () => {
      const b = await api('/briefings', {
        employeeIds: people.map((p) => p.id),
        mode: 'chief',
        hostId,
      });
      load(b);
      setTyping(!withVoice);
      if (withVoice) await connect(b);
    });
  }
  async function finish() {
    if (voice.current && state !== 'off') {
      setBusy(true);
      heard.current = false;
      ending.current = true;
      voice.current.endInput();
      voice.current.requestRecap();
      return;
    }
    await act(async () => {
      const b = current.current!;
      await flush();
      update(await api(`/briefings/${b.id}/brief`, { brief: notes }, 'PUT'));
      await completeBriefing(await saveRecap(notes, []));
    });
  }
  const chief = people.find((p) => p.id === (meeting?.hostId || hostId));
  const reviewing = meeting?.phase === 'review',
    complete = meeting?.phase === 'complete';
  const live = !['off', 'connecting'].includes(state);
  const status = ending.current
    ? 'Saving your recap…'
    : busy
      ? 'One moment…'
      : muted
        ? 'Microphone muted'
        : {
            off: typing ? 'Take your time.' : 'Voice paused',
            connecting: 'Connecting…',
            ready: 'Listening',
            listening: 'Listening…',
            transcribing: 'Thinking…',
            speaking: 'Speaking · you can interrupt',
          }[state];
  if (legacy)
    return (
      <PreviousBriefings conversationId={conversationId} initialBriefingId={initialBriefingId} />
    );
  return (
    <section className={`briefings-view chief-call${meeting ? ' is-active' : ''}`}>
      <div className="briefing-scroll ui-stack">
        <div className="briefing-stage ui-stack">
          <ChiefPresence
            ref={presence}
            employeeId={chief?.id}
            state={state}
            muted={muted}
            busy={busy}
          />
          <h1>
            {complete
              ? 'Your brief is saved.'
              : reviewing
                ? 'Here’s what we agreed.'
                : !meeting
                  ? 'What good shall we do this day?'
                  : chief?.name || 'Your Chief of Staff'}
          </h1>
          {!meeting && (
            <p className="briefing-subtitle">
              A conversation with {chief?.name || 'your Chief of Staff'}.
            </p>
          )}
          {loading && <p role="status">Loading…</p>}
          {meeting && !complete && <span role="status">{status}</span>}
          {meeting && !reviewing && !complete && !typing && <LiveThought entries={captions} />}
          {error && (
            <div className="briefing-error ui-stack" role="alert">
              <span>{error}</span>
              <div className="ui-actions">
                {failedWrites.current.size > 0 && (
                  <button className="secondary" disabled={busy} onClick={() => void act(flush)}>
                    Retry saving
                  </button>
                )}
                <button className="quiet-button" onClick={() => setError('')}>
                  Dismiss
                </button>
              </div>
            </div>
          )}
          {meeting && <PlanChecklist items={meeting.executedActions || []} />}
          {(reviewing || complete) && (
            <div className="briefing-recap ui-stack">
              <p>{meeting?.recap}</p>
              {meeting?.actions
                .filter((a) => a.selected)
                .map((a) => (
                  <div key={a.id}>
                    <strong>{meeting.participants.find((p) => p.id === a.employeeId)?.name}</strong>
                    <p>{a.text}</p>
                  </div>
                ))}
            </div>
          )}
          {typing && meeting?.phase === 'brief' && (
            <label className="ui-field">
              Your briefing
              <textarea
                rows={5}
                value={notes}
                maxLength={12000}
                onChange={(e) => setNotes(e.target.value)}
              />
            </label>
          )}
          {
            <div className="chief-controls ui-stack">
              {!meeting ? (
                <>
                  <button
                    className="primary"
                    disabled={busy || loading || !hostId}
                    onClick={() => void start(true)}
                  >
                    <Mic size={16} aria-hidden="true" />
                    Let’s talk
                  </button>
                  <button
                    className="chief-text-link"
                    disabled={busy || loading || !hostId}
                    onClick={() => void start(false)}
                  >
                    Type instead
                  </button>
                </>
              ) : complete ? (
                <button
                  className="primary"
                  onClick={() =>
                    void act(async () => {
                      load(meeting);
                      current.current = null;
                      setMeeting(null);
                      await home();
                    })
                  }
                >
                  Done
                </button>
              ) : reviewing ? (
                // Only briefings saved before the review step was removed reach this.
                <button className="primary" disabled={busy} onClick={() => void send()}>
                  Save recap
                </button>
              ) : typing ? (
                <button
                  className="primary"
                  disabled={busy || !notes.trim()}
                  onClick={() => void finish()}
                >
                  Save
                </button>
              ) : live || state === 'connecting' || ending.current ? (
                <button
                  className="primary"
                  disabled={ending.current}
                  onClick={() => {
                    if (state === 'connecting') stop();
                    else void finish();
                  }}
                >
                  <PhoneOff size={16} aria-hidden="true" />
                  End conversation
                </button>
              ) : (
                <>
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() => {
                      if (!setup.configured) onOpenVoiceSettings();
                      else
                        void act(async () => {
                          await flush();
                          await connect(current.current!);
                        });
                    }}
                  >
                    <Mic size={16} aria-hidden="true" />
                    Resume voice
                  </button>
                </>
              )}
              {meeting && !complete && live && (
                <div className="chief-call-toolbar ui-actions" aria-label="Conversation controls">
                  <button
                    className="quiet-button"
                    aria-pressed={muted}
                    onClick={() => {
                      voice.current?.mute(!muted);
                      setMuted(!muted);
                    }}
                  >
                    {muted ? <MicOff size={16} /> : <Mic size={16} />}
                    {muted ? 'Unmute' : 'Mute'}
                  </button>
                </div>
              )}
            </div>
          }
        </div>
        {meeting && (complete || reviewing) && (
          <details id="chief-conversation" className="briefing-details">
            <summary>Conversation</summary>
            <ConversationTranscript
              turns={meeting.turns}
              chiefName={chief?.name || 'Chief of Staff'}
            />
          </details>
        )}
      </div>
    </section>
  );
}
