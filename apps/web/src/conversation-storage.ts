import type { ConversationView, HistoryData, Viewport } from './conversation-cache';

export type StoredView = {
  view: ConversationView;
  data: HistoryData;
  viewport?: Viewport;
  positionAt?: number;
  expanded: string[];
  updatedAt: number;
};
export type StoredDraft = { view: ConversationView; draft: string; files: any[] };
export interface ConversationStorage {
  load(scope: string): Promise<{ views: StoredView[]; drafts: StoredDraft[] }>;
  save(scope: string, value: StoredView): Promise<void>;
  draft(scope: string, view: ConversationView, value?: StoredDraft): Promise<void>;
  purge(scope: string, allowed?: string[], employees?: string[]): Promise<void>;
}

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_VIEW_BYTES = 2 * 1024 * 1024;
const MAX_VIEWS = 8;
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const key = (scope: string, view: ConversationView) =>
  JSON.stringify([scope, view.id, view.threadId || '', view.before || 'latest']);
const request = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
const completion = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error || new Error('Cache transaction failed'));
  });

/** Optional cache. Failure/eviction never prevents authoritative network reads. */
export class IndexedConversationStorage implements ConversationStorage {
  private connection?: Promise<IDBDatabase>;
  private open() {
    if (!this.connection)
      this.connection = new Promise<IDBDatabase>((resolve, reject) => {
        const r = indexedDB.open('abralo-recent-conversations', 1);
        let expired = false;
        const timeout = setTimeout(() => {
          expired = true;
          reject(new Error('Cache unavailable'));
        }, 500);
        r.onupgradeneeded = () => {
          for (const name of ['views', 'metadata', 'drafts'])
            r.result.createObjectStore(name, { keyPath: 'key' });
        };
        r.onsuccess = () => {
          clearTimeout(timeout);
          if (expired) {
            r.result.close();
            return;
          }
          r.result.onversionchange = () => {
            r.result.close();
            this.connection = undefined;
          };
          resolve(r.result);
        };
        r.onerror = () => {
          clearTimeout(timeout);
          reject(r.error);
        };
      });
    return this.connection;
  }
  async load(scope: string) {
    const db = await this.open();
    const tx = db.transaction(['views', 'metadata', 'drafts'], 'readonly');
    const done = completion(tx);
    const views: StoredView[] = [];
    // Metadata is tiny; do not read every snapshot just to enforce an LRU budget.
    const metadata = tx.objectStore('metadata').getAll();
    metadata.onsuccess = () => {
      for (const row of metadata.result)
        if (row.scope === scope && row.updatedAt > Date.now() - MAX_AGE) {
          const r = tx.objectStore('views').get(row.key);
          r.onsuccess = () => {
            if (r.result) views.push(r.result.value);
          };
        }
    };
    const drafts = await request<any[]>(tx.objectStore('drafts').getAll());
    await done;
    return {
      views,
      drafts: drafts.filter((row) => row.scope === scope).map((row) => row.value as StoredDraft),
    };
  }
  async save(scope: string, value: StoredView) {
    const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
    const db = await this.open();
    const tx = db.transaction(['views', 'metadata'], 'readwrite');
    const done = completion(tx);
    const id = key(scope, value.view);
    const views = tx.objectStore('views'),
      metadata = tx.objectStore('metadata');
    if (bytes > MAX_VIEW_BYTES) {
      views.delete(id);
      metadata.delete(id);
    } else {
      views.put({ key: id, value });
      metadata.put({ key: id, scope, view: value.view, bytes, updatedAt: value.updatedAt });
    }
    const all = metadata.getAll();
    all.onsuccess = () => {
      let total = 0,
        count = 0;
      // Global budget across all scopes, not sixteen megabytes per account.
      for (const row of all.result.sort((a, b) => b.updatedAt - a.updatedAt)) {
        total += row.bytes;
        count++;
        if (row.updatedAt < Date.now() - MAX_AGE || total > MAX_BYTES || count > MAX_VIEWS) {
          views.delete(row.key);
          metadata.delete(row.key);
        }
      }
    };
    await done;
  }
  async draft(scope: string, view: ConversationView, value?: StoredDraft) {
    const db = await this.open();
    const tx = db.transaction('drafts', 'readwrite');
    const done = completion(tx);
    const id = key(scope, { ...view, before: null });
    // These are unacknowledged user edits, not disposable LRU entries. Remove
    // each once its durable server save succeeds; never evict unsaved typing.
    if (value) tx.objectStore('drafts').put({ key: id, scope, value });
    else tx.objectStore('drafts').delete(id);
    await done;
  }
  async purge(scope: string, allowed?: string[], employees?: string[]) {
    const db = await this.open();
    const tx = db.transaction(['views', 'metadata', 'drafts'], 'readwrite');
    const done = completion(tx);
    const remove = (row: any, view: ConversationView) =>
      row.scope === scope &&
      (!allowed ||
        !allowed.includes(view.id) ||
        (view.employeeId && employees && !employees.includes(view.employeeId)));
    const metadata = tx.objectStore('metadata').getAll();
    metadata.onsuccess = () => {
      for (const row of metadata.result)
        if (remove(row, row.view)) {
          tx.objectStore('metadata').delete(row.key);
          tx.objectStore('views').delete(row.key);
        }
    };
    const drafts = tx.objectStore('drafts').getAll();
    drafts.onsuccess = () => {
      for (const row of drafts.result)
        if (remove(row, row.value.view)) tx.objectStore('drafts').delete(row.key);
    };
    await done;
  }
}
