import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, uid } from '../apps/service/src/store.js';
import { Goals } from '../apps/service/src/goals.js';
import { registerBriefingRoutes, Briefings } from '../apps/service/src/briefings.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});
function fixture(count = 28, request?: typeof fetch) {
  const dir = mkdtempSync(join(tmpdir(), 'abralo-briefings-'));
  const store = new Store(dir),
    owner = store.createOwner('Chris');
  const people = Array.from({ length: count }, (_, i) =>
    store.createEmployee(owner.id, {
      name: `Existing employee ${i + 1}`,
      role: `Role ${i + 1}`,
      harness: 'codex',
      model: '',
      cwd: '',
      instructions: '',
    }),
  );
  const supervisor = {
    active: new Map(),
    dispatch: vi.fn(),
    cancel: vi.fn(),
    closing: false,
    maintenance: false,
  };
  const briefings = new Briefings(store, supervisor as any, request);
  cleanups.push(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, owner, people, supervisor, briefings };
}
const report = {
  understanding: 'Customer conversations matter today.',
  question: 'Which customer segment comes first?',
  reason: 'It determines my customer list.',
  priority: 3,
  nextStep: 'Prepare a customer list for review.',
};
it('retains interrupted reply text and captions idempotently without changing human instructions', () => {
  const f = fixture(1);
  const b = f.briefings.create(f.owner.id, [f.people[0].id]);
  f.briefings.turn(b.id, f.owner.id, { id: 'reply', speaker: f.people[0].id, text: 'First thought. Unspoken continuation.' });
  const saved = f.briefings.playback(b.id, f.owner.id, 'reply', 'First thought.');
  expect(saved.turns[0]).toMatchObject({ delivery: 'interrupted', heardText: 'First thought.', text: 'First thought. Unspoken continuation.' });
  expect(f.briefings.playback(b.id, f.owner.id, 'reply', 'First thought.').version).toBe(saved.version);
  expect(() => f.briefings.playback(b.id, f.owner.id, 'reply', 'Invented words')).toThrow();
  f.briefings.turn(b.id, f.owner.id, { id: 'human', speaker: 'You', text: 'Do this.' });
  expect(() => f.briefings.playback(b.id, f.owner.id, 'human', '')).toThrow();
  const other = f.store.createOwner('Other');
  expect(() => f.briefings.playback(b.id, other.id, 'reply', '')).toThrow();
});
function respond(f: ReturnType<typeof fixture>, b: any, index = 0) {
  const p = b.participants[index];
  f.briefings.report({ user_id: f.owner.id, employee_id: p.id, message_id: p.messageId }, report);
  f.store.run("UPDATE outbox SET status='done' WHERE message_id=?", p.messageId);
}
it('uses the current large roster, prepares only two at once, and accepts reports only from the assigned employee', () => {
  const f = fixture();
  expect(f.briefings.roster(f.owner.id)).toHaveLength(28);
  const created = f.briefings.create(
    f.owner.id,
    f.people.map((p) => p.id),
  );
  const b = f.briefings.prepare(created.id, f.owner.id, 'Talk to customers today.');
  expect(b.participants.filter((p) => p.state === 'preparing')).toHaveLength(2);
  expect(f.store.all("SELECT * FROM outbox WHERE status='pending'")).toHaveLength(2);
  expect(f.store.setting('delegation.purpose.' + b.participants[0].messageId)).toBe('research');
  expect(() =>
    f.briefings.report(
      { user_id: f.owner.id, employee_id: f.people[2].id, message_id: b.participants[0].messageId },
      report,
    ),
  ).toThrow();
  respond(f, b);
  f.briefings.tick();
  const updated = f.briefings.get(b.id, f.owner.id);
  expect(updated.questions).toHaveLength(1);
  expect(updated.actions[0].selected).toBe(false);
  expect(updated.participants.filter((p) => p.state === 'preparing')).toHaveLength(2);
  expect(updated.participants[2].state).toBe('preparing');
  const other = f.store.createOwner('Other owner');
  expect(() => f.briefings.get(b.id, other.id)).toThrow();
  expect(() => f.briefings.create(other.id, [f.people[0].id])).toThrow();
  expect(() => f.briefings.create(f.owner.id, [f.people[0].id, f.people[0].id])).toThrow();
});
it('review stops preparation, preserves answers and queues only selected assignments exactly once', () => {
  const f = fixture(4),
    b = f.briefings.prepare(
      f.briefings.create(
        f.owner.id,
        f.people.map((p) => p.id),
      ).id,
      f.owner.id,
      'Focus on onboarding.',
    );
  respond(f, b);
  let updated = f.briefings.get(b.id, f.owner.id);
  const q = updated.questions[0];
  f.briefings.turn(b.id, f.owner.id, {
    id: 'turn-1',
    speaker: 'You',
    questionId: q.id,
    text: 'Existing customers.',
  });
  f.briefings.turn(b.id, f.owner.id, {
    id: 'turn-1',
    speaker: 'You',
    questionId: q.id,
    text: 'Existing customers.',
  });
  expect(f.briefings.get(b.id, f.owner.id).turns).toHaveLength(1);
  f.briefings.answer(b.id, f.owner.id, q.id, 'Existing customers');
  updated = f.briefings.review(b.id, f.owner.id);
  expect(f.store.all("SELECT * FROM outbox WHERE status='pending'")).toHaveLength(0);
  expect(updated.actions[0].text).toContain('Human: Existing customers');
  expect(() => respond(f, b, 1)).toThrow();
  const actions = updated.actions.map((a) => ({
    ...a,
    selected: true,
    text: 'Prepare the list; do not contact anyone yet.',
  }));
  expect(() => f.briefings.dispatch(b.id, f.owner.id, updated.version - 1, actions)).toThrow();
  const completed = f.briefings.dispatch(b.id, f.owner.id, updated.version, actions);
  f.briefings.dispatch(b.id, f.owner.id, updated.version, actions);
  expect(completed.phase).toBe('complete');
  expect(f.store.all("SELECT * FROM outbox WHERE status='pending'")).toHaveLength(1);
  expect(
    f.store.one('SELECT text FROM messages WHERE id=?', completed.actions[0].messageId).text,
  ).toContain('Existing customers');
  expect(
    f.store.one(
      'SELECT text FROM messages WHERE conversation_id=? ORDER BY seq DESC LIMIT 1',
      f.people[3].dmId,
    ).text,
  ).toContain('For awareness');
});

it('records a single anchored recap and preserves it on a dispatch retry', () => {
  const f = fixture(1);
  const created = f.briefings.create(f.owner.id, [f.people[0].id], f.people[0].dmId);
  const prepared = f.briefings.prepare(created.id, f.owner.id, 'Prepare a customer list.');
  respond(f, prepared);
  const review = f.briefings.review(created.id, f.owner.id);
  const actions = review.actions.map((a) => ({
    ...a,
    selected: true,
    text: 'Prepare the list; no outreach.',
  }));
  const result = f.briefings.dispatch(created.id, f.owner.id, review.version, actions);
  const again = f.briefings.dispatch(created.id, f.owner.id, review.version, actions);
  expect(result.recapMessageId).toBeTruthy();
  expect(again.recapMessageId).toBe(result.recapMessageId);
  expect(f.store.one('SELECT text FROM messages WHERE id=?', result.recapMessageId).text).toContain(
    'no outreach',
  );
  expect(
    f.store.all(
      "SELECT id FROM messages WHERE author_name='Morning briefing' AND text LIKE 'Morning briefing%'",
    ),
  ).toHaveLength(1);
  const other = f.store.createOwner('Other');
  expect(() => f.briefings.create(other.id, [], f.people[0].dmId)).toThrow();
});
it('times out and does not restart stale preparation after resuming a saved meeting', () => {
  const f = fixture(4),
    b = f.briefings.prepare(
      f.briefings.create(
        f.owner.id,
        f.people.map((p) => p.id),
      ).id,
      f.owner.id,
      'Focus.',
    );
  b.createdAt = new Date(Date.now() - 31 * 60000).toISOString();
  f.store.run('UPDATE briefings SET data=? WHERE id=?', JSON.stringify(b), b.id);
  f.briefings.tick();
  expect(
    f.briefings.get(b.id, f.owner.id).participants.every((p) => p.state === 'unavailable'),
  ).toBe(true);
  expect(f.store.all("SELECT * FROM outbox WHERE status IN ('pending','new')")).toHaveLength(0);
});
it('creates a conversational host session without exposing the key and retains context on resume', async () => {
  const request = vi.fn(async (_url: any, options: any) => {
    expect(options.headers.Authorization).toBe('Bearer test-voice-key');
    const session = JSON.parse(options.body.get('session'));
    expect(session.audio.input.turn_detection.type).toBe('semantic_vad');
    expect(session.audio.input.turn_detection.create_response).toBe(true);
    expect(session.audio.input.turn_detection.eagerness).toBe('high');
    expect(session.audio.input.turn_detection.interrupt_response).toBe(true);
    expect(session.instructions).toContain('live AI morning briefing host');
    expect(session.instructions).toContain('Existing employee 1');
    expect(session.instructions).toContain('Focus on onboarding');
    expect(session.instructions).toContain('Only existing customers');
    expect(session.tools).toEqual([]);
    return new Response('answer-sdp');
  });
  const f = fixture(1, request as any),
    b = f.briefings.create(f.owner.id, [f.people[0].id]);
  f.briefings.saveBrief(b.id, f.owner.id, 'Focus on onboarding');
  f.briefings.turn(b.id, f.owner.id, {
    id: 'human-turn',
    speaker: 'You',
    text: 'Only existing customers',
  });
  const settings = await f.briefings.configureVoice(
    f.owner.id,
    'test-voice-key',
    'gpt-realtime-2.1',
  );
  expect(settings).toEqual({ configured: true, model: 'gpt-realtime-2.1', hostId: '' });
  expect(await f.briefings.connectVoice(b.id, f.owner.id, 'offer-sdp')).toEqual({
    sdp: 'answer-sdp',
    speaker: 'Host',
  });
  expect(request).toHaveBeenCalledOnce();
  await expect(f.briefings.connectVoice(b.id, f.owner.id, 'offer-sdp')).rejects.toThrow(
    'reconnecting',
  );
});

it.each(['questions', 'review'])(
  'keeps %s voice responses scoped to the current phase',
  async (phase) => {
    let session: any;
    const request = vi.fn(async (_url: any, options: any) => {
      session = JSON.parse(options.body.get('session'));
      return new Response('answer-sdp');
    });
    const f = fixture(1, request as any);
    const b = f.briefings.prepare(
      f.briefings.create(f.owner.id, [f.people[0].id]).id,
      f.owner.id,
      'Focus on onboarding.',
    );
    respond(f, b);
    const q = f.briefings.get(b.id, f.owner.id).questions[0];
    if (phase === 'review') f.briefings.review(b.id, f.owner.id);
    await f.briefings.configureVoice(f.owner.id, 'test-voice-key', 'gpt-realtime-2.1');
    const result = await f.briefings.connectVoice(
      b.id,
      f.owner.id,
      'offer-sdp',
      phase === 'questions' ? q.id : undefined,
    );
    expect(session.audio.input.turn_detection).toMatchObject({
      create_response: true,
      interrupt_response: true,
      eagerness: 'high',
    });
    expect(session.tools.map((tool: any) => tool.name)).toEqual([
      phase === 'questions' ? 'next_question' : 'revise_actions',
    ]);
    expect(result.speaker).toBe(phase === 'questions' ? f.people[0].id : 'Host');
    if (phase === 'questions') {
      expect(session.instructions).toContain(report.question);
      expect(session.audio.output.voice).toBe(b.participants[0].voice);
    } else {
      expect(session.instructions).toContain(
        'only the application can dispatch after confirmation',
      );
    }
  },
);

function chiefFixture() {
  const f = fixture(28);
  const chief = f.store.createEmployee(f.owner.id, {
    name: 'Chief of Staff',
    canDelegate: true,
    role: 'Organizes the team',
    harness: 'codex',
    model: '',
    cwd: '',
    instructions: '',
  });
  const b = f.briefings.create(
    f.owner.id,
    f.people.map((p) => p.id),
    f.people[1].dmId,
    'chief',
  );
  return { ...f, chief, b };
}
it('grounds the private chief conversation without borrowing other employee DMs or starting preparation', () => {
  const f = chiefFixture();
  expect(f.b.hostId).toBe(f.chief.id);
  expect(f.b.conversationId).toBe(f.chief.dmId);
  expect(f.b.participants).toHaveLength(29);
  f.store.addMessage(f.chief.dmId, f.owner.id, 'Chris', 'human', 'Focus on retention today.');
  f.store.addMessage(
    f.people[0].dmId,
    f.owner.id,
    'Chris',
    'human',
    'PRIVATE OTHER EMPLOYEE DETAIL',
  );
  f.store.addMessage(
    f.chief.dmId,
    f.chief.id,
    'Chief of Staff',
    'agent',
    'Retention research is ready for review.',
  );
  f.store.addMessage(
    f.chief.dmId,
    f.owner.id,
    'Morning briefing',
    'system',
    'Yesterday we agreed no outreach.',
  );
  const session = f.briefings.chiefContext(f.b.id, f.owner.id);
  expect(session.instructions).toContain('Yesterday we agreed no outreach.');
  expect(session.instructions).toContain('Retention research is ready');
  expect(session.instructions).toContain('Focus on retention today.');
  expect(session.instructions).not.toContain('PRIVATE OTHER EMPLOYEE DETAIL');
  expect(session.instructions).toContain('Chief of Staff');
  expect(session.audio.input.turn_detection).toEqual({
    type: 'semantic_vad',
    eagerness: 'auto',
    create_response: true,
    interrupt_response: true,
  });
  expect(session.tools.map((t) => t.name)).toEqual([
    'read_goals',
    'delegate_goal',
    'set_plan',
    'remove_goal',
    'create_employee',
    'delegate_task',
    'save_recap',
  ]);
  expect(() => f.briefings.prepare(f.b.id, f.owner.id, 'Start')).toThrow('Talk directly');
  f.briefings.tick();
  expect(f.store.all('SELECT * FROM outbox')).toHaveLength(0);
});
it('saves and corrects the chief recap without dispatch, then sends only the approved assignment once', () => {
  const f = chiefFixture();
  f.briefings.turn(f.b.id, f.owner.id, {
    id: 'human',
    speaker: 'You',
    text: 'Maybe pricing later. Prepare an internal customer list, no outreach.',
  });
  let b = f.briefings.get(f.b.id, f.owner.id);
  b = f.briefings.saveRecap(
    b.id,
    f.owner.id,
    b.version,
    'Private discussion. Pricing remains undecided.',
    [{ employeeId: f.people[0].id, text: 'Prepare a customer list.' }],
  );
  expect(f.store.all('SELECT * FROM outbox')).toHaveLength(0);
  const staleVersion = b.version;
  b = f.briefings.saveRecap(
    b.id,
    f.owner.id,
    b.version,
    'Private discussion. Pricing remains undecided.',
    [{ employeeId: f.people[0].id, text: 'Prepare an internal customer list. No outreach.' }],
  );
  expect(() => f.briefings.saveRecap(b.id, f.owner.id, staleVersion, 'Stale', [])).toThrow(
    'changed',
  );
  const done = f.briefings.dispatch(b.id, f.owner.id, b.version, b.actions);
  expect(f.briefings.dispatch(b.id, f.owner.id, b.version, b.actions).recapMessageId).toBe(
    done.recapMessageId,
  );
  expect(f.store.all('SELECT * FROM outbox')).toHaveLength(1);
  const assigned = f.store.one(
    'SELECT text FROM messages WHERE id=?',
    done.actions[0].messageId,
  ).text;
  expect(assigned).toContain('No outreach');
  expect(assigned).not.toContain('Private discussion');
  expect(
    f.store.all('SELECT * FROM messages WHERE conversation_id=?', f.people[1].dmId),
  ).toHaveLength(0);
  expect(
    f.store.one('SELECT conversation_id,text FROM messages WHERE id=?', done.recapMessageId),
  ).toMatchObject({
    conversation_id: f.chief.dmId,
    text: expect.stringContaining('Pricing remains undecided'),
  });
});
it('keeps a no-assignment recap private and does not wake the chief or other employees', () => {
  const f = chiefFixture();
  const b = f.briefings.saveRecap(
    f.b.id,
    f.owner.id,
    f.b.version,
    'Thinking aloud; no decisions yet.',
    [],
  );
  f.briefings.dispatch(b.id, f.owner.id, b.version, []);
  expect(f.store.all('SELECT * FROM outbox')).toHaveLength(0);
  expect(f.store.all('SELECT * FROM messages')).toHaveLength(1);
});
it('rejects unavailable hosts, other owners and invalid recap recipients', () => {
  const f = fixture(2);
  expect(() => f.briefings.create(f.owner.id, [f.people[0].id], undefined, 'chief')).toThrow(
    'unavailable',
  );
  const b = f.briefings.create(f.owner.id, [f.people[0].id], undefined, 'chief', f.people[0].id);
  expect(() => f.briefings.chiefContext(b.id, f.store.createOwner('Other').id)).toThrow();
  expect(() =>
    f.briefings.saveRecap(b.id, f.owner.id, b.version, 'Summary', [
      { employeeId: uid(), text: 'Work' },
    ]),
  ).toThrow();
  expect(() =>
    f.briefings.saveRecap(b.id, f.owner.id, b.version, 'Summary', [
      { employeeId: f.people[0].id, text: 'Work' },
      { employeeId: f.people[0].id, text: 'More' },
    ]),
  ).toThrow();
});

it('creates a requested employee and first task atomically, survives retries and never copies grants', () => {
  const f = chiefFixture();
  const quote =
    'Create Maya as a customer researcher and ask her to prepare an internal list. No outreach.';
  f.briefings.turn(f.b.id, f.owner.id, { id: 'request-create', speaker: 'You', text: quote });
  const input = {
    name: 'create_employee',
    callId: 'create-call',
    args: {
      userRequest: quote,
      name: 'Maya',
      role: 'Customer researcher',
      task: 'Prepare an internal list. No outreach.',
    },
  };
  const first = f.briefings.act(f.b.id, f.owner.id, input);
  const second = f.briefings.act(f.b.id, f.owner.id, input);
  const retry = f.briefings.act(f.b.id, f.owner.id, { ...input, callId: 'reconnected-call' });
  expect(first.result.employeeId).toBe(second.result.employeeId);
  expect(retry.result.messageId).toBe(first.result.messageId);
  expect(f.store.all('SELECT * FROM employees')).toHaveLength(30);
  expect(f.store.all('SELECT * FROM outbox')).toHaveLength(1);
  expect(f.store.employee(first.result.employeeId)).toMatchObject({
    cwd: '',
    permissionMode: 'auto',
  });
  const message = f.store.one('SELECT * FROM messages WHERE id=?', first.result.messageId);
  expect(message).toMatchObject({
    author_id: f.chief.id,
    kind: 'agent',
    text: 'Prepare an internal list. No outreach.',
  });
  expect(f.store.setting('delegation.parent.' + message.id)).toMatchObject({
    employeeId: f.chief.id,
    messageId: first.result.receiptMessageId,
  });
  expect(f.briefings.chiefContext(f.b.id, f.owner.id).instructions).toContain(
    first.result.employeeId,
  );
  const saved = f.briefings.get(f.b.id, f.owner.id);
  const recap = f.briefings.saveRecap(
    saved.id,
    f.owner.id,
    saved.version,
    'Maya has her first task.',
    [{ employeeId: first.result.employeeId, text: input.args.task }],
  );
  expect(recap.actions).toHaveLength(0);
  f.briefings.dispatch(saved.id, f.owner.id, recap.version, []);
  expect(f.store.all('SELECT * FROM outbox')).toHaveLength(1);
  expect(() =>
    f.briefings.act(saved.id, f.owner.id, {
      ...input,
      callId: 'changed',
      args: { ...input.args, name: 'Other' },
    }),
  ).toThrow('ended');
});
it('delegates only to available employees and rejects stale, fabricated or changed action requests', () => {
  const f = chiefFixture();
  const quote = 'Ask the engineer to investigate onboarding. Do not publish.';
  const input = {
    name: 'delegate_task',
    callId: 'handoff',
    args: {
      userRequest: quote,
      employeeId: f.people[0].id,
      task: 'Investigate onboarding. Do not publish.',
    },
  };
  expect(() => f.briefings.act(f.b.id, f.owner.id, input)).toThrow('spoken request');
  f.briefings.turn(f.b.id, f.owner.id, { id: 'human-handoff', speaker: 'You', text: quote });
  expect(() => f.briefings.act(f.b.id, f.store.createOwner('Other').id, input)).toThrow();
  expect(() =>
    f.briefings.act(f.b.id, f.owner.id, { ...input, args: { ...input.args, employeeId: uid() } }),
  ).toThrow('unavailable');
  const result = f.briefings.act(f.b.id, f.owner.id, input);
  expect(result.result.status).toBe('queued');
  expect(() =>
    f.briefings.act(f.b.id, f.owner.id, {
      ...input,
      args: { ...input.args, task: 'Publish immediately' },
    }),
  ).toThrow('another request');
  f.briefings.turn(f.b.id, f.owner.id, {
    id: 'correction',
    speaker: 'You',
    text: 'Wait, do not send anything else.',
  });
  expect(() =>
    f.briefings.act(f.b.id, f.owner.id, {
      ...input,
      callId: 'stale',
      args: { ...input.args, task: 'Another task' },
    }),
  ).toThrow('spoken request');
  expect(f.store.all('SELECT * FROM outbox')).toHaveLength(1);
});
it('links actions to saved input IDs without exact quotes and preserves retry receipts across restart', () => {
  const f = chiefFixture();
  f.briefings.turn(f.b.id, f.owner.id, { id: 'agreed-turn', speaker: 'You', text: 'Yes, do both please.' });
  const input = {
    name: 'delegate_goal', callId: 'linked-goal', sourceTurnId: 'agreed-turn',
    args: { employeeId: '', goalId: '', version: 0, title: 'Assess demand', success: 'Assessment recorded', nextStep: 'Review existing evidence. No outreach.' },
  };
  const first = f.briefings.act(f.b.id, f.owner.id, input);
  expect(first.result.status).toBe('queued');
  // New model calls can paraphrase or omit the request; identity comes from transport.
  const restarted = new Briefings(f.store, f.supervisor as any);
  const retry = restarted.act(f.b.id, f.owner.id, { ...input, callId: 'retry', args: { ...input.args, userRequest: 'Go ahead with the demand assessment.' } });
  expect(retry.result.goalId).toBe(first.result.goalId);
  const second = f.briefings.act(f.b.id, f.owner.id, { ...input, callId: 'second-goal', args: { ...input.args, title: 'Assess pricing' } });
  expect(second.result.status).toBe('queued');
  expect(second.result.employeeId).not.toBe(first.result.employeeId);
  expect(f.store.all('SELECT * FROM goals')).toHaveLength(2);
  expect(f.store.all('SELECT * FROM outbox')).toHaveLength(0);
  f.briefings.turn(f.b.id, f.owner.id, { id: 'correction-turn', speaker: 'You', text: 'Stop creating new goals.' });
  // A lost acknowledgement may still retrieve an existing receipt after correction.
  expect(restarted.act(f.b.id, f.owner.id, input).result.goalId).toBe(first.result.goalId);
  expect(() => restarted.act(f.b.id, f.owner.id, { ...input, callId: 'stale', args: { ...input.args, title: 'Unwanted work' } })).toThrow('latest saved human turn');
  expect(f.store.all('SELECT * FROM goals')).toHaveLength(2);
});
it('rejects fabricated, assistant, foreign and missing source turns even when a request quote is supplied', () => {
  const f = chiefFixture();
  f.briefings.turn(f.b.id, f.owner.id, { id: 'assistant', speaker: f.chief.id, text: 'Go ahead.' });
  f.briefings.turn(f.b.id, f.owner.id, { id: 'human', speaker: 'You', text: 'Go ahead.' });
  const input = { name: 'delegate_task', callId: 'source-check', args: { userRequest: 'Go ahead.', employeeId: f.people[0].id, task: 'Review evidence.' } };
  for (const sourceTurnId of ['missing', 'assistant', 'foreign']) {
    expect(() => f.briefings.act(f.b.id, f.owner.id, { ...input, sourceTurnId })).toThrow('latest saved human turn');
  }
  expect(() => f.briefings.act(f.b.id, f.store.createOwner('Other').id, { ...input, sourceTurnId: 'human' })).toThrow();
  expect(f.store.all('SELECT * FROM outbox')).toHaveLength(0);
});
it('presents legacy preparation as a briefing entry, retaining its internal source and actual human messages', () => {
  const f = chiefFixture();
  const text = `Prepare for morning briefing ${f.b.id}. This is read-only preparation, not an instruction to execute the brief yet. Internal instructions here.`;
  const legacy = f.store.addMessage(f.chief.dmId, f.owner.id, 'Chris', 'system', text);
  expect(legacy.authorName).toBe('Morning briefing');
  expect(legacy.text).toBe('Prepared for your morning briefing.');
  expect(f.store.messages(f.chief.dmId)[0].text).not.toContain('Internal instructions');
  expect(f.store.one('SELECT text FROM messages WHERE id=?', legacy.id).text).toBe(text);
  const human = f.store.addMessage(f.chief.dmId, f.owner.id, 'Chris', 'human', text);
  expect(human.text).toBe(text);
});

it('assigns durable goals to the real employee with success measures and starts only requested work', () => {
  const f = chiefFixture();
  const quote =
    'Give Maya a durable goal to validate onboarding demand. Start now, without outreach.';
  f.briefings.turn(f.b.id, f.owner.id, { id: 'goal-request', speaker: 'You', text: quote });
  const input = {
    name: 'delegate_goal',
    callId: 'goal-call',
    args: {
      userRequest: quote,
      employeeId: f.people[0].id,
      goalId: '',
      version: 0,
      title: 'Validate onboarding demand',
      success: 'Evidence-backed assessment; no external outreach.',
      nextStep: 'Review existing evidence and record uncertainties. No outreach.',
      start: true,
    },
  };
  const first = f.briefings.act(f.b.id, f.owner.id, input);
  expect(first.result.goalId).toBeTruthy();
  expect(first.result.status).toBe('queued');
  expect(
    f.briefings.act(f.b.id, f.owner.id, { ...input, callId: 'goal-retry' }).result.goalId,
  ).toBe(first.result.goalId);
  const goals = new Goals(f.store);
  const goal = goals.get(first.result.goalId, f.owner.id);
  expect(goal).toMatchObject({
    leadAgentId: f.people[0].id,
    conversationId: f.chief.dmId,
    success: input.args.success,
    nextStep: input.args.nextStep,
  });
  expect(goals.runner.policy(goal.id)).toMatchObject({ daily_sessions: 0, autonomy: 'prepare' });
  expect(f.store.all('SELECT * FROM goals')).toHaveLength(1);
  expect(f.store.all('SELECT * FROM outbox')).toHaveLength(0); // Uses goal continuation, not a duplicate ordinary task.
  goals.runner.tick();
  const cycle = f.store.one('SELECT * FROM goal_cycles WHERE goal_id=?', goal.id);
  expect(cycle.employee_id).toBe(f.people[0].id);
  expect(goals.runner.context(cycle.message_id)).toContain('No outreach');
  expect(
    f.store.one('SELECT conversation_id FROM messages WHERE id=?', cycle.message_id)
      .conversation_id,
  ).toBe(f.people[0].dmId);
  const secondQuote =
    'Also save a separate pricing research goal for the same employee, for later.';
  f.briefings.turn(f.b.id, f.owner.id, { id: 'later-goal', speaker: 'You', text: secondQuote });
  const secondInput = {
    ...input,
    callId: 'saved',
    args: { ...input.args, userRequest: secondQuote, title: 'Research pricing', start: false },
  };
  expect(() => f.briefings.act(f.b.id, f.owner.id, secondInput)).toThrow(/already leads/);
  expect(f.store.all('SELECT * FROM goals')).toHaveLength(1);
  const automaticQuote = 'Choose an available employee for pricing research and save it for later.';
  f.briefings.turn(f.b.id, f.owner.id, {
    id: 'automatic-goal',
    speaker: 'You',
    text: automaticQuote,
  });
  const saved = f.briefings.act(f.b.id, f.owner.id, {
    ...secondInput,
    args: { ...secondInput.args, userRequest: automaticQuote, employeeId: '' },
  });
  expect(saved.result.employeeId).not.toBe(first.result.employeeId);
  expect(saved.result.summary).toContain(saved.result.name);
  expect(goals.get(saved.result.goalId, f.owner.id).execution.state).toBe('saved');
  expect(f.store.all('SELECT * FROM goals')).toHaveLength(2);
});
it('reads only Chief-visible goals and reassigns an existing paused goal without restarting or increasing limits', () => {
  const f = chiefFixture(),
    goals = new Goals(f.store);
  const goal = goals.create(f.owner.id, {
    conversationId: f.chief.dmId,
    title: 'Validate demand',
    leadAgentId: f.people[0].id,
    dailySessions: 2,
    sessionMinutes: 5,
  });
  const paused = goals.change(goal.id, f.owner.id, { version: goal.version, status: 'paused' });
  const privateGoal = goals.create(f.owner.id, {
    conversationId: f.people[2].dmId,
    title: 'PRIVATE unrelated work',
    leadAgentId: f.people[2].id,
  });
  const read = f.briefings.act(f.b.id, f.owner.id, {
    name: 'read_goals',
    callId: 'read',
    args: {},
  });
  expect(read.result.goals.map((g: any) => g.id)).toContain(goal.id);
  expect(JSON.stringify(read.result)).not.toContain(privateGoal.id);
  const quote = 'Make the engineer lead the demand goal, but leave it paused.';
  f.briefings.turn(f.b.id, f.owner.id, { id: 'change-lead', speaker: 'You', text: quote });
  const input = {
    name: 'delegate_goal',
    callId: 'reassign',
    args: {
      userRequest: quote,
      employeeId: f.people[1].id,
      goalId: goal.id,
      version: paused.version,
      title: goal.title,
      success: goal.success,
      nextStep: 'Review evidence when resumed.',
      start: false,
    },
  };
  const reassigned = f.briefings.act(f.b.id, f.owner.id, input);
  expect(reassigned.result.status).toBe('paused');
  expect(reassigned.result.summary).toContain('remains paused');
  expect(goals.get(goal.id, f.owner.id).leadAgentId).toBe(f.people[1].id);
  expect(goals.runner.policy(goal.id)).toMatchObject({
    daily_sessions: 2,
    session_minutes: 5,
    state: 'paused',
  });
  expect(() =>
    f.briefings.act(f.b.id, f.owner.id, {
      ...input,
      callId: 'stale',
      args: { ...input.args, title: 'Changed title' },
    }),
  ).toThrow('changed');
  expect(() =>
    f.briefings.act(f.b.id, f.owner.id, {
      ...input,
      callId: 'private',
      args: { ...input.args, goalId: privateGoal.id, version: privateGoal.version },
    }),
  ).toThrow('not available');
  expect(f.store.all('SELECT * FROM outbox')).toHaveLength(0);
});

it('automatically staffs a voice goal when all employees already lead goals, and retries without another hire', () => {
  const f = chiefFixture(),
    goals = new Goals(f.store);
  for (const employee of [f.chief, ...f.people])
    goals.create(f.owner.id, { title: 'Existing ' + employee.name, leadAgentId: employee.id });
  const quote = 'Find someone to pursue a durable customer research goal now.';
  f.briefings.turn(f.b.id, f.owner.id, { id: 'hire-goal', speaker: 'You', text: quote });
  const input = {
    name: 'delegate_goal',
    callId: 'hire-goal',
    args: {
      userRequest: quote,
      employeeId: '',
      goalId: '',
      version: 0,
      title: 'Customer research',
      success: 'Documented customer evidence',
      nextStep: 'Review the available evidence without external outreach.',
      start: true,
    },
  };
  const count = f.store.all('SELECT id FROM employees').length;
  const first = f.briefings.act(f.b.id, f.owner.id, input);
  const retry = f.briefings.act(f.b.id, f.owner.id, { ...input, callId: 'reconnected' });
  expect(retry.result.goalId).toBe(first.result.goalId);
  expect(f.store.all('SELECT id FROM employees')).toHaveLength(count + 1);
  expect(goals.get(first.result.goalId, f.owner.id).leadAgentId).toBe(first.result.employeeId);
  expect(first.result.status).toBe('queued');
  expect(f.store.employee(first.result.employeeId)?.cwd).toBe('');
  expect(
    f.store.all('SELECT * FROM grants WHERE employee_id=?', first.result.employeeId),
  ).toHaveLength(0);
  expect(f.store.all('SELECT * FROM outbox')).toHaveLength(0);
});

it('starts every newly agreed goal by default during the call after a short agreement', () => {
  const f = chiefFixture();
  (f.supervisor as any).goals = new Goals(f.store).runner;
  f.briefings.turn(f.b.id, f.owner.id, { id: 'proposal', speaker: f.chief.id, text: 'Shall Maya research demand and our engineer test onboarding?' });
  f.briefings.turn(f.b.id, f.owner.id, { id: 'agreement', speaker: 'You', text: 'OK' });
  for (const [index, person] of f.people.entries()) {
    const result = f.briefings.act(f.b.id, f.owner.id, {
      name: 'delegate_goal', callId: 'agreed-' + index,
      args: { userRequest: 'OK', employeeId: person.id, goalId: '', version: 0, title: 'Agreed outcome ' + index, success: 'Evidence recorded', nextStep: 'Review the existing evidence without external outreach.' },
    });
    expect(result.result.status).toBe('queued');
    expect(new Goals(f.store).get(result.result.goalId, f.owner.id).execution.state).not.toBe('saved');
    expect(f.store.one('SELECT employee_id FROM goal_cycles WHERE goal_id=?', result.result.goalId)?.employee_id).toBe(person.id);
  }
  expect(f.briefings.get(f.b.id, f.owner.id).phase).toBe('brief');
  expect(f.store.all('SELECT * FROM goals')).toHaveLength(f.people.length);
  expect(f.supervisor.dispatch).toHaveBeenCalled();
});

it('keeps already assigned goal work out of recap dispatch while retaining unrelated requests', () => {
  const f = chiefFixture();
  f.briefings.turn(f.b.id, f.owner.id, { id: 'agreement', speaker: 'You', text: 'Go ahead.' });
  f.briefings.saveRecap(f.b.id, f.owner.id, f.briefings.get(f.b.id, f.owner.id).version, 'Proposed demand research.', [{ employeeId: f.people[0].id, text: 'Review existing evidence. No outreach.' }]);
  f.briefings.act(f.b.id, f.owner.id, {
    name: 'delegate_goal', callId: 'agreed',
    args: { userRequest: 'Go ahead.', employeeId: f.people[0].id, goalId: '', version: 0, title: 'Validate demand', success: 'Evidence recorded', nextStep: 'Review existing evidence. No outreach.' },
  });
  expect(f.briefings.get(f.b.id, f.owner.id).actions).toHaveLength(0);
  for (const text of ['Validate demand', 'Review existing evidence. No outreach.']) {
    const fresh = f.briefings.get(f.b.id, f.owner.id);
    expect(f.briefings.saveRecap(f.b.id, f.owner.id, fresh.version, 'Goal already assigned.', [{ employeeId: f.people[0].id, text }]).actions).toHaveLength(0);
  }
  const fresh = f.briefings.get(f.b.id, f.owner.id);
  const recap = f.briefings.saveRecap(f.b.id, f.owner.id, fresh.version, 'One separate request.', [{ employeeId: f.people[0].id, text: 'Also answer my separate pricing question.' }]);
  expect(recap.actions).toHaveLength(1);
  expect(f.store.all('SELECT * FROM outbox')).toHaveLength(0);
});
it('preserves the configured voice key when saving a different Chief of Staff', async () => {
  const f = chiefFixture();
  await f.briefings.configureVoice(f.owner.id, 'fixture-only-secret', 'gpt-realtime-2.1');
  const status = await f.briefings.configureVoice(f.owner.id, undefined, 'gpt-realtime-2.1', f.people[0].id);
  expect(status).toMatchObject({ configured: true, hostId: f.people[0].id });
  expect(JSON.stringify(status)).not.toContain('fixture-only-secret');
});

it('stores bounded voice diagnostics privately without accepting raw provider prose', async () => {
  const f = chiefFixture();
  const routes = new Map<string, any>();
  const app = Object.fromEntries(['get', 'post', 'put', 'delete'].map((method) => [method, (path: string, handler: any) => routes.set(method + path, handler)]));
  registerBriefingRoutes(app, f.briefings, {} as any);
  const req = { user: { id: f.owner.id }, params: { id: f.b.id }, body: { code: 'invalid_event', type: 'invalid_request_error', eventId: 'event', requestEventId: 'request' } };
  const post = routes.get('post/api/briefings/:id/voice-diagnostics');
  const get = routes.get('get/api/briefings/:id/voice-diagnostics');
  for (let i = 0; i < 25; i++) await post(req);
  const log = await get(req);
  expect(log).toHaveLength(20);
  expect(log[0]).toMatchObject(req.body);
  await expect(post({ ...req, body: { ...req.body, message: 'raw private speech' } })).rejects.toThrow();
  const other = f.store.createOwner('Other');
  await expect(get({ ...req, user: { id: other.id } })).rejects.toThrow('unavailable');
});
it('honours an explicit request to defer instead of applying the start-now default', () => {
  const f = chiefFixture();
  const quote = 'Save this goal for later. Do not start yet.';
  f.briefings.turn(f.b.id, f.owner.id, { id: 'defer', speaker: 'You', text: quote });
  const result = f.briefings.act(f.b.id, f.owner.id, {
    name: 'delegate_goal', callId: 'later', args: { userRequest: quote, employeeId: f.people[0].id, goalId: '', version: 0, title: 'Research later', success: 'Evidence recorded', nextStep: 'Read existing notes', start: false },
  });
  expect(result.result.status).toBe('saved');
});
