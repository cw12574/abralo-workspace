import { it, expect, vi } from 'vitest';
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
import * as maintenanceFiles from '../apps/service/src/maintenance-files.js';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';

it('blocks dispatch only during an actual maintenance handoff', async () => {
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

it('preparation rejects another data format without touching selection or data', async () => {
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
    controller.prepare(join(versions, 'new'));
    await until(() => controller.status().job?.phase === 'failed');
    expect(controller.status().job?.error).toContain('migration');
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

async function prepared(controller: ReturnType<typeof createMaintenance>) {
  controller.prepare();
  await until(() => ['prepared', 'failed'].includes(controller.status().job?.phase));
  expect(controller.status().job?.phase, controller.status().job?.error).toBe('prepared');
  return controller.status().job!;
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
    helperReadyTimeoutMs: 1000,
    storageRetryMs: 200,
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
      const latest = join(s.dir, 'maintenance/latest.json');
      if (existsSync(latest)) {
        const file = join(
          s.dir,
          'maintenance',
          JSON.parse(readFileSync(latest, 'utf8')).id,
          'job.json',
        );
        const job = JSON.parse(readFileSync(file, 'utf8'));
        if (!['failed', 'succeeded', 'rolled-back', 'prepared'].includes(job.phase))
          writeFileSync(file, JSON.stringify({ ...job, phase: 'failed' }));
      }
      sup.active.clear();
      sup.inflight.clear();
      await sup.dispose();
      s.close();
    },
  };
}

it.each(['active', 'inflight'] as const)(
  'keeps an approved update queued beyond the former timeout while %s work drains',
  async (kind) => {
    const f = handoffFixture();
    if (kind === 'active') f.sup.active.set('busy', new AbortController());
    else f.sup.inflight.add(new Promise<void>(() => {}));
    try {
      const job = await prepared(f.controller);
      const file = join(f.s.dir, 'maintenance', job.id, 'job.json');
      writeFileSync(
        file,
        JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), idleTimeoutMs: 1 }),
      );
      await f.controller.execute(job.id);
      expect(f.sup.maintenance).toBe(false);
      await until(() => f.controller.status().job?.phase === 'draining');
      expect(f.sup.maintenanceReadonly).toBe(false);
      await delay(300);
      expect(f.shutdowns()).toBe(0);
      expect(f.controller.status().job?.waitingForWork).toBe(true);
      expect(existsSync(join(f.s.dir, 'maintenance/active.json'))).toBe(true);
      expect(readFileSync(join(f.root, 'current.txt'), 'utf8')).toBe(f.version);
      f.sup.active.clear();
      f.sup.inflight.clear();
      await until(() => f.shutdowns() === 1);
      expect(f.controller.status().job?.phase).toBe('stopping');
      expect(existsSync(join(f.s.dir, 'maintenance', job.id, 'workspace.db'))).toBe(true);
    } finally {
      await f.close();
    }
  },
  25000,
);

it('rejects a release changed after preparation before starting a helper', async () => {
  const f = handoffFixture();
  try {
    const job = await prepared(f.controller);
    writeFileSync(join(f.version, 'dist/web/index.html'), 'changed');
    await expect(f.controller.execute(job.id)).rejects.toThrow('changed');
    expect(f.shutdowns()).toBe(0);
    expect(existsSync(join(f.s.dir, 'maintenance/active.json'))).toBe(false);
  } finally {
    await f.close();
  }
});

it('keeps a low-space update queued and proceeds automatically when space returns', async () => {
  const f = handoffFixture();
  const disk = vi.spyOn(maintenanceFiles, 'freeDiskBytes').mockReturnValue(1024);
  const backup = vi.spyOn(f.s.db, 'backup');
  try {
    const job = await prepared(f.controller);
    await f.controller.execute(job.id);
    await until(() => f.controller.status().job?.waitingForSpace === true);
    expect(backup).not.toHaveBeenCalled();
    expect(f.sup.maintenance).toBe(false);
    expect(f.sup.maintenanceReadonly).toBe(false);
    expect(f.shutdowns()).toBe(0);
    expect(f.controller.status().job?.requiredBytes).toBeGreaterThan(256 * 1024 * 1024);
    disk.mockReturnValue(10 * 1024 ** 3);
    await until(() => f.shutdowns() === 1);
    expect(f.controller.status().job?.id).toBe(job.id);
    expect(f.controller.status().job?.waitingForSpace).toBe(false);
  } finally {
    disk.mockRestore();
    backup.mockRestore();
    await f.close();
  }
});

it('recovers from disk exhaustion during backup without losing approval or crashing', async () => {
  const f = handoffFixture();
  const disk = vi.spyOn(maintenanceFiles, 'freeDiskBytes').mockReturnValue(10 * 1024 ** 3);
  const backup = vi.spyOn(f.s.db, 'backup').mockImplementationOnce(async (path) => {
    writeFileSync(path, 'incomplete fixture backup');
    disk.mockReturnValue(0);
    throw Object.assign(new Error('database or disk is full'), { code: 'SQLITE_FULL' });
  });
  try {
    const job = await prepared(f.controller);
    await f.controller.execute(job.id);
    await until(() => f.controller.status().job?.waitingForSpace === true);
    expect(existsSync(join(f.s.dir, 'maintenance', job.id, 'workspace.db.partial'))).toBe(false);
    expect(f.sup.maintenanceReadonly).toBe(false);
    expect(f.s.db.open).toBe(true);
    expect(f.shutdowns()).toBe(0);
    disk.mockReturnValue(10 * 1024 ** 3);
    await until(() => f.shutdowns() === 1);
    expect(f.controller.status().job?.phase).toBe('stopping');
  } finally {
    disk.mockRestore();
    backup.mockRestore();
    await f.close();
  }
});

it('aborts backup if another writer consumes the disk reserve after preflight', async () => {
  const f = handoffFixture();
  const disk = vi
    .spyOn(maintenanceFiles, 'freeDiskBytes')
    .mockReturnValue(0)
    .mockReturnValueOnce(10 * 1024 ** 3);
  try {
    const job = await prepared(f.controller);
    await f.controller.execute(job.id);
    await until(() => f.controller.status().job?.waitingForSpace === true);
    expect(disk.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(f.shutdowns()).toBe(0);
    expect(f.sup.maintenanceReadonly).toBe(false);
    expect(existsSync(join(f.s.dir, 'maintenance', job.id, 'workspace.db.partial'))).toBe(false);
    disk.mockReturnValue(10 * 1024 ** 3);
    await until(() => f.shutdowns() === 1);
  } finally {
    disk.mockRestore();
    await f.close();
  }
});

it('contains failure-report write errors and retries persistence instead of crashing the timer', async () => {
  const f = handoffFixture();
  const backup = vi.spyOn(f.s.db, 'backup').mockRejectedValue(new Error('fixture backup failed'));
  const original = maintenanceFiles.atomicJson;
  let reports = 0;
  const persist = vi
    .spyOn(maintenanceFiles, 'atomicJson')
    .mockImplementation((path, value: any) => {
      if (value.phase === 'failed') {
        reports++;
        throw Object.assign(new Error('no space left'), { code: 'ENOSPC' });
      }
      return original(path, value);
    });
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const job = await prepared(f.controller);
    await f.controller.execute(job.id);
    await until(() => reports > 0);
    expect(f.shutdowns()).toBe(0);
    expect(f.sup.maintenanceReadonly).toBe(false);
    expect(f.s.db.open).toBe(true);
    expect(existsSync(join(f.s.dir, 'maintenance/active.json'))).toBe(true);
    persist.mockRestore();
    await until(() => f.controller.status().job?.phase === 'failed');
    expect(f.sup.maintenance).toBe(false);
  } finally {
    persist.mockRestore();
    backup.mockRestore();
    log.mockRestore();
    await f.close();
  }
});

it('releases dispatch if arming and its failure record both cannot be written', async () => {
  const f = handoffFixture();
  const job = await prepared(f.controller);
  const original = maintenanceFiles.atomicJson;
  const persist = vi
    .spyOn(maintenanceFiles, 'atomicJson')
    .mockImplementation((path, value: any) => {
      if (['armed', 'failed'].includes(value.phase))
        throw Object.assign(new Error('no space left'), { code: 'ENOSPC' });
      return original(path, value);
    });
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await expect(f.controller.execute(job.id)).rejects.toThrow('no space left');
    expect(f.sup.maintenance).toBe(false);
    expect(existsSync(join(f.s.dir, 'maintenance/active.json'))).toBe(false);
    expect(f.shutdowns()).toBe(0);
  } finally {
    persist.mockRestore();
    log.mockRestore();
    await f.close();
  }
});

it('retries helper startup but reports repeated failures without stopping the original service', async () => {
  const f = handoffFixture();
  try {
    writeFileSync(join(f.version, 'scripts/maintenance-helper.mjs'), 'process.exit(1);');
    const job = await prepared(f.controller);
    await f.controller.execute(job.id);
    await until(() => f.controller.status().job?.phase === 'failed');
    expect(f.controller.status().job?.error).toContain('three attempts');
    expect(f.shutdowns()).toBe(0);
    expect(f.sup.maintenanceReadonly).toBe(false);
    expect(existsSync(join(f.s.dir, 'maintenance/active.json'))).toBe(false);
  } finally {
    await f.close();
  }
}, 25000);

it('revalidates a prepared approval after service restart and never spawns a duplicate handoff', async () => {
  const f = handoffFixture();
  f.sup.active.set('busy', new AbortController());
  try {
    const job = await prepared(f.controller);
    const file = join(f.s.dir, 'maintenance', job.id, 'job.json');
    const persisted = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(
      file,
      JSON.stringify({ ...persisted, oldPid: 123, createdAt: '2020-01-01T00:00:00.000Z' }),
    );
    await f.controller.execute(job.id);
    const retry = await f.controller.execute(job.id);
    expect(retry.message).toContain('No duplicate');
    expect(JSON.parse(readFileSync(file, 'utf8')).oldPid).toBe(process.pid);
    await until(() => f.controller.status().job?.phase === 'draining');
    expect(f.shutdowns()).toBe(0);
  } finally {
    await f.close();
  }
}, 25000);

it('rejects a saved approval if the selected installation changes', async () => {
  const f = handoffFixture();
  try {
    const job = await prepared(f.controller);
    writeFileSync(join(f.root, 'current.txt'), f.root);
    await expect(f.controller.execute(job.id)).rejects.toThrow('installation or workspace changed');
    expect(existsSync(join(f.s.dir, 'maintenance/active.json'))).toBe(false);
  } finally {
    await f.close();
  }
});

it('reclaims an approved queue after controller restart and fences the previous helper', async () => {
  const f = handoffFixture();
  f.sup.active.set('busy', new AbortController());
  let resumed: ReturnType<typeof createMaintenance> | undefined;
  try {
    const job = await prepared(f.controller);
    await f.controller.execute(job.id);
    await until(() => f.controller.status().job?.phase === 'draining');
    const file = join(f.s.dir, 'maintenance', job.id, 'job.json');
    const first = JSON.parse(readFileSync(file, 'utf8'));
    f.controller.close();
    f.sup.maintenance = false;
    let shutdowns = 0;
    resumed = createMaintenance(f.s, f.sup, {
      root: f.version,
      installRoot: f.root,
      shutdown: async () => {
        shutdowns++;
      },
    });
    expect(f.sup.maintenance).toBe(false);
    await until(() => {
      const next = JSON.parse(readFileSync(file, 'utf8'));
      return next.helperId !== first.helperId && next.phase === 'draining';
    });
    expect(resumed.status().job?.id).toBe(job.id);
    expect(shutdowns).toBe(0);
    f.sup.active.clear();
    await until(() => shutdowns === 1);
  } finally {
    resumed?.close();
    await f.close();
  }
});

it('recovers a helper that exits after readiness without losing the approved queue', async () => {
  const f = handoffFixture();
  f.sup.active.set('busy', new AbortController());
  try {
    const job = await prepared(f.controller);
    await f.controller.execute(job.id);
    await until(() => f.controller.status().job?.phase === 'draining');
    const readyFile = join(f.s.dir, 'maintenance', job.id, 'ready.json');
    const first = JSON.parse(readFileSync(readyFile, 'utf8'));
    process.kill(first.pid);
    await until(
      () =>
        JSON.parse(readFileSync(readyFile, 'utf8')).helperId !== first.helperId &&
        f.controller.status().job?.phase === 'draining',
    );
    expect(f.controller.status().job?.id).toBe(job.id);
    expect(f.shutdowns()).toBe(0);
    f.sup.active.clear();
    await until(() => f.shutdowns() === 1);
  } finally {
    await f.close();
  }
});

it('revalidates queued build fingerprints before resuming after restart', async () => {
  const f = handoffFixture();
  f.sup.active.set('busy', new AbortController());
  let resumed: ReturnType<typeof createMaintenance> | undefined;
  try {
    const job = await prepared(f.controller);
    await f.controller.execute(job.id);
    await until(() => f.controller.status().job?.phase === 'draining');
    f.controller.close();
    writeFileSync(join(f.version, 'dist/web/index.html'), 'changed');
    resumed = createMaintenance(f.s, f.sup, {
      root: f.version,
      installRoot: f.root,
      shutdown: async () => {
        throw Error('must not shut down');
      },
    });
    await until(() => resumed!.status().job?.phase === 'failed');
    expect(resumed.status().job?.error).toContain('changed');
    expect(f.sup.maintenance).toBe(false);
  } finally {
    resumed?.close();
    await f.close();
  }
});
