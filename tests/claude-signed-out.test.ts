import { expect, it, vi } from 'vitest';

// `claude auth status` prints JSON and exits 1 when nobody is signed in.
let outcome: { stdout: string; code: number } = { stdout: '', code: 0 };
vi.mock('../packages/host/src/index.js', async (original) => ({
  ...(await original<any>()),
  execFileAsync: async () => {
    if (outcome.code === 0) return { stdout: outcome.stdout, stderr: '' };
    throw Object.assign(new Error('Command failed: claude auth status'), {
      code: outcome.code,
      stdout: outcome.stdout,
      stderr: '',
    });
  },
}));
const { ClaudeAdapter } = await import('../apps/service/src/adapters/claude.js');

const fakeBinary = { command: 'claude', args: [] };

it('asks a signed-out person to sign in instead of reporting a failed check', async () => {
  outcome = {
    code: 1,
    stdout: JSON.stringify({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' }),
  };
  const info = await new ClaudeAdapter(fakeBinary).info();
  expect(info.installed).toBe(true);
  expect(info.authenticated).toBe(false);
  expect(info.detail).toBe('Sign in with Claude Code');
});

it('still reports a check that produced no status', async () => {
  outcome = { code: 1, stdout: '' };
  const info = await new ClaudeAdapter(fakeBinary).info();
  expect(info.authenticated).toBeNull();
  expect(info.detail).toMatch(/Could not check Claude Code/);
});
