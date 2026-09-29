import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, uid } from '../apps/service/src/store.js';
import { createApp } from '../apps/service/src/app.js';
const s = new Store(mkdtempSync(join(tmpdir(), 'workspace-auto-smoke-'))),
  u = s.createOwner('Permission test');
const { app, supervisor } = await createApp(s);
await app.listen({ host: '127.0.0.1', port: 0 });
supervisor.origin = `http://127.0.0.1:${(app.server.address() as any).port}`;
const report: any = { checks: [], started: new Date().toISOString() };
try {
  for (const harness of ['codex', 'claude', 'opencode']) {
    const employee = s.createEmployee(u.id, {
      name: 'Permission probe',
      harness,
      model: '',
      role: 'Test',
      cwd: '',
      instructions:
        'Only call workspace_team and return AUTO_OK. No files, other tools, delegation or external actions.',
      permissionMode: 'auto',
    });
    for (let turn = 0; turn < (harness === 'opencode' ? 2 : 1); turn++) {
      s.accept(u, employee.dmId, {
        key: uid(),
        text: 'Call workspace_team once, then reply AUTO_OK. Do not do any other work.',
        attachments: [],
        recipients: [],
        newTask: false,
      });
      await supervisor.dispatch();
      const until = Date.now() + 90000;
      while (supervisor.active.size && Date.now() < until) {
        if (s.one("SELECT 1 FROM decisions WHERE state='pending'"))
          throw Error(harness + ' unexpectedly requested approval for an internal workspace tool');
        await new Promise((r) => setTimeout(r, 250));
      }
      const run = s.one(
        'SELECT * FROM runs WHERE employee_id=? ORDER BY created_at DESC LIMIT 1',
        employee.id,
      );
      if (run.state !== 'completed') throw Error(harness + ': ' + run.state + ' ' + run.error);
      if (!s.one('SELECT text FROM messages WHERE id=?', run.response_id).text.includes('AUTO_OK'))
        throw Error(harness + ' missing reply');
      const activities = s
        .all('SELECT data FROM activities WHERE run_id=?', run.id)
        .map((a) => JSON.parse(a.data));
      if (!activities.some((a) => JSON.stringify(a).includes('workspace_team')))
        throw Error(harness + ' did not call the workspace tool');
      report.checks.push({
        harness,
        turn: turn + 1,
        status: 'passed',
        session: !!run.native_session,
      });
    }
  }
  report.status = 'passed';
} catch (e) {
  report.status = 'failed';
  report.error = String(e);
  process.exitCode = 1;
} finally {
  await app.close();
  writeFileSync('evidence/permissions.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
