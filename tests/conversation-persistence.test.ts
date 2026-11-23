import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  ConversationCache,
  type HistoryData,
  type ConversationView,
} from '../apps/web/src/conversation-cache';
import type {
  ConversationStorage,
  StoredView,
  StoredDraft,
} from '../apps/web/src/conversation-storage';

const view = { id: 'conversation', employeeId: 'agent' };
const data = (text: string, cursor = 10): HistoryData => ({
  cursor,
  messages: [
    {
      id: 'message',
      conversationId: view.id,
      threadId: null,
      authorId: 'agent',
      authorName: 'Assistant',
      kind: 'agent',
      text,
      attachments: [],
      createdAt: '2026-11-03T10:00:00Z',
      seq: 1,
      runId: 'run',
    },
  ],
  runs: [],
  decisions: [],
  attachments: [],
});
const saved = (): StoredView => ({
  view,
  data: data('Cached reply'),
  updatedAt: Date.now(),
  expanded: [JSON.stringify(['message', 'tool'])],
  viewport: { following: false, offset: 300, width: 900, height: 600, measurements: [] },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
class Storage implements ConversationStorage {
  views = new Map<string, StoredView[]>();
  drafts = new Map<string, StoredDraft[]>();
  async load(scope: string) {
    return {
      views: structuredClone(this.views.get(scope) || []),
      drafts: structuredClone(this.drafts.get(scope) || []),
    };
  }
  async save(scope: string, value: StoredView) {
    this.views.set(scope, [structuredClone(value)]);
  }
  async draft(scope: string, _view: ConversationView, value?: StoredDraft) {
    this.drafts.set(scope, value ? [structuredClone(value)] : []);
  }
  async purge(scope: string, allowed?: string[], employees?: string[]) {
    const keep = (row: { view: ConversationView }) =>
      !!allowed?.includes(row.view.id) &&
      (!row.view.employeeId || !employees || employees.includes(row.view.employeeId));
    this.views.set(scope, (this.views.get(scope) || []).filter(keep));
    this.drafts.set(scope, (this.drafts.get(scope) || []).filter(keep));
  }
}
const caches: ConversationCache[] = [];
function cache(fetcher: any, storage: ConversationStorage) {
  const c = new ConversationCache(fetcher, 8, 16 * 1024 * 1024, storage);
  caches.push(c);
  return c;
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  caches.forEach((c) => c.clear());
  caches.length = 0;
  vi.useRealTimers();
});

it('restores recent content, reading position and expanded steps before background refresh finishes', async () => {
  const disk = new Storage();
  disk.views.set('account', [saved()]);
  const fetch = deferred<HistoryData>();
  const c = cache(
    vi.fn(() => fetch.promise),
    disk,
  );
  c.setScope('account', [view.id], ['agent']);
  await c.ready();
  expect(c.read(view).data?.messages[0].text).toBe('Cached reply');
  expect(c.viewport(view)?.offset).toBe(300);
  expect(c.isExpanded('message', 'tool')).toBe(true);
  const pending = c.load(view);
  expect(c.read(view).status).toBe('ready');
  fetch.resolve(data('Current reply', 11));
  await pending;
  expect(c.read(view).data?.messages[0].text).toBe('Current reply');
  expect(c.viewport(view)?.offset).toBe(300);
});

it('never lets a late disk read replace fresh server content', async () => {
  const disk = new Storage(),
    gate = deferred<{ views: StoredView[]; drafts: StoredDraft[] }>();
  disk.load = () => gate.promise;
  const c = cache(vi.fn().mockResolvedValue(data('Fresh reply')), disk);
  c.setScope('account', [view.id]);
  await c.load(view);
  gate.resolve({ views: [saved()], drafts: [] });
  await c.ready();
  expect(c.read(view).data?.messages[0].text).toBe('Fresh reply');
});

it('cannot resurrect cached content after account or membership changes', async () => {
  const disk = new Storage(),
    gate = deferred<{ views: StoredView[]; drafts: StoredDraft[] }>();
  disk.load = () => gate.promise;
  const c = cache(vi.fn(), disk);
  c.setScope('account', [view.id]);
  const first = c.ready();
  await Promise.resolve();
  c.setScope('other', []);
  gate.resolve({ views: [saved()], drafts: [{ view, draft: 'Private draft', files: [] }] });
  await first;
  await c.ready();
  expect(c.read(view).data).toBeNull();
  expect(c.composer(view).draft).toBe('');
});

it('restores unsaved typing independently of disposable snapshots, then removes the local copy after acknowledgement', async () => {
  const disk = new Storage();
  disk.drafts.set('account', [{ view, draft: 'Keep this draft', files: [] }]);
  const fetcher = vi.fn().mockResolvedValue({ ok: true });
  const c = cache(fetcher, disk);
  c.setScope('account', [view.id]);
  await c.ready();
  expect(c.composer(view).draft).toBe('Keep this draft');
  expect(c.read(view).data).toBeNull();
  await c.saveDraft(view);
  expect(fetcher).toHaveBeenCalledWith(
    '/conversations/conversation/draft',
    { text: 'Keep this draft', attachments: [], threadId: '' },
    'PUT',
  );
  expect(disk.drafts.get('account')).toEqual([]);
});

it('keeps a newer local draft when an older server save finishes', async () => {
  const disk = new Storage(),
    gate = deferred<any>();
  const fetcher = vi.fn().mockReturnValue(gate.promise);
  const c = cache(fetcher, disk);
  c.setScope('account', [view.id]);
  await c.ready();
  c.updateComposer(view, 'draft', 'First');
  const pending = c.saveDraft(view);
  c.updateComposer(view, 'draft', 'Newer typing');
  expect(disk.drafts.get('account')?.[0].draft).toBe('Newer typing');
  // Leave the follow-up save pending so we can inspect the acknowledgement boundary.
  fetcher.mockReturnValue(new Promise(() => {}));
  gate.resolve({ ok: true });
  await pending;
  expect(disk.drafts.get('account')?.[0].draft).toBe('Newer typing');
});

it('continues normally if browser storage is unavailable', async () => {
  const disk = new Storage();
  disk.purge = async () => {
    throw new Error('Quota or private mode');
  };
  const c = cache(vi.fn().mockResolvedValue(data('Server result')), disk);
  c.setScope('account', [view.id]);
  await c.ready();
  await c.load(view);
  expect(c.read(view).data?.messages[0].text).toBe('Server result');
});

it('uses the snapshot cursor to reject obsolete replay while retaining genuinely newer updates', async () => {
  const disk = new Storage(),
    gate = deferred<HistoryData>();
  const c = cache(
    vi.fn().mockResolvedValueOnce(data('Initial', 1)).mockReturnValue(gate.promise),
    disk,
  );
  await c.load(view);
  const pending = c.load(view, true);
  c.event({
    type: 'message.updated',
    cursor: 9,
    conversationId: view.id,
    payload: { id: 'message', text: 'Obsolete text' },
  });
  c.event({
    type: 'message.updated',
    cursor: 12,
    conversationId: view.id,
    payload: { id: 'message', text: 'New stream text' },
  });
  gate.resolve(data('Snapshot at ten', 10));
  await pending;
  expect(c.read(view).data?.messages[0].text).toBe('New stream text');
});

it('retains the most recently read historical page across restart', async () => {
  const disk = new Storage();
  disk.views.set('account', [
    { ...saved(), positionAt: 1 },
    { ...saved(), view: { ...view, before: 50 }, positionAt: 2 },
  ]);
  const c = cache(vi.fn(), disk);
  c.setScope('account', [view.id]);
  await c.ready();
  expect(c.historyBefore(view)).toBe(50);
});

it('refetches after a replay gap that arrives during an older request without blanking cached content', async () => {
  const disk = new Storage(),
    gate = deferred<HistoryData>();
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(data('Visible'))
    .mockReturnValueOnce(gate.promise)
    .mockResolvedValue(data('Reconciled', 20));
  const c = cache(fetcher, disk);
  c.setScope('account', [view.id]);
  await c.ready();
  const unsub = c.subscribe(view, () => {});
  await c.load(view);
  const pending = c.load(view, true);
  c.reconnect();
  gate.resolve(data('Outdated request'));
  await pending;
  expect(c.read(view).data?.messages[0].text).toBe('Visible');
  await vi.advanceTimersByTimeAsync(100);
  expect(c.read(view).data?.messages[0].text).toBe('Reconciled');
  unsub();
});

it('persists new snapshots automatically and cancels pending writes after revocation', async () => {
  const disk = new Storage();
  const c = cache(vi.fn().mockResolvedValue(data('New content')), disk);
  c.setScope('account', [view.id]);
  await c.ready();
  await c.load(view);
  await vi.advanceTimersByTimeAsync(1000);
  expect(disk.views.get('account')?.[0].data.messages[0].text).toBe('New content');
  c.saveViewport(view, saved().viewport!);
  c.revoke(view.id);
  await vi.advanceTimersByTimeAsync(1000);
  expect(disk.views.get('account')).toEqual([]);
});
