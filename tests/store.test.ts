import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, uid } from '../apps/service/src/store.js';
import { createApp } from '../apps/service/src/app.js';
const resources: { store: Store; dir: string }[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'workspace-test-'));
  const store = new Store(dir);
  resources.push({ store, dir });
  const owner = store.createOwner('Chris');
  const employee = store.createEmployee(owner.id, {
    name: 'Chief of Staff',
    harness: 'codex',
    role: 'Coordinator',
    model: '',
    cwd: '',
    instructions: '',
  });
  return { store, dir, owner, employee };
}
afterEach(() => {
  for (const r of resources.splice(0)) {
    try {
      r.store.close();
    } catch {}
    rmSync(r.dir, { recursive: true, force: true });
  }
});
describe('durable workspace', () => {
  it('refuses to silently create a blank workspace when the device key survives but the database is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'workspace-missing-db-'));
    writeFileSync(join(dir, 'bootstrap.key'), 'existing-device-key');
    expect(() => new Store(dir)).toThrow(/Refusing to create an empty workspace/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('uses full WAL synchronization so committed work survives host power loss', () => {
    const f = fixture();
    expect(f.store.db.pragma('synchronous', { simple: true })).toBe(2);
  });

  it('accepts a retry once, rejects a conflicting retry, and survives restart', () => {
    const f = fixture();
    const input = {
      text: 'Research receipt retries',
      key: uid(),
      attachments: [],
      recipients: [],
      newTask: false,
    };
    const a = f.store.accept(f.owner, f.employee.dmId, input);
    const b = f.store.accept(f.owner, f.employee.dmId, input);
    expect(a.id).toBe(b.id);
    expect(a.clientKey).toBe(input.key);
    expect(b.clientKey).toBe(input.key);
    expect(f.store.all('SELECT * FROM outbox')).toHaveLength(1);
    expect(() => f.store.accept(f.owner, f.employee.dmId, { ...input, text: 'Different' })).toThrow(
      'different content',
    );
    f.store.close();
    const reopened = new Store(f.dir);
    expect(reopened.messages(f.employee.dmId)).toHaveLength(1);
    expect(reopened.messages(f.employee.dmId)[0].clientKey).toBe(input.key);
    reopened.close();
  });
  it('snapshots the selected conversation folder onto each accepted task', () => {
    const f = fixture();
    f.store.set('conversation.workingFolder.' + f.employee.dmId, f.dir);
    const first = f.store.accept(f.owner, f.employee.dmId, {
      text: 'Inspect this project',
      key: uid(),
      attachments: [],
      recipients: [],
      newTask: false,
      workingDirectory: f.dir,
      modelOverride: { harness: 'codex', model: 'gpt-5.6-codex' },
    });
    f.store.set('conversation.workingFolder.' + f.employee.dmId, null);
    const second = f.store.accept(f.owner, f.employee.dmId, {
      text: 'Continue without a project folder',
      key: uid(),
      attachments: [],
      recipients: [],
      newTask: false,
      workingDirectory: null,
    });
    expect(f.store.setting('message.workingDirectory.' + first.id)).toBe(f.dir);
    expect(f.store.setting('message.modelOverride.' + first.id)).toEqual({
      harness: 'codex',
      model: 'gpt-5.6-codex',
    });
    expect(f.store.setting('message.workingDirectory.' + second.id)).toBeNull();
    expect(() =>
      f.store.accept(f.owner, f.employee.dmId, {
        text: 'Use an unselected path',
        key: uid(),
        attachments: [],
        recipients: [],
        newTask: false,
        workingDirectory: f.dir,
      }),
    ).toThrow('Choose the working folder');
  });
  it('keeps private messages, events and attachments scoped to members', () => {
    const f = fixture();
    const other = f.store.createOwner('Ada');
    f.store.accept(f.owner, f.employee.dmId, {
      text: 'Private',
      key: uid(),
      attachments: [],
      recipients: [],
      newTask: false,
    });
    expect(() => f.store.authorize(other.id, f.employee.dmId)).toThrow();
    expect(
      f.store.eventsAfter(other.id, 0).filter((e) => e.conversationId === f.employee.dmId),
    ).toHaveLength(0);
    expect(f.store.eventsAfter(f.owner.id, 0).length).toBeGreaterThan(0);
    expect(() =>
      f.store.accept(f.owner, f.employee.dmId, {
        text: 'File',
        key: uid(),
        attachments: ['foreign-file'],
        recipients: [],
        newTask: false,
      }),
    ).toThrow('attachment');
  });
  it('rejects cross-conversation thread references atomically', () => {
    const f = fixture();
    const e2 = f.store.createEmployee(f.owner.id, {
      name: 'Other',
      harness: 'claude',
      role: '',
      model: '',
      cwd: '',
      instructions: '',
    });
    const parent = f.store.addMessage(e2.dmId, f.owner.id, 'Chris', 'human', 'Other private task');
    expect(() =>
      f.store.accept(f.owner, f.employee.dmId, {
        text: 'Bad thread',
        key: uid(),
        threadId: parent.id,
        attachments: [],
        recipients: [],
        newTask: false,
      }),
    ).toThrow('Thread');
    expect(f.store.messages(f.employee.dmId)).toHaveLength(0);
  });
  it('protects unauthenticated APIs and cross-origin writes', async () => {
    const f = fixture();
    const { app } = await createApp(f.store);
    expect((await app.inject({ url: '/api/workspace' })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/bootstrap',
          payload: { token: f.store.bootstrapToken },
          headers: { origin: 'https://malicious.example', 'x-workspace-request': '1' },
        })
      ).statusCode,
    ).toBe(403);
    const r = await app.inject({
      method: 'POST',
      url: '/api/bootstrap',
      payload: { token: f.store.bootstrapToken },
      headers: { 'x-workspace-request': '1' },
    });
    expect(r.statusCode).toBe(200);
    const cookie = r.headers['set-cookie'] as string;
    expect(
      (await app.inject({ url: '/api/workspace', headers: { cookie: cookie.split(';')[0] } }))
        .statusCode,
    ).toBe(200);
    await app.close();
  });
  it('stores a validated working folder per conversation for the workspace owner', async () => {
    const f = fixture();
    const { app } = await createApp(f.store);
    const session = await app.inject({
      method: 'POST',
      url: '/api/bootstrap',
      payload: { token: f.store.bootstrapToken },
      headers: { 'x-workspace-request': '1' },
    });
    const cookie = (session.headers['set-cookie'] as string).split(';')[0];
    const headers = { cookie, 'x-workspace-request': '1' };
    const saved = await app.inject({
      method: 'PUT',
      url: `/api/conversations/${f.employee.dmId}/working-folder`,
      payload: { path: f.dir },
      headers,
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ path: f.dir, name: f.dir.split(/[\\/]/).pop() });
    expect(
      (
        await app.inject({
          url: `/api/conversations/${f.employee.dmId}/working-folder`,
          headers,
        })
      ).json().path,
    ).toBe(f.dir);
    const invalid = await app.inject({
      method: 'PUT',
      url: `/api/conversations/${f.employee.dmId}/working-folder`,
      payload: { path: join(f.dir, 'missing') },
      headers,
    });
    expect(invalid.statusCode).toBe(400);
    await app.close();
  });
});
