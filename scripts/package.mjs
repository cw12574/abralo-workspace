import { spawnSync } from 'node:child_process';
import { mkdirSync, copyFileSync, writeFileSync, existsSync,readdirSync,realpathSync,unlinkSync } from 'node:fs';
import { join, resolve, dirname,relative,isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(
  process.argv[2] || join(root, 'release', `${process.platform}-${process.arch}-${Date.now()}`),
);
if (existsSync(target))
  throw new Error('Choose a new empty release directory; existing releases are never overwritten.');
const pnpm = process.env.WORKSPACE_PNPM_CLI || process.env.npm_execpath;
if (!pnpm?.endsWith('.cjs') && !pnpm?.endsWith('.js'))
  throw new Error('Set WORKSPACE_PNPM_CLI to the pinned pnpm JavaScript entry point.');
const deploy = spawnSync(
  process.execPath,
  [
    pnpm,
    '--config.node-linker=hoisted',
    '--filter',
    'agent-workspace',
    'deploy',
    '--prod',
    '--frozen-lockfile',
    target,
  ],
  { cwd: root, stdio: 'inherit', windowsHide: true },
);
if (deploy.status !== 0) throw new Error('Production deployment failed');
// The selected native OpenCode binary is already copied into opencode-ai/bin.
// Drop duplicate optional binary payloads, retaining their metadata and notices.
for(const name of readdirSync(join(target,'node_modules')).filter(n=>/^opencode-(windows|linux|darwin)-/.test(n))){
  const binary=join(target,'node_modules',name,'bin',process.platform==='win32'?'opencode.exe':'opencode');
  if(existsSync(binary)){const within=relative(realpathSync(target),realpathSync(binary));if(within.startsWith('..')||isAbsolute(within))throw new Error('Native binary escaped package directory');unlinkSync(binary);}
}
mkdirSync(join(target, 'runtime'), { recursive: true });
copyFileSync(
  process.execPath,
  join(target, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'),
);
writeFileSync(
  join(target, 'release.json'),
  JSON.stringify(
    {
      version: (process.env.ABRALO_VERSION || '0.1.0-preview').replace(/^v/, ''),
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      builtAt: new Date().toISOString(),
      maintenanceProtocol: 1,
      dataCompatibility: 'workspace-v1',
    },
    null,
    2,
  ),
);
console.log('Packaged: ' + target);
