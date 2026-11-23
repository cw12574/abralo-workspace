import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { installRuntime, runtimeBinary, newAdapter } from '../apps/service/src/provider-updates.js';
const root = mkdtempSync(join(tmpdir(), 'abralo-provider-probe-'));
const report: any = { inferenceStarted: false, liveInstallationChanged: false };
let adapter;
try {
  const metadata = await (await fetch('https://registry.npmjs.org/%40openai%2Fcodex/latest', { signal: AbortSignal.timeout(10000) })).json() as any;
  const release = await installRuntime('codex', metadata.version, root, new AbortController().signal);
  adapter = newAdapter('codex', runtimeBinary(release.root, 'codex'));
  const info = await adapter.info();
  report.version = release.version;
  report.connected = info.authenticated;
  report.models = info.models;
  report.passed = !!info.models?.length && info.authenticated === true;
  if (!report.passed) { report.detail = info.detail; process.exitCode = 1; }
} catch (e) { report.error = String(e); process.exitCode = 1; }
finally {
  await adapter?.dispose();
  mkdirSync('evidence', { recursive: true });
  writeFileSync('evidence/provider-runtime-probe.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  if (dirname(realpathSync(root)) === realpathSync(tmpdir()) && root.includes('abralo-provider-probe-')) rmSync(root, { recursive: true, force: true });
}
