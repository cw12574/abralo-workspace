// CI-only install, shortcut, and removal check using a disposable profile.
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

if (process.env.CI !== 'true') throw new Error('This installer acceptance smoke runs only on CI runners.');
if (!process.argv[2]) throw new Error('Pass a packaged release directory.');

const packageRoot = realpathSync(resolve(process.argv[2]));
const manifest = JSON.parse(readFileSync(join(packageRoot, 'release.json'), 'utf8'));
if (manifest.platform !== process.platform || manifest.arch !== process.arch)
  throw new Error(`Package ${manifest.platform}/${manifest.arch} does not match this runner.`);

const tempRoot = process.platform === 'linux' ? homedir() : tmpdir();
// macOS exposes the temp directory through a symlink (`/var` -> `/private/var`).
// Canonicalize the fixture before comparing installer paths against it.
const fixture = realpathSync(mkdtempSync(join(tempRoot, '.abralo-installer-')));
const dataDir = join(fixture, 'preserved-user-data');
mkdirSync(dataDir, { recursive: true });
writeFileSync(join(dataDir, 'keep.txt'), 'Keep application data when removing program files.\n');
const env = {
  ...process.env,
  HOME: fixture,
  XDG_DATA_HOME: join(fixture, '.local', 'share'),
  WORKSPACE_DATA_DIR: dataDir,
};
const report = {
  platform: process.platform,
  arch: process.arch,
  install: 'pending',
  launchAndLifecycle: 'pending',
  removal: 'pending',
  dataPreserved: false,
  trust: { status: 'not assessed' },
  providerCalls: false,
};
let installRoot;
let ownedShortcuts = [];

function assertInside(parent, candidate) {
  const base = resolve(parent);
  const target = resolve(candidate);
  const rel = relative(base, target);
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel))
    throw new Error(`Refusing to use a path outside the disposable profile: ${target}`);
  return target;
}

function removeInside(parent, candidate) {
  rmSync(assertInside(parent, candidate), { recursive: true, force: true });
}

function run(command, args, options = {}) {
  execFileSync(command, args, { stdio: 'pipe', windowsHide: true, ...options });
}

function verifyInstalledPayload(root) {
  const node = join(root, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
  for (const required of [
    'release.json',
    'scripts/installed-launcher.mjs',
    'docs/preview/START-HERE.md',
    'docs/preview/ACCESS-AND-PRIVACY.md',
  ]) {
    if (!existsSync(join(root, required))) throw new Error(`Installed payload is missing ${required}.`);
  }
  if (!existsSync(node)) throw new Error('Installed bundled Node runtime is missing.');
  return node;
}

try {
  if (process.platform === 'win32') {
    env.LOCALAPPDATA = join(fixture, 'LocalAppData');
    const folders = run(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "[Environment]::GetFolderPath('Desktop'); [Environment]::GetFolderPath('StartMenu'); [Environment]::GetFolderPath('Startup')",
      ],
      { encoding: 'utf8' },
    )
      .trim()
      .split(/\r?\n/);
    if (folders.length !== 3 || folders.some((value) => !value))
      throw new Error('Could not resolve Windows shell folders.');
    const [desktop, startMenu, startup] = folders;
    const shortcuts = [
      join(desktop, 'Agent Workspace.lnk'),
      join(startMenu, 'Programs', 'Agent Workspace.lnk'),
    ];
    const startupShortcut = join(startup, 'Agent Workspace.lnk');
    if ([...shortcuts, startupShortcut].some(existsSync))
      throw new Error('A Workspace shortcut already exists on this runner; refusing to overwrite it.');
    ownedShortcuts = shortcuts;

    run(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        join(packageRoot, 'scripts', 'install-windows.ps1'),
        '-ReleaseDirectory',
        packageRoot,
      ],
      { env },
    );
    installRoot = join(env.LOCALAPPDATA, 'Programs', 'AgentWorkspace');
    const current = readFileSync(join(installRoot, 'current.txt'), 'utf8').trim();
    const installedRoot = assertInside(join(installRoot, 'versions'), current);
    verifyInstalledPayload(installedRoot);
    if (ownedShortcuts.some((path) => !existsSync(path)))
      throw new Error('The Windows installer did not create both expected shortcuts.');
    if (existsSync(startupShortcut))
      throw new Error('The default Windows installation unexpectedly enabled startup on login.');
    report.install = 'passed: copied payload and created desktop/start-menu shortcuts; startup stayed off';
    const signature = run(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-AuthenticodeSignature -LiteralPath '${join(packageRoot, 'scripts', 'install-windows.ps1').replaceAll("'", "''")}').Status.ToString()`,
      ],
      { encoding: 'utf8' },
    ).trim();
    report.trust = { status: signature, note: 'Windows Authenticode publisher trust still requires a signed release.' };
  } else {
    const runtime = join(packageRoot, 'runtime', 'node');
    if ((process.platform === 'darwin' ? 'darwin' : 'linux') !== manifest.platform)
      throw new Error('Unsupported POSIX installer target.');
    run(runtime, [join(packageRoot, 'scripts', 'install-posix.mjs')], { cwd: packageRoot, env });
    const programBase =
      process.platform === 'darwin'
        ? join(fixture, 'Library', 'Application Support', 'AgentWorkspaceProgram')
        : join(fixture, '.local', 'lib', 'agent-workspace');
    installRoot = programBase;
    const installedRoot = realpathSync(readFileSync(join(programBase, 'current.txt'), 'utf8').trim());
    assertInside(programBase, installedRoot);
    const installedNode = verifyInstalledPayload(installedRoot);
    if (process.platform === 'darwin') {
      const app = join(fixture, 'Applications', 'Agent Workspace.app');
      const appExecutable = join(app, 'Contents', 'MacOS', 'AgentWorkspace');
      if (!existsSync(appExecutable) || !readFileSync(appExecutable, 'utf8').includes(installedNode))
        throw new Error('The macOS app wrapper does not launch the installed runtime.');
      const plist = spawnSync('plutil', ['-lint', join(app, 'Contents', 'Info.plist')], { encoding: 'utf8' });
      if (plist.status !== 0) throw new Error('The macOS app Info.plist is invalid: ' + plist.stderr);
      const signature = spawnSync('codesign', ['--verify', '--deep', '--strict', app], { encoding: 'utf8' });
      report.trust = {
        status: signature.status === 0 ? 'signed and valid' : 'unsigned or invalid',
        note: 'Downloaded-app Gatekeeper acceptance and notarization still require a signed release and manual test.',
      };
      ownedShortcuts = [app];
    } else {
      const desktopFile = join(fixture, '.local', 'share', 'applications', 'agent-workspace.desktop');
      const desktopEntry = readFileSync(desktopFile, 'utf8');
      if (!desktopEntry.startsWith('[Desktop Entry]') || !desktopEntry.includes(installedNode))
        throw new Error('The Linux desktop entry does not point to the installed runtime.');
      if ((readFileSync(desktopFile, 'utf8').match(/\nExec=/g) || []).length !== 1)
        throw new Error('The Linux desktop entry has an unexpected Exec field.');
      report.trust = {
        status: 'unsigned',
        note: 'No Linux publisher signature/package metadata is configured; desktop acceptance is distro-specific.',
      };
      ownedShortcuts = [desktopFile];
    }
    report.install = 'passed: installed into disposable HOME and generated the platform launch entry';
  }

  report.launchAndLifecycle = 'covered separately by preview-lifecycle-smoke.mjs';

  for (const shortcut of ownedShortcuts) {
    if (existsSync(shortcut)) rmSync(shortcut, { recursive: true, force: true });
  }
  if (installRoot) removeInside(fixture, installRoot);
  if (!existsSync(join(dataDir, 'keep.txt')))
    throw new Error('Removing application files also removed separate user data.');
  report.removal = 'passed: removed program files and launch entries';
  report.dataPreserved = true;
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = String(error);
  process.exitCode = 1;
} finally {
  // The fixture is generated under a task-specific temp directory; the installed
  // program root and each deletion target are checked to remain inside it.
  for (const shortcut of ownedShortcuts) {
    try {
      if (existsSync(shortcut)) rmSync(shortcut, { recursive: true, force: true });
    } catch {}
  }
  try {
    if (installRoot && existsSync(installRoot)) removeInside(fixture, installRoot);
  } catch {}
  try {
    if (existsSync(fixture)) removeInside(tempRoot, fixture);
  } catch {}
  console.log(JSON.stringify(report, null, 2));
}
