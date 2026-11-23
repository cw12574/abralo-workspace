export type ProviderFailure = 'signin' | 'blocked' | null;

const BLOCKED =
  /\b403\b|cloudflare|attention required|\b429\b|rate.?limit|timed? ?out|econn|enotfound|network|overloaded|\b5\d\d\b/i;
const SIGN_IN =
  /not (?:logged|signed) in|please (?:run )?\/?log ?in|sign.?in|log ?in|authentication[_ ]error|invalid (?:credentials|authentication)|\b401\b|oauth token|token (?:has )?expired|credential|failed to authenticate/i;

/**
 * Tell a genuine sign-in problem from a network or provider-side block. A 403
 * from Cloudflare says "Failed to authenticate" but re-signing in cannot fix it.
 */
export function providerFailureKind(error?: string | null): ProviderFailure {
  if (!error) return null;
  if (BLOCKED.test(error)) return 'blocked';
  if (SIGN_IN.test(error)) return 'signin';
  return null;
}
