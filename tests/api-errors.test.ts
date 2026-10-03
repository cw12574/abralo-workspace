import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../apps/web/src/api.js';
afterEach(() => vi.unstubAllGlobals());
it('explains local-service failure and never retries a sign-in mutation', async () => {
  const fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
  vi.stubGlobal('fetch', fetch);
  await expect(api('/providers/codex/login', {})).rejects.toMatchObject({
    code: 'service_unreachable',
    message: expect.stringContaining('Reopen the Abralo app'),
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('distinguishes an expired Abralo session from a provider sign-in', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response('{"error":"Unauthorized"}', { status: 401 })),
  );
  await expect(api('/providers')).rejects.toMatchObject({
    status: 401,
    message: expect.stringContaining('Abralo session has expired'),
  });
});
it('handles non-JSON error responses without displaying a parser exception', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response('<html>error</html>', { status: 502 })),
  );
  await expect(api('/providers')).rejects.toThrow('unexpected response');
});
