import { cpSync, mkdirSync, existsSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
if (process.platform === 'win32') throw new Error('Use install-windows.ps1 on Windows.');
const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const release = JSON.parse(readFileSync(join(source, 'release.json'), 'utf8'));
if (!['darwin', 'linux'].includes(process.platform) || release.platform !== process.platform || release.arch !== process.arch)
  throw new Error(`Package ${release.platform}/${release.arch} does not match ${process.platform}/${process.arch}.`);
for (const name of ['dist', 'node_modules', 'scripts', 'runtime/node', 'package.json', 'README.md', 'docs/preview'])
  if (!existsSync(join(source, name))) throw new Error('Incomplete package: ' + name);
const base =
  process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'AgentWorkspaceProgram')
    : join(homedir(), '.local', 'lib', 'agent-workspace');
const target = join(base, 'versions', String(Date.now()));
if (existsSync(target)) throw new Error('Installation already exists.');
mkdirSync(target, { recursive: true });
for (const name of ['dist', 'node_modules', 'scripts', 'runtime', 'package.json', 'release.json', 'README.md', 'docs'])
  cpSync(join(source, name), join(target, name), { recursive: true });
const node = join(target, 'runtime', 'node'),
  launcher = join(base, 'launcher.mjs');
cpSync(join(target, 'scripts', 'installed-launcher.mjs'), launcher);
writeFileSync(join(base, 'current.txt'), target + '\n', { mode: 0o600 });
chmodSync(node, 0o755);
if (process.platform === 'darwin') {
  const app = join(homedir(), 'Applications', 'Agent Workspace.app', 'Contents');
  mkdirSync(join(app, 'MacOS'), { recursive: true });
  const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
  writeFileSync(
    join(app, 'MacOS', 'AgentWorkspace'),
    '#!/bin/sh\nexec ' + quote(node) + ' ' + quote(launcher) + '\n',
    { mode: 0o755 },
  );
  writeFileSync(
    join(app, 'Info.plist'),
    '<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>local.agentworkspace.app</string><key>CFBundleName</key><string>Agent Workspace</string><key>CFBundleExecutable</key><string>AgentWorkspace</string><key>CFBundleVersion</key><string>0.1.0</string></dict></plist>',
  );
} else {
  const dir = join(homedir(), '.local', 'share', 'applications');
  mkdirSync(dir, { recursive: true });
  const quote = (s) => '"' + s.replace(/["\\`$]/g, '\\$&') + '"';
  writeFileSync(
    join(dir, 'agent-workspace.desktop'),
    '[Desktop Entry]\nType=Application\nName=Agent Workspace\nTerminal=false\nExec=' +
      quote(node) +
      ' ' +
      quote(launcher) +
      '\nCategories=Development;\n',
  );
}
console.log('Installed: ' + target);
