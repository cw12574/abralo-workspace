import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, uid, now } from '../apps/service/src/store.js';
import { createApp } from '../apps/service/src/app.js';

let store: Store;
let app: Awaited<ReturnType<typeof createApp>>['app'];
let headers: Record<string, string>;
let otherHeaders: Record<string, string>;
let agent: any;
let response: any;
let step: any;
let runId: string;
let owner: any;
let other: any;
beforeEach(async () => {
  store = new Store(mkdtempSync(join(tmpdir(), 'workspace-activity-details-')));
  owner = store.createOwner('Owner');
  other = store.createOwner('Other');
  agent = store.createEmployee(owner.id, {
    name: 'Agent',
    harness: 'codex',
    role: '',
    model: '',
    cwd: '',
    instructions: '',
  });
  const request = store.addMessage(agent.dmId, owner.id, owner.name, 'human', 'Work');
  runId = uid();
  response = store.addMessage(
    agent.dmId,
    agent.id,
    agent.name,
    'agent',
    'Visible answer',
    null,
    [],
    runId,
  );
  store.run(
    'INSERT INTO runs(id,conversation_id,user_id,employee_id,message_id,response_id,state,created_at,updated_at,context_key) VALUES(?,?,?,?,?,?,?,?,?,?)',
    runId,
    agent.dmId,
    owner.id,
    agent.id,
    request.id,
    response.id,
    'completed',
    now(),
    now(),
    'fixture',
  );
  step = {
    id: uid(),
    type: 'tool',
    title: 'Read source',
    time: now(),
    updatedAt: now(),
    state: 'complete',
    detail: 'Large tool result: ' + 'x'.repeat(9 * 1024 * 1024),
  };
  store.run('INSERT INTO activities VALUES(?,?,?)', step.id, runId, JSON.stringify(step));
  ({ app } = await createApp(store));
  headers = { cookie: 'workspace=' + store.newSession(owner.id), 'x-workspace-request': '1' };
  otherHeaders = { cookie: 'workspace=' + store.newSession(other.id), 'x-workspace-request': '1' };
});
afterEach(async () => {
  await app?.close();
  const dir = store.dir;
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

it('serves small history summaries and fetches the full output only by step', async () => {
  for (const url of [
    `/api/conversations/${agent.dmId}/messages?activity=summary`,
    `/api/conversations/${agent.dmId}/messages?agentView=1&activity=summary`,
  ]) {
    const result = await app.inject({ url, headers });
    expect(result.statusCode).toBe(200);
    expect(result.body.length).toBeLessThan(10000);
    const message = result.json().messages.find((m: any) => m.id === response.id);
    expect(message).toMatchObject({
      text: 'Visible answer',
      activity: [{ id: step.id, hasDetail: true }],
    });
    expect(message.activity[0].detail).toBeUndefined();
  }
  const direct = await app.inject({
    url: `/api/messages/${response.id}?activity=summary`,
    headers,
  });
  expect(direct.body.length).toBeLessThan(2000);
  const detail = await app.inject({
    url: `/api/messages/${response.id}/activities/${step.id}`,
    headers,
  });
  expect(detail.statusCode).toBe(200);
  expect(detail.headers['cache-control']).toBe('no-store');
  expect(detail.json().detail).toBe(step.detail);
  expect(
    store.message(store.one('SELECT * FROM messages WHERE id=?', response.id)).activity?.[0].detail,
  ).toBe(step.detail);
});

it('enforces conversation membership, agent access and message-to-step ownership', async () => {
  const url = `/api/messages/${response.id}/activities/${step.id}`;
  expect((await app.inject({ url, headers: otherHeaders })).statusCode).toBe(403);
  store.run('INSERT INTO members(conversation_id,user_id) VALUES(?,?)', agent.dmId, other.id);
  expect((await app.inject({ url, headers: otherHeaders })).statusCode).toBe(403);
  store.run('INSERT INTO employee_grants VALUES(?,?)', agent.id, other.id);
  expect((await app.inject({ url, headers: otherHeaders })).statusCode).toBe(200);
  store.run('DELETE FROM employee_grants WHERE employee_id=? AND user_id=?', agent.id, other.id);
  expect((await app.inject({ url, headers: otherHeaders })).statusCode).toBe(403);
  store.run(
    'INSERT INTO activities VALUES(?,?,?)',
    'different-step',
    'different-run',
    JSON.stringify({ ...step, detail: 'Another run' }),
  );
  expect(
    (await app.inject({ url: `/api/messages/${response.id}/activities/different-step`, headers }))
      .statusCode,
  ).toBe(404);
  expect(
    (await app.inject({ url: `/api/messages/${response.id}/activities/missing`, headers }))
      .statusCode,
  ).toBe(404);
});

it('sends compact replayed and live activity events without changing durable tool output', async () => {
  const previous = store.one('SELECT COALESCE(MAX(cursor),0) cursor FROM events').cursor;
  store.emit('activity.updated', agent.dmId, { messageId: response.id, activity: step });
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const result = await fetch(`${origin}/api/events?after=${previous}&activity=summary`, {
      headers,
      signal: controller.signal,
    });
    const reader = result.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const next = async () => {
      while (!buffer.includes('\n\n')) {
        const chunk = await reader.read();
        if (chunk.done) throw Error('Event stream ended');
        buffer += decoder.decode(chunk.value, { stream: true });
      }
      const end = buffer.indexOf('\n\n');
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      expect(frame.length).toBeLessThan(2000);
      return JSON.parse(
        frame
          .split('\n')
          .find((line) => line.startsWith('data: '))!
          .slice(6),
      );
    };
    expect((await next()).payload.activity).toMatchObject({ hasDetail: true, title: step.title });
    store.emit('activity.updated', agent.dmId, {
      messageId: response.id,
      activity: { ...step, title: 'Live output' },
    });
    expect((await next()).payload.activity).toMatchObject({
      hasDetail: true,
      title: 'Live output',
    });
    await reader.cancel();
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
  expect(JSON.parse(store.one('SELECT data FROM activities WHERE id=?', step.id).data).detail).toBe(
    step.detail,
  );
});
