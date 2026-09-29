import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, cpus, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { Store, uid } from '../apps/service/src/store.js';
import { createApp } from '../apps/service/src/app.js';
const s = new Store(mkdtempSync(join(tmpdir(), 'workspace-mixed-'))),
  user = s.createOwner('Benchmark');
const { app, supervisor } = await createApp(s);
await app.listen({ host: '127.0.0.1', port: 0 });
supervisor.origin = `http://127.0.0.1:${(app.server.address() as any).port}`;
const started = Date.now(),
  activity = new Map<string, { first: number; last: number }>(),
  latencies: number[] = [],
  memory: any[] = [];
s.bus.on('event', (e: any) => {
  const runId =
    e.payload.runId ||
    s.one('SELECT run_id FROM messages WHERE id=?', e.payload.messageId || e.payload.id || '')
      ?.run_id;
  if (runId && ['message.updated', 'activity.updated'].includes(e.type)) {
    const a = activity.get(runId) || { first: Date.now(), last: Date.now() };
    a.last = Date.now();
    activity.set(runId, a);
  }
});
for (let i = 0; i < 20; i++) {
  const cwd = mkdtempSync(join(tmpdir(), 'workspace-mixed-task-'));
  writeFileSync(
    join(cwd, 'numbers.txt'),
    Array.from({ length: 50 }, (_, n) => String(n + i)).join('\n'),
  );
  const harness = i < 12 ? 'codex' : i < 16 ? 'claude' : 'opencode';
  const employee = s.createEmployee(user.id, {
    name: 'Check ' + i,
    harness,
    role: 'Benchmark',
    model: '',
    instructions:
      'Work only in this temporary directory. Do not access external services. Avoid using workspace tools except if needed.',
    cwd,
  });
  s.accept(user, employee.dmId, {
    key: uid(),
    text: 'Read numbers.txt. Use local tools to compute sum, mean and variance, then independently verify the sum using a second method. Give the exact sum without thousands separators in a final line formatted SUM=number, followed by a short explanation of your verification. Do not modify files or ask questions.',
    attachments: [],
    recipients: [],
    newTask: false,
  });
}
await supervisor.dispatch();
let peak = 0;
try {
  while (supervisor.active.size && Date.now() - started < 240000) {
    peak = Math.max(peak, supervisor.active.size);
    const t = performance.now();
    await app.inject('/api/health');
    latencies.push(performance.now() - t);
    memory.push({
      at: Date.now(),
      serviceRss: process.memoryUsage().rss,
      active: supervisor.active.size,
    });
    for (const d of s.all("SELECT * FROM decisions WHERE state='pending'")) {
      const x = JSON.parse(d.data);
      supervisor.resolve(user.id, d.id, d.version, {
        allow: x.detail?.serverName === 'workspace' || x.title?.startsWith('mcp__workspace__'),
      });
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  const results = s
    .all(
      'SELECT r.id,r.state,r.error,r.created_at,r.updated_at,e.data,m.text FROM runs r JOIN employees e ON e.id=r.employee_id JOIN messages m ON m.id=r.response_id',
    )
    .map((r) => {
      const e = JSON.parse(r.data),
        i = Number(e.name.split(' ')[1]);
      return {
        harness: e.harness,
        state: r.state,
        error: r.error,
        expected: 1225 + 50 * i,
        answer: r.text.match(/SUM\s*=\s*([\d,]+)/i)?.[1],
        activity: activity.get(r.id),
      };
    });
  const edges = [...activity.values()]
    .flatMap((a) => [
      [a.first, 1],
      [a.last, -1],
    ])
    .sort((a, b) => a[0] - b[0]);
  let n = 0,
    observed = 0;
  for (const e of edges) {
    n += e[1];
    observed = Math.max(observed, n);
  }
  latencies.sort((a, b) => a - b);
  const report = {
    type: 'real full-service mixed harness test; not a two-hour soak or a direct-run comparison',
    started: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    host: { cpu: cpus()[0].model, ramBytes: totalmem(), platform: process.platform },
    peakActive: peak,
    peakObservedActivityIntervals: observed,
    p95HealthMs: latencies[Math.floor(latencies.length * 0.95)],
    memory,
    results,
  };
  mkdirSync('evidence', { recursive: true });
  writeFileSync('evidence/mixed.json', JSON.stringify(report, null, 2));
  console.log({
    completed: results.filter((r) => r.state === 'completed').length,
    correct: results.filter((r) => Number(r.answer?.replaceAll(',', '')) === r.expected).length,
    peak,
    observed,
    p95: report.p95HealthMs,
  });
  if (
    results.some(
      (r) => r.state !== 'completed' || Number(r.answer?.replaceAll(',', '')) !== r.expected,
    )
  )
    process.exitCode = 1;
} finally {
  await app.close();
}
