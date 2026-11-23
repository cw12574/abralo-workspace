import type { Adapter, Harness, ProviderInfo } from '../../../packages/contracts/src/index.js';
import { executable } from '../../../packages/host/src/index.js';
import { Store, uid } from './store.js';

export const RECOMMENDED_MODEL = '@recommended';
const HOURS = 6 * 60 * 60 * 1000;
const RETRY = 15 * 60 * 1000;
const harnesses: Harness[] = ['codex', 'claude', 'opencode'];
type Entry = { info: ProviderInfo; nextCheck: number; seen: Record<string, string[]>; notice?: { id: string; models: { id: string; name: string }[]; at: number } };

/** One persisted cache and one in-flight request per native provider, shared by every tab. */
export class ModelCatalogue {
  pending = new Map<string, Promise<void>>();
  entries: Partial<Record<Harness, Entry>>;
  closed = false;
  paused = false;
  constructor(public store: Store, private adapters: () => Record<string, Adapter>, private clock = Date.now, private prepare?: (harness: Harness) => Promise<boolean>) {
    this.entries = store.setting('models.catalogue.v1', {});
  }
  private publish() {
    if (this.closed || !this.store.db.open) return;
    this.store.set('models.catalogue.v1', this.entries);
    for (const owner of this.store.all("SELECT id FROM humans WHERE role='owner'"))
      this.store.emit('models.changed', null, {}, owner.id);
  }
  snapshot(): ProviderInfo[] {
    return harnesses.map(harness => this.entries[harness]?.info || {
      harness, installed: !!executable(harness), authenticated: null, version: '',
      detail: 'Checking connection in the background.', models: [],
    });
  }
  async infos(check?: string) {
    if (check && harnesses.includes(check as Harness)) await this.refresh(check as Harness, true);
    else void this.refreshDue();
    return this.snapshot();
  }
  async refreshDue(force = false) {
    for (const harness of harnesses) {
      if (this.closed) return;
      // Do not boot an unused multi-provider server just to fill an empty menu.
      if (harness === 'opencode' && !this.entries.opencode && !(this.adapters().opencode as any)?.child &&
          !this.store.one("SELECT id FROM employees WHERE json_extract(data,'$.harness')='opencode' LIMIT 1")) continue;
      await this.refresh(harness, force);
    }
  }
  refresh(harness: Harness, force = false): Promise<void> {
    if (this.closed || this.paused) return Promise.resolve();
    const pending = this.pending.get(harness);
    if (pending) return pending;
    if (!force && (this.entries[harness]?.nextCheck || 0) > this.clock()) return Promise.resolve();
    const work = this.fetch(harness).finally(() => this.pending.delete(harness));
    this.pending.set(harness, work);
    return work;
  }
  private async fetch(harness: Harness) {
    const previous = this.entries[harness];
    let info: ProviderInfo;
    try {
      if (this.prepare && !await this.prepare(harness)) {
        if (previous) previous.nextCheck = this.clock() + RETRY;
        return;
      }
      info = await this.adapters()[harness].info();
    }
    catch { info = { ...(previous?.info || this.snapshot().find(p => p.harness === harness)!), catalogueError: 'Could not check models. We will retry automatically.' }; }
    this.accept(harness, info);
  }
  accept(harness: Harness, info: ProviderInfo) {
    if (this.closed) return;
    const previous = this.entries[harness];
    if (info.models) {
      const unique = new Map<string, NonNullable<ProviderInfo['models']>[number]>();
      for (const model of info.models) {
        const prior = unique.get(model.id);
        unique.set(model.id, { ...prior, ...model,
          isDefault: !!(prior?.isDefault || model.isDefault),
          aliases: [...new Set([...(prior?.aliases || []), ...(model.aliases || [])])],
        });
      }
      info = { ...info, models: [...unique.values()] };
    }
    const at = this.clock();
    const success = info.installed && info.authenticated === true && !!info.models?.length && !info.catalogueError;
    const sameAccount = !previous?.info.accountKey || !info.accountKey || previous.info.accountKey === info.accountKey;
    if (!success && info.authenticated !== false && sameAccount && previous?.info.models?.length)
      info = { ...info, models: previous.info.models, checkedAt: previous.info.checkedAt,
        catalogueError: info.catalogueError || 'Could not refresh models. Showing the last saved list.' };
    if (info.authenticated === false || !info.installed) info = { ...info, models: [] };
    const entry: Entry = {
      info: { ...info, ...(success ? { checkedAt: at } : {}) },
      nextCheck: at + (success || !info.installed ? HOURS : RETRY),
      seen: previous?.seen || {},
      notice: sameAccount && info.authenticated !== false ? previous?.notice : undefined,
    };
    if (success) {
      const key = info.accountKey || 'native';
      const known = entry.seen[key];
      const models = info.models!.filter(m => m.id && m.id !== RECOMMENDED_MODEL);
      const added = known ? models.filter(m => !known.includes(m.id)) : [];
      // Initial connection is a baseline. Returning/renamed models are not new releases.
      entry.seen[key] = [...new Set([...(known || []), ...models.map(m => m.id)])].slice(-5000);
      if (added.length) entry.notice = { id: uid(), at, models: [...new Map([...(entry.notice?.models || []), ...added].map(m => [m.id, { id: m.id, name: m.name }])).values()] };
      if (entry.notice) {
        entry.notice.models = entry.notice.models.filter(m => models.some(current => current.id === m.id));
        if (!entry.notice.models.length) entry.notice = undefined;
      }
    }
    this.entries[harness] = entry;
    this.publish();
  }
  status(userId: string) {
    const dismissed = this.store.setting('models.dismissed.' + userId, []) as string[];
    return {
      providers: this.snapshot().map(p => ({ harness: p.harness, checkedAt: p.checkedAt, error: p.catalogueError, checking: this.pending.has(p.harness) })),
      notices: harnesses.flatMap(harness => {
        const notice = this.entries[harness]?.notice;
        return notice && !dismissed.includes(notice.id) ? [{ ...notice, harness }] : [];
      }),
      selectionIssues: this.store.all('SELECT id FROM employees').flatMap(row => {
        const employee = this.store.employee(row.id);
        if (!employee || !this.store.canUseEmployee(userId, employee.id) || !employee.model || employee.model === RECOMMENDED_MODEL) return [];
        const info = this.entries[employee.harness]?.info;
        return info?.authenticated && info.checkedAt && !info.catalogueError && !info.models?.some(m => m.id === employee.model || m.aliases?.includes(employee.model))
          ? [{ employee: employee.name, model: employee.model }] : [];
      }),
      notifications: this.store.setting('models.notifications.' + userId, true),
    };
  }
  dismiss(userId: string, ids: string[]) {
    const current = this.status(userId).notices.map(n => n.id);
    const prior = this.store.setting('models.dismissed.' + userId, []) as string[];
    this.store.set('models.dismissed.' + userId, [...new Set([...prior, ...ids.filter(id => current.includes(id))])].slice(-100));
    this.store.emit('models.changed', null, {}, userId);
  }
  async resolve(harness: Harness, model: string) {
    if (model !== RECOMMENDED_MODEL) return model;
    const entry = this.entries[harness];
    if (!entry || entry.nextCheck <= this.clock()) await this.refresh(harness);
    const info = this.entries[harness]?.info;
    if (info?.authenticated === false) throw new Error('Reconnect this provider before following its recommended model.');
    const recommendations = info?.models?.filter(m => m.isDefault) || [];
    const recommended = recommendations.length === 1 ? recommendations[0] : undefined;
    if (!recommended) throw new Error('This provider has not supplied a recommended model. Choose a model in employee settings.');
    return recommended.id;
  }
  async close() { this.closed = true; await Promise.allSettled(this.pending.values()); }
}
