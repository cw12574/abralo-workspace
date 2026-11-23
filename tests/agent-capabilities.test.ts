import { expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, uid, hash, now } from '../apps/service/src/store.js';
import { createApp } from '../apps/service/src/app.js';
import { migrateAgentCapabilities } from '../apps/service/src/agent-capabilities.js';
import { Briefings } from '../apps/service/src/briefings.js';

vi.mock('../apps/service/src/native-notifications.js', () => ({
  nativeNotificationsAvailable: () => false,
  prepareNativeNotifications: async () => {},
  sendNativeNotification: vi.fn(),
}));

it('migrates only the configured Chief by default, preserves explicit choices, and never grants by renaming', () => {
  const dir = mkdtempSync(join(tmpdir(), 'abralo-capabilities-'));
  const s = new Store(dir),
    owner = s.createOwner('Owner');
  const chief = s.createEmployee(owner.id, { name: 'Morgan', harness: 'codex' });
  const other = s.createEmployee(owner.id, { name: 'Chief of Staff', harness: 'codex' });
  const optedIn = s.createEmployee(owner.id, {
    name: 'Coordinator',
    harness: 'codex',
    canDelegate: true,
  });
  for (const person of [chief, other]) {
    delete person.canDelegate;
    s.run('UPDATE employees SET data=? WHERE id=?', JSON.stringify(person), person.id);
  }
  s.set('workspace.chiefOfStaff.' + owner.id, chief.id);
  s.set('migration.agent-capabilities', false);
  migrateAgentCapabilities(s);
  expect(s.employee(chief.id)?.canDelegate).toBe(true);
  expect(s.employee(other.id)?.canDelegate).toBe(false);
  expect(s.employee(optedIn.id)?.canDelegate).toBe(true);
  s.run(
    'UPDATE employees SET data=? WHERE id=?',
    JSON.stringify({ ...chief, canDelegate: false }),
    chief.id,
  );
  s.close();
  const reopened = new Store(dir);
  expect(reopened.employee(chief.id)?.canDelegate).toBe(false);
  expect(
    reopened.createEmployee(owner.id, { name: 'Chief of Staff', harness: 'codex' }).canDelegate,
  ).toBe(false);
  reopened.close();
}, 30000);

it('enforces delegation opt-in at tool calls, team approval, voice actions and goal assignment, including live revocation', async () => {
  const s = new Store(mkdtempSync(join(tmpdir(), 'abralo-capabilities-api-')));
  const owner = s.createOwner('Owner');
  const agent = s.createEmployee(owner.id, { name: 'Builder', harness: 'codex' });
  const target = s.createEmployee(owner.id, { name: 'Scout', harness: 'codex' });
  const { app, supervisor } = await createApp(s);
  supervisor.dispatch = async () => {};
  const request = s.addMessage(agent.dmId, owner.id, owner.name, 'human', 'Review the product');
  const run = uid();
  s.run(
    'INSERT INTO runs(id,conversation_id,user_id,employee_id,message_id,response_id,state,created_at,updated_at,context_key) VALUES(?,?,?,?,?,?,?,?,?,?)',
    run,
    agent.dmId,
    owner.id,
    agent.id,
    request.id,
    request.id,
    'running',
    now(),
    now(),
    uid(),
  );
  supervisor.tokens.set(hash('capability-test'), run);
  const headers = { cookie: 'workspace=' + s.newSession(owner.id), 'x-workspace-request': '1' };
  const rpc = async (method: string, params?: any) =>
    (
      await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: {
          authorization: 'Bearer capability-test',
          accept: 'application/json, text/event-stream',
        },
        payload: { jsonrpc: '2.0', id: 1, method, params },
      })
    ).json().result;
  const call = (name: string, args: any) => rpc('tools/call', { name, arguments: args });
  const patch = async (canDelegate: boolean) => {
    const result = await app.inject({
      method: 'PATCH',
      url: '/api/employees/' + agent.id,
      headers,
      payload: { canDelegate },
    });
    expect(result.statusCode).toBe(200);
    expect(result.json().canDelegate).toBe(canDelegate);
  };
  try {
    const names = (await rpc('tools/list')).tools.map((t: any) => t.name);
    expect(names).not.toContain('workspace_delegate');
    expect(names).not.toContain('workspace_propose_team');
    expect(
      (await call('workspace_delegate', { employeeId: target.id, task: 'Review' })).isError,
    ).toBe(true);
    const created = await app.inject({
      method: 'POST',
      url: '/api/employees',
      headers,
      payload: { name: 'Opted in', harness: 'codex', canDelegate: true },
    });
    expect(created.json().canDelegate).toBe(true);
    const ownGoal = JSON.parse(
      (await call('workspace_goal_create', { title: 'Build', start: false })).content[0].text,
    );
    expect(ownGoal.leadAgentId).toBe(agent.id);
    expect((await call('workspace_goal_create', { title: 'Another project' })).isError).toBe(true);
    expect(
      (
        await call('workspace_goal_change', {
          goalId: ownGoal.id,
          version: ownGoal.version,
          leadAgentId: target.id,
        })
      ).isError,
    ).toBe(true);
    await patch(true);
    expect((await rpc('tools/list')).tools.map((t: any) => t.name)).toContain('workspace_delegate');
    const delegated = JSON.parse(
      (await call('workspace_delegate', { employeeId: target.id, task: 'Review the public copy' }))
        .content[0].text,
    );
    expect(delegated.conversationId).toBe(target.dmId);
    const proposal = JSON.parse(
      (
        await call('workspace_propose_team', {
          purpose: 'Review',
          employees: [{ name: 'Reviewer', role: 'Review', harness: 'codex' }],
        })
      ).content[0].text,
    );
    await patch(false);
    expect(
      (await call('workspace_delegate', { employeeId: target.id, task: 'Second review' })).isError,
    ).toBe(true);
    const count = s.all('SELECT id FROM employees').length;
    const rejected = await app.inject({
      method: 'POST',
      url: '/api/proposals/' + proposal.id + '/approve',
      headers,
      payload: { version: 1 },
    });
    expect(rejected.statusCode).toBe(403);
    expect(s.all('SELECT id FROM employees')).toHaveLength(count);
    const briefings = new Briefings(s, supervisor);
    const briefing = briefings.create(owner.id, [target.id], agent.dmId, 'chief', agent.id);
    expect(briefings.chiefContext(briefing.id, owner.id).tools.map((t) => t.name)).toEqual([
      'read_goals',
      'save_recap',
    ]);
    const voice = await app.inject({
      method: 'POST',
      url: `/api/briefings/${briefing.id}/act`,
      headers,
      payload: {
        name: 'delegate_task',
        callId: 'blocked',
        args: { userRequest: 'Ask Scout to review', employeeId: target.id, task: 'Review' },
      },
    });
    expect(voice.statusCode).toBe(403);
    await patch(true);
    const approved = await app.inject({
      method: 'POST',
      url: '/api/proposals/' + proposal.id + '/approve',
      headers,
      payload: { version: 1 },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().employees[0].canDelegate).toBe(false);
    expect(s.all('SELECT id FROM employees')).toHaveLength(count + 1);
  } finally {
    await app.close();
  }
}, 30000);
