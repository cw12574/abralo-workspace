// Stable entry point, copied beside current.txt rather than inside a version.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
const installRoot = dirname(fileURLToPath(import.meta.url));
const root = realpathSync(readFileSync(join(installRoot, 'current.txt'), 'utf8').trim());
const normalize = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
if (normalize(dirname(root)) !== normalize(realpathSync(join(installRoot, 'versions'))))
  throw new Error('The selected release is outside this installation.');
const data =
  process.env.WORKSPACE_DATA_DIR ||
  join(
    process.platform === 'win32'
      ? process.env.LOCALAPPDATA
      : process.platform === 'darwin'
        ? join(homedir(), 'Library/Application Support')
        : process.env.XDG_DATA_HOME || join(homedir(), '.local/share'),
    'AgentWorkspace',
  );
const lock = join(data, 'maintenance/active.json');
if (existsSync(lock))
  throw new Error(
    'An update is pending or needs recovery. Inspect ' +
      join(data, 'maintenance/latest.json') +
      ' and its job status before starting another service.',
  );
const node = join(root, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
const child = spawn(node, [join(root, 'scripts/launcher.mjs'), ...process.argv.slice(2)], {
  cwd: root,
  windowsHide: true,
  stdio: 'inherit',
  env: { ...process.env, WORKSPACE_INSTALL_ROOT: installRoot, WORKSPACE_MAINTENANCE_JOB: '' },
});
child.once('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.once('exit', (code) => {
  process.exitCode = code || 0;
});
