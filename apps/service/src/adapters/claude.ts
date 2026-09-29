import { query } from '@anthropic-ai/claude-agent-sdk';
import { readFileSync } from 'node:fs';
import { executable, execFileAsync } from '../../../../packages/host/src/index.js';
import type { Adapter, ProviderInfo, RunInput } from '../../../../packages/contracts/src/index.js';
import { providerLimitFromError } from './provider-limit.js';
export class ClaudeAdapter implements Adapter {
  async info(): Promise<ProviderInfo> {
    const bin = executable('claude');
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
        models: [
          { id: '', name: 'Provider default' },
          { id: 'sonnet', name: 'Sonnet' },
          { id: 'opus', name: 'Opus' },
          { id: 'haiku', name: 'Haiku' },
        ],
      };
    } catch {
      return {
        harness: 'claude',
        installed: true,
        authenticated: false,
        version: '',
        detail: 'Sign in with Claude Code on this host.',
      };
    }
  }
  async run(input: RunInput) {
    if (input.signal.aborted) {
      input.emit({ type: 'complete', data: { cancelled: true } });
      return;
    }
    const bin = executable('claude');
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
          pathToClaudeCodeExecutable: bin.command,
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
          settingSources: ['project'],
          systemPrompt: {
            type: 'preset',
            preset: 'claude_code',
            append: input.employee.instructions,
          },
          mcpServers: input.tools,
          strictMcpConfig: true,
          canUseTool: async (toolName, args) => {
            if (input.signal.aborted) return { behavior: 'deny', message: 'The run was cancelled' };
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
          if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
            received = true;
            input.emit({ type: 'text', text: ev.delta.text });
          }
          if (ev.type === 'content_block_start' && ev.content_block?.type === 'thinking')
            input.emit({
              type: 'activity',
              id: 'thinking',
              data: { id: 'thinking', type: 'reasoning', title: 'Thinking', state: 'running' },
            });
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
              input.emit({
                type: 'activity',
                id: b.tool_use_id,
                data: {
                  id: b.tool_use_id,
                  type: 'tool',
                  title: 'Tool result',
                  detail:
                    typeof b.content === 'string'
                      ? b.content.slice(0, 30000)
                      : JSON.stringify(b.content).slice(0, 30000),
                  state: b.is_error ? 'failed' : 'complete',
                },
              });
        }
        if (m.type === 'result') {
          input.emit({
            type: 'activity',
            id: 'thinking',
            data: { type: 'reasoning', title: 'Thinking', state: 'complete' },
          });
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
  async dispose() {}
}
