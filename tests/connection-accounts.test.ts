import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { Store, uid } from '../apps/service/src/store.js';
import { ConnectionBroker, registerConnectionRoutes } from '../apps/service/src/connections.js';
import { identityFromResult, identityFromTokens } from '../apps/service/src/connection-accounts.js';
import { startStandInMcp } from './helpers/stand-in-mcp.js';

vi.setConfig({ testTimeout: 30000 });
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const server = (url: string) => ({
  slug: 'acme-mail',
  label: 'Acme Mail',
  url,
  auth: 'oauth' as const,
  publisher: 'acme.com',
  official: true,
  source: 'website' as const,
});

async function fixture(identity = true) {
  const service = await startStandInMcp('oauth', undefined, { identity });
  const s = new Store(mkdtempSync(join(tmpdir(), 'connection-accounts-')));
  const owner = s.createOwner('Chris');
  const employee = s.createEmployee(owner.id, {
    name: 'Agent',
    harness: 'claude',
    model: '',
    cwd: '',
    role: '',
    instructions: '',
  });
  const broker = new ConnectionBroker(s, () => 'http://localhost:4328');
  broker.discovery = { allowLocal: true, registry: 'https://registry.test' };
  const app = Fastify();
  app.addHook('onRequest', async (req: any) => {
    req.user = owner;
  });
  registerConnectionRoutes(app, broker);
  const run = () => ({
    id: uid(),
    user_id: owner.id,
    employee_id: employee.id,
    conversation_id: employee.dmId,
    message_id: uid(),
  });
  /** Completes the provider's sign-in for a card, as the given account. */
  const signIn = async (id: string, email: string, start?: any) => {
    service.signInAs(email);
    const started: any = start || (await broker.connect(id, owner.id));
    const back = await fetch(started.url, { redirect: 'manual' });
    const code = new URL(back.headers.get('location')!).searchParams.get('code')!;
    return broker.connect(id, owner.id, code);
  };
  const request = (choice = {}, access = 'read') =>
    broker.request(run(), 'acme-mail', access, server(service.url), 'check the domain', choice);
  cleanup.push(async () => {
    await app.close();
    await broker.close();
    s.close();
    await service.close();
  });
  return { service, s, owner, employee, broker, app, run, signIn, request };
}

describe('several accounts on one service', () => {
  it('adds a second account beside the first, names both, and lets agents pick by name', async () => {
    const f = await fixture();
    const first = f.request();
    expect(await f.signIn(first.requestId, 'alice@example.com')).toMatchObject({ state: 'ready' });
    // The first sign-in does not force an account chooser.
    expect(f.service.prompts).toEqual([null]);
    expect(f.broker.request(f.run(), 'acme-mail', 'read')).toMatchObject({
      status: 'ready',
      connectionId: first.requestId,
      account: 'Acme Mail (alice@example.com)',
    });

    // The agent finds the wrong account and asks for another.
    const another = f.request({ newAccount: true });
    expect(another).toMatchObject({ status: 'setup_required', accounts: [{ account: 'Acme Mail (alice@example.com)' }] });
    const card = JSON.parse(f.s.one('SELECT data FROM connections WHERE id=?', another.requestId).data);
    expect(card).toMatchObject({ anotherAccount: true, ordinal: 2 });
    expect(card.reuseId).toBeUndefined();
    // A repeat request reuses the same card.
    expect(f.request({ newAccount: true }).requestId).toBe(another.requestId);
    const started: any = await f.broker.connect(another.requestId, f.owner.id);
    expect(new URL(started.url).searchParams.get('prompt')).toBe('select_account');
    expect(await f.signIn(another.requestId, 'bob@example.com', started)).toMatchObject({ state: 'ready' });

    // Both accounts are ready; the first stays the default.
    const listed = f.broker.accountSummary(f.owner.id, 'acme-mail');
    expect(listed).toEqual([
      { connectionId: first.requestId, account: 'Acme Mail (alice@example.com)', isDefault: true },
      { connectionId: another.requestId, account: 'Acme Mail (bob@example.com)', isDefault: false },
    ]);
    const byDefault = f.broker.request(f.run(), 'acme-mail', 'read');
    expect(byDefault).toMatchObject({ connectionId: first.requestId, isDefault: true });
    expect(byDefault.accounts).toHaveLength(2);
    expect(byDefault.accountNote).toContain('ask the human');
    const bob = f.broker.request(f.run(), 'acme-mail', 'read', undefined, undefined, { account: 'bob' });
    expect(bob).toMatchObject({ status: 'ready', connectionId: another.requestId });
    // Each account reaches its own data.
    const domains: any = await f.broker.call(bob.connectionId, f.employee.id, f.owner.id, 'list_domains', {});
    expect(domains.content[0].text).toBe('bob.mail.example.com: verified');
    expect(f.service.calls.at(-1)).toMatchObject({ name: 'list_domains', account: 'bob@example.com' });

    // An unknown name is never guessed.
    expect(f.broker.request(f.run(), 'acme-mail', 'read', undefined, undefined, { account: 'carol' })).toMatchObject({
      status: 'account_not_found',
      accounts: [{ account: 'Acme Mail (alice@example.com)' }, { account: 'Acme Mail (bob@example.com)' }],
    });
    expect(f.s.all("SELECT * FROM connections WHERE state='awaiting_authorization'")).toHaveLength(0);
  });

  it('refuses to add the same account twice and recovers when the human picks another', async () => {
    const f = await fixture();
    const first = f.request();
    await f.signIn(first.requestId, 'alice@example.com');
    const another = f.request({ newAccount: true });
    // The provider silently reused the browser's sign-in.
    const duplicate: any = await f.signIn(another.requestId, 'alice@example.com');
    expect(duplicate.state).toBe('duplicate');
    expect(duplicate.error).toContain('Acme Mail (alice@example.com)');
    expect(duplicate.error).toContain('sign out of Acme Mail');
    const row = f.s.one('SELECT * FROM connections WHERE id=?', another.requestId);
    expect(row.state).toBe('failed');
    expect(JSON.parse(row.data).lastError).toBe(duplicate.error);
    expect((await f.broker.storage()).get(another.requestId).tokens).toBeUndefined();
    expect(f.broker.accounts(f.owner.id, 'acme-mail')).toHaveLength(1);
    // Trying again with the other account works on the same card.
    expect(await f.signIn(another.requestId, 'bob@example.com')).toMatchObject({ state: 'ready' });
    expect(JSON.parse(f.s.one('SELECT data FROM connections WHERE id=?', another.requestId).data).lastError).toBeUndefined();
    expect(f.broker.accounts(f.owner.id, 'acme-mail')).toHaveLength(2);
  });

  it('lets the human answer a request by choosing an existing account, or switch a share card to a new sign-in', async () => {
    const f = await fixture();
    const alice = f.request();
    await f.signIn(alice.requestId, 'alice@example.com');
    const bobCard = f.request({ newAccount: true });
    await f.signIn(bobCard.requestId, 'bob@example.com');
    // A second employee asks for a different account; the human picks Bob's existing one.
    const second = f.s.createEmployee(f.owner.id, { name: 'Second', harness: 'codex', model: '', cwd: '', role: '', instructions: '' });
    const run2 = { ...f.run(), employee_id: second.id, conversation_id: second.dmId };
    const asked = f.broker.request(run2, 'acme-mail', 'write', undefined, 'send a test', { newAccount: true });
    const chosen = await f.app.inject({
      method: 'POST',
      url: `/api/connections/${asked.requestId}/reuse`,
      payload: { write: true, accountId: bobCard.requestId },
    });
    expect(chosen.statusCode).toBe(200);
    expect(chosen.json()).toMatchObject({ state: 'granted', connectionId: bobCard.requestId });
    expect(f.s.one('SELECT state FROM connections WHERE id=?', asked.requestId).state).toBe('granted');
    expect(f.broker.status(bobCard.requestId, second.id, f.owner.id).capabilities).toEqual(['read', 'write']);
    expect(f.broker.status(alice.requestId, second.id, f.owner.id).capabilities).toEqual([]);

    // With "ask before sharing" on, a share card can become a sign-in for another account.
    f.s.set('connections.askBeforeSharing.' + f.owner.id, true);
    const third = f.s.createEmployee(f.owner.id, { name: 'Third', harness: 'codex', model: '', cwd: '', role: '', instructions: '' });
    const share = f.broker.request({ ...f.run(), employee_id: third.id, conversation_id: third.dmId }, 'acme-mail', 'read');
    expect(share.status).toBe('grant_required');
    const switched = await f.app.inject({ method: 'POST', url: `/api/connections/${share.requestId}/use-another` });
    expect(new URL(switched.json().url).searchParams.get('prompt')).toBe('select_account');
    const data = JSON.parse(f.s.one('SELECT data FROM connections WHERE id=?', share.requestId).data);
    expect(data).toMatchObject({ anotherAccount: true, ordinal: 3 });
    expect(data.reuseId).toBeUndefined();
    expect(await f.signIn(share.requestId, 'carol@example.com', switched.json())).toMatchObject({ state: 'ready' });
    expect(f.broker.status(share.requestId, third.id, f.owner.id)).toMatchObject({ status: 'ready', account: 'Acme Mail (carol@example.com)' });
  });

  it('renames, changes the default, reconnects without losing access, and disconnects at the provider', async () => {
    const f = await fixture(false);
    const first = f.request();
    await f.signIn(first.requestId, 'alice@example.com');
    const second = f.request({ newAccount: true });
    await f.signIn(second.requestId, 'bob@example.com');
    // Without an identity from the provider, accounts are numbered.
    expect(f.broker.accountSummary(f.owner.id, 'acme-mail').map((a) => a.account)).toEqual(['Acme Mail', 'Acme Mail account 2']);

    const renamed = await f.app.inject({ method: 'PATCH', url: `/api/connections/${second.requestId}`, payload: { name: 'Abralo mail' } });
    expect(renamed.json()).toMatchObject({ account: 'Abralo mail', isDefault: false });
    const made = await f.app.inject({ method: 'PATCH', url: `/api/connections/${second.requestId}`, payload: { isDefault: true } });
    expect(made.json()).toMatchObject({ isDefault: true });
    expect(f.broker.request(f.run(), 'acme-mail', 'read')).toMatchObject({ connectionId: second.requestId });
    expect(f.broker.request(f.run(), 'acme-mail', 'read', undefined, undefined, { account: 'abralo mail' })).toMatchObject({ connectionId: second.requestId });
    await f.app.inject({ method: 'PATCH', url: `/api/connections/${second.requestId}`, payload: { name: '' } });
    expect(f.broker.accountName(f.s.one('SELECT * FROM connections WHERE id=?', second.requestId))).toBe('Acme Mail account 2');

    // Reconnect signs in again on the same entry and keeps every employee grant.
    const before = f.broker.status(second.requestId, f.employee.id, f.owner.id).capabilities;
    const again = await f.app.inject({ method: 'POST', url: `/api/connections/${second.requestId}/reconnect` });
    expect(again.json().url).toContain('/authorize');
    expect(f.s.one('SELECT state FROM connections WHERE id=?', second.requestId).state).toBe('awaiting_authorization');
    expect(f.broker.request(f.run(), 'acme-mail', 'read')).toMatchObject({ connectionId: first.requestId });
    await f.signIn(second.requestId, 'bob@example.com', again.json());
    expect(f.broker.status(second.requestId, f.employee.id, f.owner.id).capabilities).toEqual(before);

    // Disconnect ends access with the provider, and the default falls back.
    const token = (await f.broker.storage()).get(second.requestId).tokens.access_token;
    const removed = await f.app.inject({ method: 'DELETE', url: `/api/connections/${second.requestId}` });
    expect(removed.json()).toMatchObject({ ok: true, revoked: 'revoked' });
    expect(removed.json().message).toContain('cancelled Abralo');
    expect(f.service.revoked).toEqual([token]);
    expect(f.broker.request(f.run(), 'acme-mail', 'read')).toMatchObject({ connectionId: first.requestId });
  });

  it('names the account on write approvals', async () => {
    const f = await fixture();
    const first = f.request();
    await f.signIn(first.requestId, 'alice@example.com');
    const run = f.run();
    const action = f.broker.actions.request(run, first.requestId, 'send_email', { to: 'x@example.com' });
    const listed = await f.app.inject({ method: 'GET', url: `/api/connection-actions?conversationId=${run.conversation_id}` });
    expect(listed.json().find((a: any) => a.actionId === action.actionId)).toMatchObject({
      account: 'Acme Mail (alice@example.com)',
    });
  });

  it('reads account names from tokens and tool results without trusting them for access', () => {
    const jwt = (claims: any) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;
    expect(identityFromTokens({ access_token: jwt({ email: 'team@abralo.com' }) })).toBe('team@abralo.com');
    expect(identityFromTokens({ access_token: 'opaque-token' })).toBeUndefined();
    expect(identityFromResult({ content: [{ type: 'text', text: 'Name: Abralo' }] })).toBe('Abralo');
    expect(identityFromResult({ isError: true, content: [{ type: 'text', text: 'a@b.com' }] })).toBeUndefined();
  });
});
