import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

/**
 * A stand-in MCP service for tests: real MCP over streamable HTTP, protected
 * either by an API key or by a minimal OAuth 2.1 server (discovery, dynamic
 * client registration, PKCE). It publishes a Resend-style /.well-known/mcp.json.
 */
export async function startStandInMcp(
  mode: 'oauth' | 'api_key',
  apiKey = 'sk_test_valid_key',
  options: { identity?: boolean } = {},
) {
  const codes = new Map<string, { challenge: string; redirect: string; account: string }>();
  // Each token belongs to the account that was signed in when it was issued.
  const tokens = new Map<string, string>();
  const calls: { name: string; args: any; account?: string }[] = [];
  const prompts: (string | null)[] = [];
  const revoked: string[] = [];
  let account = 'alice@example.com';
  let base = '';
  const json = (res: ServerResponse, status: number, body: any, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  const read = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => resolve(body));
    });
  const authorised = (req: IncomingMessage) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    return mode === 'api_key' ? token === apiKey : tokens.has(token);
  };
  const accountOf = (req: IncomingMessage) =>
    tokens.get(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', base);
    if (url.pathname === '/.well-known/mcp.json')
      return json(res, 200, {
        name: 'Acme Mail',
        description: 'A stand-in email service.',
        remote: {
          url: `${base}/mcp`,
          transport: 'streamable-http',
          authentication: {
            type: mode === 'oauth' ? 'oauth2' : 'api_key',
            api_key: { description: 'Create a key in Acme settings.' },
          },
        },
      });
    if (mode === 'oauth' && url.pathname.startsWith('/.well-known/oauth-protected-resource'))
      return json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base] });
    if (mode === 'oauth' && url.pathname === '/.well-known/oauth-authorization-server')
      return json(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        revocation_endpoint: `${base}/revoke`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      });
    if (mode === 'oauth' && url.pathname === '/register' && req.method === 'POST') {
      const body = JSON.parse(await read(req));
      return json(res, 201, { ...body, client_id: 'stand-in-client' });
    }
    if (mode === 'oauth' && url.pathname === '/authorize') {
      // The human approves immediately in this stand-in.
      const code = randomBytes(8).toString('hex');
      const redirect = url.searchParams.get('redirect_uri')!;
      prompts.push(url.searchParams.get('prompt'));
      codes.set(code, { challenge: url.searchParams.get('code_challenge')!, redirect, account });
      res.writeHead(302, {
        location: `${redirect}?code=${code}&state=${encodeURIComponent(url.searchParams.get('state') || '')}`,
      });
      return res.end();
    }
    if (mode === 'oauth' && url.pathname === '/token' && req.method === 'POST') {
      const form = new URLSearchParams(await read(req));
      const saved = codes.get(form.get('code') || '');
      const verifier = form.get('code_verifier') || '';
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      if (!saved || saved.challenge !== challenge) return json(res, 400, { error: 'invalid_grant' });
      codes.delete(form.get('code')!);
      const token = randomBytes(12).toString('hex');
      tokens.set(token, saved.account);
      return json(res, 200, { access_token: token, token_type: 'Bearer', expires_in: 3600 });
    }
    if (mode === 'oauth' && url.pathname === '/revoke' && req.method === 'POST') {
      const token = new URLSearchParams(await read(req)).get('token') || '';
      revoked.push(token);
      tokens.delete(token);
      res.writeHead(200);
      return res.end();
    }
    if (url.pathname === '/mcp') {
      if (!authorised(req))
        return json(res, 401, { error: 'unauthorized' }, mode === 'oauth'
          ? { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` }
          : {});
      const mcp = new McpServer({ name: 'acme-mail', version: '1.0.0' });
      const who = accountOf(req);
      mcp.registerTool(
        'list_domains',
        { description: 'List sending domains', annotations: { readOnlyHint: true } },
        async () => {
          calls.push({ name: 'list_domains', args: {}, account: who });
          return {
            content: [
              { type: 'text', text: `${who ? who.split('@')[0] + '.' : ''}mail.example.com: verified` },
            ],
          };
        },
      );
      if (options.identity)
        mcp.registerTool(
          'get_me',
          { description: 'The signed-in account', annotations: { readOnlyHint: true } },
          async () => ({ content: [{ type: 'text', text: JSON.stringify({ email: who }) }] }),
        );
      mcp.registerTool(
        'send_email',
        { description: 'Send an email', annotations: { readOnlyHint: false, destructiveHint: false } },
        async (args: any) => {
          calls.push({ name: 'send_email', args });
          return { content: [{ type: 'text', text: 'sent' }] };
        },
      );
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => void transport.close());
      await mcp.connect(transport);
      const body = req.method === 'POST' ? JSON.parse((await read(req)) || 'null') : undefined;
      return transport.handleRequest(req, res, body);
    }
    json(res, 404, { error: 'not found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  return {
    base,
    url: `${base}/mcp`,
    calls,
    prompts,
    revoked,
    /** The account the next sign-in approves, as if the human picked it. */
    signInAs: (email: string) => {
      account = email;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
