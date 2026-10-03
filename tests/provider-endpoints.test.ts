import { expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../apps/service/src/store.js';
import { createApp } from '../apps/service/src/app.js';

it('selected-provider checks do not launch unrelated runtimes and endpoints require an owner', async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'abralo-provider-routes-')));
  const user = store.createOwner('Tester');
  const { app, supervisor } = await createApp(store);
  const codex = vi.fn(async () => ({
    harness: 'codex' as const,
    installed: true,
    authenticated: false,
    version: 'fixture',
    detail: 'Sign in',
  }));
  const unrelated = vi.fn(async (): Promise<any> => {
    throw new Error('must not start');
  });
  supervisor.adapters = Object.fromEntries(
    ['codex', 'claude', 'opencode'].map((name) => [
      name,
      { info: name === 'codex' ? codex : unrelated, dispose: async () => {}, run: async () => {} },
    ]),
  );
  const headers = { cookie: 'workspace=' + store.newSession(user.id), 'x-workspace-request': '1' };
  try {
    expect((await app.inject('/api/providers?check=codex')).statusCode).toBe(401);
    const response = await app.inject({ url: '/api/providers?check=codex', headers });
    expect(response.statusCode).toBe(200);
    expect(response.json().find((p: any) => p.harness === 'codex').authenticated).toBe(false);
    expect(codex).toHaveBeenCalledTimes(1);
    expect(unrelated).not.toHaveBeenCalled();
    expect((await app.inject({ url: '/api/providers?check=invalid', headers })).statusCode).toBe(
      400,
    );
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/providers/codex/login',
          headers,
          payload: { type: 'apiKey', apiKey: 'not-a-key' },
        })
      ).statusCode,
    ).toBe(400);
    expect((await app.inject('/api/health')).statusCode).toBe(200);
  } finally {
    await app.close();
  }
});
