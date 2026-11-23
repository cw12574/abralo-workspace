import { expect, it } from 'vitest';
import { providerFailureKind } from '../apps/web/src/provider-failure';

it('separates network blocks from real sign-in problems', () => {
  expect(providerFailureKind('Failed to authenticate. API Error: 403 Attention Required! | Cloudflare')).toBe('blocked');
  expect(providerFailureKind('API Error: 429 rate limit')).toBe('blocked');
  expect(providerFailureKind('Failed to authenticate. API Error: 401 invalid credentials')).toBe('signin');
  expect(providerFailureKind('Not logged in · Please run /login')).toBe('signin');
  expect(providerFailureKind('OAuth token has expired')).toBe('signin');
  expect(providerFailureKind("The 'gpt-6-astra' model is not supported")).toBe(null);
  expect(providerFailureKind(null)).toBe(null);
});
