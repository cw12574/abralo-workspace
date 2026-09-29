import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolve } from 'node:path';
import {
  launch,
  executable,
  execFileAsync,
  killTree,
} from '../../../../packages/host/src/index.js';
import type { Adapter, RunInput, ProviderInfo } from '../../../../packages/contracts/src/index.js';
import { providerLimitFromError } from './provider-limit.js';
import type { SandboxPolicy } from '../../../../packages/contracts/generated/codex/v2/SandboxPolicy.js';
export class CodexAdapter implements Adapter {
  child?: ChildProcessWithoutNullStreams;
  ready?: Promise<void>;
  seq = 0;
  pending = new Map<
    number,
    { resolve: (x: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  loadedThreads = new Set<string>();
  liveRuns = new Map<string, { threadId: string; turnId?: string; pending: string[] }>();
  events = new EventEmitter();
  constructor() {
    this.events.setMaxListeners(0);
  }
  async start() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      this.child = launch('codex', ['app-server', '--stdio']);
      this.child.stderr.on('data', () => {});
      createInterface({ input: this.child.stdout }).on('line', (line) => {
        let m: any;
        try {
          m = JSON.parse(line);
        } catch {
          return;
        }
        if (m.id !== undefined && !m.method) {
          const p = this.pending.get(m.id);
          if (p) {
            clearTimeout(p.timer);
            this.pending.delete(m.id);
            m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
          }
        } else this.events.emit('message', m);
      });
      const fail = (e: Error) => {
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.reject(e);
        }
        this.pending.clear();
        this.loadedThreads.clear();
        this.events.emit('failure', e);
        this.ready = undefined;
        this.child = undefined;
      };
      this.child.on('error', fail);
      this.child.on('exit', () =>
        fail(new Error('Codex App Server stopped; the run outcome must be reconciled.')),
      );
      await this.request('initialize', {
        clientInfo: { name: 'agent_workspace', title: 'Agent Workspace', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      });
      this.notify('initialized', {});
    })();
    return this.ready;
  }
  request(method: string, params: any = {}, timeoutMs = 90000): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.child?.stdin.writable) return reject(new Error('Codex is not running'));
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  notify(method: string, params: any) {
    this.child?.stdin.write(JSON.stringify({ method, params }) + '\n');
  }
  respond(id: any, result: any) {
    this.child?.stdin.write(JSON.stringify({ id, result }) + '\n');
  }
  async info(): Promise<ProviderInfo> {
    const bin = executable('codex');
    if (!bin)
      return {
        harness: 'codex',
        installed: false,
        authenticated: false,
        version: '',
        detail: 'Install Codex to connect your ChatGPT account.',
      };
    try {
      await this.start();
      const [account, models, limits] = await Promise.all([
        this.request('account/read', { refreshToken: false }),
        this.request('model/list', { limit: 100 }),
        this.request('account/rateLimits/read').catch(() => null),
      ]);
      return {
        harness: 'codex',
        installed: true,
        authenticated: account.account?.type === 'chatgpt',
        version: 'App Server',
        detail: account.account
          ? `${account.account.type} · ${account.account.planType || 'Connected'}`
          : 'Sign in with ChatGPT',
        models: (models.data || []).map((m: any) => ({ id: m.id, name: m.displayName || m.id })),
        limits,
      };
    } catch (e) {
      return {
        harness: 'codex',
        installed: true,
        authenticated: null,
        version: '',
        detail: String(e),
      };
    }
  }
  async login() {
    await this.start();
    return this.request('account/login/start', { type: 'chatgptDeviceCode' });
  }
  async steer(runId: string, message: string) {
    const live = this.liveRuns.get(runId);
    if (!live) return false;
    if (!live.turnId) {
      live.pending.push(message);
      return true;
    }
    try {
      await this.request(
        'turn/steer',
        {
          threadId: live.threadId,
          expectedTurnId: live.turnId,
          input: [{ type: 'text', text: message, text_elements: [] }],
        },
        15000,
      );
      return true;
    } catch {
      return false;
    }
  }
  async run(input: RunInput) {
    if (input.signal.aborted) {
      input.emit({ type: 'complete', data: { cancelled: true } });
      return;
    }
    await this.start();
    const account = await this.request('account/read', { refreshToken: false });
    if (account.account?.type !== 'chatgpt')
      throw new Error(
        'Sign in with ChatGPT. This employee is configured for subscription authentication.',
      );
    const opts: any = {
      cwd: input.employee.cwd,
      model: input.employee.model || undefined,
      approvalPolicy:
        input.employee.permissionMode === 'bypass'
          ? 'never'
          : input.employee.permissionMode === 'ask'
            ? 'untrusted'
            : 'on-request',
      sandbox: input.readOnly
        ? 'read-only'
        : input.employee.permissionMode === 'bypass'
          ? 'danger-full-access'
          : 'workspace-write',
      developerInstructions: input.employee.instructions || undefined,
      ...(input.tools?.workspace
        ? {
            config: {
              mcp_servers: {
                workspace: {
                  url: input.tools.workspace.url,
                  http_headers: input.tools.workspace.headers,
                  // Workspace tools are first-party, locally authenticated, and
                  // enforce their own permission checks. Keep them callable even
                  // when the native command policy is `never` (Full access).
                  default_tools_approval_mode: 'approve',
                },
              },
            },
          }
        : {}),
    };
    // Thread settings are fixed when a Codex thread is created/resumed. This
    // adapter deliberately keeps loaded threads attached to the app-server, so
    // refresh the effective permissions on every turn as well. In particular,
    // a thread used for review must not remain read-only on its next execution task.
    const sandboxPolicy: SandboxPolicy = input.readOnly
      ? { type: 'readOnly', networkAccess: false }
      : input.employee.permissionMode === 'bypass'
        ? { type: 'dangerFullAccess' }
        : {
            type: 'workspaceWrite',
            writableRoots: [resolve(input.employee.cwd || process.cwd())],
            networkAccess: false,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false,
          };
    let prompt = input.prompt;
    let threadId: string;
    if (input.sessionId && this.loadedThreads.has(input.sessionId)) {
      threadId = input.sessionId;
    } else if (input.sessionId) {
      try {
        threadId = (
          await this.request('thread/resume', { ...opts, threadId: input.sessionId }, 15000)
        ).thread.id;
      } catch (error) {
        console.warn(
          `Codex session ${input.sessionId} could not be resumed; starting a fresh session: ${String(error)}`,
        );
        threadId = (await this.request('thread/start', opts)).thread.id;
        if (input.resumeContext)
          prompt =
            'Earlier conversation for continuity (the previous Codex session could not be resumed):\n' +
            input.resumeContext +
            '\n\nCurrent request:\n' +
            prompt;
      }
    } else {
      threadId = (await this.request('thread/start', opts)).thread.id;
    }
    const live: { threadId: string; turnId?: string; pending: string[] } = {
      threadId,
      pending: [],
    };
    this.liveRuns.set(input.id, live);
    const flushSteers = () => {
      if (!live.turnId || !live.pending.length) return;
      const messages = live.pending.splice(0);
      void this.request(
        'turn/steer',
        {
          threadId: live.threadId,
          expectedTurnId: live.turnId,
          input: messages.map((text) => ({ type: 'text', text, text_elements: [] })),
        },
        15000,
      ).catch(() => {
        live.pending.unshift(...messages);
      });
    };
    // Keep using the session already attached to this app-server process.
    // Resuming it again can block while trying to reopen its active writer.
    this.loadedThreads.add(threadId);
    input.emit({ type: 'session', data: { id: threadId } });
    let turnId: string | undefined;
    let settled = false;
    let abortRequested = false;
    let interruptSent = false;
    let completing = false;
    let lastTextItem: string | undefined;
    await new Promise<void>((resolve, reject) => {
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        this.liveRuns.delete(input.id);
        this.events.off('message', onMessage);
        this.events.off('failure', onFailure);
        input.signal.removeEventListener('abort', abort);
        err ? reject(err) : resolve();
      };
      const onFailure = (e: Error) => finish(providerLimitFromError(e, 'codex') || e);
      const abort = () => {
        abortRequested = true;
        if (turnId && !interruptSent && !settled && !completing) {
          interruptSent = true;
          this.request('turn/interrupt', { threadId, turnId }, 15000).catch((e) => finish(e));
        }
      };
      const onMessage = (m: any) => {
        try {
          const p = m.params || {};
          if (p.threadId !== threadId) return;
          if (m.id !== undefined) {
            void (async () => {
              try {
                if (m.method === 'item/tool/requestUserInput') {
                  const result = await input.decide({
                    kind: 'question',
                    title: 'A question for you',
                    questions: p.questions,
                    nativeId: m.id,
                  });
                  this.respond(m.id, { answers: input.signal.aborted ? {} : result.answers || {} });
                } else if (m.method === 'mcpServer/elicitation/request') {
                  const internalToolApproval =
                    (p.serverName === 'workspace' || input.employee.permissionMode === 'bypass') &&
                    p._meta?.codex_approval_kind === 'mcp_tool_call';
                  const result =
                    internalToolApproval &&
                    (input.readOnly || input.employee.permissionMode !== 'ask')
                      ? { allow: true, content: null }
                      : await input.decide({
                          kind: 'permission',
                          title: p.message || 'Allow this connected tool?',
                          detail: p,
                        });
                  this.respond(m.id, {
                    action: result.allow && !input.signal.aborted ? 'accept' : 'decline',
                    content: result.content || null,
                  });
                } else if (m.method === 'item/permissions/requestApproval') {
                  const result = await input.decide({
                    kind: 'permission',
                    title: p.reason || 'Additional permissions requested',
                    detail: p,
                  });
                  this.respond(m.id, {
                    permissions: result.allow && !input.signal.aborted ? p.permissions : {},
                    scope: 'turn',
                  });
                } else if (m.method?.includes('requestApproval')) {
                  const result = await input.decide({
                    kind: 'permission',
                    title: p.command || p.reason || 'Permission requested',
                    detail: p,
                    method: m.method,
                    nativeId: m.id,
                  });
                  this.respond(m.id, {
                    decision: result.allow && !input.signal.aborted ? 'accept' : 'decline',
                  });
                } else {
                  this.child?.stdin.write(
                    JSON.stringify({
                      id: m.id,
                      error: { code: -32601, message: 'Unsupported host request' },
                    }) + '\n',
                  );
                }
              } catch {
                this.respond(m.id, { decision: 'cancel' });
              }
            })();
            return;
          }
          if (m.method === 'turn/started') {
            turnId = p.turn.id;
            live.turnId = turnId;
            flushSteers();
            if (abortRequested) abort();
          }
          if (m.method === 'item/agentMessage/delta') {
            if (lastTextItem && p.itemId && lastTextItem !== p.itemId)
              input.emit({ type: 'text', text: '\n\n' });
            lastTextItem = p.itemId || lastTextItem;
            input.emit({ type: 'text', text: p.delta });
          }
          if (m.method === 'item/started' || m.method === 'item/completed') {
            const item = p.item;
            if (m.method === 'item/completed' && item?.type === 'agentMessage')
              input.emit({ type: 'final', text: item.text || '' });
            if (item?.type !== 'agentMessage' && item?.type !== 'userMessage')
              input.emit({
                type: 'activity',
                id: item.id,
                data: {
                  id: item.id,
                  type: item.type,
                  title:
                    item.type === 'reasoning' ? 'Thinking' : item.command || item.tool || item.type,
                  detail: item.type === 'reasoning' ? '' : JSON.stringify(item).slice(0, 30000),
                  state:
                    item.status === 'failed'
                      ? 'failed'
                      : m.method.endsWith('completed')
                        ? 'complete'
                        : 'running',
                },
              });
          }
          if (m.method === 'item/commandExecution/outputDelta')
            input.emit({
              type: 'activity',
              id: p.itemId,
              data: {
                id: p.itemId,
                type: 'commandExecution',
                title: 'Running command',
                append: p.delta,
                state: 'running',
              },
            });
          if (m.method === 'turn/diff/updated')
            input.emit({ type: 'diff', data: { diff: p.diff } });
          if (m.method === 'thread/tokenUsage/updated')
            input.emit({ type: 'usage', data: p.tokenUsage });
          if (m.method === 'error')
            input.emit({
              type: 'activity',
              data: {
                id: `error-${Date.now()}`,
                title: p.error?.message || 'Provider error',
                type: 'error',
                state: 'failed',
              },
            });
          if (m.method === 'turn/completed') {
            if (completing) return;
            completing = true;
            const t = p.turn;
            void (async () => {
              // Interrupt ends model generation, but native terminal sessions can
              // outlive the turn. Stop only this thread's terminals, and don't
              // acknowledge cancellation until the provider confirms cleanup.
              const cancelled =
                abortRequested || input.signal.aborted || t.status === 'interrupted';
              if (cancelled) {
                try {
                  await this.request('thread/backgroundTerminals/clean', { threadId }, 15000);
                } catch (error) {
                  throw new Error(
                    `Codex cancellation cleanup failed; tool termination is unconfirmed: ${String(error)}`,
                  );
                }
              }
              if (!settled) {
                if (t.status === 'failed') {
                  const error = new Error(t.error?.message || 'Codex turn failed');
                  throw providerLimitFromError(error, 'codex') || error;
                }
                input.emit({ type: 'complete', data: { cancelled } });
                finish();
              }
            })().catch(finish);
          }
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      };
      this.events.on('message', onMessage);
      this.events.on('failure', onFailure);
      input.signal.addEventListener('abort', abort, { once: true });
      if (input.signal.aborted) {
        input.emit({ type: 'complete', data: { cancelled: true } });
        finish();
        return;
      }
      const attachments = input.attachments
        .filter((a) => a.mime.startsWith('image/'))
        .map((a) => ({ type: 'localImage', path: a.path }));
      const files = input.attachments
        .filter((a) => !a.mime.startsWith('image/'))
        .map((a) => `Attachment ${a.name}: ${a.path}`)
        .join('\n');
      this.request('turn/start', {
        threadId,
        cwd: input.employee.cwd || undefined,
        model: input.employee.model || undefined,
        approvalPolicy: opts.approvalPolicy,
        sandboxPolicy,
        clientUserMessageId: input.id,
        input: [
          { type: 'text', text: prompt + (files ? '\n' + files : ''), text_elements: [] },
          ...attachments,
        ],
      })
        .then((r) => {
          turnId = r.turn.id;
          live.turnId = turnId;
          flushSteers();
          if (input.signal.aborted) abort();
        })
        .catch(finish);
    });
  }
  async dispose() {
    this.loadedThreads.clear();
    if (this.child?.pid) await killTree(this.child.pid);
  }
}
