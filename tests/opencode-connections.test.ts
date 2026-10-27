import { expect, it, vi } from 'vitest';
import { OpenCodeAdapter } from '../apps/service/src/adapters/opencode.js';

it('keeps connection authentication and approvals in Abralo, scoped to this run', async () => {
  const adapter = new OpenCodeAdapter();
  adapter.start = async () => {};
  const calls: any[] = [];
  adapter.api = async (path, method, body) => {
    calls.push({ path, method, body });
    return path === '/session' ? { id: 'test-session' } : {};
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          'data: ' +
            JSON.stringify({ type: 'session.idle', properties: { sessionID: 'test-session' } }) +
            '\n\n',
        ),
    ),
  );
  try {
    await adapter.run({
      id: 'test-run',
      employee: { name: 'Test', cwd: '', model: '', instructions: '', permissionMode: 'ask' },
      prompt: 'Test connection',
      attachments: [],
      signal: new AbortController().signal,
      emit() {},
      decide: async () => {
        throw new Error('Unexpected transport approval');
      },
      tools: { workspace: { url: 'http://localhost/mcp', headers: { Authorization: 'test' } } },
    } as any);
    expect(calls.find((c) => c.path === '/mcp').body.config).toMatchObject({
      oauth: false,
      headers: { Authorization: 'test' },
    });
    const rules = calls.find((c) => c.path === '/session').body.permission;
    expect(rules).toContainEqual({ permission: 'workspace_*', pattern: '*', action: 'deny' });
    expect(rules.at(-2)).toEqual({
      permission: 'workspace_testrun_workspace_connection_call',
      pattern: '*',
      action: 'allow',
    });
    expect(calls.at(-1).path).toBe('/mcp/workspace_testrun/disconnect');
  } finally {
    vi.unstubAllGlobals();
  }
});
