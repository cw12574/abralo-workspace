// Offline package checks. Does not launch agents or use provider credentials.
import { readFileSync, readdirSync, lstatSync, realpathSync, existsSync } from 'node:fs';
import { resolve, join, relative, isAbsolute, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

if (!process.argv[2]) throw new Error('Usage: node scripts/verify-package.mjs PACKAGE_DIRECTORY');
const root = realpathSync(resolve(process.argv[2]));
const release = JSON.parse(readFileSync(join(root, 'release.json'), 'utf8'));
if (release.platform !== process.platform || release.arch !== process.arch)
  throw new Error('Run verification on the package target OS and CPU.');
for (const name of ['dist/web/index.html', 'dist/service/apps/service/src/main.js', 'README.md',
  'docs/preview/START-HERE.md', 'docs/preview/ACCESS-AND-PRIVACY.md', 'docs/preview/RECOVERY.md', 'docs/preview/FEEDBACK.md'])
  if (!existsSync(join(root, name))) throw new Error('Missing package file: ' + name);
const forbidden = /^(?:\.env(?:\..*)?|workspace\.db(?:-.*)?|bootstrap\.key|vault-key(?:\.dpapi)?|secret-.*|service(?:\.previous)?\.log|auth\.json|credentials\.json)$/i;
const suspicious = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b|\bgh[pousr]_[A-Za-z0-9]{30,}\b/;
let count = 0, firstPartyTextFiles = 0;
const visited = new Set();
function walk(dir) {
  const canonical = realpathSync(dir);
  if (visited.has(canonical)) return;
  visited.add(canonical);
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry), local = relative(root, path);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      const target = realpathSync(path), within = relative(root, target);
      if (within.startsWith('..' + sep) || within === '..' || isAbsolute(within))
        throw new Error('Package link escapes its root: ' + local);
      continue;
    }
    if (stat.isDirectory()) { walk(path); continue; }
    count++;
    // Vendor fixtures are not founder data. Scan all first-party package content.
    if (local.split(sep)[0] === 'node_modules' || local.split(sep)[0] === 'runtime') continue;
    if (forbidden.test(entry)) throw new Error('Private-data filename in package: ' + local);
    if (stat.size < 5_000_000 && /\.(?:js|mjs|json|md|html|css|ps1|txt)$/i.test(entry)) {
      firstPartyTextFiles++;
      if (suspicious.test(readFileSync(path, 'utf8'))) throw new Error('Possible secret in: ' + local);
    }
  }
}
walk(root);
const binary = join(root, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
const probe = spawnSync(binary, ['-e', "const D=require('better-sqlite3');const d=new D(':memory:');console.log(JSON.stringify({platform:process.platform,arch:process.arch,node:process.version,sqlite:d.prepare('select 1 as ok').get().ok}));d.close()"], { cwd: root, encoding: 'utf8', windowsHide: true });
if (probe.status !== 0) throw new Error('Bundled runtime/SQLite probe failed: ' + probe.stderr);
const runtime = JSON.parse(probe.stdout);
if (runtime.platform !== release.platform || runtime.arch !== release.arch || runtime.sqlite !== 1)
  throw new Error('Runtime does not match manifest.');
console.log(JSON.stringify({ status: 'passed', platform: release.platform, arch: release.arch,
  runtime, files: count, firstPartyTextFiles, releaseManifestSha256: createHash('sha256').update(readFileSync(join(root, 'release.json'))).digest('hex'),
  limitations: ['Pattern scan is not exhaustive secret detection', 'No native provider/account cancellation test, package signing/trust check, or graphical desktop acceptance test'] }, null, 2));
