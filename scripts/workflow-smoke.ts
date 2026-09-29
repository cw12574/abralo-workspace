import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, uid } from '../apps/service/src/store.js';
import { createApp } from '../apps/service/src/app.js';
const store = new Store(mkdtempSync(join(tmpdir(), 'workspace-workflow-')));
const user = store.createOwner('Workflow test');
const { app, supervisor } = await createApp(store);
await app.listen({ host: '127.0.0.1', port: 0 });
supervisor.origin = `http://127.0.0.1:${(app.server.address() as any).port}`;
const harness = process.argv[2] || 'codex';
const employee = store.createEmployee(user.id, {
  name: 'Chief of Staff',
  role: 'Coordinator',
  harness,
  model: '',
  cwd: '',
  instructions: '',
});
const cookie = 'workspace=' + store.newSession(user.id);
const report: any = { started: new Date().toISOString() };
try {
  store.accept(user, employee.dmId, {
    key: uid(),
    text: 'Use workspace_team to inspect the team, then use workspace_propose_team to propose exactly one researcher called Scout who uses codex. Our purpose is to research software tooling. Do not do any other work or create files.',
    attachments: [],
    recipients: [],
    newTask: false,
  });
  await supervisor.dispatch();
  const deadline = Date.now() + 180000;
  while (
    Date.now() < deadline &&
    (supervisor.active.size || store.one("SELECT 1 FROM outbox WHERE status='pending'"))
  ) {
    for (const d of store.all("SELECT * FROM decisions WHERE state='pending'")) {
      const data = JSON.parse(d.data);
      // This isolated test authorizes only the local workspace MCP, whose team creation still needs API approval.
      if (data.detail?.serverName === 'workspace' || data.title?.startsWith('mcp__workspace__'))
        supervisor.resolve(user.id, d.id, d.version, { allow: true });
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  const proposal = store.setting('proposals.' + user.id, [])[0];
  report.runs = store.all('SELECT state,error FROM runs');
  if (!proposal)
    throw new Error(
      'Native agent did not produce a workspace proposal: ' + JSON.stringify(report.runs),
    );
  const first = await app.inject({
    method: 'POST',
    url: `/api/proposals/${proposal.id}/approve`,
    headers: { cookie, 'x-workspace-request': '1' },
    payload: { version: proposal.version },
  });
  const retry = await app.inject({
    method: 'POST',
    url: `/api/proposals/${proposal.id}/approve`,
    headers: { cookie, 'x-workspace-request': '1' },
    payload: { version: proposal.version },
  });
  if (
    first.statusCode !== 200 ||
    retry.statusCode !== 200 ||
    store.all('SELECT * FROM employees').length !== 2
  )
    throw new Error('Proposal approval/retry failed');
  store.accept(user, employee.dmId, {
    key: uid(),
    text: 'Call workspace_team again to verify the approved team. Reply with the employee names. Do not do other work.',
    attachments: [],
    recipients: [],
    newTask: false,
  });
  await supervisor.dispatch();
  const resumeDeadline = Date.now() + 120000;
  while (supervisor.active.size && Date.now() < resumeDeadline) {
    for (const d of store.all("SELECT * FROM decisions WHERE state='pending'")) {
      const data = JSON.parse(d.data);
      if (data.detail?.serverName === 'workspace' || data.title?.startsWith('mcp__workspace__'))
        supervisor.resolve(user.id, d.id, d.version, { allow: true });
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  const resumed = store.all('SELECT * FROM runs ORDER BY created_at');
  if (
    resumed.length !== 2 ||
    resumed[1].state !== 'completed' ||
    resumed[0].native_session !== resumed[1].native_session
  )
    throw new Error('Native session resume failed');
  const reply = store.one('SELECT text FROM messages WHERE id=?', resumed[1].response_id).text;
  if (!reply.includes('Scout')) throw new Error('Resumed tool did not see the approved team');
  report.status = 'passed';
  report.checks = [
    'real native ' + harness + ' workspace MCP discovery',
    'real proposal tool call',
    'explicit approval',
    'idempotent approval',
    'native session resume with refreshed workspace tool credential',
  ];
} catch (e) {
  report.status = 'failed';
  report.error = String(e);
  process.exitCode = 1;
} finally {
  await app.close();
  mkdirSync('evidence', { recursive: true });
  writeFileSync('evidence/workflow-' + harness + '.json', JSON.stringify(report, null, 2));
  console.log(report);
}
