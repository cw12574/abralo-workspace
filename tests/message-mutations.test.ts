import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../apps/service/src/store.js';
import { createApp } from '../apps/service/src/app.js';

const fixtures: {
  store: Store;
  dir: string;
  app?: Awaited<ReturnType<typeof createApp>>['app'];
}[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.app?.close();
    fixture.store.close();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

it('lets people edit and delete only their own messages while preserving thread replies', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workspace-message-mutations-'));
  const store = new Store(dir);
  const owner = store.createOwner('Chris');
  const other = store.createOwner('Ada');
  const agent = store.createEmployee(owner.id, {
    name: 'Chief of Staff',
    harness: 'codex',
    role: '',
    model: '',
    cwd: '',
    instructions: '',
  });
  const room = store.setting('workspace.team');
  const parent = store.addMessage(room, owner.id, owner.name, 'human', 'Original wording');
  const reply = store.addMessage(
    room,
    agent.id,
    agent.name,
    'agent',
    'A focused response',
    parent.id,
  );
  const { app } = await createApp(store);
  fixtures.push({ store, dir, app });
  const headers = {
    cookie: 'workspace=' + store.newSession(owner.id),
    'x-workspace-request': '1',
  };
  const otherHeaders = {
    cookie: 'workspace=' + store.newSession(other.id),
    'x-workspace-request': '1',
  };

  const edited = await app.inject({
    method: 'PATCH',
    url: `/api/messages/${parent.id}`,
    headers,
    payload: { text: 'Clearer wording' },
  });
  expect(edited.statusCode).toBe(200);
  expect(edited.json()).toMatchObject({ id: parent.id, text: 'Clearer wording' });
  expect(edited.json().editedAt).toBeTruthy();
  expect(
    (
      await app.inject({
        method: 'PATCH',
        url: `/api/messages/${parent.id}`,
        headers: otherHeaders,
        payload: { text: 'Changed' },
      })
    ).statusCode,
  ).toBe(403);

  const deniedAgentEdit = await app.inject({
    method: 'PATCH',
    url: `/api/messages/${reply.id}`,
    headers,
    payload: { text: 'Changed agent response' },
  });
  expect(deniedAgentEdit.statusCode).toBe(403);

  const deleted = await app.inject({
    method: 'DELETE',
    url: `/api/messages/${parent.id}`,
    headers,
  });
  expect(deleted.statusCode).toBe(200);
  expect(deleted.json()).toMatchObject({
    id: parent.id,
    text: '',
    attachments: [],
    deletedAt: expect.any(String),
    replyCount: 1,
  });

  const thread = await app.inject({
    url: `/api/conversations/${room}/messages?threadId=${parent.id}`,
    headers,
  });
  expect(thread.json().messages.map((message: any) => message.id)).toContain(reply.id);
  const doubleDelete = await app.inject({
    method: 'DELETE',
    url: `/api/messages/${parent.id}`,
    headers,
  });
  expect(doubleDelete.statusCode).toBe(409);

  const deniedDelete = await app.inject({
    method: 'DELETE',
    url: `/api/messages/${reply.id}`,
    headers,
  });
  expect(deniedDelete.statusCode).toBe(403);

  const queued = store.accept(owner, agent.dmId, {
    text: 'Work I no longer need',
    key: 'delete-queued-work',
    attachments: [],
    recipients: [],
    newTask: false,
  });
  const queuedDelete = await app.inject({
    method: 'DELETE',
    url: `/api/messages/${queued.id}`,
    headers,
  });
  expect(queuedDelete.statusCode).toBe(200);
  expect(store.one('SELECT status FROM outbox WHERE message_id=?', queued.id).status).toBe(
    'cancelled',
  );
});

it('clears the saved composer draft after its message is accepted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workspace-sent-draft-'));
  const store = new Store(dir);
  const owner = store.createOwner('Chris');
  const room = store.setting('workspace.team');
  const { app } = await createApp(store);
  fixtures.push({ store, dir, app });
  const headers = {
    cookie: 'workspace=' + store.newSession(owner.id),
    'x-workspace-request': '1',
  };

  const savedDraft = await app.inject({
    method: 'PUT',
    url: `/api/conversations/${room}/draft`,
    headers,
    payload: { text: 'A message ready to send', attachments: [], threadId: '' },
  });
  expect(savedDraft.statusCode).toBe(200);

  const sent = await app.inject({
    method: 'POST',
    url: `/api/conversations/${room}/messages`,
    headers,
    payload: {
      text: 'A message ready to send',
      key: 'send-and-clear-draft',
      attachments: [],
      recipients: [],
      newTask: false,
    },
  });
  expect(sent.statusCode).toBe(200);

  const draft = await app.inject({
    url: `/api/conversations/${room}/draft`,
    headers,
  });
  expect(draft.json()).toEqual({ text: '', attachments: [] });
});

it('sends thread replies with the destination conversation working folder', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workspace-thread-folder-'));
  const store = new Store(dir);
  const owner = store.createOwner('Chris');
  const agent = store.createEmployee(owner.id, {
    name: 'Chief of Staff',
    harness: 'codex',
    role: '',
    model: '',
    cwd: '',
    instructions: '',
  });
  const { app } = await createApp(store);
  fixtures.push({ store, dir, app });
  const headers = {
    cookie: 'workspace=' + store.newSession(owner.id),
    'x-workspace-request': '1',
  };
  const folder = join(dir, 'workspace');
  store.set('conversation.workingFolder.' + agent.dmId, folder);
  const parent = store.addMessage(
    agent.dmId,
    agent.id,
    agent.name,
    'agent',
    'A message with a thread attached',
  );

  const reply = await app.inject({
    method: 'POST',
    url: `/api/conversations/${agent.dmId}/messages`,
    headers,
    payload: {
      text: 'A thread reply while the working folder is selected',
      key: 'thread-reply-with-working-folder',
      threadId: parent.id,
      attachments: [],
      recipients: [],
      newTask: false,
      modelOverride: null,
    },
  });

  expect(reply.statusCode).toBe(200);
  expect(reply.json()).toMatchObject({ conversationId: agent.dmId, threadId: parent.id });
  expect(store.setting('message.workingDirectory.' + reply.json().id)).toBe(folder);
});
