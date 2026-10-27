import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { randomBytes } from 'node:crypto';
import { Store, ApiError, hash, uid } from './store.js';
import { ConnectionActions } from './connection-actions.js';
import { Vault } from './vault.js';
import type { Supervisor } from './supervisor.js';
import { GmailConnection, gmailTools } from './gmail.js';
import { z } from 'zod';
const recipes: Record<string, { url: string; label: string; probe?: string }> = {
  stripe: { url: 'https://mcp.stripe.com', label: 'Stripe', probe: 'get_stripe_account_info' },
  railway: { url: 'https://mcp.railway.com', label: 'Railway' },
};
export class ConnectionBroker {
  actions: ConnectionActions;
  resolve(id: string, ownerId: string) {
    const c = this.store.one('SELECT * FROM connections WHERE id=? AND owner_id=?', id, ownerId);
    if (!c) throw new ApiError(404, 'Connection unavailable');
    const data = JSON.parse(c.data);
    if (data.reuseId) {
      const account = this.store.one(
        'SELECT * FROM connections WHERE id=? AND owner_id=?',
        data.reuseId,
        ownerId,
      );
      if (!account || account.service !== c.service)
        throw new ApiError(404, 'Connected account unavailable');
      return account;
    }
    return c;
  }
  status(id: string, employeeId: string, ownerId: string) {
    const c = this.resolve(id, ownerId),
      data = JSON.parse(c.data);
    const grant = this.store.one(
      'SELECT capabilities FROM grants WHERE connection_id=? AND employee_id=?',
      c.id,
      employeeId,
    );
    const capabilities: string[] = grant ? JSON.parse(grant.capabilities) : [];
    return {
      id: c.id,
      connectionId: c.id,
      requestId: id !== c.id ? id : undefined,
      service: c.service,
      label: c.label,
      state: c.state,
      capabilities,
      status: c.state === 'ready' ? (grant ? 'ready' : 'grant_required') : c.state,
      toolCount: grant ? data.tools?.length || 0 : 0,
      nextStep:
        c.state === 'ready'
          ? grant
            ? 'Use this connectionId. Writes return a durable Abralo action approval; do not reconnect.'
            : 'Share the existing account using the setup card.'
          : 'Complete the existing setup card. Do not create another connection.',
    };
  }
  request(run: any, service: string, access: string) {
    const s = this.store;
    const accounts = s.all(
      "SELECT * FROM connections WHERE owner_id=? AND service=? AND state='ready'",
      run.user_id,
      service,
    );
    const granted = accounts.find((c) => {
      const status = this.status(c.id, run.employee_id, run.user_id);
      return status.capabilities.includes(access);
    });
    if (granted) return this.status(granted.id, run.employee_id, run.user_id);
    const pending = s
      .all(
        "SELECT * FROM connections WHERE owner_id=? AND service=? AND state IN ('awaiting_authorization','failed','disconnected')",
        run.user_id,
        service,
      )
      .find((c) => {
        const d = JSON.parse(c.data);
        return d.employeeId === run.employee_id && d.conversationId === run.conversation_id;
      });
    const id = pending?.id || uid();
    const data = {
      ...(pending ? JSON.parse(pending.data) : {}),
      employeeId: run.employee_id,
      conversationId: run.conversation_id,
      requestMessageId: run.message_id,
      runId: run.id,
      service,
      requestedWrite: access === 'write' || !!(pending && JSON.parse(pending.data).requestedWrite),
      ...(accounts[0] ? { reuseId: accounts[0].id, accountLabel: accounts[0].label } : {}),
    };
    if (pending) s.run('UPDATE connections SET data=? WHERE id=?', JSON.stringify(data), id);
    else
      s.run(
        'INSERT INTO connections VALUES(?,?,?,?,?,?)',
        id,
        run.user_id,
        service,
        service,
        'awaiting_authorization',
        JSON.stringify(data),
      );
    s.emit('connection.requested', run.conversation_id, { id, service }, run.user_id);
    return {
      ...this.status(id, run.employee_id, run.user_id),
      requestId: id,
      status: data.reuseId ? 'grant_required' : 'setup_required',
      requestedAccess: data.requestedWrite ? 'write' : 'read',
      nextStep:
        'Use the existing inline setup card. Do not create another request or ask for secrets in chat.',
    };
  }
  access(id: string, employeeId: string, ownerId: string, name: string) {
    const c = this.resolve(id, ownerId);
    const status = this.status(c.id, employeeId, ownerId);
    if (status.status !== 'ready')
      throw new ApiError(403, 'Connection access is not ready. Check workspace_connection_status.');
    const tool = JSON.parse(c.data).tools?.find((t: any) => t.name === name);
    if (!tool)
      throw new ApiError(
        400,
        'Tool unavailable. Refresh workspace_connection_tools before choosing a tool.',
      );
    const read = tool.annotations?.readOnlyHint === true;
    if (!status.capabilities.includes(read ? 'read' : 'write'))
      throw new ApiError(
        403,
        'This account grant is read-only. Request write access on the existing connection.',
      );
    return { connection: c, tool, read };
  }
  announceReady(c: any) {
    const data = JSON.parse(c.data);
    if (!data.conversationId || this.store.setting('connection.announced.' + c.id)) return;
    const service =
      ({ stripe: 'Stripe', railway: 'Railway', gmail: 'Gmail' } as Record<string, string>)[
        c.service
      ] || c.service;
    const grant = data.employeeId
      ? this.store.one(
          'SELECT capabilities FROM grants WHERE connection_id=? AND employee_id=?',
          c.id,
          data.employeeId,
        )
      : null;
    const write = grant && JSON.parse(grant.capabilities).includes('write');
    this.store.db.transaction(() => {
      this.store.addMessage(
        data.conversationId,
        'workspace',
        'Workspace',
        'system',
        `${service} connected. ${write ? 'Read and write' : 'Read-only'} access is ready${data.employeeId ? ' for ' + (this.store.employee(data.employeeId)?.name || 'your employee') : ''}.`,
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
  ) {
    this.actions = new ConnectionActions(store, this);
  }
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
    // Reconnection can unblock a later task on the same account. Dedupe per originating run.
    key += '.' + runId;
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
    const continuation =
      setupData.continuation ||
      `Connection setup is complete for ${setupData.service || connection.service}. Use workspace_connection_status with connectionId ${connection.id} to check the exact access granted. Continue the existing request from its current state. Do not repeat completed work or publish or deploy without the human's instruction.`;
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
      if (adapter?.steer && (await adapter.steer(runId, continuation).catch(() => false))) {
        s.set('connection.continuation.' + key, 'steered');
        return;
      }
    }
    if (!active && !['completed', 'interrupted'].includes(originRun.state)) return;
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
    if (JSON.parse(c.data).reuseId)
      throw new ApiError(
        409,
        'This is an access request. Use the existing account button; sign-in is already complete.',
      );
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
          JSON.stringify(data.approvedAccess || ['read']),
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
      const tools: { tools: any[] } = { tools: [] };
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined);
        tools.tools.push(...page.tools);
        cursor = page.nextCursor;
        if (cursor && (cursors.has(cursor) || cursors.size >= 100))
          throw new Error('Provider tool pagination did not finish.');
        if (cursor) cursors.add(cursor);
      } while (cursor);
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
          JSON.stringify(data.approvedAccess || ['read']),
        );
      await this.clients.get(id)?.close();
      this.clients.set(id, client);
      client.onclose = () => {
        if (this.clients.get(id) === client) this.clients.delete(id);
      };
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
      this.store.emit(
        'connection.ready',
        JSON.parse(c.data).conversationId || null,
        { id, state: 'failed' },
        ownerId,
      );
      throw new ApiError(
        502,
        'The provider could not verify this connection. Retry this connection card; you do not need a new account setup.',
      );
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
    const { connection: c, read } = this.access(id, employeeId, ownerId, name);
    id = c.id;
    if (c.service === 'gmail') {
      const vault = await this.storage();
      this.access(id, employeeId, ownerId, name);
      return new GmailConnection(vault, id, `${this.origin()}/oauth/callback/${id}`).call(
        name,
        args,
      );
    }
    if (!this.clients.has(id)) await this.ensure(id, ownerId);
    this.access(id, employeeId, ownerId, name);
    const client = this.clients.get(id);
    if (!client) throw new ApiError(409, 'Sign-in needs to be completed.');
    try {
      return await client.callTool({ name, arguments: args });
    } catch (error: any) {
      // Only reads are eligible for one transport recovery. Never retry a dispatched write.
      if (!read || !/closed|session|fetch failed|ECONNRESET/i.test(String(error?.message)))
        throw error;
      this.clients.delete(id);
      await client.close().catch(() => {});
      await this.ensure(id, ownerId);
      this.access(id, employeeId, ownerId, name);
      const recovered = this.clients.get(id);
      if (!recovered)
        throw new ApiError(409, 'Sign-in needs to be completed on the existing connection card.');
      return recovered.callTool({ name, arguments: args });
    }
  }
  async close() {
    await Promise.allSettled([...this.actions.inflight]);
    await Promise.all([...this.clients.values()].map((c) => c.close()));
  }
}
export function registerConnectionRoutes(app: any, broker: ConnectionBroker) {
  const s = broker.store;
  app.get('/api/connections/native-mcp', async (req: any) => ({
    enabled: s.setting('connections.nativeMcp.' + req.user.id, false),
  }));
  app.put('/api/connections/native-mcp', async (req: any) => {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    s.set('connections.nativeMcp.' + req.user.id, enabled);
    s.emit('workspace.changed', null, { nativeMcp: enabled }, req.user.id);
    return { enabled };
  });
  app.get('/api/connection-actions', async (req: any) => {
    const conversationId = z.string().parse(req.query.conversationId);
    s.authorize(req.user.id, conversationId);
    return s
      .all(
        "SELECT a.*,c.service,c.label FROM connection_actions a JOIN connections c ON c.id=a.connection_id WHERE a.owner_id=? AND a.conversation_id=? AND (a.state IN ('awaiting_approval','running','unknown') OR a.id IN (SELECT id FROM connection_actions WHERE owner_id=? AND conversation_id=? ORDER BY created_at DESC LIMIT 5)) ORDER BY a.created_at ASC",
        req.user.id,
        conversationId,
        req.user.id,
        conversationId,
      )
      .map((a) => ({
        ...broker.actions.receipt(a),
        service: a.service,
        label: a.label,
        arguments: JSON.parse(a.arguments),
      }));
  });
  app.post('/api/connection-actions/:id/decision', async (req: any) => {
    const { allow } = z.object({ allow: z.boolean() }).parse(req.body);
    return broker.actions.decide(req.params.id, req.user.id, allow);
  });
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
  app.post('/api/connections/:id/connect', async (req: any) => {
    const c = broker.resolve(req.params.id, req.user.id);
    if (c.id !== req.params.id)
      throw new ApiError(409, 'Use the existing account button to share this connection.');
    const body = z.object({ grantWrite: z.boolean().optional() }).parse(req.body || {});
    const data = JSON.parse(c.data);
    if (body.grantWrite !== undefined && c.state !== 'ready') {
      data.approvedAccess = body.grantWrite ? ['read', 'write'] : ['read'];
      s.run('UPDATE connections SET data=? WHERE id=?', JSON.stringify(data), c.id);
    }
    return broker.ensure(c.id, req.user.id);
  });
  app.post('/api/connections/:id/reuse', async (req: any) => {
    const { write } = z.object({ write: z.boolean() }).parse(req.body);
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
    if (write !== !!data.requestedWrite)
      throw new ApiError(409, 'The requested access changed. Review the updated connection card.');
    const employee = s.employee(data.employeeId);
    if (!existing || !employee || !s.canUseEmployee(req.user.id, employee.id))
      throw new ApiError(409, 'Existing connection is no longer available');
    s.run(
      'INSERT INTO grants VALUES(?,?,?) ON CONFLICT(connection_id,employee_id) DO UPDATE SET capabilities=excluded.capabilities',
      existing.id,
      employee.id,
      JSON.stringify(
        data.requestedWrite ||
          broker.status(existing.id, employee.id, req.user.id).capabilities.includes('write')
          ? ['read', 'write']
          : ['read'],
      ),
    );
    // Settle all older duplicate cards for this employee and account without changing their scopes.
    for (const duplicate of s.all(
      "SELECT * FROM connections WHERE owner_id=? AND service=? AND state='awaiting_authorization'",
      req.user.id,
      request.service,
    )) {
      const d = JSON.parse(duplicate.data);
      if (
        d.reuseId === existing.id &&
        d.employeeId === employee.id &&
        (!d.requestedWrite || data.requestedWrite)
      )
        s.run("UPDATE connections SET state='granted' WHERE id=?", duplicate.id);
    }
    s.emit('connection.ready', data.conversationId, { id: existing.id }, req.user.id);
    await broker.resumeWaitingTask(existing, data, request.id);
    return {
      state: 'granted',
      connectionId: existing.id,
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
    if (!c || !employee || !s.canUseEmployee(req.user.id, employee.id))
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
    s.emit(
      'connection.ready',
      JSON.parse(c.data).conversationId || null,
      { id: c.id },
      req.user.id,
    );
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
    if (req.query.error) {
      s.run("UPDATE connections SET state='failed' WHERE id=?", c.id);
      s.emit(
        'connection.ready',
        JSON.parse(c.data).conversationId || null,
        { id: c.id, state: 'failed' },
        c.owner_id,
      );
      return reply
        .type('text/plain')
        .send('Sign-in cancelled. Return to your conversation to retry.');
    }
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
