import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, uid } from '../apps/service/src/store.js';
import { ConnectionBroker } from '../apps/service/src/connections.js';
import { discoverServices, safeServerUrl } from '../apps/service/src/connection-discovery.js';
import { startStandInMcp } from './helpers/stand-in-mcp.js';

vi.setConfig({ testTimeout: 20000 });
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function fakeFetch(routes: Record<string, any>) {
  return (async (url: string) => {
    const body = routes[url];
    return body === undefined
      ? new Response('missing', { status: 404 })
      : new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
}

describe('discovery', () => {
  it('ranks the service’s own server first and labels relays as third party', async () => {
    const registry = 'https://registry.test';
    const fetch = fakeFetch({
      [`${registry}/v0.1/servers?search=linear&version=latest&limit=20`]: {
        servers: [
          { server: { name: 'com.relay/linear', remotes: [{ type: 'streamable-http', url: 'https://gateway.relay.com/linear/mcp' }] } },
          { server: { name: 'app.linear/mcp', remotes: [{ type: 'streamable-http', url: 'https://mcp.linear.app/mcp' }] } },
          { server: { name: 'com.other/plinear', remotes: [{ type: 'streamable-http', url: 'https://plinear.other.com/mcp' }] } },
          { server: { name: 'com.old/linear', remotes: [{ type: 'streamable-http', url: 'https://old.example.com/mcp' }] }, _meta: { 'io.modelcontextprotocol.registry/official': { status: 'deprecated' } } },
          { server: { name: 'com.local/linear', remotes: [{ type: 'streamable-http', url: 'http://10.0.0.5/mcp' }] } },
        ],
      },
    });
    const found = await discoverServices('linear', { fetch, registry });
    expect(found.map((c) => [c.url, c.official])).toEqual([
      ['https://mcp.linear.app/mcp', true],
      ['https://gateway.relay.com/linear/mcp', false],
    ]);
    expect(found[0]).toMatchObject({ label: 'Linear', publisher: 'linear.app', source: 'registry' });
  });

  it('reads a service’s own published description, and knows Resend', async () => {
    const fetch = fakeFetch({
      'https://acme.com/.well-known/mcp.json': {
        name: 'Acme',
        remote: { url: 'https://mcp.acme.com/mcp', authentication: { type: 'oauth2', api_key: { description: 'Keys live in Acme settings.' } } },
      },
    });
    const [acme] = await discoverServices('acme', { fetch, registry: 'https://registry.test' });
    expect(acme).toMatchObject({ url: 'https://mcp.acme.com/mcp', auth: 'oauth', official: true, source: 'website', apiKeyHelp: 'Keys live in Acme settings.' });
    const [resend] = await discoverServices('Resend', { fetch: fakeFetch({}), registry: 'https://registry.test' });
    expect(resend).toMatchObject({ url: 'https://mcp.resend.com/mcp', official: true, source: 'built-in' });
  });

  it('refuses insecure, local and credential-bearing server addresses', () => {
    for (const url of ['http://mcp.example.com', 'https://localhost/mcp', 'https://192.168.1.4/mcp', 'https://user:pw@mcp.example.com', 'https://printer.local/mcp', 'not a url'])
      expect(safeServerUrl(url)).toBeNull();
    expect(safeServerUrl('https://mcp.example.com/mcp')?.href).toBe('https://mcp.example.com/mcp');
  });
});

function fixture() {
  const s = new Store(mkdtempSync(join(tmpdir(), 'connect-any-')));
  const owner = s.createOwner('Chris');
  const employee = s.createEmployee(owner.id, { name: 'Agent', harness: 'claude', model: '', cwd: '', role: '', instructions: '' });
  const broker = new ConnectionBroker(s, () => 'http://localhost:4328');
  broker.discovery = { allowLocal: true, fetch: fakeFetch({}), registry: 'https://registry.test' };
  const run = { id: uid(), user_id: owner.id, employee_id: employee.id, conversation_id: employee.dmId, message_id: uid() };
  cleanup.push(async () => {
    await broker.close();
    s.close();
  });
  return { s, owner, employee, broker, run };
}
const server = (url: string, auth: 'oauth' | 'api_key' | 'unknown') => ({
  slug: 'acme-mail', label: 'Acme Mail', url, auth, publisher: 'acme.com', official: true, source: 'website' as const,
  apiKeyHelp: 'Create a key in Acme settings.',
});

describe('connecting any service', () => {
  it('signs in with OAuth discovered from the server, then enforces read/write grants by tool labels', async () => {
    const service = await startStandInMcp('oauth');
    cleanup.push(service.close);
    const f = fixture();
    const requested: any = f.broker.request(f.run, 'acme-mail', 'read', server(service.url, 'unknown'));
    expect(requested.status).toBe('setup_required');
    const id = requested.requestId;
    expect(f.s.one('SELECT label FROM connections WHERE id=?', id).label).toBe('Acme Mail');
    // Abralo discovers the sign-in server, registers itself, and returns the sign-in page.
    const started: any = await f.broker.connect(id, f.owner.id);
    expect(started.url).toMatch(new RegExp(`^${service.base}/authorize\\?`));
    expect(new URL(started.url).searchParams.get('redirect_uri')).toBe(`http://localhost:4328/oauth/callback/${id}`);
    // The human approves; the provider redirects back with a code.
    const back = await fetch(started.url, { redirect: 'manual' });
    const code = new URL(back.headers.get('location')!).searchParams.get('code')!;
    expect(await f.broker.connect(id, f.owner.id, code)).toMatchObject({ state: 'ready' });
    const data = JSON.parse(f.s.one('SELECT data FROM connections WHERE id=?', id).data);
    expect(data.tools.map((t: any) => t.name).sort()).toEqual(['list_domains', 'send_email']);
    // Grants follow the tool labels: with a read-only grant, writes are refused.
    f.s.run('UPDATE grants SET capabilities=? WHERE connection_id=?', JSON.stringify(['read']), id);
    const read: any = await f.broker.call(id, f.employee.id, f.owner.id, 'list_domains', {});
    expect(read.content[0].text).toContain('verified');
    await expect(f.broker.call(id, f.employee.id, f.owner.id, 'send_email', {})).rejects.toThrow('read-only');
    expect(service.calls.map((c) => c.name)).toEqual(['list_domains']);
    // No credential is stored in the database; tokens live only in the vault.
    expect(JSON.stringify(f.s.all('SELECT * FROM connections'))).not.toMatch(/access_token|Bearer/);
  });

  it('connects with an API key from Abralo’s form, rejects a wrong key, and never keeps it', async () => {
    const service = await startStandInMcp('api_key', 'sk_test_valid_key');
    cleanup.push(service.close);
    const f = fixture();
    const id = (f.broker.request(f.run, 'acme-mail', 'read', server(service.url, 'api_key')) as any).requestId;
    expect(await f.broker.connect(id, f.owner.id)).toMatchObject({ requiresApiKey: true, apiKeyHelp: 'Create a key in Acme settings.' });
    const wrong: any = await f.broker.useApiKey(id, f.owner.id, 'sk_test_wrong_key');
    expect(wrong).toMatchObject({ requiresApiKey: true });
    expect(wrong.message).toContain('did not accept');
    expect((await f.broker.storage()).get(id).apiKey).toBeUndefined();
    expect(await f.broker.useApiKey(id, f.owner.id, 'sk_test_valid_key')).toMatchObject({ state: 'ready' });
    expect(JSON.stringify(f.s.all('SELECT * FROM connections'))).not.toContain('sk_test_valid_key');
    // The agent that asked can use it straight away, with writes still approval-gated per action.
    expect(f.broker.status(id, f.employee.id, f.owner.id)).toMatchObject({ status: 'ready', capabilities: ['read', 'write'] });
    expect(f.s.all('SELECT * FROM connections WHERE state=?', 'ready')).toHaveLength(1);
  });

  it('falls back to an API key when a server offers no browser sign-in', async () => {
    const service = await startStandInMcp('api_key');
    cleanup.push(service.close);
    const f = fixture();
    const id = (f.broker.request(f.run, 'acme-mail', 'read', server(service.url, 'unknown')) as any).requestId;
    const result: any = await f.broker.connect(id, f.owner.id);
    expect(result).toMatchObject({ requiresApiKey: true });
    expect(result.message).toContain('API key');
    expect(f.s.one('SELECT state FROM connections WHERE id=?', id).state).toBe('awaiting_authorization');
  });

  it('lets an agent request a service by name, preferring the official server and warning about relays', async () => {
    const f = fixture();
    f.broker.discovery = {
      fetch: fakeFetch({
        'https://registry.test/v0.1/servers?search=notion&version=latest&limit=20': {
          servers: [{ server: { name: 'com.relay/notion', remotes: [{ type: 'streamable-http', url: 'https://relay.com/notion/mcp' }] } }],
        },
      }),
      registry: 'https://registry.test',
    };
    const relayed: any = await f.broker.requestAny(f.run, 'notion', 'read');
    expect(relayed).toMatchObject({ status: 'setup_required', server: { publisher: 'relay.com', official: false } });
    expect(relayed.warning).toContain('relay.com');
    const resend: any = await f.broker.requestAny(f.run, 'resend', 'write');
    expect(resend).toMatchObject({ service: 'resend', status: 'setup_required', requestedAccess: 'write' });
    const none: any = await f.broker.requestAny(f.run, 'no-such-service-xyz', 'read');
    expect(none.status).toBe('not_found');
    // Existing checked services keep their original behaviour.
    expect((await f.broker.requestAny(f.run, 'railway', 'read') as any).service).toBe('railway');
  });

  it('lets the owner add a service from the Connections page without an employee waiting', async () => {
    const service = await startStandInMcp('api_key', 'sk_test_valid_key');
    cleanup.push(service.close);
    const f = fixture();
    f.broker.discovery = {
      allowLocal: true,
      fetch: fakeFetch({
        'https://acme.com/.well-known/mcp.json': {
          name: 'Acme',
          remote: { url: service.url, authentication: { type: 'api_key' } },
        },
      }),
      registry: 'https://registry.test',
    };
    const added: any = await f.broker.addService(f.owner.id, 'Acme');
    expect(added).toMatchObject({ status: 'setup_required', server: { label: 'Acme', official: true } });
    const row = f.s.one('SELECT * FROM connections WHERE id=?', added.id);
    expect(row.state).toBe('awaiting_authorization');
    const data = JSON.parse(row.data);
    expect(data).toMatchObject({ addedByOwner: true, requestedWrite: true });
    expect(data.employeeId).toBeUndefined();
    // Adding it again reuses the same pending sign-in rather than piling up rows.
    expect((await f.broker.addService(f.owner.id, 'acme')).id).toBe(added.id);
    await f.broker.useApiKey(added.id, f.owner.id, 'sk_test_valid_key');
    expect(f.s.one('SELECT state FROM connections WHERE id=?', added.id).state).toBe('ready');
    // No employee was granted anything by the owner adding it.
    expect(f.s.all('SELECT * FROM grants WHERE connection_id=?', added.id)).toHaveLength(0);
    expect(await f.broker.addService(f.owner.id, 'Acme')).toMatchObject({ status: 'already_connected', id: added.id });
    // An employee asking later uses the existing account; changes still ask for approval.
    const shared: any = await f.broker.requestAny(f.run, 'Acme', 'read');
    expect(shared).toMatchObject({ status: 'ready', sharedAutomatically: true });
    await expect(f.broker.addService(f.owner.id, 'no-such-service-xyz')).rejects.toThrow(/couldn’t find/);
  });

  it('shares a connected account with the next employee automatically, unless the owner asks to be asked', async () => {
    const service = await startStandInMcp('api_key', 'sk_test_valid_key');
    cleanup.push(service.close);
    const f = fixture();
    const first: any = f.broker.request(f.run, 'acme-mail', 'read', server(service.url, 'api_key'), 'check the email domain');
    const card = JSON.parse(f.s.one('SELECT data FROM connections WHERE id=?', first.requestId).data);
    expect(card).toMatchObject({ reason: 'check the email domain', employeeName: 'Agent' });
    await f.broker.useApiKey(first.requestId, f.owner.id, 'sk_test_valid_key');
    const second = f.s.createEmployee(f.owner.id, { name: 'Second', harness: 'codex', model: '', cwd: '', role: '', instructions: '' });
    const run2 = { ...f.run, id: uid(), employee_id: second.id, conversation_id: second.dmId };
    const shared: any = await f.broker.requestAny(run2, 'Acme Mail', 'write');
    expect(shared).toMatchObject({ status: 'ready', sharedAutomatically: true, capabilities: ['read', 'write'] });
    expect(f.s.all("SELECT * FROM connections WHERE state='awaiting_authorization'")).toHaveLength(0);
    // Sharing posts no message; approval cards are where the human sees changes.
    expect(f.s.all("SELECT text FROM messages WHERE conversation_id=? AND kind='system'", second.dmId)).toHaveLength(0);
    // With "ask before sharing" on, a third employee gets a share card instead.
    f.s.set('connections.askBeforeSharing.' + f.owner.id, true);
    const third = f.s.createEmployee(f.owner.id, { name: 'Third', harness: 'opencode', model: '', cwd: '', role: '', instructions: '' });
    const asked: any = await f.broker.requestAny({ ...f.run, id: uid(), employee_id: third.id, conversation_id: third.dmId }, 'Acme Mail', 'read');
    expect(asked.status).toBe('grant_required');
  });
});
