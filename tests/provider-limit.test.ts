import { describe, expect, it } from 'vitest';
import { ProviderLimitError, providerLimitFromError } from '../apps/service/src/adapters/provider-limit.js';

describe('provider limit recognition', () => {
  it('recognizes Codex weekly usage limits and exact reset times', () => {
    const result = providerLimitFromError(
      new Error("You've hit your weekly usage limit. Try again at 12:52 PM."),
      'codex',
    );
    expect(result).toBeInstanceOf(ProviderLimitError);
    expect(result?.provider).toBe('Codex');
    expect(result?.window).toBe('weekly');
    expect(Date.parse(result!.retryAt)).toBeGreaterThan(Date.now());
  });

  it('uses the configured provider for OpenCode instead of calling it a quota owner', () => {
    const result = providerLimitFromError(
      { error: { message: '429 rate limit exceeded' } },
      'opencode',
      'anthropic',
    );
    expect(result?.provider).toBe('anthropic');
    expect(result?.window).toBe('rate');
  });

  it('does not treat exhausted credits or spend limits as resumable usage windows', () => {
    expect(providerLimitFromError(new Error('Insufficient credits: add funds to continue'), 'claude')).toBeUndefined();
    expect(providerLimitFromError(new Error('Monthly spend limit reached'), 'opencode')).toBeUndefined();
  });
});
