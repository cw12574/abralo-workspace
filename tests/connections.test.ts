import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Store, uid, hash } from '../apps/service/src/store.js';
import { ConnectionBroker, registerConnectionRoutes } from '../apps/service/src/connections.js';
import { Supervisor } from '../apps/service/src/supervisor.js';
import { registerWorkspaceTools } from '../apps/service/src/workspace-tools.js';

const cleanup: (() => Promise<void>)[] = [];
vi.setConfig({ testTimeout: 15000 });
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
function fixture(harness: 'codex' | 'claude' | 'opencode' = 'codex', service = 'railway') {
  const s = new Store(mkdtempSync(join(tmpdir(), 'connection-test-')));
  const user = s.createOwner('Owner');
  const employee = s.createEmployee(user.id, {
    name: 'Agent',
    harness,
    model: '',
    cwd: '',
    role: '',
    instructions: '',
  });
  const broker = new ConnectionBroker(s, () => 'http://localhost');
  const id = uid();
  s.run(
    'INSERT INTO connections VALUES(?,?,?,?,?,?)',
    id,
    user.id,
    service,
    'My account',
    'ready',
    JSON.stringify({
      tools: [
        { name: 'read', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
        { name: 'write', inputSchema: { type: 'object' } },
      ],
    }),
  );
  s.run('INSERT INTO grants VALUES(?,?,?)', id, employee.id, JSON.stringify(['read', 'write']));
  const run = {
    id: uid(),
    user_id: user.id,
    employee_id: employee.id,
    conversation_id: employee.dmId,
    message_id: String(uid()),
  };
  const provider = vi.fn(async (_args?: any) => ({
    content: [{ type: 'text', text: 'confirmed' }],
  }));
  broker.clients.set(id, { callTool: provider, close: async () => {} } as any);
  cleanup.push(async () => {
    await broker.close();
    s.close();
  });
  return { s, user, employee, broker, id, run, provider };
}

describe('durable connected actions', () => {
  it('resumes the original task once after its harness turn has ended', async () => {
    const { s, broker, run, employee, user, id } = fixture();
    const message = s.addMessage(
      employee.dmId,
      user.id,
      user.name,
      'human',
      'Create the requested service',
    );
    run.message_id = message.id;
    s.run(
      'INSERT INTO runs(id,message_id,response_id,conversation_id,employee_id,user_id,state,created_at,updated_at,context_key) VALUES(?,?,?,?,?,?,?,?,?,?)',
      run.id,
      message.id,
      message.id,
      employee.dmId,
      employee.id,
      user.id,
      'completed',
      new Date().toISOString(),
      new Date().toISOString(),
      uid(),
    );
    const dispatch = vi.fn(async () => {});
    broker.supervisor = { active: new Map(), dispatch } as any;
    const action = broker.actions.request(run, id, 'write', {});
    broker.actions.decide(action.actionId, user.id, true);
    await Promise.all([...broker.actions.inflight]);
    await broker.actions.resume(broker.actions.get(action.actionId, user.id));
    expect(s.all('SELECT * FROM outbox')).toHaveLength(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(s.messages(employee.dmId).at(-1)?.text).toContain(action.actionId);
    expect(s.messages(employee.dmId).at(-1)?.text).toContain('Do not repeat');
  });

  it('isolates action receipts and approvals from other users and employees', () => {
    const { s, broker, run, id, provider } = fixture();
    const action = broker.actions.request(run, id, 'write', {});
    const other = s.createOwner('Other');
    expect(() => broker.actions.get(action.actionId, other.id)).toThrow('Action unavailable');
    expect(() => broker.actions.decide(action.actionId, other.id, true)).toThrow(
      'Action unavailable',
    );
    expect(() => broker.actions.get(action.actionId, run.user_id, 'different-employee')).toThrow(
      'Action unavailable',
    );
    expect(provider).not.toHaveBeenCalled();
  });
  it.each(['railway', 'stripe', 'gmail'])(
    'deduplicates approval and exact arguments for %s',
    async (service) => {
      const { broker, run, id, provider } = fixture('codex', service);
      if (service === 'gmail')
        vi.spyOn(broker, 'call').mockImplementation(async (_id, _employee, _owner, name, args) =>
          provider({ name, arguments: args } as any),
        );
      const a = broker.actions.request(run, id, 'write', { b: 2, a: 1 });
      const b = broker.actions.request({ ...run, id: uid(), message_id: uid() }, id, 'write', {
        a: 1,
        b: 2,
      });
      expect(a.actionId).toBe(b.actionId);
      expect(provider).not.toHaveBeenCalled();
      broker.actions.decide(a.actionId, run.user_id, true);
      broker.actions.decide(a.actionId, run.user_id, true);
      await Promise.all([...broker.actions.inflight]);
      expect(provider).toHaveBeenCalledTimes(1);
      expect(provider).toHaveBeenCalledWith({ name: 'write', arguments: { a: 1, b: 2 } });
      expect(broker.actions.request(run, id, 'write', { a: 1, b: 2 }).status).toBe('succeeded');
    },
  );
  it('keeps approvals after restart and never replays an uncertain write', async () => {
    const { s, broker, run, id } = fixture();
    const a = broker.actions.request(run, id, 'write', {});
    const pending = new ConnectionBroker(s, () => 'http://localhost');
    expect(pending.actions.get(a.actionId, run.user_id).state).toBe('awaiting_approval');
    s.run("UPDATE connection_actions SET state='running' WHERE id=?", a.actionId);
    const restarted = new ConnectionBroker(s, () => 'http://localhost');
    expect(restarted.actions.decide(a.actionId, run.user_id, true).status).toBe('unknown');
    expect(restarted.actions.request({ ...run, message_id: uid() }, id, 'write', {}).actionId).toBe(
      a.actionId,
    );
  });
  it('does not dispatch after a timeout, a decline, or loss of write grant', async () => {
    const { s, broker, run, id, provider, employee } = fixture();
    provider.mockRejectedValueOnce(new Error('timeout'));
    const a = broker.actions.request(run, id, 'write', {});
    broker.actions.decide(a.actionId, run.user_id, true);
    await Promise.all([...broker.actions.inflight]);
    expect(broker.actions.get(a.actionId, run.user_id).state).toBe('unknown');
    broker.actions.decide(a.actionId, run.user_id, true);
    expect(provider).toHaveBeenCalledTimes(1);
    const b = broker.actions.request(run, id, 'write', { next: true });
    broker.actions.decide(b.actionId, run.user_id, false);
    expect(broker.actions.request(run, id, 'write', { next: true }).status).toBe('declined');
    const c = broker.actions.request(run, id, 'write', { third: true });
    s.run('UPDATE grants SET capabilities=? WHERE employee_id=?', '["read"]', employee.id);
    expect(() => broker.actions.decide(c.actionId, run.user_id, true)).toThrow('read-only');
    expect(provider).toHaveBeenCalledTimes(1);
  });
  it('validates tools, access and task limits before creating an approval', () => {
    const { s, broker, run, id } = fixture();
    expect(() => broker.actions.request(run, id, 'missing', {})).toThrow('Tool unavailable');
    const other = s.createOwner('Other');
    expect(() => broker.actions.request({ ...run, user_id: other.id }, id, 'write', {})).toThrow();
    s.set('run.readOnly.' + run.id, true);
    expect(() => broker.actions.request(run, id, 'write', {})).toThrow('only permits reads');
    expect(s.all('SELECT * FROM connection_actions')).toHaveLength(0);
  });
});

describe('connection setup and recovery', () => {
  it('collects every provider tool page and honors write access explicitly chosen on the setup card', async () => {
    const { s, broker, run, employee, user } = fixture();
    s.run('DELETE FROM grants');
    s.run('DELETE FROM connections');
    const request = broker.request(run, 'railway', 'write');
    const saved: Record<string, any> = {};
    vi.spyOn(broker, 'storage').mockResolvedValue({
      get: (id: string) => saved[id] || {},
      set: (id: string, value: any) => {
        saved[id] = value;
      },
    } as any);
    const connect = vi.spyOn(Client.prototype, 'connect').mockResolvedValue();
    const close = vi.spyOn(Client.prototype, 'close').mockResolvedValue();
    const list = vi
      .spyOn(Client.prototype, 'listTools')
      .mockResolvedValueOnce({
        tools: [{ name: 'first', inputSchema: { type: 'object' } }],
        nextCursor: 'page2',
      })
      .mockResolvedValueOnce({ tools: [{ name: 'last', inputSchema: { type: 'object' } }] });
    const app = Fastify();
    app.addHook('onRequest', async (req: any) => {
      req.user = user;
    });
    registerConnectionRoutes(app, broker);
    try {
      const r = await app.inject({
        method: 'POST',
        url: `/api/connections/${request.requestId}/connect`,
        payload: { grantWrite: true },
      });
      expect(r.statusCode).toBe(200);
      expect(list).toHaveBeenLastCalledWith({ cursor: 'page2' });
      expect(broker.status(request.requestId!, employee.id, user.id)).toMatchObject({
        toolCount: 2,
        capabilities: ['read', 'write'],
      });
    } finally {
      await app.close();
      connect.mockRestore();
      close.mockRestore();
      list.mockRestore();
    }
  });

  it('recovers a stale read once but never retries a dispatched write', async () => {
    const { broker, id, employee, user, provider } = fixture();
    provider.mockRejectedValueOnce(new Error('Session closed'));
    const recovered = vi.fn(async () => ({ content: [] }));
    const ensure = vi.spyOn(broker, 'ensure').mockImplementation(async () => {
      broker.clients.set(id, { callTool: recovered, close: async () => {} } as any);
    });
    await broker.call(id, employee.id, user.id, 'read', {});
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(recovered).toHaveBeenCalledTimes(1);
    recovered.mockRejectedValueOnce(new Error('Session closed'));
    await expect(broker.call(id, employee.id, user.id, 'write', {})).rejects.toThrow(
      'Session closed',
    );
    expect(ensure).toHaveBeenCalledTimes(1);
  });
  it('reuses one card, upgrades its requested access, and resolves request IDs after approval', async () => {
    const { s, broker, run, id, employee, user } = fixture();
    s.run('DELETE FROM grants');
    const read = broker.request(run, 'railway', 'read');
    const write = broker.request(run, 'railway', 'write');
    expect(read.requestId).toBe(write.requestId);
    const app = Fastify();
    app.addHook('onRequest', async (req: any) => {
      req.user = user;
    });
    registerConnectionRoutes(app, broker);
    cleanup.push(async () => {
      await app.close();
    });
    const r = await app.inject({
      method: 'POST',
      url: `/api/connections/${write.requestId}/reuse`,
      payload: { write: true },
    });
    expect(r.statusCode).toBe(200);
    expect(broker.status(write.requestId!, employee.id, user.id)).toMatchObject({
      connectionId: id,
      capabilities: ['read', 'write'],
      status: 'ready',
      toolCount: 2,
    });
    expect(broker.request(run, 'railway', 'write').connectionId).toBe(id);
    const wrong = await app.inject({
      method: 'POST',
      url: `/api/connections/${write.requestId}/connect`,
      payload: {},
    });
    expect(wrong.statusCode).toBe(409);
  });
  it('does not downgrade an existing write grant when an older read card is approved', async () => {
    const { s, broker, run, employee, user, id } = fixture();
    s.run('DELETE FROM grants');
    const read = broker.request(run, 'railway', 'read');
    s.run('INSERT INTO grants VALUES(?,?,?)', id, employee.id, '["read","write"]');
    const app = Fastify();
    app.addHook('onRequest', async (req: any) => {
      req.user = user;
    });
    registerConnectionRoutes(app, broker);
    cleanup.push(async () => {
      await app.close();
    });
    await app.inject({
      method: 'POST',
      url: `/api/connections/${read.requestId}/reuse`,
      payload: { write: false },
    });
    expect(broker.status(id, employee.id, user.id).capabilities).toContain('write');
  });
});

describe.each(['codex', 'claude', 'opencode'] as const)('%s shared MCP contract', (harness) => {
  it('returns a durable action receipt without waiting for approval and allows research reads', async () => {
    const { s, broker, user, employee, id, provider } = fixture(harness);
    const sup = new Supervisor(s);
    const message = s.addMessage(
      employee.dmId,
      user.id,
      user.name,
      'human',
      'Use my connected account',
    );
    const runId = uid();
    // Use the production run schema rather than a live model/provider.
    s.run(
      'INSERT INTO runs(id,message_id,response_id,conversation_id,employee_id,user_id,state,created_at,updated_at,context_key) VALUES(?,?,?,?,?,?,?,?,?,?)',
      runId,
      message.id,
      message.id,
      employee.dmId,
      employee.id,
      user.id,
      'running',
      new Date().toISOString(),
      new Date().toISOString(),
      uid(),
    );
    sup.tokens.set(hash('test-token'), runId);
    const app = Fastify();
    await registerWorkspaceTools(app, s, sup, broker);
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const client = new Client({ name: harness, version: 'test' });
    cleanup.push(async () => {
      await client.close();
      await app.close();
      await sup.dispose();
    });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(origin + '/mcp'), {
        requestInit: { headers: { Authorization: 'Bearer test-token' } },
      }),
    );
    const call = async (name: string, args: any) => {
      const r = await client.callTool({ name, arguments: args });
      expect(r.isError).not.toBe(true);
      return JSON.parse((r.content as any)[0].text);
    };
    const status = await call('workspace_connection_status', { connectionId: id });
    expect(status.capabilities).toEqual(['read', 'write']);
    const discovered = await call('workspace_connection_tools', { connectionId: id, query: 'read' });
    expect(discovered.tools.map((tool: any) => tool.name)).toEqual(['read']);
    expect(discovered.totalTools).toBe(2);
    const result = await call('workspace_connection_call', {
      connectionId: id,
      tool: 'write',
      arguments: { item: 1 },
    });
    expect(result.status).toBe('awaiting_approval');
    expect(provider).not.toHaveBeenCalled();
    expect((await call('workspace_connection_action', { actionId: result.actionId })).status).toBe(
      'awaiting_approval',
    );
    s.set('run.readOnly.' + runId, true);
    await call('workspace_connection_call', { connectionId: id, tool: 'read' });
    expect(provider).toHaveBeenCalledTimes(1);
    const denied = await client.callTool({
      name: 'workspace_connection_call',
      arguments: { connectionId: id, tool: 'write' },
    });
    expect(denied.isError).toBe(true);
  });
});
