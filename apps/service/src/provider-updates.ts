import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statfsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, delimiter } from 'node:path';
import { platform, arch } from 'node:os';
import type { Adapter, Harness, ProviderInfo } from '../../../packages/contracts/src/index.js';
import { executable, execFileAsync, type Executable } from '../../../packages/host/src/index.js';
import { CodexAdapter } from './adapters/codex.js';
import { ClaudeAdapter } from './adapters/claude.js';
import { OpenCodeAdapter } from './adapters/opencode.js';
import type { Supervisor } from './supervisor.js';
import { uid } from './store.js';

const packages: Record<Harness, string> = { codex: '@openai/codex', claude: '@anthropic-ai/claude-code', opencode: 'opencode-ai' };
const DAY = 86400000;
type Release = { version: string; root: string };
type Update = { nextCheck?: number; checkedAt?: number; current?: string; available?: string; active?: Release; previous?: Release; staged?: Release; candidateAttempts?: number; retryAt?: number; rejectedVersion?: string; error?: string };
export function newerVersion(a: string, b: string) {
  if (!/^\d+\.\d+\.\d+$/.test(a) || !/^\d+\.\d+\.\d+$/.test(b)) return false;
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  return x.some((v, i) => v > y[i] && x.slice(0, i).every((n, j) => n === y[j]));
}
function contained(root: string, path: string) {
  const rel = relative(realpathSync(root), realpathSync(path));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}
export function runtimeBinary(root: string, harness: Harness): Executable {
  const suffix = platform() === 'win32' ? '.exe' : '';
  const os = platform() === 'win32' ? 'windows' : platform();
  const candidates = harness === 'codex'
    ? [join(root, 'node_modules/@openai/codex/bin/codex.js')]
    : harness === 'claude'
      ? [join(root, `node_modules/@anthropic-ai/claude-code-${platform()}-${arch()}/claude${suffix}`),
         join(root, `node_modules/@anthropic-ai/claude-code-${platform()}-${arch()}/bin/claude${suffix}`),
         join(root, `node_modules/@anthropic-ai/claude-code/bin/claude${suffix}`),
         join(root, 'node_modules/@anthropic-ai/claude-code/cli.js')]
      : [join(root, `node_modules/opencode-${os}-${arch()}/bin/opencode${suffix}`),
         join(root, `node_modules/opencode-ai/bin/opencode${suffix}`)];
  const path = candidates.find(p => existsSync(p) && contained(root, p));
  if (!path) throw new Error('The downloaded provider does not include a compatible executable for this device.');
  return path.endsWith('.js') ? { command: process.execPath, args: [path] } : { command: path, args: [] };
}
export function newAdapter(harness: Harness, binary?: Executable): Adapter {
  return harness === 'codex' ? new CodexAdapter(binary) : harness === 'claude' ? new ClaudeAdapter(binary) : new OpenCodeAdapter(binary);
}
function npmCLI() {
  const candidates = [
    process.env.npm_execpath || '',
    join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    ...(process.env.PATH || '').split(delimiter).map(p => join(p, 'node_modules/npm/bin/npm-cli.js')),
  ];
  return candidates.find(p => p.endsWith('npm-cli.js') && existsSync(p));
}
export async function installRuntime(harness: Harness, version: string, base: string, signal: AbortSignal): Promise<Release> {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid provider release.');
  const npm = npmCLI();
  if (!npm) throw new Error('Automatic provider updates need npm on this device. Install Node.js with npm, then retry.');
  mkdirSync(base, { recursive: true });
  const disk = statfsSync(base);
  if (disk.bavail * disk.bsize < 1024 ** 3) throw new Error('Provider update is waiting for at least 1 GB of free disk space.');
  const parent = join(base, harness);
  mkdirSync(parent, { recursive: true });
  const stage = join(parent, '.download-' + uid());
  mkdirSync(stage);
  const root = join(parent, version + '-' + uid());
  try {
    // npm verifies registry tarball integrity. No package lifecycle scripts or global installs.
    await execFileAsync(process.execPath, [npm, 'install', '--prefix', stage,
      '--registry=https://registry.npmjs.org', '--ignore-scripts', '--no-audit', '--no-fund',
      '--package-lock=false', '--no-progress', '--loglevel=error', '--cache', join(stage, '.npm-cache'),
      packages[harness] + '@' + version], { windowsHide: true, timeout: 300000, signal, maxBuffer: 1024 * 1024 });
    const pkg = JSON.parse(readFileSync(join(stage, 'node_modules', packages[harness], 'package.json'), 'utf8'));
    if (pkg.version !== version || pkg.name !== packages[harness]) throw new Error('Downloaded provider identity did not match.');
    runtimeBinary(stage, harness);
    const cache = join(stage, '.npm-cache');
    if (existsSync(cache) && contained(stage, cache)) rmSync(cache, { recursive: true, force: true });
    renameSync(stage, root);
    return { version, root };
  } finally {
    if (existsSync(stage) && contained(parent, stage)) rmSync(stage, { recursive: true, force: true });
  }
}

type Dependencies = {
  latest: (harness: Harness, signal: AbortSignal) => Promise<string>;
  install: typeof installRuntime;
  adapter: typeof newAdapter;
  binary: typeof runtimeBinary;
  version: (harness: Harness) => Promise<string>;
};
export class ProviderUpdates {
  state: Partial<Record<Harness, Update>>;
  pending?: Promise<void>;
  closed = false;
  controller = new AbortController();
  base: string;
  deps: Dependencies;
  constructor(public supervisor: Supervisor, dependencies: Partial<Dependencies> = {}) {
    this.base = join(supervisor.store.dir, 'provider-runtimes');
    this.state = supervisor.store.setting('models.runtimes.v1', {});
    this.deps = {
      latest: async (harness, signal) => {
        const response = await fetch('https://registry.npmjs.org/' + encodeURIComponent(packages[harness]) + '/latest',
          { signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
        if (!response.ok) throw new Error('Provider update check is temporarily unavailable.');
        const data = await response.json() as any;
        if (data.name !== packages[harness] || !/^\d+\.\d+\.\d+$/.test(data.version)) throw new Error('Provider release metadata was invalid.');
        return data.version;
      },
      install: installRuntime, adapter: newAdapter,
      binary: (root, harness) => {
        if (!existsSync(this.base) || !contained(this.base, root)) throw new Error('Provider runtime is outside its managed directory.');
        return runtimeBinary(root, harness);
      },
      version: async harness => {
        const bin = (supervisor.adapters[harness] as any).binary || executable(harness);
        if (!bin) return '';
        const r = await execFileAsync(bin.command, [...bin.args, '--version'], { windowsHide: true, timeout: 10000, signal: this.controller.signal });
        return r.stdout.match(/\b\d+\.\d+\.\d+\b/)?.[0] || '';
      },
      ...dependencies,
    };
  }
  restore() {
    for (const harness of Object.keys(this.state) as Harness[]) {
      const state = this.state[harness]!;
      if (!state.active) continue;
      try {
        if (!existsSync(this.base) || !contained(this.base, state.active.root)) throw new Error('Saved provider runtime is unavailable.');
        this.supervisor.adapters[harness] = this.deps.adapter(harness, this.deps.binary(state.active.root, harness));
      } catch { state.error = 'Using the bundled provider because its saved update is unavailable.'; state.active = undefined; }
    }
  }
  status() {
    return { enabled: this.supervisor.store.setting('models.autoUpdate', true),
      checking: !!this.pending, providers: Object.entries(this.state).map(([harness, s]) => ({
        harness, checkedAt: s!.checkedAt, current: s!.current, available: s!.available,
        waitingForIdle: !!s!.staged && !s!.error, error: s!.error,
      })) };
  }
  private save() {
    if (this.closed) return;
    this.supervisor.store.set('models.runtimes.v1', this.state);
    for (const owner of this.supervisor.store.all("SELECT id FROM humans WHERE role='owner'"))
      this.supervisor.store.emit('models.changed', null, {}, owner.id);
  }
  tick(): Promise<void> {
    if (this.closed || !this.supervisor.store.setting('models.autoUpdate', true)) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = this.check().finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async check() {
    for (const info of this.supervisor.catalogue.snapshot()) {
      if (this.closed || !this.supervisor.store.setting('models.autoUpdate', true)) return;
      if (!info.installed || info.authenticated !== true) continue;
      const harness = info.harness;
      const state = this.state[harness] ||= {};
      try {
        if (state.staged) {
          if ((state.retryAt || 0) <= Date.now()) await this.activate(harness, state);
          continue;
        }
        if ((state.nextCheck || 0) > Date.now()) continue;
        state.checkedAt = Date.now(); state.nextCheck = Date.now() + DAY;
        this.save();
        state.current = await this.deps.version(harness);
        state.available = await this.deps.latest(harness, this.controller.signal);
        if (state.available !== state.rejectedVersion) state.error = undefined;
        if (state.current && state.available !== state.rejectedVersion && newerVersion(state.available, state.current)) {
          state.staged = await this.deps.install(harness, state.available, this.base, this.controller.signal);
          state.candidateAttempts = 0; state.retryAt = undefined;
          this.save();
          await this.activate(harness, state);
        }
      } catch (error) {
        if (this.closed) return;
        state.error = error instanceof Error ? error.message.slice(0, 350) : 'Provider update failed. Your current version is still available.';
        state.nextCheck = Date.now() + 6 * 3600000;
        if (state.staged) {
          state.candidateAttempts = (state.candidateAttempts || 0) + 1;
          state.retryAt = state.nextCheck;
          if (state.candidateAttempts >= 3) {
            state.rejectedVersion = state.staged.version;
            state.staged = undefined;
            try { this.cleanup(harness, state); } catch {}
          }
        }
      }
      this.save();
    }
  }
  async activate(harness: Harness, state: Update) {
    const s = this.supervisor;
    if (!state.staged || this.closed || s.closing || s.maintenance || s.active.size || s.inflight.size || s.catalogue.pending.size || s.providerActivating) return;
    if (!s.store.setting('models.autoUpdate', true)) return;
    s.providerActivating = true;
    s.catalogue.paused = true;
    const old = s.adapters[harness];
    let candidate: Adapter | undefined;
    let verified: ProviderInfo | undefined;
    try {
      candidate = this.deps.adapter(harness, this.deps.binary(state.staged.root, harness));
      const info = await candidate.info();
      verified = info;
      if (!info.installed || info.authenticated !== true || !info.models?.length || info.catalogueError)
        throw new Error('The provider update did not pass its connection and model-list checks. Your previous version is still in use.');
      if (this.closed || s.closing || !s.store.setting('models.autoUpdate', true)) return;
      await old.dispose?.();
      s.adapters[harness] = candidate;
      candidate = undefined;
      state.previous = state.active;
      state.active = state.staged; state.staged = undefined; state.current = state.active.version; state.error = undefined; state.rejectedVersion = undefined; state.candidateAttempts = 0; state.retryAt = undefined;
      this.save();
      try { this.cleanup(harness, state); } catch { /* keep the verified update; cleanup can retry later */ }
    } finally {
      try { await candidate?.dispose?.(); }
      finally { s.catalogue.paused = false; s.providerActivating = false; }
    }
    if (verified) s.catalogue.accept(harness, verified);
  }
  private cleanup(harness: Harness, state: Update) {
    const parent = join(this.base, harness);
    if (!existsSync(parent)) return;
    const retained = new Set([state.active?.root, state.previous?.root, state.staged?.root].filter(Boolean).map(p => resolve(p!)));
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^(?:\d+\.\d+\.\d+|\.download)-[a-f0-9-]{36}$/.test(entry.name)) continue;
      const path = join(parent, entry.name);
      if (retained.has(resolve(path))) continue;
      // Only this manager's checked descendants; keep active and rollback versions.
      try { if (contained(parent, path)) rmSync(path, { recursive: true, force: true }); } catch { /* retry at the next successful update */ }
    }
  }
  retryChecks() {
    for (const state of Object.values(this.state)) {
      state!.nextCheck = 0; state!.retryAt = 0; state!.rejectedVersion = undefined; state!.candidateAttempts = 0;
    }
    this.save();
    return this.tick();
  }
  async close() {
    this.closed = true;
    this.controller.abort();
    await this.pending?.catch(() => {});
  }
}
