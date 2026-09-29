import { CodexAdapter } from '../apps/service/src/adapters/codex.js';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, cpus, totalmem } from 'node:os';
const adapter = new CodexAdapter();
const total = Number(process.argv[2] || 20);
const samples: any[] = [];
let running = 0,
  peak = 0;
const started = Date.now();
const info = await adapter.info();
if (!info.authenticated) throw new Error('Codex sign-in required');
const jobs = Array.from({ length: total }, async (_, index) => {
  const cwd = mkdtempSync(join(tmpdir(), 'workspace-concurrency-'));
  writeFileSync(
    join(cwd, 'numbers.txt'),
    Array.from({ length: 50 }, (_, n) => String(n + index)).join('\n'),
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180000);
  let text = '',
    tools = 0;
  const record: any = { index, start: Date.now(), events: [] };
  running++;
  peak = Math.max(peak, running);
  try {
    await adapter.run({
      id: crypto.randomUUID(),
      employee: {
        id: 'benchmark-' + index,
        name: 'Benchmark ' + index,
        kind: 'agent',
        ownerId: 'benchmark',
        dmId: 'benchmark',
        role: 'Verification',
        harness: 'codex',
        model: '',
        cwd,
        instructions:
          'Only work with the supplied temporary numbers file. Do not use network services or modify any other directory.',
        createdAt: new Date().toISOString(),
      },
      prompt:
        'Read numbers.txt and calculate its sum, mean, median, variance and SHA256 using local commands. Independently verify the sum with a second method. Then write a concise 500-word analytical report explaining the results and checks. Do not ask questions.',
      attachments: [],
      signal: controller.signal,
      decide: async () => ({ allow: false }),
      emit: (e) => {
        if (e.type === 'text') {
          text += e.text;
          record.events.push({ at: Date.now(), type: 'text' });
        }
        if (e.type === 'activity') {
          tools++;
          record.events.push({ at: Date.now(), type: e.data?.type, state: e.data?.state });
        }
      },
    });
    record.status = text.includes(String(1225 + 50 * index)) ? 'passed' : 'failed';
    record.tools = tools;
    record.result = text.slice(-300);
  } catch (e) {
    record.status = 'failed';
    record.error = String(e);
  } finally {
    clearTimeout(timeout);
    running--;
    record.end = Date.now();
    samples.push(record);
  }
});
await Promise.all(jobs);
await adapter.dispose();
mkdirSync('evidence', { recursive: true });
const report = {
  type: 'real Codex runs; not a mixed-harness release gate',
  count: total,
  peakDispatched: peak,
  durationMs: Date.now() - started,
  host: {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    cpu: cpus()[0]?.model,
    ramBytes: totalmem(),
  },
  samples,
};
writeFileSync('evidence/concurrency-codex.json', JSON.stringify(report, null, 2));
console.log(
  JSON.stringify({
    count: total,
    passed: samples.filter((s) => s.status === 'passed').length,
    peakDispatched: peak,
    durationMs: report.durationMs,
    report: 'evidence/concurrency-codex.json',
  }),
);
if (samples.some((s) => s.status !== 'passed')) process.exitCode = 1;
