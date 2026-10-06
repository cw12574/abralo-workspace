// Exercise the shipped CLI with fixture downloads and intercepted child processes.
// No network, real installer, provider call or existing user profile is used.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import * as stream from 'node:stream';
import * as promises from 'node:stream/promises';
import { SourceTextModule, SyntheticModule, createContext } from 'node:vm';
import { pathToFileURL } from 'node:url';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'abralo-npm-check-')));
const version = JSON.parse(fs.readFileSync('installer/package.json')).version;
const source = fs.readFileSync('installer/bin/abralo.mjs', 'utf8').replace(
  'main().catch((error) => {', 'globalThis.completed = main().catch((error) => {',
);
const bytes = Buffer.from('fixture archive; extraction is intercepted');
const digest = crypto.createHash('sha256').update(bytes).digest('hex');
const targets = { 'win32:x64': 'windows-x64', 'darwin:x64': 'macos-x64', 'darwin:arm64': 'macos-arm64', 'linux:x64': 'linux-x64' };
let count = 0;

async function check(name, options = {}) {
  const fixture = fs.mkdtempSync(path.join(root, 'case-'));
  const platform = options.platform || 'win32', arch = options.arch || 'x64';
  const archive = `abralo-${targets[`${platform}:${arch}`]}.tar.gz`;
  fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ version }));
  fs.writeFileSync(path.join(fixture, 'releases.json'), JSON.stringify({ [version]: options.noHash ? {} : { [archive]: options.badHash ? '0'.repeat(64) : digest } }));
  const calls = [], messages = [], requests = [];
  const processFixture = { argv: ['node', 'abralo', ...(options.args || [])], platform, arch, exitCode: 0 };
  const child = {
    spawnSync(command, args) {
      calls.push({ command, args });
      if (command === 'tar') {
        if (options.extractFailure) return { status: 1, stderr: 'fixture extraction error' };
        const destination = args[args.indexOf('-C') + 1];
        fs.writeFileSync(path.join(destination, 'release.json'), JSON.stringify({ version: options.wrongVersion ? '0.0.0' : version, platform: options.wrongPlatform ? 'unknown' : platform, arch }));
        fs.writeFileSync(path.join(destination, 'native-fixture'), Buffer.from('7f454c46', 'hex'), { mode: 0o644 });
        fs.writeFileSync(path.join(destination, 'text-fixture'), 'ordinary data', { mode: 0o644 });
      } else if (platform !== 'win32' && process.platform !== 'win32') {
        const destination = path.dirname(path.dirname(command));
        assert.ok(fs.statSync(path.join(destination, 'native-fixture')).mode & 0o111);
        assert.equal(fs.statSync(path.join(destination, 'text-fixture')).mode & 0o111, 0);
      }
      return { status: command === 'tar' ? 0 : (options.installFailure ? 7 : 0) };
    },
  };
  const context = createContext({
    process: processFixture, URL, Buffer,
    console: { log: (...args) => messages.push(args.join(' ')), error: (...args) => messages.push(args.join(' ')) },
    fetch: async (url) => {
      requests.push(url);
      if (options.httpFailure) return new Response('fixture failure', { status: 503 });
      assert.equal(url, `https://github.com/cw12574/abralo-workspace/releases/download/v${version}/${archive}`);
      return new Response(bytes);
    },
  });
  const modules = {
    'node:fs': fs, 'node:path': path, 'node:os': { tmpdir: () => fixture },
    'node:crypto': crypto, 'node:stream': stream, 'node:stream/promises': promises,
    'node:child_process': child,
  };
  const module = new SourceTextModule(source, {
    context,
    initializeImportMeta(meta) { meta.url = pathToFileURL(path.join(fixture, 'bin/abralo.mjs')).href; },
  });
  await module.link((specifier) => {
    const exports = modules[specifier];
    assert.ok(exports, `Unexpected import ${specifier}`);
    return new SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context });
  });
  await module.evaluate();
  await context.completed;
  assert.equal(processFixture.exitCode, options.exit ?? 0, messages.join('\n'));
  if (options.match) assert.match(messages.join('\n'), options.match);
  if (options.calls !== undefined) assert.equal(calls.length, options.calls);
  if (options.offline) assert.equal(requests.length, 0);
  if (options.success) {
    assert.equal(calls.length, 2);
    assert.match(messages.join('\n'), /Installation complete/);
    if (platform === 'win32') {
      assert.equal(calls[1].command, 'powershell.exe');
      assert.deepEqual(Array.from(calls[1].args).slice(0, 3), ['-NoProfile', '-ExecutionPolicy', 'Bypass']);
    } else assert.ok(calls[1].command.endsWith(path.join('runtime', 'node')));
  }
  assert.equal(fs.readdirSync(fixture).filter(x => x.startsWith('abralo-install-')).length, 0, 'Scratch downloads must be removed');
  count++;
  console.log(`PASS ${name}`);
}

try {
  await check('help is offline', { args: ['--help'], offline: true, calls: 0, match: /Usage:/ });
  await check('version is offline', { args: ['--version'], offline: true, calls: 0, match: new RegExp(version) });
  await check('unknown argument', { args: ['--unknown'], offline: true, calls: 0, exit: 1, match: /Unknown option/ });
  await check('unsupported architecture', { arch: 'arm64', offline: true, calls: 0, exit: 1, match: /No preview package/ });
  for (const target of Object.keys(targets)) {
    const [platform, arch] = target.split(':');
    await check(`install ${target}`, { platform, arch, success: true });
  }
  await check('download failure', { httpFailure: true, calls: 0, exit: 1, match: /Download failed/ });
  await check('missing pinned hash', { noHash: true, calls: 0, exit: 1, match: /no pinned SHA-256/ });
  await check('tampered archive never extracted', { badHash: true, calls: 0, exit: 1, match: /SHA-256 mismatch/ });
  await check('extraction failure never installed', { extractFailure: true, calls: 1, exit: 1, match: /extraction error/ });
  await check('wrong archive version never installed', { wrongVersion: true, calls: 1, exit: 1, match: /version mismatch/ });
  await check('wrong platform never installed', { wrongPlatform: true, calls: 1, exit: 1, match: /target mismatch/ });
  await check('installer failure is propagated', { installFailure: true, calls: 2, exit: 7 });
  console.log(`${count} npm installer checks passed; no real downloads or installs.`);
} finally {
  const resolved = fs.realpathSync(root);
  assert.ok(path.basename(resolved).startsWith('abralo-npm-check-'));
  assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
  fs.rmSync(resolved, { recursive: true, force: true });
}
