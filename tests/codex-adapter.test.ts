import { describe, expect, it } from 'vitest';
import { CodexAdapter } from '../apps/service/src/adapters/codex.js';

describe('CodexAdapter session reuse', () => {
  it('steers the expected active turn when an agent receives a live @mention', async () => {
    const adapter = new CodexAdapter();
    let steer: any;
    adapter.liveRuns.set('run-live', { threadId: 'thread-live', turnId: 'turn-live', pending: [] });
    adapter.request = async (method: string, params: any) => {
      expect(method).toBe('turn/steer');
      steer = params;
      return {};
    };

    expect(await adapter.steer('run-live', 'A new mention needs your attention.')).toBe(true);
    expect(steer).toEqual({
      threadId: 'thread-live',
      expectedTurnId: 'turn-live',
      input: [
        {
          type: 'text',
          text: 'A new mention needs your attention.',
          text_elements: [],
        },
      ],
    });
    expect(await adapter.steer('missing-run', 'No live turn.')).toBe(false);
  });

  it('approves only the authenticated first-party workspace MCP surface under Full access', async () => {
    const adapter = new CodexAdapter();
    let startParams: any;
    let turnParams: any;
    adapter.start = async () => {};
    adapter.request = async (method: string, params: any) => {
      if (method === 'account/read') return { account: { type: 'chatgpt' } };
      if (method === 'thread/start') {
        startParams = params;
        return { thread: { id: 'thread-1' } };
      }
      if (method === 'turn/start') {
        turnParams = params;
        queueMicrotask(() =>
          adapter.events.emit('message', {
            method: 'turn/completed',
            params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
          }),
        );
        return { turn: { id: 'turn-1' } };
      }
      throw new Error(`Unexpected request: ${method}`);
    };

    await adapter.run({
      id: 'run-1',
      employee: {
        id: 'employee-1',
        name: 'Ada',
        role: 'Engineering',
        harness: 'codex',
        model: '',
        cwd: '',
        instructions: '',
        permissionMode: 'bypass',
      },
      readOnly: true,
      prompt: 'Review the plan.',
      attachments: [],
      signal: new AbortController().signal,
      emit: () => {},
      decide: async () => ({ allow: true }),
      tools: { workspace: { url: 'http://127.0.0.1/mcp', headers: { Authorization: 'token' } } },
    } as any);

    expect(startParams.approvalPolicy).toBe('never');
    expect(startParams.sandbox).toBe('read-only');
    expect(turnParams.approvalPolicy).toBe('never');
    expect(turnParams.sandboxPolicy).toEqual({ type: 'readOnly', networkAccess: false });
    expect(startParams.config.mcp_servers.workspace.default_tools_approval_mode).toBe('approve');
    expect(startParams.config.mcp_servers.workspace.url).toBe('http://127.0.0.1/mcp');
  });

  it('starts the next turn on an already loaded thread without resuming it again', async () => {
    const adapter = new CodexAdapter();
    const calls: string[] = [];
    const turnParams: any[] = [];
    let turnNumber = 0;
    adapter.start = async () => {};
    adapter.request = async (method: string, params: any) => {
      calls.push(method);
      if (method === 'account/read') return { account: { type: 'chatgpt' } };
      if (method === 'thread/start') return { thread: { id: 'thread-1' } };
      if (method === 'turn/start') {
        turnParams.push(params);
        turnNumber += 1;
        queueMicrotask(() =>
          adapter.events.emit('message', {
            method: 'turn/completed',
            params: {
              threadId: 'thread-1',
              turn: { id: `turn-${turnNumber}`, status: 'completed' },
            },
          }),
        );
        return { turn: { id: `turn-${turnNumber}` } };
      }
      throw new Error(`Unexpected request: ${method}`);
    };
    const input = (sessionId?: string, readOnly = false) =>
      ({
        id: `run-${turnNumber + 1}`,
        employee: {
          id: 'employee-1',
          name: 'Ada',
          role: 'Engineering',
          harness: 'codex',
          model: '',
          cwd: '',
          instructions: '',
          permissionMode: 'bypass',
        },
        readOnly,
        prompt: 'Continue the task',
        sessionId,
        attachments: [],
        signal: new AbortController().signal,
        emit: () => {},
        decide: async () => ({ allow: true }),
      }) as any;

    await adapter.run(input(undefined, true));
    await adapter.run(input('thread-1', false));
    await adapter.run(input('thread-1', true));
    const askInput = input('thread-1', false);
    askInput.employee.permissionMode = 'ask';
    await adapter.run(askInput);

    expect(calls.filter((method) => method === 'thread/start')).toHaveLength(1);
    expect(calls.filter((method) => method === 'thread/resume')).toHaveLength(0);
    expect(calls.filter((method) => method === 'turn/start')).toHaveLength(4);
    expect(turnParams.map((params) => params.sandboxPolicy.type)).toEqual([
      'readOnly',
      'dangerFullAccess',
      'readOnly',
      'workspaceWrite',
    ]);
    expect(turnParams.map((params) => params.approvalPolicy)).toEqual([
      'never',
      'never',
      'never',
      'untrusted',
    ]);
    expect(turnParams[3].sandboxPolicy.networkAccess).toBe(false);
  });

  it('starts a new session with conversation context when resume fails', async () => {
    const adapter = new CodexAdapter();
    const calls: string[] = [];
    let turnPrompt = '';
    adapter.start = async () => {};
    adapter.request = async (method: string, params: any) => {
      calls.push(method);
      if (method === 'account/read') return { account: { type: 'chatgpt' } };
      if (method === 'thread/resume') throw new Error('Codex thread/resume timed out');
      if (method === 'thread/start') return { thread: { id: 'fresh-thread' } };
      if (method === 'turn/start') {
        turnPrompt = params.input[0].text;
        queueMicrotask(() =>
          adapter.events.emit('message', {
            method: 'turn/completed',
            params: { threadId: 'fresh-thread', turn: { id: 'turn-1', status: 'completed' } },
          }),
        );
        return { turn: { id: 'turn-1' } };
      }
      throw new Error(`Unexpected request: ${method}`);
    };

    await adapter.run({
      id: 'run-1',
      employee: {
        id: 'employee-1',
        kind: 'agent',
        ownerId: 'owner-1',
        dmId: 'dm-1',
        createdAt: new Date().toISOString(),
        name: 'Ada',
        role: 'Engineering',
        harness: 'codex',
        model: '',
        cwd: '',
        instructions: '',
        permissionMode: 'bypass',
      },
      readOnly: false,
      prompt: 'Could we build a global startup?',
      sessionId: 'unresponsive-thread',
      resumeContext: 'Chris owns abralo.com.',
      attachments: [],
      signal: new AbortController().signal,
      emit: (event) => {
        if (event.type === 'session') expect(event.data.id).toBe('fresh-thread');
      },
      decide: async () => ({ allow: true }),
    });

    expect(calls).toEqual(['account/read', 'thread/resume', 'thread/start', 'turn/start']);
    expect(turnPrompt).toContain('Chris owns abralo.com.');
    expect(turnPrompt).toContain('Could we build a global startup?');
  });
});
