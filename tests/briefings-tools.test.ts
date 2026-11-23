import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Store, hash, now, uid } from '../apps/service/src/store.js';
import { Supervisor } from '../apps/service/src/supervisor.js';
import { ConnectionBroker } from '../apps/service/src/connections.js';
import { Briefings } from '../apps/service/src/briefings.js';
import { registerWorkspaceTools } from '../apps/service/src/workspace-tools.js';

it('allows briefing context/report tools but blocks preparation from starting work or sharing messages', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'abralo-briefing-tools-'));
  const store = new Store(dir),
    owner = store.createOwner('Owner');
  const employee = store.createEmployee(owner.id, {
    name: 'Engineer',
    harness: 'codex',
    model: '',
    cwd: '',
    role: '',
    instructions: '',
  });
  const supervisor = new Supervisor(store);
  supervisor.dispatch = async () => {};
  const briefings = (supervisor.briefings = new Briefings(store, supervisor));
  const b = briefings.prepare(
    briefings.create(owner.id, [employee.id]).id,
    owner.id,
    'Focus on onboarding.',
  );
  const messageId = b.participants[0].messageId!,
    runId = uid();
  store.run(
    'INSERT INTO runs(id,message_id,response_id,conversation_id,employee_id,user_id,state,created_at,updated_at,context_key) VALUES(?,?,?,?,?,?,?,?,?,?)',
    runId,
    messageId,
    messageId,
    employee.dmId,
    employee.id,
    owner.id,
    'running',
    now(),
    now(),
    uid(),
  );
  supervisor.tokens.set(hash('test-token'), runId);
  const app = Fastify(),
    client = new Client({ name: 'test', version: '1' });
  try {
    await registerWorkspaceTools(
      app,
      store,
      supervisor,
      new ConnectionBroker(store, () => 'http://127.0.0.1'),
    );
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(origin + '/mcp'), {
        requestInit: { headers: { Authorization: 'Bearer test-token' } },
      }),
    );
    for (const name of [
      'workspace_delegate',
      'workspace_post_message',
      'workspace_remember',
      'workspace_schedule',
      'workspace_connection_call',
      'workspace_maintenance',
    ]) {
      const result = await client.callTool({ name, arguments: {} });
      expect(result.isError, name).toBe(true);
    }
    expect((await client.callTool({ name: 'workspace_read', arguments: {} })).isError).not.toBe(
      true,
    );
    expect(
      (
        await client.callTool({
          name: 'workspace_briefing_report',
          arguments: {
            understanding: 'Finish onboarding.',
            question: '',
            nextStep: 'Complete the current onboarding fix.',
          },
        })
      ).isError,
    ).not.toBe(true);
    expect(briefings.get(b.id, owner.id).actions[0].selected).toBe(false);
    briefings.review(b.id, owner.id);
    expect(
      (
        await client.callTool({
          name: 'workspace_briefing_report',
          arguments: {
            understanding: 'Late report',
            question: 'Should I start something new?',
          },
        })
      ).isError,
    ).toBe(true);
  } finally {
    await client.close();
    await app.close();
    await supervisor.dispose();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
