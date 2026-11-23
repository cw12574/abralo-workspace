import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Fastify, { type FastifyRequest } from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, uid, now } from '../apps/service/src/store.js';
import { registerNotifications } from '../apps/service/src/notifications.js';
import { sendNativeNotification } from '../apps/service/src/native-notifications.js';

vi.mock('../apps/service/src/native-notifications.js', () => ({
  nativeNotificationsAvailable: () => true,
  prepareNativeNotifications: async () => {},
  sendNativeNotification: vi.fn(async () => {}),
}));

let s: Store;
let app: ReturnType<typeof Fastify>;
let owner: any;
let employee: any;
let conversationId: string;
beforeEach(async () => {
  vi.mocked(sendNativeNotification).mockReset().mockResolvedValue();
  s = new Store(mkdtempSync(join(tmpdir(), 'abralo-alerts-')));
  owner = s.createOwner('Owner');
  employee = s.createEmployee(owner.id, {
    name: 'Agent',
    harness: 'codex',
    model: '',
    cwd: '',
    role: '',
    instructions: '',
  });
  conversationId = employee.dmId;
  app = Fastify();
  app.addHook('onRequest', async (req: FastifyRequest) => {
    (req as any).user = owner;
  });
  await registerNotifications(app, s);
  await app.ready();
  // Only delivery delays are faked; Fastify's request lifecycle uses real microtasks.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(async () => {
  await app.close();
  await Promise.resolve();
  s.close();
  vi.useRealTimers();
});

function finish(state = 'completed', preparation = false) {
  const request = s.addMessage(conversationId, owner.id, owner.name, 'human', 'Please work');
  const runId = uid();
  if (preparation) s.set('briefing.message.' + request.id, 'briefing-fixture');
  const response = s.addMessage(
    conversationId,
    employee.id,
    employee.name,
    'agent',
    '',
    null,
    [],
    runId,
  );
  s.run(
    'INSERT INTO runs(id,conversation_id,user_id,employee_id,message_id,response_id,state,created_at,updated_at,context_key) VALUES(?,?,?,?,?,?,?,?,?,?)',
    runId,
    conversationId,
    owner.id,
    employee.id,
    request.id,
    response.id,
    'running',
    now(),
    now(),
    uid(),
  );
  if (state === 'cancelled') s.transition(runId, 'cancelling');
  s.transition(runId, state as any);
  return response;
}

it('keeps briefing preparation silent while ordinary employee completion still notifies', async () => {
  const response = finish('completed', true);
  s.recordNotifications({ ...response, text: 'Prepared my question.' });
  await vi.advanceTimersByTimeAsync(1600);
  expect(sendNativeNotification).not.toHaveBeenCalled();
  expect(s.one('SELECT 1 FROM inbox WHERE message_id=?', response.id)).toBeUndefined();
  finish();
  await vi.advanceTimersByTimeAsync(1600);
  expect(sendNativeNotification).toHaveBeenCalledOnce();
});

it.each(['completed', 'failed', 'provider_limited'])(
  'alerts the run owner for %s, including an empty conversation reply without a mention',
  async (state) => {
    finish(state);
    await vi.advanceTimersByTimeAsync(1600);
    expect(sendNativeNotification).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendNativeNotification).mock.calls[0][1].title).toBe('Agent');
  },
);

it.each(['cancelled', 'interrupted'])('stays silent for a %s turn', async (state) => {
  const response = finish(state);
  s.recordNotifications({ ...response, text: 'Partial reply' });
  await vi.advanceTimersByTimeAsync(1600);
  expect(sendNativeNotification).not.toHaveBeenCalled();
});

it('keeps other direct messages unread without a desktop alert', async () => {
  // e.g. Chief of Staff receipts, delegated tasks, goal reports and handoffs.
  const posted = s.addMessage(conversationId, employee.id, employee.name, 'agent', 'Goal progress report');
  await vi.advanceTimersByTimeAsync(1600);
  expect(sendNativeNotification).not.toHaveBeenCalled();
  expect(s.one('SELECT 1 FROM inbox WHERE user_id=? AND message_id=?', owner.id, posted.id)).toBeTruthy();
});

it('merges the final message with completion and ignores focused-page acknowledgments', async () => {
  const response = finish();
  s.run('INSERT INTO inbox VALUES(?,?,0,?)', owner.id, response.id, now());
  s.emit(
    'notification.message',
    conversationId,
    { id: response.id, authorName: 'Agent', text: 'Finished work' },
    owner.id,
  );
  await Promise.resolve();
  const ack = await app.inject({
    method: 'POST',
    url: '/api/notifications/ack',
    payload: { messageId: response.id },
  });
  expect(ack.statusCode).toBe(200);
  await vi.advanceTimersByTimeAsync(1600);
  expect(sendNativeNotification).toHaveBeenCalledTimes(1);
  expect(vi.mocked(sendNativeNotification).mock.calls[0][1].body).toBe('Finished work');
});

it.each([
  ['decision.created', { kind: 'question' }],
  ['decision.created', { kind: 'permission' }],
  ['connection.requested', {}],
  ['connection.action', { state: 'awaiting_approval' }],
  ['proposal.created', {}],
])('alerts for attention event %s %j', async (type, payload) => {
  s.emit(type, employee.dmId, { id: uid(), ...payload }, owner.id);
  await vi.advanceTimersByTimeAsync(1600);
  expect(sendNativeNotification).toHaveBeenCalledTimes(1);
});

it('does not alert for resolved actions or deliver into another human’s private conversation', async () => {
  const other = s.createOwner('Other');
  s.emit('connection.action', conversationId, { id: uid(), state: 'succeeded' }, owner.id);
  s.emit('decision.created', employee.dmId, { id: uid(), kind: 'question' }, other.id);
  await vi.advanceTimersByTimeAsync(1600);
  expect(sendNativeNotification).not.toHaveBeenCalled();
});

it('honors opt-out and uses current sound and preview preferences at delivery', async () => {
  finish();
  await Promise.resolve();
  s.set('notifications.' + owner.id, { enabled: false, sound: true, privatePreview: false });
  await vi.advanceTimersByTimeAsync(1600);
  expect(sendNativeNotification).not.toHaveBeenCalled();
  s.set('notifications.' + owner.id, { enabled: true, sound: true, privatePreview: false });
  finish();
  await Promise.resolve();
  s.set('notifications.' + owner.id, { enabled: true, sound: false, privatePreview: true });
  await vi.advanceTimersByTimeAsync(1600);
  expect(vi.mocked(sendNativeNotification).mock.calls[0][1]).toEqual({
    title: 'Agent',
    body: 'You have a new message.',
    sound: false,
  });
});

it('does not overwrite a synchronous native failure with a Windows success status', async () => {
  vi.mocked(sendNativeNotification).mockImplementation(async (_s, _n, onFailure) => {
    onFailure?.(new Error('Unavailable'));
  });
  finish();
  await vi.advanceTimersByTimeAsync(1600);
  expect(s.setting('notifications.delivery.' + owner.id).channel).toBe('none');
});
