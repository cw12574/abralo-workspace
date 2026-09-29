import { it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, uid } from '../apps/service/src/store.js';
import { createApp } from '../apps/service/src/app.js';

function fixture() {
  const s = new Store(mkdtempSync(join(tmpdir(), 'workspace-planning-')));
  const user = s.createOwner('Owner');
  const agent = s.createEmployee(user.id, {
    name: 'Chief',
    harness: 'codex',
    model: '',
    role: '',
    cwd: '',
    instructions: '',
  });
  return { s, user, agent, room: s.setting('workspace.team') };
}

it('keeps execution in the agent view and only publishes final output in the room, with access boundaries', async () => {
  const { s, user, agent, room } = fixture();
  const { app, supervisor } = await createApp(s);
  let readOnly: boolean | undefined;
  supervisor.adapters.codex = {
    info: async () => ({}) as any,
    dispose: async () => {},
    run: async (input) => {
      readOnly = input.readOnly;
      expect(input.employee.instructions).not.toContain('workspace_publish_plan');
      expect(input.employee.instructions).toContain('Follow clear user requests directly');
      input.emit({
        type: 'text',
        text: 'Reading files. Inspecting evidence. Final recommendation.',
      });
      input.emit({
        type: 'activity',
        id: 'read',
        data: { type: 'tool', title: 'Read file', state: 'complete' },
      });
      input.emit({ type: 'final', text: 'Final recommendation.' });
      input.emit({ type: 'complete' });
    },
  };
  const headers = { cookie: 'workspace=' + s.newSession(user.id), 'x-workspace-request': '1' };
  try {
    const res = await app.inject({
      method: 'POST',
      url: `/api/conversations/${room}/messages`,
      headers,
      payload: {
        text: '@Chief fix the planning system and strategy editor',
        key: uid(),
        recipients: [agent.id],
        planFirst: true,
      },
    });
    expect(res.statusCode).toBe(200);
    await supervisor.dispatch();
    await Promise.all([...supervisor.inflight]);
    expect(readOnly).toBe(false);
    const shared = (
      await app.inject({ url: `/api/conversations/${room}/messages`, headers })
    ).json();
    const final = shared.messages.find((m: any) => m.runId);
    expect(final.text).toBe('Final recommendation.');
    expect(final.activity).toEqual([]);
    const privateMessage = s.addMessage(agent.dmId, user.id, user.name, 'human', 'Private context');
    const feed = (
      await app.inject({ url: `/api/conversations/${agent.dmId}/messages?agentView=1`, headers })
    ).json();
    expect(feed.messages.find((m: any) => m.id === final.id).text).toContain('Reading files.');
    expect(feed.messages.find((m: any) => m.id === final.id).activity).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: 'Read file' }),
        expect.objectContaining({ type: 'workspace_post', url: `/?conversation=${room}` }),
      ]),
    );
    const other = s.createOwner('Other');
    s.run('INSERT INTO employee_grants VALUES(?,?)', agent.id, other.id);
    const otherHeaders = { cookie: 'workspace=' + s.newSession(other.id) };
    const denied = await app.inject({
      url: `/api/conversations/${agent.dmId}/messages?agentView=1`,
      headers: otherHeaders,
    });
    expect(denied.statusCode).toBe(403);
    expect(JSON.stringify(denied.json())).not.toContain(privateMessage.text);
  } finally {
    await app.close();
  }
});

it('archives every plan revision once, preserves deleted messages and never routes by old plan state', async () => {
  const { s, user, agent, room } = fixture();
  const message = s.addMessage(room, agent.id, agent.name, 'agent', 'Old plan cover');
  const removed = s.addMessage(room, agent.id, agent.name, 'agent', '');
  s.run('UPDATE messages SET deleted_at=? WHERE id=?', new Date().toISOString(), removed.id);
  const plan = {
    id: uid(),
    title: 'Historical approach',
    state: 'review',
    employeeId: agent.id,
    messageId: message.id,
    conversationId: room,
    threadId: null,
    revisions: [
      {
        title: 'First draft',
        body: 'Original proposal',
        responsibilities: [{ name: 'Chief', responsibility: 'Investigate' }],
      },
      { title: 'Revised draft', body: 'Updated proposal', responsibilities: [] },
    ],
  };
  for (const id of [message.id, removed.id])
    s.run(
      'INSERT INTO plans VALUES(?,?,?,?,?,?)',
      uid(),
      id,
      room,
      agent.id,
      JSON.stringify(plan),
      new Date().toISOString(),
    );
  s.set('migration.plan-history', false);
  const dir = s.dir;
  s.close();
  const reopened = new Store(dir);
  const text = reopened.one('SELECT text FROM messages WHERE id=?', message.id).text;
  expect(text).toContain('Original proposal');
  expect(text).toContain('Updated proposal');
  expect(text).toContain('Chief: Investigate');
  expect(text.indexOf('Updated proposal')).toBeLessThan(text.indexOf('Original proposal'));
  expect(reopened.one('SELECT text FROM messages WHERE id=?', removed.id).text).toBe('');
  expect(reopened.all('SELECT * FROM plans')).toHaveLength(2);
  expect(
    reopened.message(reopened.one('SELECT * FROM messages WHERE id=?', message.id)),
  ).not.toHaveProperty('plan');
  const followup = reopened.accept(user, room, {
    key: uid(),
    text: 'Go ahead',
    recipients: [],
    attachments: [],
  });
  expect(reopened.all('SELECT * FROM outbox WHERE message_id=?', followup.id)).toHaveLength(0);
  const threadReply = reopened.accept(user, room, {
    key: uid(),
    text: 'Explain the earlier draft',
    threadId: message.id,
    recipients: [],
    attachments: [],
  });
  expect(
    reopened.one('SELECT employee_id FROM outbox WHERE message_id=?', threadReply.id).employee_id,
  ).toBe(agent.id);
  reopened.close();
  const again = new Store(dir);
  try {
    expect(again.one('SELECT text FROM messages WHERE id=?', message.id).text).toBe(text);
  } finally {
    again.close();
  }
});

it('uses read-only execution only for explicit delegated review or research, ignoring legacy flags', async () => {
  const { s, user, agent } = fixture();
  const { app, supervisor } = await createApp(s);
  const inputs: any[] = [];
  supervisor.adapters.codex = {
    info: async () => ({}) as any,
    dispose: async () => {},
    run: async (input) => {
      inputs.push(input);
      input.emit({ type: 'complete' });
    },
  };
  try {
    for (const purpose of ['review', 'research', 'execute']) {
      const message = s.accept(user, agent.dmId, {
        key: uid(),
        text: 'Work on the strategy plan',
        recipients: [],
        attachments: [],
      });
      s.set('delegation.purpose.' + message.id, purpose);
      s.set('message.planFirst.' + message.id, true);
      s.set('message.plan.' + message.id, 'obsolete-plan');
      await supervisor.dispatch();
      await Promise.all([...supervisor.inflight]);
    }
    expect(inputs.map((input) => input.readOnly)).toEqual([true, true, false]);
    expect(inputs[0].employee.instructions).toContain('bounded review or research');
    expect(inputs[2].employee.instructions).not.toContain('PLAN FIRST');
    expect(inputs[2].employee.instructions).toContain(
      'If the user asks for a plan, review or research',
    );
  } finally {
    await app.close();
  }
});
