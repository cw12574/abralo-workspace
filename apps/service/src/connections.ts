import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { randomBytes } from 'node:crypto';
import { Store, ApiError, hash } from './store.js';
import { Vault } from './vault.js';
import type { Supervisor } from './supervisor.js';
import { GmailConnection, gmailTools } from './gmail.js';
import { z } from 'zod';
const recipes: Record<string, { url: string; label: string; probe?: string }> = {
  stripe: { url: 'https://mcp.stripe.com', label: 'Stripe', probe: 'get_stripe_account_info' },
  railway: { url: 'https://mcp.railway.com', label: 'Railway' },
};
export class ConnectionBroker {
  announceReady(c: any) {
    const data = JSON.parse(c.data);
    if (!data.conversationId || this.store.setting('connection.announced.' + c.id)) return;
    const service =
      ({ stripe: 'Stripe', railway: 'Railway', gmail: 'Gmail' } as Record<string, string>)[
        c.service
      ] || c.service;
    this.store.db.transaction(() => {
      this.store.addMessage(
        data.conversationId,
        'workspace',
        'Workspace',
        'system',
        `${service} connected. Read-only access is ready${data.employeeId ? ' for ' + (this.store.employee(data.employeeId)?.name || 'your employee') : ''}.`,
      );
      this.store.set('connection.announced.' + c.id, true);
    })();
  }
  clients = new Map<string, Client>();
  locks = new Map<string, Promise<any>>();
  vault?: Vault;
  vaultPromise?: Promise<Vault>;
  constructor(
    public store: Store,
    public origin: () => string,
    public supervisor?: Supervisor,
  ) {}
  async resumeWaitingTask(
    connection: any,
    setupData = JSON.parse(connection.data),
    key = connection.id,
  ) {
    const s = this.store,
      employeeId = setupData.employeeId,
      conversationId = setupData.conversationId,
      requestId = setupData.requestMessageId,
      runId = setupData.runId;
    if (!employeeId || !conversationId || !requestId || !runId || !this.supervisor) return;
    const request = s.one(
        'SELECT * FROM messages WHERE id=? AND conversation_id=? AND deleted_at IS NULL',
        requestId,
        conversationId,
      ),
      employee = s.employee(employeeId),
      originRun = s.one(
        'SELECT * FROM runs WHERE id=? AND message_id=? AND employee_id=?',
        runId,
        requestId,
        employeeId,
      );
    if (!request || !employee || !originRun || !s.canUseEmployee(connection.owner_id, employeeId))
      return;
    try {
      s.authorize(connection.owner_id, conversationId);
      s.authorizeEmployee(employeeId, conversationId);
    } catch {
      return;
    }
    if (s.setting('connection.continuation.' + key)) return;
    const continuation = `Connection setup is complete for ${setupData.service || connection.service}. Continue the existing request from its current state. Use the connection only within the access the human granted. Do not repeat completed work. Keep any unresolved release choice unresolved, and do not publish or deploy without the required explicit instruction.`;
    const active = [
      'accepted',
      'dispatching',
      'running',
      'waiting_input',
      'waiting_permission',
      'cancelling',
    ].includes(originRun.state);
    if (active && this.supervisor.active.has(runId)) {
      const config = s.setting('run.config.' + runId, {});
      const adapter = this.supervisor.adapters[config.harness || employee.harness];
      if (adapter?.steer && (await adapter.steer(runId, continuation))) {
        s.set('connection.continuation.' + key, 'steered');
        return;
      }
    }
    if (!active && originRun.state !== 'completed') return;
    const queued = s.db.transaction(() => {
      if (s.setting('connection.continuation.' + key)) return false;
      const followup = s.addMessage(
        conversationId,
        'workspace',
        'Workspace',
        'system',
        continuation,
        request.thread_id || null,
      );
      for (const prefix of [
        'message.workingDirectory.',
        'message.modelOverride.',
        'delegation.purpose.',
        'message.context.',
      ]) {
        const value = s.setting(prefix + requestId);
        if (value !== undefined) s.set(prefix + followup.id, value);
      }
      s.run(
        'INSERT OR IGNORE INTO outbox VALUES(?,?,?,?,?,?)',
        key,
        followup.id,
        employeeId,
        connection.owner_id,
        'pending',
        new Date().toISOString(),
      );
      s.set('connection.continuation.' + key, 'queued');
      return true;
    })();
    if (!queued) return;
    void this.supervisor.dispatch();
  }
  async storage() {
    return (this.vaultPromise ??= Vault.open(this.store.dir).then((v) => (this.vault = v)));
  }
  async provider(id: string) {
    const vault = await this.storage();
    const self = this;
    let data = vault.get(id);
    const save = (key: string, value: any) => {
      data = { ...vault.get(id), [key]: value };
      vault.set(id, data);
    };
    const p: OAuthClientProvider = {
      redirectUrl: `${this.origin()}/oauth/callback/${id}`,
      clientMetadata: {
        client_name: 'Agent Workspace',
        redirect_uris: [`${this.origin()}/oauth/callback/${id}`],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      },
      state: () => {
        const state = randomBytes(32).toString('base64url');
        save('attempt', { stateHash: hash(state), expires: Date.now() + 10 * 60000 });
        return state;
      },
      clientInformation: () => vault.get(id).client,
      saveClientInformation: (c) => save('client', c),
      tokens: () => vault.get(id).tokens,
      saveTokens: (t) => save('tokens', t),
      redirectToAuthorization: (url) => {
        save('authorizationUrl', url.href);
      },
      saveCodeVerifier: (v) => save('verifier', v),
      codeVerifier: () => vault.get(id).verifier,
      invalidateCredentials: (scope) => {
        if (scope === 'all') vault.set(id, {});
        else
          save(
            scope === 'client' ? 'client' : scope === 'verifier' ? 'verifier' : 'tokens',
            undefined,
          );
      },
    };
    return p;
  }
  async connect(id: string, ownerId: string, code?: string) {
    const c = this.store.one('SELECT * FROM connections WHERE id=? AND owner_id=?', id, ownerId);
    if (!c) throw new ApiError(404, 'Connection unavailable');
    if (c.service === 'gmail') {
      const vault = await this.storage(),
        saved = vault.get(id),
        redirect = `${this.origin()}/oauth/callback/${id}`;
      if (!saved.googleClient)
        return {
          message:
            'This self-hosted installation needs a Google OAuth client once. Enable the Gmail API and register the redirect below, then enter the client details here. These fields go directly to the encrypted credential store.',
          requiresConfiguration: 'google-oauth',
          redirect,
        };
      const gmail = new GmailConnection(vault, id, redirect);
      if (!code && !saved.tokens)
        return {
          url: await gmail.authorize(!!saved.googleClient.write),
          message: 'Continue with Google. The requested access is shown before you connect.',
        };
      const account = code ? await gmail.finish(code) : await gmail.profile();
      const data = {
        ...JSON.parse(c.data),
        account,
        tools: gmailTools.filter((t) => saved.googleClient.write || t.annotations.readOnlyHint),
      };
      this.store.run(
        "UPDATE connections SET state='ready',label=?,data=? WHERE id=?",
        account.email,
        JSON.stringify(data),
        id,
      );
      if (data.employeeId)
        this.store.run(
          'INSERT OR IGNORE INTO grants VALUES(?,?,?)',
          id,
          data.employeeId,
          JSON.stringify(['read']),
        );
      this.store.emit('connection.ready', data.conversationId, { id }, ownerId);
      this.announceReady(c);
      await this.resumeWaitingTask(c);
      return { message: 'Connected to ' + account.email, state: 'ready' };
    }
    const recipe = recipes[c.service];
    if (!recipe) throw new ApiError(400, 'No verified connection recipe');
    const provider = await this.provider(id),
      client = new Client({ name: 'agent-workspace', version: '0.1.0' }),
      transport = new StreamableHTTPClientTransport(new URL(recipe.url), {
        authProvider: provider,
      });
    try {
      if (code) await transport.finishAuth(code);
      await client.connect(transport);
      const tools = await client.listTools();
      let account: any = null;
      if (recipe.probe && tools.tools.some((t) => t.name === recipe.probe))
        account = await client.callTool({ name: recipe.probe, arguments: {} });
      const data = JSON.parse(c.data);
      data.tools = tools.tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        annotations: t.annotations,
      }));
      data.account = account;
      if (account?.isError) throw new Error('The provider rejected the account verification.');
      const vault = await this.storage();
      vault.set(id, { ...vault.get(id), authorizationUrl: undefined });
      this.store.run(
        "UPDATE connections SET state='ready',data=? WHERE id=?",
        JSON.stringify(data),
        id,
      );
      if (data.employeeId)
        this.store.run(
          'INSERT OR IGNORE INTO grants VALUES(?,?,?)',
          id,
          data.employeeId,
          JSON.stringify(['read']),
        );
      await this.clients.get(id)?.close();
      this.clients.set(id, client);
      this.store.emit(
        'connection.ready',
        data.conversationId || null,
        { id, service: c.service },
        ownerId,
      );
      this.announceReady(c);
      await this.resumeWaitingTask(c);
      return { message: 'Connected and verified.', state: 'ready' };
    } catch (e: any) {
      await client.close().catch(() => {});
      const vault = await this.storage(),
        saved = vault.get(id);
      if (saved.authorizationUrl) {
        this.store.run("UPDATE connections SET state='awaiting_authorization' WHERE id=?", id);
        return {
          url: saved.authorizationUrl,
          message: 'Sign in with the provider and choose the account and access you want to grant.',
        };
      }
      this.store.run("UPDATE connections SET state='failed' WHERE id=?", id);
      throw new ApiError(502, 'Provider connection failed: ' + e.message);
    }
  }
  async ensure(id: string, ownerId: string) {
    let pending = this.locks.get(id);
    if (!pending) {
      pending = this.connect(id, ownerId).finally(() => this.locks.delete(id));
      this.locks.set(id, pending);
    }
    return pending;
  }
  async call(id: string, employeeId: string, ownerId: string, name: string, args: any) {
    const c = this.store.one(
      "SELECT c.*,g.capabilities FROM connections c JOIN grants g ON g.connection_id=c.id WHERE c.id=? AND c.owner_id=? AND g.employee_id=? AND c.state='ready'",
      id,
      ownerId,
      employeeId,
    );
    if (!c) throw new ApiError(403, 'Connection access is not granted.');
    const tool = JSON.parse(c.data).tools?.find((t: any) => t.name === name);
    if (!tool) throw new ApiError(400, 'Tool unavailable');
    const read = tool.annotations?.readOnlyHint === true;
    if (!read && !JSON.parse(c.capabilities).includes('write'))
      throw new ApiError(
        403,
        'This grant is read-only. Request write access explicitly for this task.',
      );
    if (c.service === 'gmail')
      return new GmailConnection(
        await this.storage(),
        id,
        `${this.origin()}/oauth/callback/${id}`,
      ).call(name, args);
    if (!this.clients.has(id)) await this.ensure(id, ownerId);
    const client = this.clients.get(id);
    if (!client) throw new ApiError(409, 'Sign-in needs to be completed.');
    return client.callTool({ name, arguments: args });
  }
  async close() {
    await Promise.all([...this.clients.values()].map((c) => c.close()));
  }
}
export function registerConnectionRoutes(app: any, broker: ConnectionBroker) {
  const s = broker.store;
  app.post('/api/connections/:id/google-client', async (req: any) => {
    const c = s.one(
      "SELECT * FROM connections WHERE id=? AND owner_id=? AND service='gmail'",
      req.params.id,
      req.user.id,
    );
    if (!c) throw new ApiError(403, 'Connection unavailable');
    const data = z
      .object({
        id: z.string().min(8).max(300),
        secret: z.string().min(1).max(500),
        write: z.boolean().default(false),
      })
      .parse(req.body);
    const vault = await broker.storage();
    vault.set(c.id, { ...vault.get(c.id), googleClient: data });
    return broker.connect(c.id, req.user.id);
  });
  app.post('/api/connections/:id/connect', async (req: any) =>
    broker.ensure(req.params.id, req.user.id),
  );
  app.post('/api/connections/:id/reuse', async (req: any) => {
    const request = s.one(
      'SELECT * FROM connections WHERE id=? AND owner_id=?',
      req.params.id,
      req.user.id,
    );
    if (!request) throw new ApiError(404, 'Request unavailable');
    const data = JSON.parse(request.data),
      existing = s.one(
        "SELECT * FROM connections WHERE id=? AND owner_id=? AND state='ready'",
        data.reuseId,
        req.user.id,
      );
    const employee = s.employee(data.employeeId);
    if (!existing || !employee || employee.ownerId !== req.user.id)
      throw new ApiError(409, 'Existing connection is no longer available');
    s.run(
      'INSERT INTO grants VALUES(?,?,?) ON CONFLICT(connection_id,employee_id) DO UPDATE SET capabilities=excluded.capabilities',
      existing.id,
      employee.id,
      JSON.stringify(data.requestedWrite ? ['read', 'write'] : ['read']),
    );
    s.run("UPDATE connections SET state='granted' WHERE id=?", request.id);
    s.emit('connection.ready', data.conversationId, { id: existing.id }, req.user.id);
    await broker.resumeWaitingTask(existing, data, request.id);
    return {
      state: 'granted',
      message:
        'Existing account shared with ' +
        employee.name +
        (data.requestedWrite ? ' for read and write access.' : ' for read access.'),
    };
  });
  app.post('/api/connections/:id/grant', async (req: any) => {
    const c = s.one(
      "SELECT * FROM connections WHERE id=? AND owner_id=? AND state='ready'",
      req.params.id,
      req.user.id,
    );
    const employee = s.employee(req.body?.employeeId);
    if (!c || !employee || employee.ownerId !== req.user.id)
      throw new ApiError(403, 'Account or employee unavailable');
    const capabilities = req.body.write ? ['read', 'write'] : ['read'];
    s.run(
      'INSERT INTO grants VALUES(?,?,?) ON CONFLICT(connection_id,employee_id) DO UPDATE SET capabilities=excluded.capabilities',
      c.id,
      employee.id,
      JSON.stringify(capabilities),
    );
    return { ok: true };
  });
  app.delete('/api/connections/:id', async (req: any) => {
    const c = s.one(
      'SELECT * FROM connections WHERE id=? AND owner_id=?',
      req.params.id,
      req.user.id,
    );
    if (!c) throw new ApiError(403, 'Account unavailable');
    (await broker.storage()).set(c.id, {});
    await broker.clients.get(c.id)?.close();
    broker.clients.delete(c.id);
    s.run('DELETE FROM grants WHERE connection_id=?', c.id);
    s.run("UPDATE connections SET state='disconnected' WHERE id=?", c.id);
    return { ok: true };
  });
  app.get('/oauth/callback/:id', async (req: any, reply: any) => {
    const c = s.one('SELECT * FROM connections WHERE id=?', req.params.id);
    if (!c) throw new ApiError(404, 'Unknown connection');
    const vault = await broker.storage(),
      data = vault.get(c.id);
    if (
      !req.query.state ||
      data.attempt?.expires < Date.now() ||
      hash(req.query.state) !== data.attempt?.stateHash
    )
      throw new ApiError(403, 'This sign-in request expired.');
    vault.set(c.id, { ...data, attempt: undefined, authorizationUrl: undefined });
    if (req.query.error)
      return reply
        .type('text/plain')
        .send('Sign-in cancelled. Return to your conversation to retry.');
    if (typeof req.query.code !== 'string') throw new ApiError(400, 'Missing authorization code');
    await broker.connect(c.id, c.owner_id, req.query.code);
    return reply
      .type('text/html')
      .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
      .send(
        '<!doctype html><title>Connected</title><body style="font:16px system-ui;padding:48px;background:#fcfbf8;color:#252a30"><h1>Connected.</h1><p>You can close this tab and return to your conversation.</p></body>',
      );
  });
  app.addHook('onClose', async () => broker.close());
}
