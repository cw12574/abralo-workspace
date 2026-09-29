import { it, expect } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  copyFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../apps/service/src/store.js';
import { Supervisor } from '../apps/service/src/supervisor.js';
import { createMaintenance } from '../apps/service/src/maintenance.js';
import { versionInfo } from '../apps/service/src/maintenance-files.js';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';

it('blocks dispatch and scheduled resumption while maintenance is waiting', async () => {
  const s = new Store(mkdtempSync(join(tmpdir(), 'maintenance-queue-')));
  const owner = s.createOwner('Owner');
  const agent = s.createEmployee(owner.id, {
    name: 'Agent',
    harness: 'codex',
    model: '',
    role: '',
    cwd: '',
    instructions: '',
  });
  const sup = new Supervisor(s);
  sup.maintenance = true;
  s.accept(owner, agent.dmId, {
    text: 'Keep queued',
    key: 'queued',
    attachments: [],
    recipients: [],
  });
  await sup.dispatch();
  expect(s.one("SELECT COUNT(*) n FROM outbox WHERE status='pending'").n).toBe(1);
  expect(s.one('SELECT COUNT(*) n FROM runs').n).toBe(0);
  await expect(sup.resumeProviderLimited('any')).rejects.toThrow('restart');
  await sup.dispose();
  s.close();
});

it('preparation rejects another data format without touching selection or data', () => {
  const root = mkdtempSync(join(tmpdir(), 'maintenance-prepare-'));
  const versions = join(root, 'versions');
  mkdirSync(versions);
  for (const name of ['old', 'new']) {
    const p = join(versions, name);
    for (const d of [
      'dist/service/apps/service/src',
      'dist/web',
      'scripts',
      'runtime',
      'node_modules',
    ])
      mkdirSync(join(p, d), { recursive: true });
    for (const file of [
      'scripts/launcher.mjs',
      'scripts/maintenance-helper.mjs',
      'dist/service/apps/service/src/main.js',
      'dist/service/apps/service/src/maintenance-files.js',
      'dist/web/index.html',
      'runtime/' + (process.platform === 'win32' ? 'node.exe' : 'node'),
    ])
      writeFileSync(join(p, file), 'fixture');
    writeFileSync(join(p, 'package.json'), JSON.stringify({ name: 'agent-workspace' }));
    writeFileSync(
      join(p, 'release.json'),
      JSON.stringify({
        platform: process.platform,
        arch: process.arch,
        maintenanceProtocol: 1,
        dataCompatibility: name,
      }),
    );
  }
  const old = join(versions, 'old');
  writeFileSync(join(root, 'current.txt'), old);
  const s = new Store(join(root, 'data'));
  const sup = new Supervisor(s);
  const controller = createMaintenance(s, sup, {
    root: old,
    installRoot: root,
    shutdown: async () => {
      throw new Error('must not stop');
    },
  });
  try {
    expect(() => controller.prepare(join(versions, 'new'))).toThrow('migration');
    expect(readFileSync(join(root, 'current.txt'), 'utf8')).toBe(old);
    expect(existsSync(join(s.dir, 'maintenance/active.json'))).toBe(false);
    expect(() => versionInfo(root, root)).toThrow('versions');
  } finally {
    controller.close();
    s.close();
  }
});

async function until(check: () => boolean, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (check()) return;
    await delay(100);
  }
  throw new Error('Maintenance condition timed out');
}

function handoffFixture() {
  const root = mkdtempSync(join(tmpdir(), 'maintenance-handoff-'));
  const version = join(root, 'versions', 'old');
  for (const d of [
    'dist/service/apps/service/src',
    'dist/web',
    'scripts',
    'runtime',
    'node_modules',
  ])
    mkdirSync(join(version, d), { recursive: true });
  for (const file of [
    'scripts/launcher.mjs',
    'dist/service/apps/service/src/main.js',
    'dist/web/index.html',
    'runtime/' + (process.platform === 'win32' ? 'node.exe' : 'node'),
  ])
    writeFileSync(join(version, file), 'fixture');
  copyFileSync(
    resolve('scripts/maintenance-helper.mjs'),
    join(version, 'scripts/maintenance-helper.mjs'),
  );
  const compiled = transpileModule(
    readFileSync(resolve('apps/service/src/maintenance-files.ts'), 'utf8'),
    { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } },
  );
  writeFileSync(
    join(version, 'dist/service/apps/service/src/maintenance-files.js'),
    compiled.outputText,
  );
  writeFileSync(
    join(version, 'package.json'),
    JSON.stringify({ name: 'agent-workspace', type: 'module' }),
  );
  writeFileSync(
    join(version, 'release.json'),
    JSON.stringify({
      platform: process.platform,
      arch: process.arch,
      maintenanceProtocol: 1,
      dataCompatibility: 'fixture',
    }),
  );
  writeFileSync(join(root, 'current.txt'), version);
  const s = new Store(join(root, 'data'));
  const sup = new Supervisor(s);
  let shutdowns = 0;
  const controller = createMaintenance(s, sup, {
    root: version,
    installRoot: root,
    idleTimeoutMs: 1500,
    shutdown: async () => {
      shutdowns++;
    },
  });
  return {
    root,
    version,
    s,
    sup,
    controller,
    shutdowns: () => shutdowns,
    close: async () => {
      controller.close();
      sup.active.clear();
      sup.inflight.clear();
      await sup.dispose();
      s.close();
    },
  };
}

it.each(['active', 'inflight'] as const)(
  'leaves the original service running when %s work cannot drain',
  async (kind) => {
    const f = handoffFixture();
    if (kind === 'active') f.sup.active.set('busy', new AbortController());
    else f.sup.inflight.add(new Promise<void>(() => {}));
    try {
      const job = f.controller.prepare().job!;
      await f.controller.execute(job.id);
      await until(() => f.sup.maintenance);
      expect(f.sup.maintenanceReadonly).toBe(false);
      await until(() => f.controller.status().job?.phase === 'failed' && !f.sup.maintenance);
      expect(f.shutdowns()).toBe(0);
      expect(f.controller.status().job?.error).toContain('not killed');
      expect(existsSync(join(f.s.dir, 'maintenance/active.json'))).toBe(false);
      expect(readFileSync(join(f.root, 'current.txt'), 'utf8')).toBe(f.version);
    } finally {
      await f.close();
    }
  },
  25000,
);

it('rejects a release changed after preparation before starting a helper', async () => {
  const f = handoffFixture();
  try {
    const job = f.controller.prepare().job!;
    writeFileSync(join(f.version, 'dist/web/index.html'), 'changed');
    await expect(f.controller.execute(job.id)).rejects.toThrow('changed');
    expect(f.shutdowns()).toBe(0);
    expect(existsSync(join(f.s.dir, 'maintenance/active.json'))).toBe(false);
  } finally {
    await f.close();
  }
});

it('keeps the original service running if the helper exits before acknowledging readiness', async () => {
  const f = handoffFixture();
  try {
    writeFileSync(join(f.version, 'scripts/maintenance-helper.mjs'), 'process.exit(1);');
    const job = f.controller.prepare().job!;
    await f.controller.execute(job.id);
    await until(() => f.controller.status().job?.phase === 'failed');
    expect(f.shutdowns()).toBe(0);
    expect(f.sup.maintenanceReadonly).toBe(false);
    expect(existsSync(join(f.s.dir, 'maintenance/active.json'))).toBe(false);
  } finally {
    await f.close();
  }
}, 25000);
