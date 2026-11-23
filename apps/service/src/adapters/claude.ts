import { createHash } from 'node:crypto';
import type { Executable } from '../../../../packages/host/src/index.js';
import { connectionTools } from '../connection-tools.js';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { readFileSync } from 'node:fs';
import { executable, execFileAsync } from '../../../../packages/host/src/index.js';
import type { Adapter, ProviderInfo, RunInput } from '../../../../packages/contracts/src/index.js';
import { providerLimitFromError } from './provider-limit.js';
const LIMITS_TTL = 60000;
type LimitWindow = { usedPercent: number; windowDurationMins: number; resetsAt: number; label: string };
export type ClaudeLimits = { rateLimitsByLimitId: Record<string, { primary?: LimitWindow; secondary?: LimitWindow }> };
type UsageWindow = { utilization: number | null; resets_at: string | null } | null | undefined;

function limitWindow(value: UsageWindow, label: string, windowDurationMins: number): LimitWindow | undefined {
  if (!value || typeof value.utilization !== 'number' || !value.resets_at) return undefined;
  const reset = Date.parse(value.resets_at);
  if (!Number.isFinite(reset)) return undefined;
  // Whole seconds keep the reset stable across readings, so usage trends line up.
  return { usedPercent: Math.min(100, Math.max(0, value.utilization)), windowDurationMins, resetsAt: Math.round(reset / 1000), label };
}

/** Map Claude Code's /usage response onto the shared provider-limit shape. */
export function claudeLimits(usage: { rate_limits_available?: boolean; rate_limits?: Record<string, any> | null }): ClaudeLimits | undefined {
  const limits = usage?.rate_limits;
  if (!usage?.rate_limits_available || !limits) return undefined;
  const buckets: ClaudeLimits['rateLimitsByLimitId'] = {};
  const plan = { primary: limitWindow(limits.five_hour, 'This session', 300), secondary: limitWindow(limits.seven_day, 'This week', 10080) };
  if (plan.primary || plan.secondary) buckets.plan = plan;
  for (const [key, name] of [['seven_day_opus', 'Opus'], ['seven_day_sonnet', 'Sonnet']] as const) {
    const primary = limitWindow(limits[key], `${name} this week`, 10080);
    if (primary) buckets[key] = { primary };
  }
  for (const scoped of Array.isArray(limits.model_scoped) ? limits.model_scoped : []) {
    const name = String(scoped?.display_name || '').slice(0, 60);
    const primary = name && limitWindow(scoped, `${name} this week`, 10080);
    if (primary) buckets['model.' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-')] = { primary };
  }
  return Object.keys(buckets).length ? { rateLimitsByLimitId: buckets } : undefined;
}

export class ClaudeAdapter implements Adapter {
  private discovery = new Set<{ controller: AbortController; stream?: ReturnType<typeof query>; release: () => void }>();
  private limits?: { at: number; value: ClaudeLimits | undefined };
  private limitsPending?: Promise<ClaudeLimits | undefined>;
  constructor(public binary?: Executable) {}
  async info(): Promise<ProviderInfo> {
    const bin = this.binary || executable('claude');
    if (!bin)
      return {
        harness: 'claude',
        installed: false,
        authenticated: false,
        version: '',
        detail: 'Install Claude Code, then sign in.',
      };
    try {
      const r = await execFileAsync(bin.command, [...bin.args, 'auth', 'status'], {
        windowsHide: true,
        timeout: 20000,
      });
      const auth = JSON.parse(r.stdout);
      return {
        harness: 'claude',
        installed: true,
        authenticated: auth.loggedIn && auth.authMethod === 'claude.ai',
        version: 'native Claude Code',
        detail: auth.loggedIn
          ? `${auth.authMethod} · ${auth.subscriptionType || auth.apiProvider}`
          : 'Sign in with Claude Code',
        accountKey: createHash('sha256').update(JSON.stringify([auth.email, auth.accountUuid, auth.orgUuid, auth.authMethod])).digest('hex'),
        ...(auth.loggedIn ? await this.catalogue(bin) : { models: [] }),
      };
    } catch {
      return {
        harness: 'claude',
        installed: true,
        authenticated: null,
        version: '',
        detail: 'Could not check Claude Code on this host.',
      };
    }
  }
  private async control<T>(bin: Executable, use: (stream: ReturnType<typeof query>) => Promise<T>): Promise<T> {
    // Initialize the native SDK control channel without submitting a user turn.
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    async function* emptyInput(): AsyncGenerator<any> { await gate; }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    const discovery: { controller: AbortController; stream?: ReturnType<typeof query>; release: () => void } = { controller, release };
    this.discovery.add(discovery);
    let stream: ReturnType<typeof query> | undefined;
    try {
      stream = query({ prompt: emptyInput(), options: {
      pathToClaudeCodeExecutable: bin.args[0] || bin.command,
      abortController: controller, env, persistSession: false,
      tools: [], mcpServers: {}, strictMcpConfig: true, settingSources: [],
      } });
      discovery.stream = stream;
      return await use(stream);
    } finally {
      clearTimeout(timer); release(); stream?.close(); this.discovery.delete(discovery);
    }
  }
  private async catalogue(bin: Executable): Promise<Pick<ProviderInfo, 'models' | 'catalogueError'>> {
    try {
      const models = await this.control(bin, stream => stream.supportedModels());
      return { models: models.map(m => ({ id: m.resolvedModel || m.value, name: m.displayName, aliases: [m.value], isDefault: m.value === 'default' })) };
    } catch {
      return { catalogueError: 'Could not refresh Claude models. Your saved choices are still available.' };
    }
  }
  /** Plan allowance from Claude Code's /usage data. Cached briefly and shared by every open Usage panel. */
  readLimits(): Promise<ClaudeLimits | undefined> {
    if (this.limits && Date.now() - this.limits.at < LIMITS_TTL) return Promise.resolve(this.limits.value);
    if (this.limitsPending) return this.limitsPending;
    const bin = this.binary || executable('claude');
    if (!bin) return Promise.resolve(undefined);
    const work = this.control(bin, stream =>
      stream.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }))
      .then(usage => {
        const value = claudeLimits(usage);
        this.limits = { at: Date.now(), value };
        return value;
      })
      // Keep the last reading if a refresh fails; never block the panel on it.
      .catch(() => this.limits?.value)
      .finally(() => { this.limitsPending = undefined; });
    this.limitsPending = work;
    return work;
  }
  async run(input: RunInput) {
    if (input.signal.aborted) {
      input.emit({ type: 'complete', data: { cancelled: true } });
      return;
    }
    const bin = this.binary || executable('claude');
    if (!bin) throw new Error('Claude Code is not installed');
    const auth = JSON.parse(
      (
        await execFileAsync(bin.command, [...bin.args, 'auth', 'status'], {
          windowsHide: true,
          timeout: 20000,
        })
      ).stdout,
    );
    if (!auth.loggedIn || auth.authMethod !== 'claude.ai')
      throw new Error(
        'Sign in with your Claude subscription. API billing is not enabled for this employee.',
      );
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    const controller = new AbortController();
    let stream: ReturnType<typeof query> | undefined;
    let stopping: Promise<Error | undefined> | undefined;
    const abort = () => {
      if (stopping) return;
      stopping = (async () => {
        let timer: NodeJS.Timeout | undefined;
        try {
          // Give this session's CLI a chance to stop its tools before closing
          // its transport. Aborting the SDK first can orphan native children.
          if (stream)
            await Promise.race([
              stream.interrupt(),
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error('Interrupt timed out')), 15000);
              }),
            ]);
          return undefined;
        } catch (error) {
          return new Error(
            `Claude cancellation cleanup failed; tool termination is unconfirmed: ${String(error)}`,
          );
        } finally {
          if (timer) clearTimeout(timer);
          controller.abort();
        }
      })();
    };
    input.signal.addEventListener('abort', abort, { once: true });
    if (input.signal.aborted) abort();
    let received = false;
    let paragraphBreak = false;
    // Each thinking block is its own step so it appears where it happened.
    let thinkingCount = 0;
    const openThinking = new Map<number, string>();
    const finishThinking = (id: string) =>
      input.emit({
        type: 'activity',
        id,
        data: { id, type: 'reasoning', title: 'Thinking', state: 'complete' },
      });
    const blocks: any[] = [{ type: 'text', text: input.prompt }];
    for (const a of input.attachments) {
      if (['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(a.mime))
        blocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: a.mime,
            data: readFileSync(a.path).toString('base64'),
          },
        });
      else blocks.push({ type: 'text', text: `Attachment ${a.name}: ${a.path}` });
    }
    async function* prompt() {
      yield {
        type: 'user' as const,
        message: { role: 'user' as const, content: blocks },
        parent_tool_use_id: null,
        session_id: input.sessionId || '',
      };
    }
    try {
      stream = query({
        prompt: prompt(),
        options: {
          pathToClaudeCodeExecutable: bin.args[0] || bin.command,
          cwd: input.employee.cwd,
          model: input.employee.model || undefined,
          resume: input.sessionId,
          abortController: controller,
          env,
          includePartialMessages: true,
          perTaskStopAffordance: false,
          permissionMode: input.readOnly
            ? 'plan'
            : input.employee.permissionMode === 'bypass'
              ? 'bypassPermissions'
              : input.employee.permissionMode === 'ask'
                ? 'default'
                : 'auto',
          allowDangerouslySkipPermissions:
            !input.readOnly && input.employee.permissionMode === 'bypass',
          settingSources: input.nativeMcp ? ['user', 'project'] : ['project'],
          systemPrompt: {
            type: 'preset',
            preset: 'claude_code',
            append: input.employee.instructions,
          },
          mcpServers: input.tools,
          strictMcpConfig: !input.nativeMcp,
          canUseTool: async (toolName, args) => {
            if (input.signal.aborted) return { behavior: 'deny', message: 'The run was cancelled' };
            if (
              input.tools?.workspace &&
              ['workspace_browser', 'workspace_desktop'].some((name) => toolName === 'mcp__workspace__' + name)
            )
              return { behavior: 'allow', updatedInput: args };
            if (
              input.tools?.workspace &&
              connectionTools.some((name) => toolName === 'mcp__workspace__' + name)
            )
              return { behavior: 'allow', updatedInput: args };
            if (
              toolName.startsWith('mcp__workspace__') &&
              (input.readOnly || input.employee.permissionMode !== 'ask')
            )
              return { behavior: 'allow', updatedInput: args };
            const result = await input.decide({
              kind: toolName === 'AskUserQuestion' ? 'question' : 'permission',
              title: toolName,
              detail: args,
              questions: (args as any).questions,
            });
            if (result.allow === false || input.signal.aborted)
              return { behavior: 'deny', message: 'Declined by the user' };
            return {
              behavior: 'allow',
              updatedInput: { ...args, ...(result.answers ? { answers: result.answers } : {}) },
            };
          },
        },
      });
      if (input.tools) await stream.setMcpServers(input.tools);
      for await (const raw of stream) {
        const m: any = raw;
        if (m.type === 'system' && m.subtype === 'init') {
          input.emit({ type: 'session', data: { id: m.session_id } });
          if (input.tools?.workspace)
            input.emit({
              type: 'activity',
              id: 'workspace-tools',
              data: {
                type: 'connection',
                title: 'Workspace tools',
                state: 'complete',
                detail: JSON.stringify(m.mcp_servers),
              },
            });
        }
        if (m.type === 'stream_event' && !m.parent_tool_use_id) {
          const ev = m.event;
          // Text written between tool calls arrives as separate blocks. Keep them as
          // separate paragraphs instead of running sentences together.
          if (ev.type === 'content_block_start' && ev.content_block?.type === 'text' && received)
            paragraphBreak = true;
          if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
            if (paragraphBreak && ev.delta.text.trim()) {
              input.emit({ type: 'text', text: '\n\n' });
              paragraphBreak = false;
            }
            received = true;
            input.emit({ type: 'text', text: ev.delta.text });
          }
          if (ev.type === 'content_block_start' && ev.content_block?.type === 'thinking') {
            const id = `thinking-${++thinkingCount}`;
            openThinking.set(ev.index, id);
            input.emit({
              type: 'activity',
              id,
              data: { id, type: 'reasoning', title: 'Thinking', state: 'running' },
            });
          }
          if (ev.type === 'content_block_stop' && openThinking.has(ev.index)) {
            finishThinking(openThinking.get(ev.index)!);
            openThinking.delete(ev.index);
          }
        }
        if (m.type === 'assistant') {
          for (const block of m.message?.content || []) {
            if (block.type === 'tool_use')
              input.emit({
                type: 'activity',
                id: block.id,
                data: {
                  id: block.id,
                  type: 'tool',
                  title: block.name,
                  detail: JSON.stringify(block.input).slice(0, 30000),
                  state: 'running',
                },
              });
          }
        }
        if (m.type === 'user') {
          for (const b of m.message?.content || [])
            if (b.type === 'tool_result')
              // The result completes the tool's own step: keep its name and input, add the output.
              input.emit({
                type: 'activity',
                id: b.tool_use_id,
                data: {
                  id: b.tool_use_id,
                  type: 'tool',
                  append:
                    '\n\nResult:\n' +
                    (typeof b.content === 'string'
                      ? b.content.slice(0, 30000)
                      : JSON.stringify(b.content).slice(0, 30000)),
                  state: b.is_error ? 'failed' : 'complete',
                },
              });
        }
        if (m.type === 'result') {
          for (const id of openThinking.values()) finishThinking(id);
          openThinking.clear();
          input.emit({
            type: 'usage',
            data: {
              usage: m.usage,
              modelUsage: m.modelUsage,
              total_cost_usd: m.total_cost_usd,
              source: 'observed workspace turn',
            },
          });
          if (input.signal.aborted) continue;
          if (m.is_error) {
            const error = new Error(m.errors?.join('\n') || m.result || 'Claude turn failed');
            throw providerLimitFromError(error, 'claude') || error;
          }
          if (!received && m.result) input.emit({ type: 'text', text: m.result });
          input.emit({ type: 'final', text: m.result || '' });
          input.emit({ type: 'complete', data: { cancelled: false } });
        }
      }
      if (input.signal.aborted) {
        const error = await stopping;
        if (error) throw error;
        input.emit({ type: 'complete', data: { cancelled: true } });
      }
    } catch (e) {
      if (input.signal.aborted) {
        const error = await stopping;
        if (error) throw error;
        input.emit({ type: 'complete', data: { cancelled: true } });
        return;
      }
      throw providerLimitFromError(e, 'claude') || e;
    } finally {
      input.signal.removeEventListener('abort', abort);
      stream?.close();
    }
  }
  async dispose() {
    for (const discovery of this.discovery) {
      discovery.controller.abort();
      discovery.release();
      discovery.stream?.close();
    }
  }
}
