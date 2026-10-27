import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../apps/service/src/store.js';
import { createApp } from '../apps/service/src/app.js';
import { Goals } from '../apps/service/src/goals.js';

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it('keeps a conversational agent active through deactivation and deletion', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'abralo-agent-guard-'));
  roots.push(dir);
  const store = new Store(dir);
  const owner = store.createOwner('Owner');
  const first = store.createEmployee(owner.id, {
    name: 'First',
    harness: 'codex',
    model: '',
    cwd: '',
    role: '',
    instructions: '',
  });
  const token = store.newSession(owner.id);
  const { app } = await createApp(store);
  const request = (path: string, method: 'POST' | 'DELETE') =>
    app.inject({
      method,
      url: path,
      headers: { host: '127.0.0.1', cookie: 'workspace=' + token, 'x-workspace-request': '1' },
    });
  try {
    expect((await request(`/api/employees/${first.id}/deactivate`, 'POST')).statusCode).toBe(409);
    expect((await request(`/api/employees/${first.id}`, 'DELETE')).statusCode).toBe(409);
    expect(store.employee(first.id)?.deactivatedAt).toBeUndefined();
    const second = store.createEmployee(owner.id, {
      name: 'Second',
      harness: 'codex',
      model: '',
      cwd: '',
      role: '',
      instructions: '',
    });
    const goal = new Goals(store).create(owner.id, {
      conversationId: first.dmId,
      title: 'A lasting outcome',
      success: 'Reached target',
    });
    expect((await request(`/api/employees/${first.id}/deactivate`, 'POST')).statusCode).toBe(200);
    expect((await request(`/api/employees/${second.id}/deactivate`, 'POST')).statusCode).toBe(409);
    expect(store.employee(second.id)?.deactivatedAt).toBeUndefined();
    expect((await request(`/api/employees/${first.id}`, 'DELETE')).statusCode).toBe(200);
    expect(new Goals(store).get(goal.id, owner.id).conversationId).toBe(second.dmId);
    const third = store.createEmployee(owner.id, {
      name: 'Third',
      harness: 'codex',
      model: '',
      cwd: '',
      role: '',
      instructions: '',
    });
    const results = await Promise.all([
      request(`/api/employees/${second.id}/deactivate`, 'POST'),
      request(`/api/employees/${third.id}/deactivate`, 'POST'),
    ]);
    expect(results.map((response) => response.statusCode).sort()).toEqual([200, 409]);
  } finally {
    await app.close();
    store.close();
  }
});
