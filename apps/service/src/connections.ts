import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { createHash, randomBytes } from 'node:crypto';
import { Store, ApiError, hash, uid, now } from './store.js';
import { ConnectionActions } from './connection-actions.js';
import { Vault } from './vault.js';
import type { Supervisor } from './supervisor.js';
import { GmailConnection, gmailTools } from './gmail.js';
import { z } from 'zod';
import {
  builtInServices,
  discoverServices,
  integrationServices,
  safeServerUrl,
  type DiscoveryOptions,
  type ServiceCandidate,
} from './connection-discovery.js';
import {
  chooseAccount,
  identityFromResult,
  identityFromTokens,
  identityTool,
  revokeOAuth,
} from './connection-accounts.js';
/** How an agent picks among several accounts on one service. */
export type AccountChoice = { account?: string; newAccount?: boolean };
// Account checks after sign-in, for services Abralo has verified.
const probes: Record<string, string> = { stripe: 'get_stripe_account_info' };
export class ConnectionBroker {
  actions: ConnectionActions;
  /** Tests may point discovery at a stand-in registry or local service. */
  discovery: DiscoveryOptions = {};
  /** The MCP server behind a connection: a checked service, or the one the human chose. */
  server(c: any): ServiceCandidate | null {
    if (builtInServices[c.service]) return builtInServices[c.service];
    const saved = JSON.parse(c.data).server;
    return saved && safeServerUrl(saved.url, this.discovery.allowLocal) ? saved : null;
  }
  label(c: any) {
    return (
      ({ gmail: 'Gmail' } as Record<string, string>)[c.service] ||
      this.server(c)?.label ||
      c.label ||
      c.service
    );
  }
  /** Ready accounts for one service, oldest first. */
  accounts(ownerId: string, service: string): any[] {
    return this.store.all(
      "SELECT * FROM connections WHERE owner_id=? AND service=? AND state='ready' ORDER BY rowid",
      ownerId,
      service,
    );
  }
  /** The account agents use unless a task names another: the chosen default, else the oldest. */
  defaultAccount(ownerId: string, service: string, accounts = this.accounts(ownerId, service)) {
    const chosen = this.store.setting(`connections.default.${ownerId}.${service}`);
    return accounts.find((a) => a.id === chosen) || accounts[0];
  }
  /** A name that tells accounts apart: the human's own name, the provider's identity, or a number. */
  accountName(c: any) {
    const data = JSON.parse(c.data),
      service = this.label(c);
    if (data.customName) return data.customName as string;
    if (data.identity && data.identity !== service) return `${service} (${data.identity})`;
    if (data.ordinal > 1) return `${service} account ${data.ordinal}`;
    return c.service === 'gmail' && c.label !== 'gmail' ? (c.label as string) : service;
  }
  accountSummary(ownerId: string, service: string) {
    const accounts = this.accounts(ownerId, service),
      fallback = this.defaultAccount(ownerId, service, accounts);
    return accounts.map((a) => ({
      connectionId: a.id,
      account: this.accountName(a),
      isDefault: a.id === fallback?.id,
    }));
  }
  /** Match an agent's account name to one connected account: exact first, then a unique partial match. */
  findAccount(ownerId: string, service: string, name: string) {
    const wanted = name.trim().toLowerCase();
    const accounts = this.accounts(ownerId, service);
    const names = (a: any) => {
      const data = JSON.parse(a.data);
      return [a.id, this.accountName(a), data.identity, data.customName, a.label]
        .filter(Boolean)
        .map((v: string) => v.toLowerCase());
    };
    const exact = accounts.filter((a) => names(a).includes(wanted));
    if (exact.length === 1) return exact[0];
    const partial = accounts.filter((a) => names(a).some((v) => v.includes(wanted)));
    return partial.length === 1 ? partial[0] : undefined;
  }
  discover(query: string) {
    return discoverServices(query, this.discovery);
  }
  /**
   * An agent may name any service. Checked services and existing accounts are
   * reused; otherwise the best discovered server becomes a setup card, which
   * shows who runs it. Nothing connects until the human chooses to.
   */
  async requestAny(
    run: any,
    query: string,
    access: string,
    reason?: string,
    choice: AccountChoice = {},
  ) {
    const name = query.trim().toLowerCase();
    if (integrationServices.has(name) || builtInServices[name])
      return this.request(run, name, access, undefined, reason, choice);
    const existing = this.store
      .all(
        "SELECT * FROM connections WHERE owner_id=? AND state IN ('ready','awaiting_authorization','failed','disconnected')",
        run.user_id,
      )
      .find((c) => {
        const server = this.server(c);
        return (
          !JSON.parse(c.data).reuseId &&
          [c.service, c.label, server?.label, server?.publisher, server?.url]
            .filter(Boolean)
            .some((v: string) => v.toLowerCase() === name || v.toLowerCase().startsWith(name + '.'))
        );
      });
    if (existing)
      return this.request(
        run,
        existing.service,
        access,
        this.server(existing) || undefined,
        reason,
        choice,
      );
    const candidates = await this.discover(query);
    let best = candidates.find((c) => c.official) || candidates[0];
    // Two different servers can share a name. Keep accounts on different addresses apart.
    if (
      best &&
      this.store
        .all('SELECT * FROM connections WHERE owner_id=? AND service=?', run.user_id, best.slug)
        .some((c) => (this.server(c)?.url || '') !== best!.url)
    )
      best = { ...best, slug: `${best.slug}-${hash(best.url).slice(0, 8)}` };
    if (!best)
      return {
        status: 'not_found',
        service: query,
        candidates: [],
        nextStep:
          'No connectable MCP server was found. Ask the human for the service’s MCP server address, then call workspace_connection again with that address.',
      };
    return {
      ...this.request(run, best.slug, access, best, reason, choice),
      server: { label: best.label, url: best.url, publisher: best.publisher, official: best.official },
      ...(best.official
        ? {}
        : {
            warning: `This server is run by ${best.publisher}, not by the service itself. The human decides on the setup card whether to trust it.`,
          }),
    };
  }
  /**
   * The owner adds a service from the Connections page. Same discovery as an
   * agent request, but no employee is waiting: the account is connected for
   * the workspace, and employees still need grants and approvals to use it.
   */
  async addService(ownerId: string, query: string) {
    const name = query.trim().toLowerCase();
    const ready = this.store
      .all("SELECT * FROM connections WHERE owner_id=? AND state='ready'", ownerId)
      .find((c) => {
        const server = this.server(c);
        return [c.service, c.label, server?.label, server?.publisher]
          .filter(Boolean)
          .some((v: string) => v.toLowerCase() === name);
      });
    if (ready) return { status: 'already_connected', id: ready.id, service: ready.service };
    let candidate: ServiceCandidate | undefined;
    let service = name;
    if (!integrationServices.has(name)) {
      candidate = builtInServices[name] || (await this.discover(query)).sort((a, b) => Number(b.official) - Number(a.official))[0];
      if (!candidate)
        throw new ApiError(404, `Abralo couldn’t find a way to connect “${query.trim()}”. Check the name or ask an employee to set it up.`);
      service = candidate.slug;
      if (
        this.store
          .all('SELECT * FROM connections WHERE owner_id=? AND service=?', ownerId, service)
          .some((c) => (this.server(c)?.url || '') !== candidate!.url)
      )
        service = `${service}-${hash(candidate.url).slice(0, 8)}`;
    }
    const pending = this.store
      .all(
        "SELECT * FROM connections WHERE owner_id=? AND service=? AND state IN ('awaiting_authorization','failed','disconnected')",
        ownerId,
        service,
      )
      .find((c) => JSON.parse(c.data).addedByOwner);
    if (pending) return { status: 'setup_required', id: pending.id, service };
    const id = uid();
    this.store.run(
      'INSERT INTO connections VALUES(?,?,?,?,?,?)',
      id,
      ownerId,
      service,
      candidate?.label || service,
      'awaiting_authorization',
      JSON.stringify({
        service,
        addedByOwner: true,
        requestedWrite: true,
        ...(candidate && !builtInServices[service] ? { server: candidate } : {}),
      }),
    );
    this.store.emit('connection.requested', null, { id, service }, ownerId);
    return {
      status: 'setup_required',
      id,
      service,
      ...(candidate ? { server: { label: candidate.label, publisher: candidate.publisher, official: candidate.official } } : {}),
    };
  }
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
    const siblings = c.state === 'ready' ? this.accountSummary(ownerId, c.service) : [];
    return {
      id: c.id,
      connectionId: c.id,
      requestId: id !== c.id ? id : undefined,
      service: c.service,
      label: c.label,
      account: this.accountName(c),
      ...(siblings.length > 1
        ? { isDefault: !!siblings.find((a) => a.connectionId === c.id)?.isDefault }
        : {}),
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
  /** Owners can require a card before an account is shared with another employee. */
  asksBeforeSharing(ownerId: string) {
    return !!this.store.setting('connections.askBeforeSharing.' + ownerId, false);
  }
  request(
    run: any,
    service: string,
    access: string,
    server?: ServiceCandidate,
    reason?: string,
    choice: AccountChoice = {},
  ): any {
    const s = this.store;
    const accounts = this.accounts(run.user_id, service);
    // Every card keeps the server address, so it can become a sign-in for another account.
    server ??= (accounts[0] && this.server(accounts[0])) || undefined;
    const named =
      choice.account && !choice.newAccount
        ? this.findAccount(run.user_id, service, choice.account)
        : undefined;
    if (choice.account && !choice.newAccount && !named && accounts.length)
      return {
        status: 'account_not_found',
        service,
        accounts: this.accountSummary(run.user_id, service),
        nextStep:
          'No connected account matches that name. Use one of these accounts, ask the human which one the task needs, or call workspace_connection with newAccount: true so they can sign in to another account.',
      };
    const another = !!choice.newAccount && accounts.length > 0;
    const chosen = another ? undefined : named || this.defaultAccount(run.user_id, service, accounts);
    // With several accounts, agents see them all and ask rather than guess.
    const withChoices = <T extends object>(result: T) =>
      accounts.length > 1
        ? {
            ...result,
            accounts: this.accountSummary(run.user_id, service),
            accountNote:
              'Several accounts are connected. This is the default unless you named another. If the task does not make clear which account to use, ask the human.',
          }
        : result;
    if (chosen && this.status(chosen.id, run.employee_id, run.user_id).capabilities.includes(access))
      return withChoices(this.status(chosen.id, run.employee_id, run.user_id));
    if (chosen && !this.asksBeforeSharing(run.user_id)) {
      // The human already connected this account. Every write still needs their
      // approval, so sharing it with their own employee adds no unapproved power.
      const account = chosen;
      s.db.transaction(() => {
        s.run(
          'INSERT INTO grants VALUES(?,?,?) ON CONFLICT(connection_id,employee_id) DO UPDATE SET capabilities=excluded.capabilities',
          account.id,
          run.employee_id,
          JSON.stringify(['read', 'write']),
        );
        const noted = `connection.shared.${account.id}.${run.employee_id}`;
        if (!s.setting(noted)) {
          this.noteSharing(run, account);
          s.set(noted, true);
        }
      })();
      return withChoices({
        ...this.status(account.id, run.employee_id, run.user_id),
        sharedAutomatically: true,
      });
    }
    const pending = s
      .all(
        "SELECT * FROM connections WHERE owner_id=? AND service=? AND state IN ('awaiting_authorization','failed','disconnected')",
        run.user_id,
        service,
      )
      .find((c) => {
        const d = JSON.parse(c.data);
        return (
          d.employeeId === run.employee_id &&
          d.conversationId === run.conversation_id &&
          !!d.anotherAccount === another
        );
      });
    const id = pending?.id || uid();
    const data = {
      ...(pending ? JSON.parse(pending.data) : {}),
      employeeId: run.employee_id,
      conversationId: run.conversation_id,
      requestMessageId: run.message_id,
      runId: run.id,
      service,
      ...(server && !builtInServices[service] ? { server } : {}),
      ...(reason ? { reason: reason.slice(0, 200) } : {}),
      employeeName: s.employee(run.employee_id)?.name,
      requestedWrite: access === 'write' || !!(pending && JSON.parse(pending.data).requestedWrite),
      ...(chosen ? { reuseId: chosen.id, accountLabel: this.accountName(chosen) } : {}),
      // A second sign-in on the same service: numbered until the provider names it.
      ...(another ? { anotherAccount: true, ordinal: accounts.length + 1 } : {}),
    };
    if (!chosen) {
      delete data.reuseId;
      delete data.accountLabel;
    }
    if (pending) s.run('UPDATE connections SET data=? WHERE id=?', JSON.stringify(data), id);
    else
      s.run(
        'INSERT INTO connections VALUES(?,?,?,?,?,?)',
        id,
        run.user_id,
        service,
        server?.label || service,
        'awaiting_authorization',
        JSON.stringify(data),
      );
    s.emit('connection.requested', run.conversation_id, { id, service }, run.user_id);
    return {
      ...this.status(id, run.employee_id, run.user_id),
      requestId: id,
      status: data.reuseId ? 'grant_required' : 'setup_required',
      requestedAccess: data.requestedWrite ? 'write' : 'read',
      ...(another ? { accounts: this.accountSummary(run.user_id, service) } : {}),
      nextStep: another
        ? 'The human sees one card to pick an existing account or sign in to another. This task resumes automatically with the account they choose. Do not create another request.'
        : 'Use the existing inline setup card. Do not create another request or ask for secrets in chat.',
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
  /**
   * Records that an employee started using an account as a quiet step inside the
   * reply in progress. It is never a separate message: the approval card is the
   * one place the human learns about changes to their account.
   */
  noteSharing(run: any, account: any) {
    const s = this.store,
      name = this.accountName(account);
    const live = s.one(
      "SELECT r.response_id,m.text FROM runs r JOIN messages m ON m.id=r.response_id WHERE r.id=? AND r.state IN ('accepted','dispatching','running','waiting_input','waiting_permission')",
      run.id,
    );
    if (!live) return;
    const at = now();
    const activity = {
      // Same id scheme as harness steps, so detail lookups find it.
      id: `${run.id}:connection-shared-${account.id}`,
      type: 'connection',
      title: `Using your ${name} account`,
      label: `Using your ${name} account`,
      state: 'complete',
      time: at,
      updatedAt: at,
      textOffset: (live.text || '').length,
    };
    s.run(
      'INSERT INTO activities VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
      activity.id,
      run.id,
      JSON.stringify(activity),
    );
    s.emit('activity.updated', run.conversation_id, { messageId: live.response_id, activity });
  }
  announceReady(c: any) {
    c = this.store.one('SELECT * FROM connections WHERE id=?', c.id) || c;
    const data = JSON.parse(c.data);
    if (!data.conversationId || this.store.setting('connection.announced.' + c.id)) return;
    const service = this.accountName(c);
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
    const goalCycle = s.one('SELECT * FROM goal_cycles WHERE message_id=?', requestId);
    if (goalCycle) {
      const goal = s.one('SELECT * FROM goals WHERE id=?', goalCycle.goal_id);
      if (!goal || goal.status !== 'active' || goal.lead_agent_id !== employeeId) return;
      s.db.transaction(() => {
        s.set('goal.signal.' + goal.id, { context: continuation, at: now() });
        s.set('connection.continuation.' + key, 'goal_queued');
      })();
      void this.supervisor.dispatch();
      return;
    }
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
      // The continuation is an instruction for the agent, not news for the human:
      // it wakes the agent but never appears in the conversation.
      const followup = s.addMessage(
        conversationId,
        'workspace',
        'Workspace',
        'system',
        continuation,
        request.thread_id || null,
        [],
        null,
        true,
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
        // With another account already connected, the provider must ask which
        // account to use instead of silently reusing the browser's sign-in.
        const c = self.store.one('SELECT * FROM connections WHERE id=?', id);
        const another =
          c &&
          (JSON.parse(c.data).anotherAccount ||
            self.accounts(c.owner_id, c.service).some((a) => a.id !== id));
        save('authorizationUrl', (another ? chooseAccount(new URL(url.href)) : url).href);
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
          url: await gmail.authorize(
          !!saved.googleClient.write,
          this.accounts(c.owner_id, 'gmail').some((a) => a.id !== id),
        ),
          message: 'Continue with Google. The requested access is shown before you connect.',
        };
      const account = code ? await gmail.finish(code) : await gmail.profile();
      const data = {
        ...JSON.parse(c.data),
        account,
        identity: account.email,
        lastError: undefined,
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
          JSON.stringify(data.approvedAccess || ['read', 'write']),
        );
      this.store.emit('connection.ready', data.conversationId, { id }, ownerId);
      this.announceReady(c);
      await this.resumeWaitingTask(c);
      return { message: 'Connected to ' + account.email, state: 'ready' };
    }
    const recipe = this.server(c);
    if (!recipe) throw new ApiError(400, 'This connection has no usable server address.');
    const saved = (await this.storage()).get(id);
    const apiKey: string | undefined = saved.apiKey;
    // Explicit API-key servers skip OAuth; otherwise sign-in is discovered from the server.
    if (!apiKey && recipe.auth === 'api_key')
      return this.needsApiKey(c, recipe, `${recipe.label} connects with an API key.`);
    const client = new Client({ name: 'agent-workspace', version: '0.1.0' }),
      transport = new StreamableHTTPClientTransport(
        new URL(recipe.url),
        apiKey
          ? { requestInit: { headers: { Authorization: `Bearer ${apiKey}` } } }
          : { authProvider: await this.provider(id) },
      );
    try {
      // A service that never answers must not leave the card spinning.
      const limit = <T,>(work: Promise<T>) =>
        Promise.race([
          work,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('The service did not respond in time.')), 45000).unref(),
          ),
        ]);
      if (code) await limit(transport.finishAuth(code));
      await limit(client.connect(transport));
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
      const probe = probes[c.service];
      if (probe && tools.tools.some((t) => t.name === probe))
        account = await client.callTool({ name: probe, arguments: {} });
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
      // Name the account from the provider, so several accounts can be told apart.
      const who = identityTool(data.tools);
      const whoResult = who
        ? await limit(client.callTool({ name: who.name, arguments: {} })).catch(() => null)
        : null;
      const identity =
        identityFromResult(account) ||
        identityFromResult(whoResult) ||
        identityFromTokens(vault.get(id).tokens);
      if (identity) data.identity = identity;
      delete data.lastError;
      const twin =
        data.anotherAccount &&
        data.identity &&
        this.accounts(c.owner_id, c.service).find(
          (a) => a.id !== id && JSON.parse(a.data).identity === data.identity,
        );
      if (twin) {
        // The provider reused the account that is already connected. Keep nothing.
        await client.close().catch(() => {});
        vault.set(id, { ...vault.get(id), tokens: undefined, authorizationUrl: undefined });
        const service = this.label(c);
        data.lastError = `That was your ${this.accountName(twin)} account, which is already connected. Try again and choose a different account. If ${service} signs you straight in, sign out of ${service} in that window first.`;
        delete data.tools;
        this.store.run(
          "UPDATE connections SET state='failed',data=? WHERE id=?",
          JSON.stringify(data),
          id,
        );
        this.store.emit(
          'connection.ready',
          data.conversationId || null,
          { id, state: 'failed' },
          ownerId,
        );
        return { state: 'duplicate', error: data.lastError };
      }
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
          JSON.stringify(data.approvedAccess || ['read', 'write']),
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
      if (apiKey && /401|403|unauthori[sz]ed|forbidden/i.test(String(e?.message))) {
        // Never keep a key the service rejected.
        vault.set(id, { ...saved, apiKey: undefined });
        return this.needsApiKey(c, recipe, `${recipe.label} did not accept that API key. Check it and try again.`);
      }
      if (!apiKey && !builtInServices[c.service])
        // No browser sign-in offered: the service most likely expects an API key.
        return this.needsApiKey(
          c,
          recipe,
          `${recipe.label} does not offer browser sign-in to Abralo. Connect with an API key instead.`,
        );
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
  private needsApiKey(c: any, server: ServiceCandidate, message: string) {
    this.store.run("UPDATE connections SET state='awaiting_authorization' WHERE id=?", c.id);
    return { requiresApiKey: true, message, apiKeyHelp: server.apiKeyHelp };
  }
  /** The key goes straight from Abralo's form to the encrypted vault. It is never shown again. */
  async useApiKey(id: string, ownerId: string, key: string) {
    const c = this.store.one('SELECT * FROM connections WHERE id=? AND owner_id=?', id, ownerId);
    if (!c) throw new ApiError(404, 'Connection unavailable');
    if (integrationServices.has(c.service) || JSON.parse(c.data).reuseId)
      throw new ApiError(409, 'This connection does not use an API key.');
    const vault = await this.storage();
    vault.set(id, { ...vault.get(id), apiKey: key, tokens: undefined, authorizationUrl: undefined });
    await this.clients.get(id)?.close().catch(() => {});
    this.clients.delete(id);
    return this.ensure(id, ownerId);
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
  app.post('/api/connections', async (req: any) => {
    const { service } = z.object({ service: z.string().trim().min(2).max(120) }).parse(req.body);
    return broker.addService(req.user.id, service);
  });
  app.get('/api/connection-actions', async (req: any) => {
    const conversationId = z.string().parse(req.query.conversationId);
    s.authorize(req.user.id, conversationId);
    return s
      .all(
        "SELECT a.*,c.service,c.label,c.data AS connection_data FROM connection_actions a JOIN connections c ON c.id=a.connection_id WHERE a.owner_id=? AND a.conversation_id=? AND NOT EXISTS (SELECT 1 FROM runs r JOIN messages m ON m.id=r.response_id WHERE r.id=a.run_id AND m.superseded=1) AND (a.state IN ('awaiting_approval','running','unknown') OR a.id IN (SELECT id FROM connection_actions WHERE owner_id=? AND conversation_id=? ORDER BY created_at DESC LIMIT 5)) ORDER BY a.created_at ASC",
        req.user.id,
        conversationId,
        req.user.id,
        conversationId,
      )
      .map((a) => ({
        ...broker.actions.receipt(a),
        dismissed: broker.actions.isDismissed(a),
        service: a.service,
        label: a.label,
        account: broker.accountName({ ...a, data: a.connection_data }),
        runId: a.run_id,
        createdAt: a.created_at,
        arguments: JSON.parse(a.arguments),
      }));
  });
  app.post('/api/connection-actions/:id/decision', async (req: any) => {
    const { allow } = z.object({ allow: z.boolean() }).parse(req.body);
    return broker.actions.decide(req.params.id, req.user.id, allow);
  });
  app.put('/api/connection-actions/:id/dismissal', async (req: any) => {
    const { dismissed } = z.object({ dismissed: z.boolean() }).parse(req.body);
    return broker.actions.dismiss(req.params.id, req.user.id, dismissed);
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
  app.get('/api/connections/sharing', async (req: any) => ({
    askBeforeSharing: broker.asksBeforeSharing(req.user.id),
  }));
  app.put('/api/connections/sharing', async (req: any) => {
    if (s.user(req.user.id)?.role !== 'owner')
      throw new ApiError(403, 'Only the workspace owner can change account sharing.');
    const { askBeforeSharing } = z.object({ askBeforeSharing: z.boolean() }).parse(req.body);
    s.set('connections.askBeforeSharing.' + req.user.id, askBeforeSharing);
    return { askBeforeSharing };
  });
  app.post('/api/connections/:id/api-key', async (req: any) => {
    const { key } = z.object({ key: z.string().trim().min(8).max(4000) }).parse(req.body);
    const c = broker.resolve(req.params.id, req.user.id);
    if (c.id !== req.params.id)
      throw new ApiError(409, 'Use the existing account button to share this connection.');
    return broker.useApiKey(c.id, req.user.id, key);
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
  /** Rename an account or make it the one agents use by default. */
  app.patch('/api/connections/:id', async (req: any) => {
    const body = z
      .object({
        name: z.string().trim().max(80).optional(),
        isDefault: z.literal(true).optional(),
      })
      .parse(req.body || {});
    const c = s.one(
      "SELECT * FROM connections WHERE id=? AND owner_id=? AND state='ready'",
      req.params.id,
      req.user.id,
    );
    if (!c) throw new ApiError(404, 'Account unavailable');
    const data = JSON.parse(c.data);
    if (body.name !== undefined) {
      // An empty name goes back to the provider's own name for the account.
      if (body.name) data.customName = body.name;
      else delete data.customName;
      s.run('UPDATE connections SET data=? WHERE id=?', JSON.stringify(data), c.id);
    }
    if (body.isDefault) s.set(`connections.default.${req.user.id}.${c.service}`, c.id);
    s.emit('connection.ready', null, { id: c.id }, req.user.id);
    return {
      id: c.id,
      account: broker.accountName({ ...c, data: JSON.stringify(data) }),
      isDefault: broker.defaultAccount(req.user.id, c.service)?.id === c.id,
    };
  });
  /** Sign in again on the same account entry. Employee access is kept. */
  app.post('/api/connections/:id/reconnect', async (req: any) => {
    const c = s.one(
      'SELECT * FROM connections WHERE id=? AND owner_id=?',
      req.params.id,
      req.user.id,
    );
    if (!c || JSON.parse(c.data).reuseId) throw new ApiError(404, 'Account unavailable');
    const vault = await broker.storage();
    vault.set(c.id, {
      ...vault.get(c.id),
      tokens: undefined,
      apiKey: undefined,
      authorizationUrl: undefined,
    });
    await broker.clients.get(c.id)?.close().catch(() => {});
    broker.clients.delete(c.id);
    s.run("UPDATE connections SET state='awaiting_authorization' WHERE id=?", c.id);
    s.emit('connection.ready', null, { id: c.id }, req.user.id);
    return broker.ensure(c.id, req.user.id);
  });
  /** Turn a request card into a sign-in for a different account on the same service. */
  app.post('/api/connections/:id/use-another', async (req: any) => {
    const c = s.one(
      "SELECT * FROM connections WHERE id=? AND owner_id=? AND state IN ('awaiting_authorization','failed')",
      req.params.id,
      req.user.id,
    );
    if (!c) throw new ApiError(404, 'Request unavailable');
    const data = JSON.parse(c.data);
    if (!data.reuseId && !data.anotherAccount)
      throw new ApiError(409, 'This card already signs in to a new account.');
    if (data.reuseId) {
      delete data.reuseId;
      delete data.accountLabel;
      data.anotherAccount = true;
      data.ordinal = broker.accounts(req.user.id, c.service).length + 1;
      s.run(
        "UPDATE connections SET state='awaiting_authorization',data=? WHERE id=?",
        JSON.stringify(data),
        c.id,
      );
    }
    return broker.ensure(c.id, req.user.id);
  });
  app.post('/api/connections/:id/reuse', async (req: any) => {
    const { write, accountId } = z
      .object({ write: z.boolean(), accountId: z.string().optional() })
      .parse(req.body);
    const request = s.one(
      'SELECT * FROM connections WHERE id=? AND owner_id=?',
      req.params.id,
      req.user.id,
    );
    if (!request) throw new ApiError(404, 'Request unavailable');
    const data = JSON.parse(request.data),
      existing = s.one(
        "SELECT * FROM connections WHERE id=? AND owner_id=? AND state='ready'",
        accountId || data.reuseId,
        req.user.id,
      );
    if (existing && existing.service !== request.service)
      throw new ApiError(409, 'That account belongs to a different service.');
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
    // The card the human answered is settled, whichever account they picked.
    s.run("UPDATE connections SET state='granted' WHERE id=?", request.id);
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
    // Also end the sign-in at the provider where it supports that.
    const vault = await broker.storage(),
      saved = vault.get(c.id),
      server = broker.server(c);
    let revoked: 'revoked' | 'unsupported' | 'failed' = 'unsupported';
    if (c.service === 'gmail' && saved.tokens)
      revoked = await new GmailConnection(vault, c.id, `${broker.origin()}/oauth/callback/${c.id}`)
        .revoke()
        .then(() => 'revoked' as const)
        .catch(() => 'failed' as const);
    else if (saved.tokens && server) revoked = await revokeOAuth(server.url, saved);
    vault.set(c.id, {});
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
    const name = broker.accountName(c);
    return {
      ok: true,
      revoked,
      message:
        revoked === 'revoked'
          ? `Disconnected ${name} and cancelled Abralo's access with the provider.`
          : saved.apiKey
            ? `Disconnected ${name}. Abralo no longer stores its API key; delete the key in your ${broker.label(c)} settings if you no longer need it.`
            : `Disconnected ${name}. Abralo deleted its sign-in; you can also remove Abralo in your ${broker.label(c)} account settings.`,
    };
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
      return signInPage(reply, 'Sign-in cancelled', 'Return to Abralo to try again.');
    }
    if (typeof req.query.code !== 'string') throw new ApiError(400, 'Missing authorization code');
    const result: any = await broker.connect(c.id, c.owner_id, req.query.code);
    if (result?.state === 'duplicate')
      return signInPage(reply, 'Already connected', result.error);
    return signInPage(reply, 'Connected', 'You can return to Abralo.');
  });
  app.addHook('onClose', async () => broker.close());
}

// The sign-in window was opened by Abralo, so it closes itself and the card
// updates on its own. If the browser keeps it open, the message still helps.
const closeScript = 'setTimeout(function(){window.close()},600)';
const closeHash = createHash('sha256').update(closeScript).digest('base64');
const escapeHtml = (v: string) =>
  v.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
function signInPage(reply: any, title: string, message: string) {
  title = escapeHtml(title);
  message = escapeHtml(message);
  return reply
    .type('text/html')
    .header(
      'Content-Security-Policy',
      `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${closeHash}'`,
    )
    .send(
      `<!doctype html><title>${title}</title><body style="font:16px system-ui;padding:48px;background:#fcfbf8;color:#252a30"><h1>${title}.</h1><p>${message}</p><script>${closeScript}</script></body>`,
    );
}
