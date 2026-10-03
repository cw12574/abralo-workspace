import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { launch, executable, killTree } from '../../../../packages/host/src/index.js';
import type { Adapter, RunInput, ProviderInfo } from '../../../../packages/contracts/src/index.js';
import { providerLimitFromError } from './provider-limit.js';
export class OpenCodeAdapter implements Adapter {
  child: any;
  url = '';
  password = randomBytes(32).toString('hex');
  starting?: Promise<void>;
  async start() {
    if (this.starting) return this.starting;
    this.starting = new Promise<void>((resolve, reject) => {
      const child = launch('opencode', ['serve', '--hostname', '127.0.0.1', '--port', '0'], {
        env: { ...process.env, OPENCODE_SERVER_PASSWORD: this.password },
      });
      this.child = child;
      let buffer = '';
      const fail = (error: Error) => {
        clearTimeout(timer);
        if (this.child === child) {
          this.starting = undefined;
          this.child = undefined;
          this.url = '';
        }
        child.kill();
        reject(error);
      };
      const timer = setTimeout(() => {
        fail(new Error('OpenCode did not start. Try connecting again.'));
        child.kill();
      }, 15000);
      child.stdout.on('data', (d: Buffer) => {
        buffer = (buffer + d.toString()).slice(-10000);
        const m = buffer.match(/https?:\/\/127\.0\.0\.1:\d+/);
        if (m) {
          this.url = m[0];
          clearTimeout(timer);
          resolve();
        }
      });
      child.stderr.on('data', () => {});
      child.stdin.on('error', fail);
      child.on('error', fail);
      child.on('exit', () => fail(new Error('OpenCode stopped. Try connecting again.')));
    });
    const attempt = this.starting;
    try {
      return await attempt;
    } catch (error) {
      if (this.starting === attempt) this.starting = undefined;
      throw error;
    }
  }
  async api(path: string, method = 'GET', body?: any, directory?: string) {
    await this.start();
    const url = new URL(path, this.url);
    if (directory) url.searchParams.set('directory', directory);
    const r = await fetch(url, {
      signal: AbortSignal.timeout(
        path.startsWith('/provider') || path.startsWith('/auth') ? 20000 : 90000,
      ),
      method,
      headers: {
        authorization: `Basic ${Buffer.from('opencode:' + this.password).toString('base64')}`,
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`OpenCode ${r.status}: ${(await r.text()).slice(0, 2000)}`);
    return r.status === 204 ? null : r.json();
  }
  async info(): Promise<ProviderInfo> {
    if (!executable('opencode'))
      return {
        harness: 'opencode',
        installed: false,
        authenticated: false,
        version: '',
        detail: 'Install OpenCode and choose a provider.',
      };
    try {
      const p = await this.api('/provider');
      return {
        harness: 'opencode',
        installed: true,
        authenticated: p.connected?.length > 0,
        version: '1.18.32 server',
        detail: p.connected?.length
          ? 'Connected providers: ' + p.connected.join(', ')
          : 'Choose a provider in OpenCode',
        models:
          p.all
            ?.filter((x: any) => p.connected.includes(x.id))
            .flatMap((x: any) =>
              Object.values(x.models).map((m: any) => ({
                id: `${x.id}/${m.id}`,
                name: m.name || m.id,
              })),
            ) || [],
      };
    } catch (e) {
      return {
        harness: 'opencode',
        installed: true,
        authenticated: null,
        version: '',
        detail:
          'OpenCode could not check its providers. Check your connection and try again, or restart Abralo.',
      };
    }
  }
  async run(input: RunInput) {
    await this.start();
    const directory = input.employee.cwd;
    const toolName = 'workspace_' + input.id.replaceAll('-', '');
    if (input.tools?.workspace)
      await this.api(
        '/mcp',
        'POST',
        {
          name: toolName,
          config: {
            type: 'remote',
            url: input.tools.workspace.url,
            headers: input.tools.workspace.headers,
            oauth: false,
            enabled: true,
          },
        },
        directory,
      );
    const permission = [
      ...(input.readOnly
        ? [
            { permission: '*', pattern: '*', action: 'ask' },
            ...['read', 'glob', 'grep', 'list', 'webfetch', 'websearch'].map((permission) => ({
              permission,
              pattern: '*',
              action: 'allow',
            })),
          ]
        : input.employee.permissionMode === 'bypass'
          ? [{ permission: '*', pattern: '*', action: 'allow' }]
          : input.employee.permissionMode === 'ask'
            ? [{ permission: '*', pattern: '*', action: 'ask' }]
            : []),
      { permission: 'workspace_*', pattern: '*', action: 'deny' },
      {
        permission: toolName + '_*',
        pattern: '*',
        action: !input.readOnly && input.employee.permissionMode === 'ask' ? 'ask' : 'allow',
      },
    ];
    const session = input.sessionId
      ? { id: input.sessionId }
      : await this.api(
          '/session',
          'POST',
          {
            title: input.employee.name,
            permission,
          },
          directory,
        );
    if (input.sessionId)
      await this.api(`/session/${session.id}`, 'PATCH', { permission }, directory);
    input.emit({ type: 'session', data: { id: session.id } });
    const controller = new AbortController();
    let done = false;
    const parts = new Map<string, string>();
    const roles = new Map<string, string>();
    let finish!: () => void;
    let failure!: (e: Error) => void;
    const completion = new Promise<void>((resolve, reject) => {
      finish = resolve;
      failure = reject;
    });
    const events = await fetch(`${this.url}/event?directory=${encodeURIComponent(directory)}`, {
      headers: {
        authorization: `Basic ${Buffer.from('opencode:' + this.password).toString('base64')}`,
      },
      signal: controller.signal,
    });
    const pump = (async () => {
      let buffer = '';
      for await (const bytes of events.body as any) {
        buffer += Buffer.from(bytes).toString();
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = frame.split('\n').find((l) => l.startsWith('data: '));
          if (!data) continue;
          let e: any;
          try {
            e = JSON.parse(data.slice(6));
          } catch {
            continue;
          }
          const p = e.properties || {};
          if (
            p.sessionID !== session.id &&
            p.part?.sessionID !== session.id &&
            p.info?.sessionID !== session.id
          )
            continue;
          if (e.type === 'message.updated' && p.info) roles.set(p.info.id, p.info.role);
          if (e.type === 'message.part.updated') {
            const part = p.part;
            if (part.type === 'text' && roles.get(part.messageID) === 'assistant') {
              const previous = parts.get(part.id) || '';
              if (part.text?.startsWith(previous))
                input.emit({ type: 'text', text: part.text.slice(previous.length) });
              parts.set(part.id, part.text || '');
            }
            if (part.type === 'tool')
              input.emit({
                type: 'activity',
                id: part.id,
                data: {
                  id: part.id,
                  type: 'tool',
                  title: part.tool,
                  detail: JSON.stringify(part.state).slice(0, 30000),
                  state: part.state.status,
                },
              });
          }
          if (e.type === 'permission.asked')
            void input
              .decide({ kind: 'permission', title: p.permission, detail: p })
              .then((r) =>
                this.api(
                  `/permission/${p.id}/reply`,
                  'POST',
                  { reply: r.allow ? 'once' : 'reject' },
                  directory,
                ),
              )
              .catch(failure);
          if (e.type === 'message.updated' && p.info?.tokens)
            input.emit({ type: 'usage', data: { tokens: p.info.tokens, cost: p.info.cost } });
          if (e.type === 'session.error')
            failure(
              providerLimitFromError(
                p.error?.data || p.error,
                'opencode',
                input.employee.model.split('/')[0] || 'OpenCode provider',
              ) || new Error(p.error?.data?.message || 'OpenCode run failed'),
            );
          if (e.type === 'session.idle') {
            done = true;
            finish();
          }
        }
      }
    })().catch((e) => {
      if (!controller.signal.aborted) failure(e);
    });
    const abort = () => {
      void this.api(`/session/${session.id}/abort`, 'POST', {}, directory)
        .then(() => {
          done = true;
          finish();
        })
        .catch(failure);
    };
    input.signal.addEventListener('abort', abort, { once: true });
    try {
      const split = input.employee.model.indexOf('/');
      const model =
        split > 0
          ? {
              providerID: input.employee.model.slice(0, split),
              modelID: input.employee.model.slice(split + 1),
            }
          : undefined;
      await this.api(
        `/session/${session.id}/prompt_async`,
        'POST',
        {
          parts: [
            {
              type: 'text',
              text:
                input.prompt +
                input.attachments.map((a) => `\nAttachment ${a.name}: ${a.path}`).join(''),
            },
            ...input.attachments
              .filter((a) => a.mime.startsWith('image/'))
              .map((a) => ({
                type: 'file',
                mime: a.mime,
                filename: a.name,
                url: `data:${a.mime};base64,${readFileSync(a.path).toString('base64')}`,
              })),
          ],
          model,
          agent: input.readOnly ? 'plan' : 'build',
          system: input.employee.instructions,
        },
        directory,
      );
      if (input.signal.aborted) abort();
      await completion;
      input.emit({ type: 'final', text: [...parts.values()].at(-1) || '' });
      input.emit({ type: 'complete', data: { cancelled: input.signal.aborted } });
    } catch (error) {
      throw (
        providerLimitFromError(
          error,
          'opencode',
          input.employee.model.split('/')[0] || 'OpenCode provider',
        ) || error
      );
    } finally {
      input.signal.removeEventListener('abort', abort);
      controller.abort();
      await pump;
      if (input.tools?.workspace)
        await this.api(`/mcp/${toolName}/disconnect`, 'POST', {}, directory).catch(() => {});
    }
  }
  async dispose() {
    if (this.child?.pid) await killTree(this.child.pid);
  }
}
