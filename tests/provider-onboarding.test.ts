import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { ProviderChecks } from '../apps/service/src/provider-checks.js';
import { CodexAdapter } from '../apps/service/src/adapters/codex.js';
import { OpenCodeAdapter } from '../apps/service/src/adapters/opencode.js';
import { ClaudeAdapter } from '../apps/service/src/adapters/claude.js';
import { launch, execFileAsync } from '../packages/host/src/index.js';
import type { Adapter, ProviderInfo } from '../packages/contracts/src/index.js';

vi.mock('../packages/host/src/index.js', () => ({
  launch: vi.fn(),
  executable: () => ({ command: 'fixture', args: [] }),
  killTree: vi.fn(),
  execFileAsync: vi.fn(),
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const connected: ProviderInfo = {
  harness: 'codex',
  installed: true,
  authenticated: true,
  version: 'fixture',
  detail: 'Connected',
};
const adapter = (info: Adapter['info']) => ({ info, dispose: async () => {}, run: async () => {} });
function child() {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
}

it('contains provider rejection and coalesces simultaneous status checks', async () => {
  const checks = new ProviderChecks(100);
  const info = vi.fn(async () => connected);
  const [one, two, failed] = await Promise.all([
    checks.check('codex', adapter(info)),
    checks.check('codex', adapter(info)),
    checks.check(
      'claude',
      adapter(async () => {
        throw new Error('secret internal detail');
      }),
    ),
  ]);
  expect(info).toHaveBeenCalledTimes(1);
  expect(one.authenticated).toBe(true);
  expect(two).toEqual(one);
  expect(failed.authenticated).toBeNull();
  expect(failed.detail).not.toContain('secret');
});

it('bounds a stuck probe without creating more probes, then permits recovery', async () => {
  vi.useFakeTimers();
  const checks = new ProviderChecks(100);
  let complete!: (info: ProviderInfo) => void;
  const info = vi.fn(
    () =>
      new Promise<ProviderInfo>((resolve) => {
        complete = resolve;
      }),
  );
  const pending = checks.check('codex', adapter(info));
  await vi.advanceTimersByTimeAsync(101);
  expect((await pending).authenticated).toBeNull();
  await checks.check('codex', adapter(info));
  expect(info).toHaveBeenCalledTimes(1);
  complete(connected);
  await vi.advanceTimersByTimeAsync(0);
  expect(
    (
      await checks.check(
        'codex',
        adapter(async () => connected),
      )
    ).authenticated,
  ).toBe(true);
});

it('survives a Codex stdin EPIPE during initialization and allows the next start', async () => {
  const first = child(),
    second = child();
  vi.mocked(launch)
    .mockReturnValueOnce(first as any)
    .mockReturnValueOnce(second as any);
  const codex = new CodexAdapter();
  const failed = codex.start();
  const assertion = expect(failed).rejects.toThrow('broken pipe');
  first.stdin.emit('error', new Error('broken pipe'));
  await assertion;
  expect(codex.pending.size).toBe(0);
  const restarted = codex.start();
  second.stdout.write(JSON.stringify({ id: 2, result: {} }) + '\n');
  await restarted;
  // Late exit from the first process must not clear the replacement.
  first.emit('exit', 1);
  expect(codex.child).toBe(second);
});

it('signed-out Codex never asks authenticated model or quota endpoints', async () => {
  const codex = new CodexAdapter();
  vi.spyOn(codex, 'start').mockResolvedValue();
  const request = vi.spyOn(codex, 'request').mockResolvedValue({ account: null });
  expect((await codex.info()).authenticated).toBe(false);
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0][0]).toBe('account/read');
});

it('a synchronous Codex launch failure does not poison later startup', async () => {
  const replacement = child();
  vi.mocked(launch)
    .mockImplementationOnce(() => {
      throw new Error('missing runtime');
    })
    .mockReturnValueOnce(replacement as any);
  const codex = new CodexAdapter();
  await expect(codex.start()).rejects.toThrow('missing runtime');
  const restarted = codex.start();
  replacement.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\n');
  await restarted;
});

it('optional model/quota failures do not turn an authenticated account into a sign-in failure', async () => {
  const codex = new CodexAdapter();
  vi.spyOn(codex, 'start').mockResolvedValue();
  vi.spyOn(codex, 'request').mockImplementation(async (method) => {
    if (method === 'account/read') return { account: { type: 'chatgpt' } };
    throw new Error('offline catalog');
  });
  expect((await codex.info()).authenticated).toBe(true);
});

it('coalesces duplicate Codex login requests and cancels before changing method', async () => {
  const codex = new CodexAdapter();
  vi.spyOn(codex, 'start').mockResolvedValue();
  const request = vi.spyOn(codex, 'request').mockResolvedValue({ loginId: 'fixture' });
  await Promise.all([codex.login(), codex.login()]);
  expect(request).toHaveBeenCalledTimes(1);
  await codex.login('chatgptDeviceCode');
  expect(request.mock.calls.map((call) => call[0])).toEqual([
    'account/login/start',
    'account/login/cancel',
    'account/login/start',
  ]);
});

it('OpenCode rejects early exit immediately and can restart', async () => {
  const first = child(),
    second = child();
  vi.mocked(launch)
    .mockReturnValueOnce(first as any)
    .mockReturnValueOnce(second as any);
  const opencode = new OpenCodeAdapter();
  const failed = opencode.start();
  const assertion = expect(failed).rejects.toThrow('stopped');
  first.emit('exit', 1);
  await assertion;
  const restarted = opencode.start();
  second.stdout.write('server listening on http://127.0.0.1:9876\n');
  await restarted;
  first.emit('exit', 1);
  expect(opencode.child).toBe(second);
  expect(opencode.url).toBe('http://127.0.0.1:9876');
});

it('OpenCode kills timed-out startup and clears the failed promise for retry', async () => {
  vi.useFakeTimers();
  const process = child();
  vi.mocked(launch).mockReturnValueOnce(process as any);
  const opencode = new OpenCodeAdapter();
  const assertion = expect(opencode.start()).rejects.toThrow('did not start');
  await vi.advanceTimersByTimeAsync(15001);
  await assertion;
  expect(process.kill).toHaveBeenCalled();
  expect(opencode.starting).toBeUndefined();
});

it('Claude distinguishes a signed-out exit status from a broken runtime', async () => {
  vi.mocked(execFileAsync).mockRejectedValueOnce(
    Object.assign(new Error('exit 1'), { stdout: '{"loggedIn":false}' }),
  );
  expect((await new ClaudeAdapter().info()).authenticated).toBe(false);
  vi.mocked(execFileAsync).mockRejectedValueOnce(new Error('spawn failed'));
  expect((await new ClaudeAdapter().info()).authenticated).toBeNull();
});

it('Claude reports detected sign-in without claiming verified task entitlement', async () => {
  vi.mocked(execFileAsync).mockResolvedValueOnce({
    stdout: '{"loggedIn":true,"authMethod":"claude.ai"}',
    stderr: '',
  } as any);
  const info = await new ClaudeAdapter().info();
  expect(info.authenticated).toBe(true);
  expect(info.detail).toContain('confirm access when a task runs');
});

it('a missing or malformed Claude status is unknown, never a successful connection', async () => {
  vi.mocked(execFileAsync).mockResolvedValueOnce({ stdout: '{}', stderr: '' } as any);
  expect((await new ClaudeAdapter().info()).authenticated).toBeNull();
});
