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
import { Goals } from '../apps/service/src/goals.js';
import { Work } from '../apps/service/src/work.js';
import { registerWorkspaceTools } from '../apps/service/src/workspace-tools.js';

it('lets the running agent create a conversation goal and proof card, with review runs read-only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'abralo-goal-tools-'));
  const store = new Store(dir);
  const owner = store.createOwner('Owner');
  const employee = store.createEmployee(owner.id, {
    name: 'Agent',
    harness: 'codex',
    model: '',
    cwd: '',
    role: '',
    instructions: '',
  });
  const message = store.addMessage(employee.dmId, owner.id, 'Owner', 'human', 'Grow this business');
  const runId = uid();
  store.run(
    'INSERT INTO runs(id,message_id,response_id,conversation_id,employee_id,user_id,state,created_at,updated_at,context_key) VALUES(?,?,?,?,?,?,?,?,?,?)',
    runId,
    message.id,
    message.id,
    employee.dmId,
    employee.id,
    owner.id,
    'running',
    now(),
    now(),
    uid(),
  );
  const supervisor = new Supervisor(store);
  supervisor.tokens.set(hash('test-token'), runId);
  const broker = new ConnectionBroker(store, () => 'http://127.0.0.1');
  const app = Fastify();
  const client = new Client({ name: 'test', version: '1' });
  try {
    await registerWorkspaceTools(
      app,
      store,
      supervisor,
      broker,
      undefined,
      new Goals(store),
      new Work(store),
    );
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(origin + '/mcp'), {
        requestInit: { headers: { Authorization: 'Bearer test-token' } },
      }),
    );
    const call = async (name: string, args: any) => client.callTool({ name, arguments: args });
    const created = await call('workspace_goal_create', {
      title: 'Reach $10K MRR',
      success: 'Monthly revenue reaches $10K',
      nextStep: 'Find the baseline',
    });
    expect(created.isError).not.toBe(true);
    const goal = JSON.parse((created.content as any)[0].text);
    expect(goal.conversationId).toBe(employee.dmId);
    expect((await call('workspace_goals', {})).isError).not.toBe(true);
    const work = await call('workspace_work_start', {
      title: 'Find the baseline',
      goalId: goal.id,
      doneWhen: ['Revenue known'],
      proofPlan: ['Check revenue report'],
    });
    expect(work.isError).not.toBe(true);
    store.set('run.readOnly.' + runId, true);
    expect(
      (await call('workspace_goal_create', { title: 'Another', success: 'Something' })).isError,
    ).toBe(true);
    expect(
      (
        await call('workspace_work_start', {
          title: 'Another',
          doneWhen: ['Done'],
          proofPlan: ['Check'],
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
