// Detached, single-job preparation helper. It never selects a release or opens
// workspace.db. Its durable result is consumed by the service after restarts.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  cpSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { constants, setPriority } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export const buildEnvironment = (heapMiB = 768) => ({
  ...process.env,
  NODE_OPTIONS: `--max-old-space-size=${heapMiB}`,
  UV_THREADPOOL_SIZE: '2',
  GOMAXPROCS: '2',
  npm_config_child_concurrency: '1',
  npm_config_network_concurrency: '2',
});

export async function runBuild(
  request,
  {
    save,
    versionInfo,
    run = runNode,
    heapMiB = 768,
  },
) {
  const { sourceRoot, folder, installRoot, pnpmCli } = request;
  const startStage = (stage) => {
    save({
      phase: 'building',
      stage,
      message: `Preparing update: ${stage}. Agents can keep working.`,
    });
  };
  startStage('copy source');
  const attempt = join(folder, 'build-' + randomUUID());
  const snapshot = join(attempt, 'source');
  mkdirSync(snapshot, { recursive: true });
  try {
    const allowed = [
      'apps',
      'packages',
      'scripts',
      'tests',
      'docs',
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'tsconfig.json',
      'tsconfig.service.json',
      'README.md',
      'LICENSE',
    ];
    for (const name of allowed) {
      const from = join(sourceRoot, name);
      if (!existsSync(from)) continue;
      cpSync(from, join(snapshot, name), {
        recursive: true,
        filter: (path) => {
          if (['node_modules', '.git', 'dist', 'release', 'evidence'].includes(basename(path)))
            return false;
          if (lstatSync(path).isSymbolicLink())
            throw new Error('Build inputs must not contain links: ' + path);
          return true;
        },
      });
    }
    // Immutable source snapshot, shared installed dependencies, isolated output.
    symlinkSync(
      realpathSync(join(sourceRoot, 'node_modules')),
      join(snapshot, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const modules = join(snapshot, 'node_modules');
    const packaged = join(attempt, 'release');
    const stages = [
      ['type check', [join(modules, 'typescript/bin/tsc'), '--noEmit']],
      [
        'tests',
        [join(modules, 'vitest/vitest.mjs'), 'run', '--maxWorkers=1', '--no-file-parallelism', '--testTimeout=20000', '--hookTimeout=20000'],
      ],
      [
        'web build',
        [
          join(modules, 'vite/bin/vite.js'),
          'build',
          '--config',
          'apps/web/vite.config.ts',
          '--configLoader',
          'native',
        ],
      ],
      ['service build', [join(modules, 'typescript/bin/tsc'), '-p', 'tsconfig.service.json']],
      ['package', [join(snapshot, 'scripts/package.mjs'), packaged]],
    ];
    for (const [stage, args] of stages) {
      startStage(stage);
      await run(args, {
        cwd: snapshot,
        env: {
          ...buildEnvironment(heapMiB), WORKSPACE_PNPM_CLI: pnpmCli,
          WORKSPACE_DATA_DIR: join(attempt, 'test-data'), WORKSPACE_PORT: '0',
          WORKSPACE_INSTALL_ROOT: '', WORKSPACE_MAINTENANCE_JOB: '', WORKSPACE_PUBLIC_URL: '',
        },
      });
    }
    startStage('stage release');
    const candidateRoot = join(installRoot, 'versions', 'update-' + randomUUID());
    // A unique candidate is never selected until separately verified and approved.
    try {
      renameSync(packaged, candidateRoot);
    } catch (error) {
      if (error.code !== 'EXDEV') throw error;
      cpSync(packaged, candidateRoot, { recursive: true, dereference: true });
    }
    return versionInfo(candidateRoot, installRoot);
  } finally {
    // Delete only this helper's disposable attempt, never the installed version
    // or shared dependency tree. Resolve and check the boundary before removal.
    const checked = realpathSync(attempt);
    const within = relative(realpathSync(folder), checked);
    if (!within || within.startsWith('..') || isAbsolute(within))
      throw new Error('Build cleanup escaped its job directory.');
    const dependencies = join(snapshot, 'node_modules');
    if (existsSync(dependencies) && lstatSync(dependencies).isSymbolicLink())
      unlinkSync(dependencies);
    rmSync(checked, { recursive: true, force: true });
  }
}

async function runNode(args, { onChild, ...options }) {
  await new Promise((resolve, reject) => {
    let tail = '';
    const child = spawn(process.execPath, args, {
      ...options,
      windowsHide: true,
      stdio: ['ignore', 'inherit', 'pipe'],
    });
    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk);
      tail = (tail + chunk).slice(-65536);
    });
    child.once('spawn', () => {
      onChild?.(child.pid);
      try {
        setPriority(child.pid, constants.priority.PRIORITY_BELOW_NORMAL);
      } catch {}
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      onChild?.(undefined);
      if (code === 0) resolve();
      else
        reject(
          Object.assign(
            new Error(`Preparation stage exited (${signal || code}). Inspect preparation.log.`),
            {
              resourcePressure:
                /heap out of memory|allocation failed|not enough memory|ENOMEM/i.test(tail) ||
                [137, 3221225495].includes(code),
            },
          ),
        );
    });
  });
}

async function main() {
  const [requestFile, moduleUrl] = process.argv.slice(2);
  const { alive, atomicJson, versionInfo } = await import(moduleUrl);
  const request = JSON.parse(readFileSync(requestFile, 'utf8'));
  const folder = dirname(requestFile);
  const claim = join(folder, 'build-worker.json');
  if (existsSync(claim)) {
    const previous = JSON.parse(readFileSync(claim, 'utf8'));
    if (alive(previous.pid)) return;
    // Wait for this job's surviving compiler. Never start duplicate stages or
    // terminate a process that might belong to someone else's active work.
    if (previous.childPid && alive(previous.childPid)) {
      atomicJson(join(folder, 'build-status.json'), {
        phase: 'building',
        message: 'Update queued: waiting for its previous build worker to finish.',
      });
      return;
    }
    unlinkSync(claim);
  }
  let fd;
  try {
    fd = openSync(claim, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') return;
    throw error;
  }
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, phase: 'starting' }));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    setPriority(process.pid, constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {}
  let childPid;
  let state = { phase: 'starting' };
  const save = (value) => {
    state = value;
    atomicJson(claim, { pid: process.pid, childPid, phase: value.phase });
    atomicJson(join(folder, 'build-status.json'), {
      ...value,
      updatedAt: new Date().toISOString(),
    });
  };
  let heapMiB = 768;
  for (;;) {
    try {
      const candidate = await runBuild(
        { ...request, folder },
        {
          save,
          versionInfo,
          heapMiB,
          run: (args, options) =>
            runNode(args, {
              ...options,
              onChild: (pid) => {
                childPid = pid;
                save(state);
              },
            }),
        },
      );
      atomicJson(join(folder, 'build-result.json'), candidate);
      save({ phase: 'built', message: 'Build and tests passed. Verifying release.' });
      break;
    } catch (error) {
      if (error.resourcePressure && heapMiB < 1536) {
        heapMiB = Math.min(1536, heapMiB + 256);
        save({
          phase: 'queued',
          message:
            'Build ran out of memory. Retrying with a larger heap allowance; agents can keep working.',
        });
        await delay(30000);
        continue;
      }
      save({ phase: 'failed', message: String(error.message || error) });
      process.exitCode = 1;
      break;
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();
