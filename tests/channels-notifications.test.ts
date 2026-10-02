import { it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, uid, hash, now } from '../apps/service/src/store.js';
import { createApp } from '../apps/service/src/app.js';

it('isolates agent DMs, delivers channel briefs, and keeps a durable per-human notification inbox', async () => {
  const s = new Store(mkdtempSync(join(tmpdir(), 'workspace-channels-')));
  const u = s.createOwner('Owner');
  const other = s.createOwner('Other');
  const make = (name: string) =>
    s.createEmployee(u.id, {
      name,
      harness: 'codex',
      model: '',
      cwd: '',
      role: '',
      instructions: '',
    });
  const chief = make('Chief'),
    scout = make('Scout');
  const team = s.setting('workspace.team');
  expect(s.messages(team).filter((m) => m.kind === 'system')).toHaveLength(2);
  s.ensureTeam();
  expect(s.messages(team)).toHaveLength(2);
  const { app, supervisor } = await createApp(s);
  supervisor.adapters.codex = {
    info: async () => ({}) as any,
    dispose: async () => {},
    run: async (input) => {
      expect(input.prompt).not.toContain('PRIVATE_SECRET');
      expect(input.employee.instructions).toContain('@Owner');
      input.emit({ type: 'text', text: 'Shared result' });
      input.emit({ type: 'complete', data: {} });
    },
  };
  const headers = { cookie: 'workspace=' + s.newSession(u.id), 'x-workspace-request': '1' };
  const otherHeaders = {
    cookie: 'workspace=' + s.newSession(other.id),
    'x-workspace-request': '1',
  };
  try {
    const request = s.addMessage(chief.dmId, u.id, u.name, 'human', 'PRIVATE_SECRET');
    const runId = uid();
    const response = s.addMessage(
      chief.dmId,
      chief.id,
      chief.name,
      'agent',
      'Ready',
      null,
      [],
      runId,
    );
    s.run(
      'INSERT INTO runs(id,conversation_id,user_id,employee_id,message_id,response_id,state,created_at,updated_at,context_key) VALUES(?,?,?,?,?,?,?,?,?,?)',
      runId,
      chief.dmId,
      u.id,
      chief.id,
      request.id,
      response.id,
      'completed',
      now(),
      now(),
      uid(),
    );
    supervisor.tokens.set(hash('fixture-token'), runId);
    const call = async (name: string, args: any) => {
      const r = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: {
          authorization: 'Bearer fixture-token',
          accept: 'application/json, text/event-stream',
        },
        payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
      });
      return r.json();
    };
    expect(JSON.stringify(await call('workspace_publish_plan', {}))).toContain('not found');
    expect(JSON.stringify(await call('workspace_read_plans', {}))).toContain('not found');
    const selectedFolder = tmpdir();
    s.set('conversation.workingFolder.' + chief.dmId, selectedFolder);
    s.set('message.workingDirectory.' + request.id, selectedFolder);
    const folderAccess = await call('workspace_request_project_access', {
      type: 'directory',
      reason: 'Continue the current project work',
      suggestedPath: selectedFolder,
    });
    expect(JSON.stringify(folderAccess)).toContain(
      'persistent working folder selected in the composer',
    );
    expect(s.all('SELECT * FROM decisions')).toHaveLength(0);
    expect(s.employee(chief.id)?.cwd).toBe('');
    const routed = await call('workspace_delegate', {
      employeeId: scout.id,
      task: 'Research a public project',
    });
    expect(JSON.stringify(routed)).toContain('Delivered');
    expect(
      s.all(
        "SELECT o.* FROM outbox o JOIN messages m ON m.id=o.message_id WHERE m.author_id=? AND m.text LIKE '@Scout%'",
        chief.id,
      ),
    ).toHaveLength(1);
    const routedMessage = s.messages(team).find((m) => m.kind === 'agent');
    expect(routedMessage?.text).toContain('Research a public project');
    expect(routedMessage?.text).not.toContain('PRIVATE_SECRET');
    expect(routedMessage?.text).not.toContain('Read this private conversation');
    const roomPost = await call('workspace_post_message', {
      conversationId: chief.dmId,
      text: '@Scout — please add a brief pricing review in the shared room.',
    });
    expect(JSON.stringify(roomPost)).toContain('routedFrom');
    expect(
      s
        .messages(team)
        .some((message) => message.text.includes('please add a brief pricing review')),
    ).toBe(true);
    const agentMention = s
      .messages(team)
      .find((message) => message.text.includes('please add a brief pricing review'))!;
    const agentMentionJob = s.one('SELECT * FROM outbox WHERE message_id=?', agentMention.id);
    expect(agentMentionJob.employee_id).toBe(scout.id);
    expect(s.setting('outbox.mention.' + agentMentionJob.id)).toBe(true);
    expect(s.setting(`delegation.parent.${agentMention.id}.${scout.id}`).employeeId).toBe(chief.id);
    expect(s.messages(chief.dmId).some((message) => message.text.includes('pricing review'))).toBe(
      false,
    );
    expect(
      s.all(
        "SELECT o.id FROM outbox o JOIN messages m ON m.id=o.message_id WHERE m.author_id=? AND m.text LIKE '@Scout%'",
        chief.id,
      ),
    ).toHaveLength(2);
    const scheduledAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const scheduled = await call('workspace_schedule', {
      at: scheduledAt,
      prompt: 'Resume the requested work in the shared room.',
    });
    expect(JSON.stringify(scheduled)).toContain('Scheduled once');
    const savedSchedule = s.one('SELECT * FROM schedules');
    expect(savedSchedule.conversation_id).toBe(team);
    expect(savedSchedule.next_at).toBe(scheduledAt);
    expect(savedSchedule.prompt).not.toContain('PRIVATE_SECRET');
    expect(
      s.all(
        "SELECT o.* FROM outbox o JOIN messages m ON m.id=o.message_id WHERE m.author_id=? AND m.text LIKE '@Scout%'",
        chief.id,
      ),
    ).toHaveLength(2);
    const planId = uid();
    const plan = {
      id: planId,
      messageId: uid(),
      conversationId: team,
      threadId: null,
      employeeId: chief.id,
      responsibilities: [{ employeeId: chief.id }],
      state: 'review',
    };
    s.run(
      'INSERT INTO plans VALUES(?,?,?,?,?,?)',
      planId,
      plan.messageId,
      team,
      chief.id,
      JSON.stringify(plan),
      now(),
    );
    s.set('run.plan.' + runId, planId);
    s.run(
      'UPDATE messages SET text=? WHERE id=?',
      'Please wait until 12pm tomorrow, and then execute on this.',
      request.id,
    );
    const plannedAt = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
    const scheduledPlan = await call('workspace_schedule', {
      at: plannedAt,
      prompt: 'Execute the agreed PollyTalks plan.',
    });
    expect(JSON.stringify(scheduledPlan)).toContain('Scheduled once');
    const agreedPlan = JSON.parse(s.one('SELECT data FROM plans WHERE id=?', planId).data);
    expect(agreedPlan.state).toBe('review'); // Historical state is no longer consulted or mutated.
    expect(
      s.all(
        "SELECT o.* FROM outbox o JOIN messages m ON m.id=o.message_id WHERE m.author_id=? AND m.text LIKE '@Scout%'",
        chief.id,
      ),
    ).toHaveLength(2);
    const posted = await call('workspace_post_message', {
      conversationId: team,
      text: '@room A useful update.',
    });
    const postedId = JSON.parse(posted.result.content[0].text).id;
    expect(s.all('SELECT * FROM outbox WHERE message_id=?', postedId)).toHaveLength(0);
    expect(
      s.all(
        "SELECT o.* FROM outbox o JOIN messages m ON m.id=o.message_id WHERE m.author_id=? AND m.text LIKE '@Scout%'",
        chief.id,
      ),
    ).toHaveLength(2);
    s.set('run.readOnly.' + runId, true);
    const premature = await call('workspace_delegate', {
      employeeId: scout.id,
      task: 'Implement this immediately',
      conversationId: team,
      purpose: 'execute',
    });
    expect(JSON.stringify(premature)).toContain('bounded review or research');
    s.set('run.readOnly.' + runId, false);
    // Even an old erroneous membership cannot override DM participant identity.
    s.run('INSERT INTO employee_conversations VALUES(?,?)', scout.id, chief.dmId);
    expect(() => s.authorizeEmployee(scout.id, chief.dmId)).toThrow('Private messages');
    expect(JSON.stringify(await call('workspace_read', { conversationId: scout.dmId }))).toContain(
      'Private messages',
    );
    expect(() =>
      s.accept(u, chief.dmId, {
        key: uid(),
        text: 'Hello',
        recipients: [scout.id],
        attachments: [],
      }),
    ).toThrow('private direct message');
    const sent = await call('workspace_delegate', {
      employeeId: scout.id,
      task: 'Research the public project',
      conversationId: team,
    });
    expect(JSON.stringify(sent)).toContain('Delivered');
    for (let attempt = 0; attempt < 8; attempt++) {
      await supervisor.dispatch();
      await Promise.all([...supervisor.inflight]);
      if (!s.one("SELECT 1 FROM outbox WHERE status IN ('pending','new','claimed')")) break;
    }
    expect(s.messages(team).some((m) => m.text === 'Shared result')).toBe(true);
    s.emit('message.finished', chief.dmId, { id: response.id }, u.id);
    s.emit('message.finished', chief.dmId, { id: response.id }, u.id);
    const root = s.addMessage(team, u.id, u.name, 'human', 'Question for everyone');
    const unrelated = s.addMessage(team, scout.id, scout.name, 'agent', 'Routine channel update');
    const runningResponse = s.addMessage(
      team,
      scout.id,
      scout.name,
      'agent',
      'A routine response to your channel request',
      null,
      [],
      uid(),
    );
    s.emit('message.finished', team, { id: runningResponse.id }, u.id);
    const mentioned = s.addMessage(
      team,
      scout.id,
      scout.name,
      'agent',
      `@${u.name}, please review this`,
    );
    const roomReference = s.addMessage(
      team,
      scout.id,
      scout.name,
      'agent',
      `#${u.name} is a room reference`,
    );
    const reply = s.addMessage(team, scout.id, scout.name, 'agent', 'Thread answer', root.id);
    const inbox = (await app.inject({ url: '/api/notifications/inbox', headers })).json();
    expect(inbox.items.filter((m: any) => m.id === response.id)).toHaveLength(1);
    expect(inbox.items.some((m: any) => m.id === unrelated.id)).toBe(false);
    expect(inbox.items.some((m: any) => m.id === runningResponse.id)).toBe(false);
    expect(inbox.items.some((m: any) => m.id === mentioned.id)).toBe(true);
    expect(inbox.items.some((m: any) => m.id === roomReference.id)).toBe(false);
    expect(inbox.items.find((m: any) => m.id === reply.id).threadId).toBe(root.id);
    expect(
      (await app.inject({ url: '/api/notifications/inbox', headers: otherHeaders })).json().items,
    ).toHaveLength(0);
    await app.inject({
      method: 'POST',
      url: '/api/notifications/inbox/read',
      headers,
      payload: { messageId: reply.id },
    });
    expect(
      (await app.inject({ url: '/api/notifications/inbox', headers }))
        .json()
        .items.find((m: any) => m.id === reply.id).seen,
    ).toBe(true);
    expect(
      s.one('SELECT seen FROM inbox WHERE user_id=? AND message_id=?', u.id, reply.id).seen,
    ).toBe(1);
  } finally {
    await app.close();
  }
}, 30_000);
