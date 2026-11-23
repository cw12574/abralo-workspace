import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../apps/service/src/store.js';
import { ModelCatalogue, RECOMMENDED_MODEL } from '../apps/service/src/model-catalogue.js';
import { Supervisor } from '../apps/service/src/supervisor.js';
import { ProviderUpdates, newerVersion } from '../apps/service/src/provider-updates.js';
import { CodexAdapter } from '../apps/service/src/adapters/codex.js';
import { createApp } from '../apps/service/src/app.js';
import type { ProviderInfo } from '../packages/contracts/src/index.js';

function setup() {
  const s = new Store(mkdtempSync(join(tmpdir(), 'abralo-models-')));
  const owner = s.createOwner('Morgan');
  let at = 1000;
  let info: ProviderInfo = { harness: 'codex', installed: true, authenticated: true, version: '1.0.0', detail: 'Connected', accountKey: 'account-a', models: [{ id: 'a', name: 'A', isDefault: true }] };
  const adapter = { info: vi.fn(async () => structuredClone(info)), dispose: vi.fn(async () => {}), run: vi.fn() };
  const unavailable = { ...adapter, info: vi.fn(async () => ({ ...info, harness: 'claude' as const, installed: false, authenticated: false, models: [] })) };
  const adapters = { codex: adapter, claude: unavailable, opencode: unavailable };
  const catalogue = new ModelCatalogue(s, () => adapters, () => at);
  return { s, owner, catalogue, adapter, adapters, setInfo: (value: Partial<ProviderInfo>) => { info = { ...info, ...value }; }, advance: () => { at += 7 * 3600000; } };
}

describe('Model catalogue', () => {
  it('shares in-flight discovery, returns the cache immediately and stays quiet on first connection', async () => {
    const f = setup();
    let release!: (value: ProviderInfo) => void;
    f.adapter.info.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const first = f.catalogue.refresh('codex');
    expect(f.catalogue.refresh('codex')).toBe(first);
    const result = await f.catalogue.infos();
    expect(result.find(p => p.harness === 'codex')?.models).toEqual([]);
    expect(f.adapter.info).toHaveBeenCalledTimes(1);
    release({ harness: 'codex', installed: true, authenticated: true, version: '1', detail: '', accountKey: 'a', models: [{ id: 'a', name: 'A' }] });
    await first;
    await f.catalogue.refreshDue();
    expect(f.adapter.info).toHaveBeenCalledTimes(1);
    expect(f.catalogue.status(f.owner.id).notices).toEqual([]);
    await f.catalogue.close(); f.s.close();
  });
  it('announces additions once across restart, preserves dismissals, ignores renames and reappearing models', async () => {
    const f = setup(); await f.catalogue.refresh('codex');
    f.setInfo({ models: [{ id: 'a', name: 'Renamed A' }, { id: 'b', name: 'B' }] });
    await f.catalogue.refresh('codex', true);
    const notices = f.catalogue.status(f.owner.id).notices;
    expect(notices[0].models.map(m => m.id)).toEqual(['b']);
    f.catalogue.dismiss(f.owner.id, [notices[0].id]);
    const resumed = new ModelCatalogue(f.s, () => f.adapters, () => 2000);
    expect(resumed.status(f.owner.id).notices).toEqual([]);
    f.setInfo({ models: [{ id: 'a', name: 'A' }] }); await resumed.refresh('codex', true);
    f.setInfo({ models: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B again' }] }); await resumed.refresh('codex', true);
    expect(resumed.status(f.owner.id).notices).toEqual([]);
    f.setInfo({ accountKey: 'other', models: [{ id: 'c', name: 'C' }] }); await resumed.refresh('codex', true);
    expect(resumed.status(f.owner.id).notices).toEqual([]);
    await resumed.close(); await f.catalogue.close(); f.s.close();
  });
  it('keeps useful cached models on failure, backs off, clears disconnected accounts and preserves pinned choices', async () => {
    const f = setup(); await f.catalogue.refresh('codex');
    f.adapter.info.mockRejectedValueOnce(new Error('Offline'));
    f.advance(); await f.catalogue.refresh('codex');
    expect(f.catalogue.snapshot()[0].models?.[0].id).toBe('a');
    expect(f.catalogue.snapshot()[0].catalogueError).toBeTruthy();
    await f.catalogue.refresh('codex'); expect(f.adapter.info).toHaveBeenCalledTimes(2);
    expect(await f.catalogue.resolve('codex', 'pinned-old')).toBe('pinned-old');
    expect(await f.catalogue.resolve('codex', RECOMMENDED_MODEL)).toBe('a');
    f.setInfo({ models: [{ id: 'b', name: 'B', isDefault: true }] }); await f.catalogue.refresh('codex', true);
    expect(await f.catalogue.resolve('codex', RECOMMENDED_MODEL)).toBe('b');
    expect(await f.catalogue.resolve('codex', 'a')).toBe('a');
    f.setInfo({ authenticated: false, models: [] }); await f.catalogue.refresh('codex', true);
    expect(f.catalogue.snapshot()[0].models).toEqual([]);
    await expect(f.catalogue.resolve('codex', RECOMMENDED_MODEL)).rejects.toThrow('Reconnect');
    await f.catalogue.close(); f.s.close();
  });
  it('merges aliases without losing the recommendation or showing duplicates', async () => {
    const f = setup();
    f.catalogue.accept('codex', { harness: 'codex', installed: true, authenticated: true, version: '', detail: '', models: [
      { id: 'canonical', name: 'Default', isDefault: true, aliases: ['default'] },
      { id: 'canonical', name: 'Current model', aliases: ['family'] },
    ] });
    expect(f.catalogue.snapshot()[0].models).toHaveLength(1);
    expect(f.catalogue.snapshot()[0].models?.[0].aliases).toEqual(['default', 'family']);
    expect(await f.catalogue.resolve('codex', RECOMMENDED_MODEL)).toBe('canonical');
    await f.catalogue.close(); f.s.close();
  });
  it('keeps quota checks independently cached without fetching the model catalogue', async () => {
    const adapter = new CodexAdapter();
    adapter.start = async () => {};
    adapter.request = vi.fn(async () => ({ remaining: 75 }));
    const [first, second] = await Promise.all([adapter.readLimits(), adapter.readLimits()]);
    expect(first).toEqual(second);
    expect(await adapter.readLimits()).toEqual(first);
    expect(adapter.request).toHaveBeenCalledTimes(1);
    expect(adapter.request).toHaveBeenCalledWith('account/rateLimits/read', {}, 15000);
  });
  it('paginates Codex discovery using wire ids, defaults and upgrade metadata', async () => {
    const adapter = new CodexAdapter();
    adapter.request = vi.fn(async (_method, params) => params.cursor ? {
      data: [{ id: 'ui-b', model: 'b', displayName: 'B', isDefault: true }], nextCursor: null,
    } : { data: [{ id: 'ui-a', model: 'a', displayName: 'A', upgrade: 'b' }, { id: 'hidden', hidden: true }], nextCursor: 'next' });
    expect(await adapter.models()).toEqual([{ id: 'a', name: 'A', isDefault: false, upgrade: 'b' }, { id: 'b', name: 'B', isDefault: true, upgrade: undefined }]);
    expect(adapter.request).toHaveBeenCalledTimes(2);
  });
});

describe('Provider runtime updates', () => {
  function runtimeSetup() {
    const f = setup();
    const sup = new Supervisor(f.s);
    sup.adapters = f.adapters;
    sup.catalogue = f.catalogue;
    const next = { ...f.adapter, info: vi.fn(async () => ({ harness: 'codex' as const, installed: true, authenticated: true, version: '2.0.0', detail: '', accountKey: 'account-a', models: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B', isDefault: true }] })), dispose: vi.fn(async () => {}) };
    const install = vi.fn(async () => ({ root: join(f.s.dir, 'staged'), version: '2.0.0' }));
    const latest = vi.fn(async () => '2.0.0');
    const updater = new ProviderUpdates(sup, { latest, install, version: async () => '1.0.0', binary: () => ({ command: 'fixture', args: [] }), adapter: () => next });
    return { ...f, sup, next, updater, latest, install };
  }
  it('stages once, waits for work to finish, verifies before switching and checks only daily', async () => {
    const f = runtimeSetup(); await f.catalogue.refresh('codex');
    f.sup.active.set('working', new AbortController());
    await f.updater.tick();
    expect(f.install).toHaveBeenCalledTimes(1); expect(f.next.info).not.toHaveBeenCalled();
    expect(f.sup.adapters.codex).toBe(f.adapter);
    await f.updater.tick(); expect(f.install).toHaveBeenCalledTimes(1);
    f.sup.active.clear(); await f.updater.tick();
    expect(f.next.info).toHaveBeenCalledTimes(1);
    expect(f.sup.adapters.codex).toBe(f.next);
    expect(f.adapter.dispose).toHaveBeenCalledOnce();
    expect(f.sup.providerActivating).toBe(false);
    await f.updater.tick(); expect(f.latest).toHaveBeenCalledTimes(1);
    await f.updater.close(); await f.catalogue.close(); f.s.close();
  });
  it('retains the working runtime when a candidate fails and respects update opt-out', async () => {
    const f = runtimeSetup(); await f.catalogue.refresh('codex');
    f.next.info.mockRejectedValueOnce(new Error('Incompatible protocol'));
    await f.updater.tick();
    expect(f.sup.adapters.codex).toBe(f.adapter); expect(f.adapter.dispose).not.toHaveBeenCalled();
    expect(f.next.dispose).toHaveBeenCalledOnce();
    expect(f.updater.status().providers[0].error).toContain('Incompatible');
    expect(f.sup.providerActivating).toBe(false);
    await f.updater.tick();
    expect(f.next.info).toHaveBeenCalledTimes(1);
    expect(f.install).toHaveBeenCalledTimes(1);
    f.s.set('models.autoUpdate', false); await f.updater.tick();
    expect(f.install).toHaveBeenCalledTimes(1);
    f.s.set('models.autoUpdate', true);
    f.updater.state.codex!.retryAt = 0;
    await f.updater.tick();
    expect(f.sup.adapters.codex).toBe(f.next);
    expect(f.install).toHaveBeenCalledTimes(1);
    expect(f.next.info).toHaveBeenCalledTimes(2);
    await f.updater.close(); await f.catalogue.close(); f.s.close();
  });
  it('compares release versions numerically without downgrading or accepting prereleases', () => {
    expect(newerVersion('0.167.0', '0.99.1')).toBe(true);
    expect(newerVersion('0.99.1', '0.167.0')).toBe(false);
    expect(newerVersion('1.1.1', '1.1.1')).toBe(false);
    expect(newerVersion('1.2.0-beta', '1.1.1')).toBe(false);
  });
});

it('protects model settings, persists owner notification choices and dismisses exact notice identities', async () => {
  const f = setup();
  const sup = new Supervisor(f.s); sup.adapters = f.adapters; sup.catalogue = f.catalogue;
  const { app } = await createApp(f.s, { supervisor: sup });
  const headers = { cookie: 'workspace=' + f.s.newSession(f.owner.id), 'x-workspace-request': '1' };
  try {
    await f.catalogue.refresh('codex');
    f.setInfo({ models: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] }); await f.catalogue.refresh('codex', true);
    const status = (await app.inject({ url: '/api/models', headers })).json();
    expect(status.notices).toHaveLength(1);
    expect((await app.inject({ method: 'PUT', url: '/api/models/preferences', headers, payload: { notifications: false, autoUpdate: false } })).statusCode).toBe(200);
    expect(f.s.setting('models.notifications.' + f.owner.id)).toBe(false);
    expect(f.s.setting('models.autoUpdate')).toBe(false);
    await app.inject({ method: 'POST', url: '/api/models/dismiss', headers, payload: { ids: ['stale-notice'] } });
    expect(f.catalogue.status(f.owner.id).notices).toHaveLength(1);
    await app.inject({ method: 'POST', url: '/api/models/dismiss', headers, payload: { ids: [status.notices[0].id] } });
    expect(f.catalogue.status(f.owner.id).notices).toEqual([]);
    const member = f.s.createOwner('Member'); f.s.run("UPDATE humans SET role='member' WHERE id=?", member.id);
    const forbidden = await app.inject({ url: '/api/models', headers: { cookie: 'workspace=' + f.s.newSession(member.id) } });
    expect(forbidden.statusCode).toBe(403);
  } finally { await app.close(); }
}, 30000);
