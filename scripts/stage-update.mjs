// Prepare a fresh version only. Never selects it, starts it, or touches workspace data.
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
if (!process.argv[2] || !process.argv[3])
  throw new Error('Usage: node stage-update.mjs PACKAGED_RELEASE INSTALL_ROOT');
const source = realpathSync(process.argv[2]);
const install = realpathSync(process.argv[3]);
const current = realpathSync(readFileSync(join(install, 'current.txt'), 'utf8').trim());
const { versionInfo } = await import(
  pathToFileURL(join(current, 'dist/service/apps/service/src/maintenance-files.js'))
);
const release = JSON.parse(readFileSync(join(source, 'release.json'), 'utf8'));
if (
  release.platform !== process.platform ||
  release.arch !== process.arch ||
  release.maintenanceProtocol !== 1
)
  throw new Error('Release platform or maintenance protocol mismatch.');
const id = 'update-' + randomUUID();
const staging = join(install, 'versions', '.' + id);
const target = join(install, 'versions', id);
if (existsSync(target) || existsSync(staging)) throw new Error('Staging path already exists.');
mkdirSync(staging);
for (const name of [
  'dist',
  'node_modules',
  'scripts',
  'runtime',
  'package.json',
  'release.json',
  'README.md',
  'docs',
])
  cpSync(join(source, name), join(staging, name), { recursive: true, dereference: true });
versionInfo(staging, install);
renameSync(staging, target);
console.log(
  JSON.stringify({
    candidateRoot: target,
    selected: false,
    message: 'Prepared only. Request owner approval through workspace_maintenance to apply.',
  }),
);
