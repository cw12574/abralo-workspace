import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../apps/service/src/store.js';
import { createApp } from '../apps/service/src/app.js';

it('atomically reserves leads across requests and never leaves a successfully created goal unstaffed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'goal-staffing-api-'));
  const store = new Store(root),
    owner = store.createOwner('Owner');
  const lead = store.createEmployee(owner.id, {
    name: 'Chief of Staff',
    harness: 'codex',
    model: '',
    cwd: '',
    role: '',
    instructions: '',
  });
  store.set('notifications.' + owner.id, { enabled: false, sound: false, privatePreview: true });
  const { app } = await createApp(store);
  const headers = {
    host: '127.0.0.1',
    cookie: 'workspace=' + store.newSession(owner.id),
    'x-workspace-request': '1',
  };
  const post = (payload: object) =>
    app.inject({ method: 'POST', url: '/api/goals', headers, payload });
  try {
    const requests = await Promise.all([
      post({ title: 'First', leadAgentId: lead.id }),
      post({ title: 'Second', leadAgentId: lead.id }),
    ]);
    expect(requests.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const automatic = await Promise.all([post({ title: 'Second' }), post({ title: 'Third' })]);
    expect(automatic.map((r) => r.statusCode)).toEqual([200, 200]);
    const goals = (await app.inject({ method: 'GET', url: '/api/goals', headers })).json();
    expect(goals).toHaveLength(3);
    expect(new Set(goals.map((goal: any) => goal.leadAgentId)).size).toBe(3);
    expect(goals.every((goal: any) => goal.leadAgentActive && goal.leadAgentName)).toBe(true);
    const before = store.all('SELECT id FROM employees').length;
    expect(
      (await post({ title: 'Invalid', sourceMessageId: '00000000-0000-4000-8000-000000000000' }))
        .statusCode,
    ).toBe(400);
    expect(store.all('SELECT id FROM employees')).toHaveLength(before);
  } finally {
    await app.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
