import { expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../apps/service/src/app.js';
import { Store, hash, now, uid } from '../apps/service/src/store.js';

it('offers busy-agent mentions for a choice and preserves queued work until it runs', async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'workspace-mentions-')));
  const owner = store.createOwner('Owner');
  const agent = store.createEmployee(owner.id, {
    name: 'Builder',
    role: 'Builds the product',
    harness: 'codex',
    model: '',
    cwd: '',
    instructions: '',
  });
  const team = store.setting('workspace.team');
  const { app, supervisor } = await createApp(store);
  const busyRunId = uid();
  const activeRequest = store.addMessage(team, owner.id, owner.name, 'human', 'Current work');
  const activeResponse = store.addMessage(
    team,
    agent.id,
    agent.name,
    'agent',
    'Working…',
    null,
    [],
    busyRunId,
  );
  store.run(
    'INSERT INTO runs(id,conversation_id,user_id,employee_id,message_id,response_id,state,created_at,updated_at,context_key) VALUES(?,?,?,?,?,?,?,?,?,?)',
    busyRunId,
    team,
    owner.id,
    agent.id,
    activeRequest.id,
    activeResponse.id,
    'running',
    now(),
    now(),
    uid(),
  );
  store.set('run.config.' + busyRunId, { harness: 'codex' });
  const nudges: string[] = [];
  let startedRuns = 0;
  let lastPrompt = '';
  supervisor.adapters.codex = {
    info: async () => ({}) as any,
    dispose: async () => {},
    steer: async (_runId, message) => {
      nudges.push(message);
      return true;
    },
    run: async (input) => {
      startedRuns++;
      lastPrompt = input.prompt;
      input.emit({ type: 'text', text: 'I handled the queued request.' });
      input.emit({ type: 'final', text: 'I handled the queued request.' });
      input.emit({ type: 'complete', data: {} });
    },
  };
  supervisor.active.set(busyRunId, new AbortController());
  const busyToken = 'busy-agent-token';
  supervisor.tokens.set(hash(busyToken), busyRunId);
  const tool = async (name: string, args: any) => {
    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        authorization: `Bearer ${busyToken}`,
        accept: 'application/json, text/event-stream',
      },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    });
    return response.json();
  };
  try {
    const immediate = store.accept(owner, team, {
      key: uid(),
      text: '@Builder please check the migration issue.',
      recipients: [],
      attachments: [],
    });
    const immediateJob = store.one('SELECT * FROM outbox WHERE message_id=?', immediate.id);
    expect(store.setting('outbox.mention.' + immediateJob.id)).toBe(true);

    await supervisor.dispatch();
    expect(nudges).toHaveLength(1);
    expect(nudges[0]).toContain(immediate.id);
    expect(immediateJob.status).toBe('pending');

    const choice = await tool('workspace_mention_decision', {
      action: 'handle_now',
      messageId: immediate.id,
    });
    expect(JSON.stringify(choice)).toContain('handling_now');
    const posted = await tool('workspace_post_message', {
      conversationId: team,
      threadId: null,
      text: 'I found the migration issue and will fix it.',
    });
    const replyMessageId = JSON.parse(posted.result.content[0].text).id;
    const completed = await tool('workspace_mention_decision', {
      action: 'complete',
      messageId: immediate.id,
      replyMessageId,
    });
    expect(JSON.stringify(completed)).toContain('completed');
    expect(store.one('SELECT status FROM outbox WHERE id=?', immediateJob.id).status).toBe('done');

    const queued = store.accept(owner, team, {
      key: uid(),
      text: '@Builder after this, review the README.',
      threadId: activeRequest.id,
      recipients: [],
      attachments: [],
    });
    const queuedJob = store.one('SELECT * FROM outbox WHERE message_id=?', queued.id);
    await supervisor.dispatch();
    expect(nudges).toHaveLength(2);
    const deferred = await tool('workspace_mention_decision', {
      action: 'queue',
      messageId: queued.id,
    });
    expect(JSON.stringify(deferred)).toContain('automatically');
    expect(store.one('SELECT status FROM outbox WHERE id=?', queuedJob.id).status).toBe('pending');

    store.transition(busyRunId, 'completed');
    supervisor.active.delete(busyRunId);
    for (let attempt = 0; attempt < 5; attempt++) {
      await supervisor.dispatch();
      await Promise.all([...supervisor.inflight]);
      if (store.one('SELECT status FROM outbox WHERE id=?', queuedJob.id).status === 'done') break;
    }
    expect(startedRuns).toBe(1);
    expect(store.one('SELECT status FROM outbox WHERE id=?', queuedJob.id).status).toBe('done');
    expect(lastPrompt).toContain('You were explicitly @mentioned');
    expect(lastPrompt).toContain('acknowledge the mention and contribute usefully');
    const reply = store.one(
      'SELECT m.thread_id,m.text FROM runs r JOIN messages m ON m.id=r.response_id WHERE r.message_id=?',
      queued.id,
    );
    expect(reply).toEqual({ thread_id: activeRequest.id, text: 'I handled the queued request.' });
  } finally {
    await app.close();
    store.close();
  }
}, 30_000);
