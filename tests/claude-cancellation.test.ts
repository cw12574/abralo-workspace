import { beforeEach, describe, expect, it, vi } from 'vitest';
const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }));
vi.mock('../packages/host/src/index.js', () => ({
  executable: () => ({ command: 'fixture-claude', args: [] }),
  execFileAsync: async () => ({ stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }) }),
}));
import { ClaudeAdapter } from '../apps/service/src/adapters/claude.js';

function input() {
  const controller = new AbortController();
  const emit = vi.fn();
  return { controller, emit, value: {
    id: 'fixture', prompt: 'Test', attachments: [], signal: controller.signal, emit,
    employee: { permissionMode: 'ask', instructions: '', cwd: '' },
    decide: async () => ({ allow: true }),
  } as any };
}
beforeEach(() => { queryMock.mockReset(); });

describe('Claude cancellation lifecycle', () => {
  it('keeps the transport open until native interrupt acknowledges, then closes it', async () => {
    const a = input();
    let release!: () => void;
    let sdkSignal!: AbortSignal;
    const close = vi.fn();
    const interrupt = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    queryMock.mockImplementation(({ options }) => {
      sdkSignal = options.abortController.signal;
      expect(options.perTaskStopAffordance).toBe(false);
      return {
        interrupt, close,
        async *[Symbol.asyncIterator]() {
          await new Promise(resolve => sdkSignal.addEventListener('abort', resolve, { once: true }));
        },
      };
    });
    const run = new ClaudeAdapter().run(a.value);
    await vi.waitFor(() => expect(queryMock).toHaveBeenCalledOnce());
    a.controller.abort();
    expect(interrupt).toHaveBeenCalledOnce();
    expect(sdkSignal.aborted).toBe(false);
    expect(a.emit).not.toHaveBeenCalled();
    release();
    await run;
    expect(sdkSignal.aborted).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    expect(a.emit).toHaveBeenCalledWith({ type: 'complete', data: { cancelled: true } });
  });

  it('reports unconfirmed termination if native interrupt fails', async () => {
    const a = input();
    queryMock.mockImplementation(({ options }) => ({
      interrupt: async () => { throw new Error('Native cleanup failed'); }, close: () => {},
      async *[Symbol.asyncIterator]() {
        await new Promise(resolve => options.abortController.signal.addEventListener('abort', resolve, { once: true }));
      },
    }));
    const result = new ClaudeAdapter().run(a.value).then(() => undefined, error => error);
    await vi.waitFor(() => expect(queryMock).toHaveBeenCalledOnce());
    a.controller.abort();
    expect(String(await result)).toContain('tool termination is unconfirmed');
    expect(a.emit).not.toHaveBeenCalled();
  });

  it('does not create a query when already cancelled', async () => {
    const a = input();
    a.controller.abort();
    await new ClaudeAdapter().run(a.value);
    expect(queryMock).not.toHaveBeenCalled();
    expect(a.emit).toHaveBeenCalledWith({ type: 'complete', data: { cancelled: true } });
  });
});
