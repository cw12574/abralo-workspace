import { it, expect, vi } from 'vitest';
const mock = vi.hoisted(() => ({ query: vi.fn(), auth: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: mock.query }));
vi.mock('../packages/host/src/index.js', () => ({ executable: () => ({ command: 'fixture-claude', args: [] }), execFileAsync: mock.auth }));
import { ClaudeAdapter } from '../apps/service/src/adapters/claude.js';
it('discovers native Claude models without submitting a turn or persisting a session', async () => {
  mock.auth.mockResolvedValue({ stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'fixture@example.test' }) });
  const close = vi.fn();
  let input: Promise<any> | undefined;
  mock.query.mockImplementation(({ prompt, options }) => {
    expect(options.persistSession).toBe(false);
    expect(options.tools).toEqual([]);
    expect(options.strictMcpConfig).toBe(true);
    input = prompt[Symbol.asyncIterator]().next();
    return { supportedModels: async () => [{ value: 'default', resolvedModel: 'current-model', displayName: 'Current model' }], close };
  });
  const result = await new ClaudeAdapter().info();
  expect(result.models?.[0]).toEqual({ id: 'current-model', name: 'Current model', aliases: ['default'], isDefault: true });
  expect(await input).toEqual({ value: undefined, done: true });
  expect(close).toHaveBeenCalledOnce();
  expect(result.accountKey).not.toContain('fixture@example.test');
});
it('closes a failed control channel and reports a retryable catalogue error', async () => {
  mock.auth.mockResolvedValue({ stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }) });
  const close = vi.fn();
  mock.query.mockReturnValue({ supportedModels: async () => { throw new Error('Offline'); }, close });
  const result = await new ClaudeAdapter().info();
  expect(result.authenticated).toBe(true);
  expect(result.catalogueError).toBeTruthy();
  expect(close).toHaveBeenCalledOnce();
});
