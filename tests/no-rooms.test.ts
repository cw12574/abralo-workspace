import { expect, it, vi } from 'vitest';
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, uid, hash, now } from '../apps/service/src/store.js';
import { createApp } from '../apps/service/src/app.js';
import { Goals } from '../apps/service/src/goals.js';

vi.mock('../apps/service/src/native-notifications.js', () => ({
  nativeNotificationsAvailable: () => false,
  prepareNativeNotifications: async () => {},
  sendNativeNotification: vi.fn(),
}));

it.each(['channel', 'archive'])(
  'permanently removes %s rooms and dependent records while preserving DMs and goals',
  async (kind) => {
    const dir = mkdtempSync(join(tmpdir(), 'abralo-retire-rooms-'));
    let s = new Store(dir);
    const owner = s.createOwner('Owner');
    const other = s.createOwner('Other');
    const agent = s.createEmployee(owner.id, { name: 'Agent', harness: 'codex' });
    expect(s.all("SELECT id FROM conversations WHERE kind='channel'")).toEqual([]);
    const room = uid();
    s.run('INSERT INTO conversations VALUES(?,?,?,?,?)', room, 'Old work', kind, null, now());
    s.run('INSERT INTO members(conversation_id,user_id) VALUES(?,?)', room, owner.id);
    s.run('CREATE TABLE employee_conversations(employee_id TEXT,conversation_id TEXT)');
    s.run('INSERT INTO employee_conversations VALUES(?,?)', agent.id, room);
    const message = s.addMessage(room, owner.id, owner.name, 'human', 'Historical brief');
    s.run(
      'INSERT INTO schedules VALUES(?,?,?,?,?,?,?,1)',
      uid(),
      owner.id,
      room,
      agent.id,
      'Old work',
      now(),
      null,
    );
    s.run(
      'INSERT INTO outbox VALUES(?,?,?,?,?,?)',
      uid(),
      message.id,
      agent.id,
      owner.id,
      'pending',
      now(),
    );
    s.set('workspace.team', room);
    const goal = new Goals(s).create(owner.id, {
      conversationId: agent.dmId,
      title: 'Finish old work',
      success: 'Outcome checked',
      start: false,
    });
    s.run(
      'UPDATE goals SET conversation_id=?,source_message_id=? WHERE id=?',
      room,
      message.id,
      goal.id,
    );
    const attachment = uid(),
      artifact = join(dir, 'artifacts', attachment);
    writeFileSync(artifact, 'old room attachment');
    s.run(
      'INSERT INTO attachments VALUES(?,?,?,?,?,?,?,?)',
      attachment,
      owner.id,
      room,
      'old.txt',
      'text/plain',
      19,
      artifact,
      now(),
    );
    const runId = uid();
    s.run(
      'INSERT INTO runs(id,conversation_id,user_id,employee_id,message_id,response_id,state,created_at,updated_at,context_key) VALUES(?,?,?,?,?,?,?,?,?,?)',
      runId,
      room,
      owner.id,
      agent.id,
      message.id,
      message.id,
      'running',
      now(),
      now(),
      uid(),
    );
    s.run('INSERT INTO activities VALUES(?,?,?)', uid(), runId, '{}');
    s.run(
      'INSERT INTO decisions(id,run_id,user_id,state,data) VALUES(?,?,?,?,?)',
      uid(),
      runId,
      owner.id,
      'pending',
      '{}',
    );
    const memoryId = uid();
    s.run(
      'INSERT INTO memories(id,conversation_id,author_id,content,source_id,created_at) VALUES(?,?,?,?,?,?)',
      memoryId,
      room,
      agent.id,
      'old room note',
      message.id,
      now(),
    );
    s.run('INSERT INTO memory_fts VALUES(?,?)', memoryId, 'old room note');
    s.set('run.sharedText.' + runId, 'old response');
    s.set('message.context.' + message.id, 'old prompt');
    s.set('proposals.' + owner.id, [{ conversationId: room }, { conversationId: agent.dmId }]);
    s.set('briefing.record.kept', { conversationId: room, brief: 'Earlier team briefing' });
    s.run(
      'CREATE TABLE briefings(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,created_at TEXT NOT NULL,data TEXT NOT NULL)',
    );
    s.run(
      'INSERT INTO briefings VALUES(?,?,?,?)',
      'earlier-briefing',
      owner.id,
      now(),
      JSON.stringify({
        conversationId: room,
        recapMessageId: message.id,
        brief: 'Keep this team briefing',
      }),
    );
    const keptMessage = s.addMessage(agent.dmId, owner.id, owner.name, 'human', 'Keep this DM');
    const keptAttachment = uid(),
      keptPath = join(dir, 'artifacts', keptAttachment);
    writeFileSync(keptPath, 'current artifact');
    s.run(
      'INSERT INTO attachments VALUES(?,?,?,?,?,?,?,?)',
      keptAttachment,
      owner.id,
      agent.dmId,
      'current.txt',
      'text/plain',
      16,
      keptPath,
      now(),
    );
    s.set('message.context.' + keptMessage.id, 'Keep current context');
    s.set('migration.retired-rooms', true);
    s.set('migration.removed-rooms', false);
    s.close();
    s = new Store(dir);
    expect(s.messages(room)).toEqual([]);
    for (const table of [
      'schedules',
      'outbox',
      'runs',
      'activities',
      'decisions',
      'memories',
      'memory_fts',
    ])
      expect(s.all(`SELECT * FROM ${table}`), table).toEqual([]);
    expect(
      s.one("SELECT name FROM sqlite_master WHERE name='employee_conversations'"),
    ).toBeUndefined();
    expect(existsSync(artifact)).toBe(false);
    expect(existsSync(keptPath)).toBe(true);
    expect(s.all('SELECT id FROM attachments')).toEqual([{ id: keptAttachment }]);
    expect(s.messages(agent.dmId).some((m) => m.text === 'Keep this DM')).toBe(true);
    expect(s.setting('message.context.' + keptMessage.id)).toBe('Keep current context');
    expect(
      JSON.parse(s.one('SELECT data FROM briefings WHERE id=?', 'earlier-briefing').data),
    ).toEqual({ brief: 'Keep this team briefing' });
    expect(s.setting('run.sharedText.' + runId)).toBeNull();
    expect(s.setting('message.context.' + message.id)).toBeNull();
    expect(s.setting('proposals.' + owner.id)).toEqual([{ conversationId: agent.dmId }]);
    expect(s.setting('briefing.record.kept')).toEqual({ brief: 'Earlier team briefing' });
    expect(
      s.one('SELECT conversation_id,source_message_id FROM goals WHERE id=?', goal.id),
    ).toEqual({ conversation_id: agent.dmId, source_message_id: null });
    expect(s.all('PRAGMA foreign_key_check')).toEqual([]);
    expect(s.setting('workspace.team')).toBeNull();
    expect(
      new Goals(s).runner.destination(s.one('SELECT * FROM goals WHERE id=?', goal.id)).cid,
    ).toBe(agent.dmId);
    expect(() => s.authorizeEmployee(agent.id, room)).toThrow();
    expect(() => s.authorize(other.id, room)).toThrow();
    expect(() => s.authorize(owner.id, room)).toThrow(/unavailable/);
    const { app } = await createApp(s);
    const headers = { cookie: 'workspace=' + s.newSession(owner.id), 'x-workspace-request': '1' };
    try {
      const workspace = (await app.inject({ url: '/api/workspace', headers })).json();
      expect(workspace.conversations.map((c: any) => c.id)).toEqual([agent.dmId]);
      expect(workspace).not.toHaveProperty('archivedChannels');
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/channels',
            headers,
            payload: { name: 'New room' },
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (await app.inject({ method: 'POST', url: '/api/channels/' + room + '/restore', headers }))
          .statusCode,
      ).toBe(404);
      const history = await app.inject({
        url: '/api/conversations/' + room + '/messages',
        headers,
      });
      expect(history.statusCode).toBe(404);
      const post = await app.inject({
        method: 'POST',
        url: '/api/conversations/' + room + '/messages',
        headers,
        payload: { text: 'Restart', key: uid(), attachments: [], recipients: [] },
      });
      expect(post.statusCode).toBe(404);
      const direct = await app.inject({
        method: 'POST',
        url: '/api/humans/' + other.id + '/conversation',
        headers,
      });
      expect(direct.statusCode).toBe(200);
      const humanMessage = await app.inject({
        method: 'POST',
        url: '/api/conversations/' + direct.json().id + '/messages',
        headers,
        payload: { text: 'Hello', key: uid(), recipients: [], attachments: [] },
      });
      expect(humanMessage.statusCode).toBe(200);
      expect((await app.inject({ url: '/api/workspace', headers })).json().conversations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: direct.json().id, kind: 'human_dm' }),
        ]),
      );
    } finally {
      await app.close();
    }
    const reopened = new Store(dir);
    expect(reopened.messages(room)).toHaveLength(0);
    reopened.close();
  },
  20000,
);

it('keeps schedules in the DM and returns delegated results without granting transcript access', async () => {
  const s = new Store(mkdtempSync(join(tmpdir(), 'abralo-direct-work-')));
  const owner = s.createOwner('Owner');
  const chief = s.createEmployee(owner.id, {
    name: 'Chief',
    canDelegate: true,
    harness: 'codex',
    role: '',
    cwd: '',
    model: '',
    instructions: '',
  });
  const scout = s.createEmployee(owner.id, {
    name: 'Scout',
    harness: 'codex',
    role: '',
    cwd: '',
    model: '',
    instructions: '',
  });
  const { app, supervisor } = await createApp(s);
  const request = s.addMessage(chief.dmId, owner.id, owner.name, 'human', 'PRIVATE_SECRET');
  const runId = uid();
  const response = s.addMessage(
    chief.dmId,
    chief.id,
    chief.name,
    'agent',
    'Working',
    null,
    [],
    runId,
  );
  s.run(
    'INSERT INTO runs(id,conversation_id,user_id,employee_id,message_id,response_id,state,created_at,updated_at,context_key) VALUES(?,?,?,?,?,?,?,?,?,?)',
    runId,
    chief.dmId,
    owner.id,
    chief.id,
    request.id,
    response.id,
    'completed',
    now(),
    now(),
    uid(),
  );
  supervisor.tokens.set(hash('direct-test'), runId);
  supervisor.adapters.codex = {
    info: async () => ({}) as any,
    dispose: async () => {},
    run: async (input) => {
      if (input.employee.id === scout.id) {
        expect(input.prompt).not.toContain('PRIVATE_SECRET');
        expect(input.prompt).toContain('Review the public copy');
      }
      input.emit({ type: 'text', text: 'Private working trace' });
      input.emit({ type: 'final', text: 'The copy is clear.' });
      input.emit({ type: 'complete' });
    },
  };
  const call = async (name: string, args: any) => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        authorization: 'Bearer direct-test',
        accept: 'application/json, text/event-stream',
      },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    });
    const body = res.json();
    const text = body.result?.content?.[0]?.text;
    if (!text) return body;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };
  try {
    expect(
      JSON.stringify(await call('workspace_create_channel', { name: 'Hidden room' })),
    ).toContain('not found');
    const scheduled = await call('workspace_schedule', {
      at: new Date(Date.now() + 3600000).toISOString(),
      prompt: 'Check progress',
    });
    expect(scheduled.conversationId).toBe(chief.dmId);
    const scheduledAgain = await call('workspace_schedule', {
      at: s.one('SELECT next_at FROM schedules').next_at,
      prompt: 'Check progress',
    });
    expect(scheduledAgain.id).toBe(scheduled.id);
    const delegated = await call('workspace_delegate', {
      employeeId: scout.id,
      task: 'Review the public copy',
      purpose: 'review',
    });
    expect(delegated.conversationId).toBe(scout.dmId);
    await supervisor.dispatch();
    await Promise.all([...supervisor.inflight]);
    expect(() => s.authorizeEmployee(chief.id, scout.dmId)).toThrow();
    expect(() => s.authorizeEmployee(scout.id, chief.dmId)).toThrow();
    const result = s
      .messages(chief.dmId, undefined, request.id)
      .find((m) => m.authorId === scout.id);
    expect(result?.text).toBe('The copy is clear.');
    expect(result?.text).not.toContain('Private working trace');
    expect(s.all("SELECT id FROM conversations WHERE kind='channel'")).toEqual([]);
    s.set('run.readOnly.' + runId, true);
    expect(
      (await call('workspace_delegate', { employeeId: scout.id, task: 'More work' })).error,
    ).toContain('bounded');
  } finally {
    await app.close();
  }
}, 20000);
