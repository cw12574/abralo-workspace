// Shared with the detached helper. Keep this module free of app/DB dependencies.
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  statfsSync,
  lstatSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, isAbsolute } from 'node:path';

export const terminalMaintenance = new Set(['succeeded', 'rolled-back', 'failed']);
export function freeDiskBytes(path: string) {
  const disk = statfsSync(path);
  return disk.bavail * disk.bsize;
}
export function windowsBackgroundLauncher(data: string, port: number) {
  const quote = (text: string) => "'" + text.replaceAll("'", "''") + "'";
  return [
    "$ErrorActionPreference = 'Stop'",
    `$env:WORKSPACE_DATA_DIR = ${quote(data)}`,
    `$env:WORKSPACE_PORT = ${quote(String(port))}`,
    "$selected = (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'current.txt') -Raw).Trim()",
    "$runtime = Join-Path $selected 'runtime\\node.exe'",
    "$launcher = Join-Path $PSScriptRoot 'launcher.mjs'",
    "Start-Process -FilePath $runtime -ArgumentList @(('\"' + $launcher + '\"'),'--background') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden",
    '',
  ].join('\r\n');
}
export function refreshInstalledLauncher(
  root: string,
  installRoot: string,
  data: string,
  port: number,
) {
  atomicText(
    join(installRoot, 'launcher.mjs'),
    readFileSync(join(root, 'scripts/installed-launcher.mjs'), 'utf8'),
  );
  if (process.platform === 'win32')
    atomicText(
      join(installRoot, 'Background Workspace.ps1'),
      windowsBackgroundLauncher(data, port),
    );
}
export function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'));
}
export function atomicJson(path: string, value: unknown) {
  atomicText(path, JSON.stringify(value, null, 2) + '\n');
}
export function atomicText(path: string, value: string) {
  const temporary = path + `.tmp-${process.pid}`;
  const fd = openSync(temporary, 'w', 0o600);
  try {
    writeFileSync(fd, value);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  // Windows can briefly deny replacement while another process reads the job.
  // Keep the old complete file until replacement succeeds; never delete it first.
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(temporary, path);
      break;
    } catch (error: any) {
      if (
        process.platform !== 'win32' ||
        !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) ||
        attempt >= 10
      )
        throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}
export function alive(pid: number) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error.code !== 'ESRCH';
  }
}
export function workspaceIdentity(path: string) {
  const canonical = realpathSync(path);
  return createHash('sha256')
    .update(process.platform === 'win32' ? canonical.toLowerCase() : canonical)
    .digest('hex');
}
export function versionInfo(root: string, installRoot: string) {
  root = realpathSync(root);
  const versions = realpathSync(join(installRoot, 'versions'));
  const normalize = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
  if (normalize(dirname(root)) !== normalize(versions))
    throw new Error('Choose a prepared version inside this installation’s versions directory.');
  const release = readJson(join(root, 'release.json'));
  const pkg = readJson(join(root, 'package.json'));
  if (
    pkg.name !== 'agent-workspace' ||
    release.platform !== process.platform ||
    release.arch !== process.arch ||
    release.maintenanceProtocol !== 1 ||
    typeof release.dataCompatibility !== 'string'
  )
    throw new Error(
      'The prepared release is not compatible with this platform or maintenance protocol.',
    );
  const node = join(root, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
  for (const file of [
    node,
    join(root, 'scripts/launcher.mjs'),
    join(root, 'scripts/maintenance-helper.mjs'),
    join(root, 'dist/service/apps/service/src/main.js'),
    join(root, 'dist/service/apps/service/src/maintenance-files.js'),
    join(root, 'dist/web/index.html'),
  ])
    if (!statSync(file).isFile()) throw new Error('Incomplete release: ' + file);
  if (!existsSync(join(root, 'node_modules')))
    throw new Error('Prepared release dependencies are missing.');
  const digest = createHash('sha256');
  // Reuse one bounded buffer, including for Chromium's hundreds-of-MiB DLL.
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const walk = (path: string) => {
    if (lstatSync(path).isSymbolicLink())
      throw new Error('Release code must not contain symbolic links.');
    const rel = relative(root, path);
    if (rel.startsWith('..') || isAbsolute(rel))
      throw new Error('Release path escaped its version directory.');
    if (statSync(path).isDirectory()) {
      for (const name of readdirSync(path).sort()) walk(join(path, name));
    } else {
      digest.update(rel.replaceAll('\\', '/'));
      const fd = openSync(path, 'r');
      try {
        let bytes: number;
        while ((bytes = readSync(fd, buffer, 0, buffer.length, null)) > 0)
          digest.update(buffer.subarray(0, bytes));
      } finally {
        closeSync(fd);
      }
    }
  };
  for (const part of ['dist', 'scripts', 'package.json', 'release.json', 'runtime'])
    walk(join(root, part));
  return {
    root,
    node,
    buildId: basename(root),
    dataCompatibility: release.dataCompatibility,
    fingerprint: digest.digest('hex'),
  };
}
// Serialize verification workers: concurrent approvals must not multiply memory
// or disk pressure. Never run recursive hashing on the service's event loop.
let verificationTail: Promise<unknown> = Promise.resolve();
export function versionInfoAsync(
  root: string,
  installRoot: string,
): Promise<ReturnType<typeof versionInfo>> {
  const task = verificationTail.then(
    () =>
      new Promise<ReturnType<typeof versionInfo>>((resolve, reject) => {
        const worker = new Worker(
          `
      const { parentPort, workerData } = require('node:worker_threads');
      import(workerData.module).then(({ versionInfo }) => {
        parentPort.postMessage(versionInfo(workerData.root, workerData.installRoot));
      }).catch(error => { throw error; });
    `,
          {
            eval: true,
            workerData: { module: import.meta.url, root, installRoot },
            resourceLimits: { maxOldGenerationSizeMb: 64 },
          },
        );
        let received = false;
        worker.once('message', (value) => {
          received = true;
          resolve(value);
        });
        worker.once('error', reject);
        worker.once('exit', (code) => {
          if (!received) reject(new Error(`Verification helper exited (${code}).`));
        });
      }),
  );
  verificationTail = task.catch(() => {});
  return task;
}
export async function health(port: number): Promise<any> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(1500),
    });
    return response.ok ? await response.json() : { occupied: true };
  } catch (error: any) {
    // A timeout is an occupied/unresponsive port, not permission to start another service.
    if (error?.cause?.code === 'ECONNREFUSED') return null;
    return { occupied: true };
  }
}
