import { describe, expect, it, vi } from 'vitest';
import { CodexAdapter } from '../apps/service/src/adapters/codex.js';
import type { RunInput } from '../packages/contracts/src/index.js';

function fixture() {
  const adapter = new CodexAdapter();
  adapter.start = async () => {};
  adapter.loadedThreads = new Set(['thread-a', 'thread-b']);
  const cleanup = vi.fn(async (_params: any) => ({}));
  const calls: { method: string; params: any }[] = [];
  const completed = (threadId: string, status: string) => adapter.events.emit('message', {
    method: 'turn/completed', params: { threadId, turn: { id: 'turn-' + threadId, status } },
  });
  adapter.request = async (method, params) => {
    calls.push({ method, params });
    if (method === 'account/read') return { account: { type: 'chatgpt' } };
    if (method === 'turn/start') {
      adapter.events.emit('message', {
        method: 'turn/started', params: { threadId: params.threadId, turn: { id: 'turn-' + params.threadId } },
      });
      return { turn: { id: 'turn-' + params.threadId } };
    }
    if (method === 'turn/interrupt') {
      queueMicrotask(() => completed(params.threadId, 'interrupted'));
      return {};
    }
    if (method === 'thread/backgroundTerminals/clean') return cleanup(params);
    throw new Error('Unexpected request: ' + method);
  };
  const input = (sessionId = 'thread-a') => {
    const controller = new AbortController();
    const emit = vi.fn();
    const value: RunInput = {
      id: sessionId, sessionId, attachments: [], prompt: 'Test cancellation',
      employee: { id: sessionId, cwd: '', permissionMode: 'ask' } as any,
      signal: controller.signal, emit, decide: async () => ({ allow: true }),
    };
    return { value, controller, emit };
  };
  return { adapter, input, calls, cleanup, completed };
}

describe('Codex native cancellation lifecycle', () => {
  it('waits for its own terminal cleanup while another thread completes independently', async () => {
    const f = fixture();
    let release!: () => void;
    f.cleanup.mockImplementation(() => new Promise(resolve => { release = () => resolve({}); }));
    const a = f.input(), b = f.input('thread-b');
    let settled = false;
    const runA = f.adapter.run(a.value).finally(() => { settled = true; });
    const runB = f.adapter.run(b.value);
    await vi.waitFor(() => expect(f.calls.filter(c => c.method === 'turn/start')).toHaveLength(2));
    a.controller.abort();
    await vi.waitFor(() => expect(f.cleanup).toHaveBeenCalledWith({ threadId: 'thread-a' }));
    expect(settled).toBe(false);
    expect(a.emit.mock.calls.some(([e]) => e.type === 'complete')).toBe(false);
    f.completed('thread-b', 'completed');
    await runB;
    expect(b.emit).toHaveBeenCalledWith({ type: 'complete', data: { cancelled: false } });
    release();
    await runA;
    expect(a.emit).toHaveBeenCalledWith({ type: 'complete', data: { cancelled: true } });
    expect(f.calls.filter(c => c.method === 'turn/interrupt')).toHaveLength(1);
    expect(f.cleanup).toHaveBeenCalledTimes(1);
  });

  it('does not report a successful cancellation when terminal cleanup fails', async () => {
    const f = fixture(), a = f.input();
    f.cleanup.mockRejectedValue(new Error('Cleanup unavailable'));
    const result = f.adapter.run(a.value).then(() => undefined, error => error);
    await vi.waitFor(() => expect(f.calls.some(c => c.method === 'turn/start')).toBe(true));
    a.controller.abort();
    expect(String(await result)).toContain('tool termination is unconfirmed');
    expect(a.emit.mock.calls.some(([e]) => e.type === 'complete')).toBe(false);
  });

  it('does not start provider work for an already cancelled input', async () => {
    const f = fixture(), a = f.input();
    a.controller.abort();
    await f.adapter.run(a.value);
    expect(f.calls).toHaveLength(0);
    expect(a.emit).toHaveBeenCalledWith({ type: 'complete', data: { cancelled: true } });
  });

  it('declines an approval whose response arrives after cancellation', async () => {
    const f = fixture(), a = f.input();
    let decide!: (value: any) => void;
    a.value.decide = () => new Promise(resolve => { decide = resolve; });
    const respond = vi.spyOn(f.adapter, 'respond').mockImplementation(() => {});
    const run = f.adapter.run(a.value);
    await vi.waitFor(() => expect(f.calls.some(c => c.method === 'turn/start')).toBe(true));
    f.adapter.events.emit('message', {
      id: 42, method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-a', command: 'fixture command' },
    });
    a.controller.abort();
    decide({ allow: true });
    await run;
    expect(respond).toHaveBeenCalledWith(42, { decision: 'decline' });
  });
});
