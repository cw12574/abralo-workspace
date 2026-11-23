import { discoverOAuthServerInfo } from '@modelcontextprotocol/sdk/client/auth.js';

/**
 * Helpers for telling several accounts on one service apart, and for ending
 * access with the provider when an account is disconnected.
 */

const clean = (value: unknown) =>
  typeof value === 'string' && value.trim() && value.length <= 120 ? value.trim() : undefined;

/** Claims from a JWT, without trusting it for anything beyond a display name. */
function claims(token?: string): Record<string, any> | null {
  const part = token?.split('.')[1];
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/** The best human-readable account name in a token, e.g. an email or team name. */
export function identityFromTokens(tokens: any): string | undefined {
  for (const token of [tokens?.id_token, tokens?.access_token]) {
    const c = claims(token);
    if (!c) continue;
    const found =
      clean(c.email) ||
      clean(c.preferred_username) ||
      clean(c.team_name) ||
      clean(c.org_name) ||
      clean(c.organization_name) ||
      clean(c.name);
    if (found) return found;
  }
  return undefined;
}

/** Read-only tools that describe the signed-in account and take no arguments. */
const whoAmI = /^(get[_-]?)?(me|whoami|current[_-]?user|my[_-]?profile|user[_-]?info|account[_-]?info|account|profile)$/i;
export function identityTool(tools: any[]) {
  return tools.find(
    (t) =>
      whoAmI.test(t.name) &&
      t.annotations?.readOnlyHint === true &&
      !(t.inputSchema?.required || []).length,
  );
}

/** Pull an email, or else a name, out of a tool result. */
export function identityFromResult(result: any): string | undefined {
  if (!result || result.isError) return undefined;
  const text = (result.content || [])
    .filter((c: any) => c.type === 'text')
    .map((c: any) => c.text)
    .join('\n')
    .slice(0, 4000);
  const email = text.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/);
  if (email) return email[0];
  try {
    const value = JSON.parse(text);
    return clean(value.email) || clean(value.name) || clean(value.username);
  } catch {
    const named = text.match(/^\s*(?:name|team|account|organi[sz]ation)\s*:\s*(.+)$/im);
    return clean(named?.[1]);
  }
}

/**
 * Asks the provider to cancel this sign-in (RFC 7009). Best effort: many
 * services have no revocation endpoint, and the local credentials are deleted
 * either way.
 */
export async function revokeOAuth(
  serverUrl: string,
  saved: any,
  fetchFn: typeof fetch = fetch,
): Promise<'revoked' | 'unsupported' | 'failed'> {
  const token = saved?.tokens?.refresh_token || saved?.tokens?.access_token;
  if (!token) return 'unsupported';
  const signal = AbortSignal.timeout(10000);
  const limited = ((url: any, init?: any) => fetchFn(url, { ...init, signal })) as typeof fetch;
  try {
    const info = await discoverOAuthServerInfo(serverUrl, { fetchFn: limited });
    const endpoint = (info.authorizationServerMetadata as any)?.revocation_endpoint as string | undefined;
    if (!endpoint) return 'unsupported';
    const body = new URLSearchParams({
      token,
      token_type_hint: saved.tokens.refresh_token ? 'refresh_token' : 'access_token',
    });
    if (saved.client?.client_id) body.set('client_id', saved.client.client_id);
    const res = await limited(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    return res.ok ? 'revoked' : 'failed';
  } catch {
    return 'failed';
  }
}

/** Ask the provider to show its account chooser, so a second sign-in can pick another account. */
export function chooseAccount(url: URL) {
  if (!url.searchParams.has('prompt')) url.searchParams.set('prompt', 'select_account');
  return url;
}
