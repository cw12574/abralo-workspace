import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationCache, type HistoryData } from '../apps/web/src/conversation-cache';
import type { Message } from '../packages/contracts/src/index';

const view = { id: 'a', employeeId: 'agent-a' };
const message = (text = 'Hello'): Message => ({
  id: 'm',
  conversationId: 'a',
  threadId: null,
  authorId: 'agent-a',
  authorName: 'Agent',
  kind: 'agent',
  text,
  attachments: [],
  createdAt: '2026-09-28T13:00:00Z',
  seq: 1,
  runId: 'r',
});
const data = (text = 'Hello'): HistoryData => ({
  messages: [message(text)],
  runs: [{ id: 'r', employee_id: 'agent-a', state: 'running' }],
  decisions: [],
  attachments: [],
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: any) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const delta = (offset: number, text: string) => ({
  type: 'message.updated',
  conversationId: 'a',
  createdAt: '2026-09-28T13:01:00Z',
  payload: { id: 'm', runId: 'r', offset, delta: text },
});
afterEach(() => vi.useRealTimers());

describe('recent conversation cache', () => {
  it('retains text and image references after leaving tool history larger than the entire budget', async () => {
    const huge = {
      id: 'step',
      type: 'tool',
      title: 'Read files',
      time: '2026-09-28T13:00:00Z',
      detail: 'x'.repeat(10 * 1024 * 1024),
    };
    const payload = {
      ...data(),
      messages: [{ ...message(), attachments: ['image'], activity: [huge] }],
      attachments: [{ id: 'image', name: 'Image.png', mime: 'image/png', size: 30 * 1024 * 1024 }],
    };
    const fetcher = vi.fn().mockResolvedValue(payload);
    const cache = new ConversationCache(fetcher);
    const leave = cache.subscribe(view, () => {});
    await cache.load(view);
    leave();
    await cache.load({ id: 'b' });
    expect(cache.read(view).data?.messages[0]).toMatchObject({
      text: 'Hello',
      attachments: ['image'],
      activity: [{ id: 'step', hasDetail: true }],
    });
    expect(cache.read(view).data?.messages[0].activity?.[0].detail).toBeUndefined();
    expect(cache.stats().bytes).toBeLessThan(10000);
    expect(payload.messages[0].activity[0].detail).toHaveLength(10 * 1024 * 1024);
    expect(fetcher.mock.calls[0][0]).toContain('activity=summary');
    cache.clear();
  });
  it('keeps large live tool updates and in-flight event replays compact', async () => {
    const wait = deferred<HistoryData>();
    const cache = new ConversationCache(
      vi.fn().mockResolvedValueOnce(data()).mockReturnValue(wait.promise),
    );
    await cache.load(view);
    const refresh = cache.load(view, true);
    cache.event({
      type: 'activity.updated',
      conversationId: 'a',
      payload: {
        messageId: 'm',
        activity: {
          id: 'step',
          type: 'tool',
          title: 'New output',
          time: '2026-09-28T13:00:00Z',
          detail: 'x'.repeat(10 * 1024 * 1024),
        },
      },
    });
    expect(cache.stats().bytes).toBeLessThan(10000);
    wait.resolve(data());
    await refresh;
    expect(cache.read(view).data?.messages[0].activity?.[0]).toMatchObject({
      title: 'New output',
      hasDetail: true,
    });
    expect(cache.read(view).data?.messages[0].activity?.[0].detail).toBeUndefined();
    expect(cache.stats().bytes).toBeLessThan(10000);
    cache.clear();
  });
  it('returns cached data synchronously and deduplicates refreshes', async () => {
    const wait = deferred<HistoryData>();
    const fetcher = vi.fn().mockResolvedValueOnce(data()).mockReturnValue(wait.promise);
    const cache = new ConversationCache(fetcher);
    await cache.load(view);
    const first = cache.load(view, true),
      second = cache.load(view, true);
    expect(first).toBe(second);
    expect(cache.read(view).data?.messages[0].text).toBe('Hello');
    wait.resolve(data('Updated'));
    await first;
    expect(fetcher).toHaveBeenCalledTimes(2);
    await cache.load(view);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('applies events to inactive views and replays deltas over an older refresh', async () => {
    const wait = deferred<HistoryData>();
    const cache = new ConversationCache(
      vi.fn().mockResolvedValueOnce(data()).mockReturnValue(wait.promise),
    );
    await cache.load(view);
    const refresh = cache.load(view, true);
    cache.event(delta(5, ' world'));
    expect(cache.read(view).data?.messages[0].text).toBe('Hello world');
    wait.resolve(data());
    await refresh;
    expect(cache.read(view).data?.messages[0].text).toBe('Hello world');
    cache.event(delta(5, ' world'));
    expect(cache.read(view).data?.messages[0].text).toBe('Hello world');
  });
  it('does not mix conversations, threads, agent views or history pages', async () => {
    const fetcher = vi.fn(async (path: string) => data(path));
    const cache = new ConversationCache(fetcher);
    const variants = [
      view,
      { id: 'b' },
      { id: 'a', threadId: 'thread' },
      { id: 'a' },
      { ...view, before: 3 },
    ];
    await Promise.all(variants.map((item) => cache.load(item)));
    expect(new Set(variants.map((item) => cache.read(item).data?.messages[0].text)).size).toBe(5);
  });
  it('keeps content, including a cached empty view, on background failure', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ ...data(), messages: [] })
      .mockRejectedValue(new Error('Offline'));
    const cache = new ConversationCache(fetcher);
    await cache.load(view);
    await expect(cache.load(view, true)).rejects.toThrow('Offline');
    expect(cache.read(view)).toMatchObject({ status: 'error', data: { messages: [] } });
  });
  it('prevents requests and composer completions from reviving a cleared session', async () => {
    const wait = deferred<HistoryData>();
    const cache = new ConversationCache(vi.fn().mockReturnValue(wait.promise));
    cache.setScope('first', ['a']);
    const token = cache.composerToken(view);
    const loading = cache.load(view);
    cache.setScope('second', ['a']);
    wait.resolve(data('Private'));
    await loading;
    cache.updateComposer(view, 'draft', 'Old user draft', token);
    expect(cache.read(view).data).toBeNull();
    expect(cache.composer(view).draft).toBe('');
  });
  it('purges revoked conversations and aggregated agent history', async () => {
    const cache = new ConversationCache(vi.fn().mockResolvedValue(data()));
    cache.setScope('user', ['a', 'b']);
    await cache.load(view);
    await cache.load({ id: 'b' });
    cache.setScope('user', ['a']);
    expect(cache.read({ id: 'b' }).data).toBeNull();
    expect(cache.read(view).data).toBeNull();
  });
  it('purges aggregated history when agent access is removed even if DM membership remains', async () => {
    const cache = new ConversationCache(vi.fn().mockResolvedValue(data()));
    cache.setScope('user', ['a'], ['agent-a']);
    await cache.load(view);
    cache.setScope('user', ['a'], []);
    expect(cache.read(view).data).toBeNull();
    cache.clear();
  });
  it('evicts least recently used unused views by count and byte size', async () => {
    const cache = new ConversationCache(vi.fn().mockResolvedValue(data()), 2);
    await cache.load(view);
    const unsubscribe = cache.subscribe(view, () => {});
    await cache.load({ id: 'b' });
    await cache.load({ id: 'c' });
    expect(cache.stats().views).toBe(2);
    expect(cache.read(view).data).not.toBeNull();
    expect(cache.read({ id: 'b' }).data).toBeNull();
    unsubscribe();
    const tiny = new ConversationCache(vi.fn().mockResolvedValue(data('x'.repeat(3000))), 8, 1024);
    await tiny.load(view);
    expect(tiny.stats().bytes).toBeLessThanOrEqual(1024);
  });
  it('saves drafts after navigation and does not overwrite a local edit with a late draft response', async () => {
    vi.useFakeTimers();
    const wait = deferred<any>();
    const fetcher = vi
      .fn()
      .mockImplementation((_path: string, body?: any) =>
        body ? Promise.resolve({ ok: true }) : wait.promise,
      );
    const cache = new ConversationCache(fetcher);
    const loading = cache.loadDraft(view);
    cache.updateComposer(view, 'draft', 'New draft');
    cache.updateComposer(view, 'files', [{ id: 'file', name: 'Notes' }]);
    wait.resolve({ text: 'Old server draft', attachments: [] });
    await loading;
    await vi.advanceTimersByTimeAsync(401);
    expect(cache.composer(view).draft).toBe('New draft');
    expect(fetcher).toHaveBeenLastCalledWith(
      '/conversations/a/draft',
      { text: 'New draft', attachments: ['file'], threadId: '' },
      'PUT',
    );
    cache.clear();
  });
  it('serializes draft saves so clearing after send cannot be undone by an older save', async () => {
    const wait = deferred<any>();
    const fetcher = vi.fn().mockReturnValueOnce(wait.promise).mockResolvedValue({ ok: true });
    const cache = new ConversationCache(fetcher);
    cache.updateComposer(view, 'draft', 'Before send');
    const saving = cache.saveDraft(view);
    cache.updateComposer(view, 'draft', '');
    wait.resolve({ ok: true });
    await saving;
    await Promise.resolve();
    expect(fetcher.mock.calls[1][1].text).toBe('');
    cache.clear();
  });
  it('keeps pending sends across unmount and reconciles confirmed client keys', async () => {
    const confirmed = { ...message(), clientKey: 'client' };
    const cache = new ConversationCache(
      vi.fn().mockResolvedValue({ ...data(), messages: [confirmed] }),
    );
    cache.updateComposer(view, 'outgoing', [
      { message: confirmed, body: {}, files: [], state: 'sending' },
    ]);
    const leave = cache.subscribeComposer(view, () => {});
    leave();
    expect(cache.composer(view).outgoing).toHaveLength(1);
    await cache.load(view);
    expect(cache.composer(view).outgoing).toHaveLength(0);
  });
  it('does not reveal quiet agent events in a shared room', async () => {
    vi.useFakeTimers();
    const cache = new ConversationCache(vi.fn().mockResolvedValue(data()));
    const room = { id: 'a', room: true };
    await cache.load(room);
    cache.event(delta(5, ' private tool detail'));
    expect(cache.read(room).data?.messages[0].text).toBe('Hello');
    cache.clear();
  });
  it('retains a failed draft save and retries it on reconnect', async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error('Offline'))
      .mockResolvedValue({ ok: true });
    const cache = new ConversationCache(fetcher);
    cache.updateComposer(view, 'draft', 'Keep this safe');
    await expect(cache.saveDraft(view)).rejects.toThrow('Offline');
    expect(cache.composer(view)).toMatchObject({ draft: 'Keep this safe', saveError: 'Offline' });
    cache.reconnect();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(cache.composer(view).saveError).toBeUndefined();
    cache.clear();
  });
  it('keeps the cache bounded after visiting many conversations and cancels evicted requests', async () => {
    const fetcher = vi.fn().mockResolvedValue(data('x'.repeat(2000)));
    const cache = new ConversationCache(fetcher);
    for (let i = 0; i < 100; i++) await cache.load({ id: String(i) });
    expect(cache.stats().views).toBe(8);
    expect(cache.stats().bytes).toBeLessThan(16 * 1024 * 1024);
    const wait = deferred<HistoryData>();
    const stalled = vi.fn().mockReturnValue(wait.promise);
    const small = new ConversationCache(stalled, 1);
    const first = small.load({ id: 'old' });
    const second = small.load({ id: 'new' });
    expect(stalled.mock.calls[0][3].aborted).toBe(true);
    wait.resolve(data());
    await Promise.all([first, second]);
    expect(small.stats().views).toBe(1);
  });
  it('isolates late responses when conversations are switched rapidly', async () => {
    const a = deferred<HistoryData>(),
      b = deferred<HistoryData>();
    const cache = new ConversationCache(
      vi.fn((path: string) => (path.includes('/a/') ? a.promise : b.promise)),
    );
    const loadingA = cache.load({ id: 'a' }),
      loadingB = cache.load({ id: 'b' });
    b.resolve(data('B'));
    await loadingB;
    a.resolve(data('A'));
    await loadingA;
    expect(cache.read({ id: 'a' }).data?.messages[0].text).toBe('A');
    expect(cache.read({ id: 'b' }).data?.messages[0].text).toBe('B');
  });
  it('clears cached content on authorization errors and retries active views after reconnect', async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(data())
      .mockRejectedValueOnce(Object.assign(new Error('Denied'), { status: 403 }))
      .mockResolvedValue(data('Reconnected'));
    const cache = new ConversationCache(fetcher);
    await cache.load(view);
    await expect(cache.load(view, true)).rejects.toThrow('Denied');
    expect(cache.read(view).data).toBeNull();
    const leave = cache.subscribe(view, () => {});
    cache.reconnect();
    await vi.advanceTimersByTimeAsync(81);
    expect(cache.read(view).data?.messages[0].text).toBe('Reconnected');
    leave();
    cache.clear();
  });
});
