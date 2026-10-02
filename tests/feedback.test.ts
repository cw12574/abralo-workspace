import { it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, uid } from '../apps/service/src/store.js';
import { createApp } from '../apps/service/src/app.js';
import { Supervisor } from '../apps/service/src/supervisor.js';
import { ConnectionBroker } from '../apps/service/src/connections.js';

it('onboards one automatic Chief of Staff and gives agents the human name for mentions', async () => {
  const s = new Store(mkdtempSync(join(tmpdir(), 'workspace-onboarding-')));
  const u = s.createOwner('You');
  const { app, supervisor } = await createApp(s);
  let instructions = '';
  supervisor.adapters.codex = {
    info: async () => ({}) as any,
    dispose: async () => {},
    run: async (input) => {
      instructions = input.employee.instructions;
      input.emit({ type: 'complete' });
    },
  };
  const headers = { cookie: 'workspace=' + s.newSession(u.id), 'x-workspace-request': '1' };
  const payload = {
    userName: '  Morgan  ',
    purpose: 'Build a useful product',
    employee: { name: 'Custom name', harness: 'codex' },
  };
  try {
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/onboarding',
      headers,
      payload: { ...payload, userName: '   ' },
    });
    expect(invalid.statusCode).toBe(400);
    const first = await app.inject({ method: 'POST', url: '/api/onboarding', headers, payload });
    expect(first.statusCode).toBe(200);
    await supervisor.dispatch();
    await Promise.all([...supervisor.inflight]);
    expect(first.json().name).toBe('Chief of Staff');
    expect(s.user(u.id).name).toBe('Morgan');
    expect(instructions).toContain('@Morgan');
    expect(s.messages(first.json().dmId).find((m) => m.kind === 'human')?.authorName).toBe(
      'Morgan',
    );
    await app.inject({ method: 'POST', url: '/api/onboarding', headers, payload });
    expect(s.all('SELECT * FROM employees')).toHaveLength(1);
  } finally {
    await app.close();
  }
});

it('approves a team once, includes employees in a channel, and actually queues the chief briefing', async () => {
  const s = new Store(mkdtempSync(join(tmpdir(), 'workspace-team-feedback-'))),
    u = s.createOwner('Owner');
  const chief = s.createEmployee(u.id, {
    name: 'Chief of Staff',
    harness: 'codex',
    model: '',
    role: '',
    cwd: '',
    instructions: '',
  });
  const sup = new Supervisor(s);
  let prompt = '';
  sup.adapters.codex = {
    info: async () => ({
      harness: 'codex',
      installed: true,
      authenticated: true,
      version: 'fixture',
      detail: 'fixture',
    }),
    run: async (input) => {
      prompt = input.prompt;
      input.emit({ type: 'complete', data: {} });
    },
    dispose: async () => {},
  };
  const { app } = await createApp(s, { supervisor: sup });
  const proposal = {
    id: uid(),
    version: 1,
    purpose: 'Build a useful product',
    conversationId: chief.dmId,
    chiefId: chief.id,
    channelName: 'product',
    employees: [{ name: 'Scout', harness: 'codex', role: 'Research' }],
    approved: false,
  };
  s.set('proposals.' + u.id, [proposal]);
  const headers = { cookie: 'workspace=' + s.newSession(u.id), 'x-workspace-request': '1' };
  try {
    const approve = () =>
      app.inject({
        method: 'POST',
        url: '/api/proposals/' + proposal.id + '/approve',
        headers,
        payload: { version: 1 },
      });
    const first = await approve();
    expect(first.statusCode).toBe(200);
    await Promise.all([...sup.inflight]);
    const second = await approve();
    expect(second.json().channelId).toBe(first.json().channelId);
    expect(s.all('SELECT * FROM employees')).toHaveLength(2);
    expect(s.all('SELECT * FROM outbox')).toHaveLength(2);
    expect(
      s.all('SELECT * FROM employee_conversations WHERE conversation_id=?', first.json().channelId),
    ).toHaveLength(2);
    const confirmation = s.messages(chief.dmId).find((m) => m.text.startsWith('The team is ready'));
    expect(confirmation?.authorId).toBe(chief.id);
    expect(confirmation?.authorName).toBe(chief.name);
    expect(confirmation?.kind).toBe('system');
    expect(s.messages(chief.dmId).some((m) => m.text.startsWith('Team created:'))).toBe(false);
    expect(prompt).not.toContain('workspace_publish_plan');
    expect(prompt).toContain('Follow the user’s requested scope');
    expect(s.one('SELECT conversation_id FROM runs LIMIT 1').conversation_id).toBe(
      first.json().channelId,
    );
    expect(
      s.one('SELECT text FROM messages WHERE id=?', first.json().handoffMessageId).text,
    ).not.toContain('workspace_delegate');
  } finally {
    await app.close();
  }
});

it('posts connection success to the conversation exactly once, without credentials', () => {
  const s = new Store(mkdtempSync(join(tmpdir(), 'workspace-connection-feedback-'))),
    u = s.createOwner('Owner');
  const e = s.createEmployee(u.id, {
    name: 'Chief',
    harness: 'codex',
    model: '',
    role: '',
    cwd: '',
    instructions: '',
  });
  const broker = new ConnectionBroker(s, () => 'http://127.0.0.1:4317');
  const c = {
    id: uid(),
    service: 'stripe',
    data: JSON.stringify({ conversationId: e.dmId, employeeId: e.id }),
  };
  broker.announceReady(c);
  broker.announceReady(c);
  expect(s.messages(e.dmId)).toHaveLength(1);
  expect(s.messages(e.dmId)[0].text).toBe('Stripe connected. Read-only access is ready for Chief.');
  s.close();
});

it('announces an agent leaving each room when deleted and removes its room membership', async () => {
  const s = new Store(mkdtempSync(join(tmpdir(), 'workspace-agent-leave-'))),
    u = s.createOwner('Owner'),
    e = s.createEmployee(u.id, {
      name: 'Chief of Staff',
      harness: 'codex',
      model: '',
      cwd: '',
      role: '',
      instructions: '',
    });
  const room = uid();
  s.run(
    'INSERT INTO conversations VALUES(?,?,?,?,?)',
    room,
    'team',
    'channel',
    null,
    new Date().toISOString(),
  );
  s.run('INSERT INTO members(conversation_id,user_id) VALUES(?,?)', room, u.id);
  s.run('INSERT INTO employee_conversations VALUES(?,?)', e.id, room);
  const { app } = await createApp(s);
  const headers = { cookie: 'workspace=' + s.newSession(u.id), 'x-workspace-request': '1' };
  try {
    const deleted = await app.inject({ method: 'DELETE', url: '/api/employees/' + e.id, headers });
    expect(deleted.statusCode).toBe(200);
    expect(
      s
        .messages(room)
        .some(
          (message) => message.kind === 'system' && message.text === 'Chief of Staff left #team.',
        ),
    ).toBe(true);
    expect(
      s.one(
        'SELECT 1 FROM employee_conversations WHERE employee_id=? AND conversation_id=?',
        e.id,
        room,
      ),
    ).toBeUndefined();
  } finally {
    await app.close();
  }
});

it('recreates a deleted Chief of Staff and preserves saved workspace objectives', async () => {
  const s = new Store(mkdtempSync(join(tmpdir(), 'workspace-recreate-chief-'))),
    u = s.createOwner('Owner'),
    e = s.createEmployee(u.id, {
      name: 'Chief of Staff',
      harness: 'claude',
      model: '',
      cwd: '',
      role: '',
      instructions: '',
    });
  s.set('workspace.chiefOfStaff.' + u.id, e.id);
  s.set('workspace.objectives.' + u.id, ['Ship the preview']);
  const { app } = await createApp(s);
  const headers = { cookie: 'workspace=' + s.newSession(u.id), 'x-workspace-request': '1' };
  try {
    const deleted = await app.inject({ method: 'DELETE', url: '/api/employees/' + e.id, headers });
    expect(deleted.statusCode).toBe(200);
    const created = await app.inject({
      method: 'POST',
      url: '/api/chief-of-staff',
      headers,
      payload: { harness: 'codex' },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().name).toBe('Chief of Staff');
    expect(created.json().harness).toBe('codex');
    expect(s.setting('workspace.objectives.' + u.id)).toEqual(['Ship the preview']);
    expect(s.setting('workspace.chiefOfStaff.' + u.id)).toBe(created.json().id);
  } finally {
    await app.close();
  }
});
