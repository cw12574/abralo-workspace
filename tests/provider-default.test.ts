import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../apps/service/src/store.js';
import { Supervisor } from '../apps/service/src/supervisor.js';
import { createApp } from '../apps/service/src/app.js';

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const adapter = (harness: string, authenticated: boolean, models: string[]) =>
  ({
    info: async () => ({
      harness,
      installed: true,
      authenticated,
      version: 'fixture',
      detail: 'fixture',
      models: models.map((id) => ({ id, name: id })),
    }),
    run: async () => {},
    dispose: async () => {},
  }) as any;

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'abralo-provider-default-'));
  roots.push(dir);
  const store = new Store(dir);
  const owner = store.createOwner('Owner');
  const supervisor = new Supervisor(store);
  supervisor.adapters.codex = adapter('codex', true, ['gpt-a']);
  supervisor.adapters.claude = adapter('claude', true, ['sonnet-a']);
  supervisor.adapters.opencode = adapter('opencode', false, []);
  for (const harness of ['codex', 'claude', 'opencode'] as const) await supervisor.catalogue.refresh(harness, true);
  const employee = store.createEmployee(owner.id, {
    name: 'Ada', harness: 'codex', model: 'gpt-a', cwd: '', role: '', instructions: '',
  });
  const { app } = await createApp(store, { supervisor });
  const headers = { host: '127.0.0.1', cookie: 'workspace=' + store.newSession(owner.id), 'x-workspace-request': '1' };
  const call = (method: 'GET' | 'PUT' | 'PATCH', url: string, payload?: any) =>
    app.inject({ method, url, headers, payload });
  return { store, owner, employee, app, call };
}

it('defaults to the first connected provider and lets the owner change it', async () => {
  const f = await fixture();
  try {
    const initial = (await f.call('GET', '/api/providers')).json();
    expect(initial.find((p: any) => p.isDefault).harness).toBe('codex');
    expect((await f.call('PUT', '/api/providers/default', { harness: 'opencode' })).statusCode).toBe(409);
    expect((await f.call('PUT', '/api/providers/default', { harness: 'claude' })).statusCode).toBe(200);
    const changed = (await f.call('GET', '/api/providers')).json();
    expect(changed.find((p: any) => p.isDefault).harness).toBe('claude');
  } finally {
    await f.app.close();
  }
});

it('switches an employee provider, resets the model and guards unsafe changes', async () => {
  const f = await fixture();
  try {
    expect((await f.call('PATCH', `/api/employees/${f.employee.id}`, { harness: 'opencode' })).statusCode).toBe(409);
    const switched = await f.call('PATCH', `/api/employees/${f.employee.id}`, { harness: 'claude' });
    expect(switched.statusCode).toBe(200);
    expect(f.store.employee(f.employee.id)).toMatchObject({ harness: 'claude', model: '' });
    const valid = await f.call('PATCH', `/api/employees/${f.employee.id}`, { harness: 'codex', model: 'gpt-a' });
    expect(valid.statusCode).toBe(200);
    expect(f.store.employee(f.employee.id)).toMatchObject({ harness: 'codex', model: 'gpt-a' });
    f.store.run(
      "INSERT INTO runs(id,conversation_id,user_id,employee_id,message_id,response_id,state,created_at,updated_at,context_key) VALUES('r1',?,?,?,'m','x','running','t','t','k')",
      f.employee.dmId, f.owner.id, f.employee.id,
    );
    const busy = await f.call('PATCH', `/api/employees/${f.employee.id}`, { harness: 'claude' });
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error ?? busy.json().message).toMatch(/current run/);
    expect(f.store.employee(f.employee.id)?.harness).toBe('codex');
  } finally {
    await f.app.close();
  }
});
