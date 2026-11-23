import { expect, it, vi } from 'vitest';
const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }));
vi.mock('../packages/host/src/index.js', () => ({
  executable: () => ({ command: 'fixture-claude', args: [] }),
  execFileAsync: async () => ({
    stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }),
  }),
}));
import { ClaudeAdapter } from '../apps/service/src/adapters/claude.js';

const event = (e: any) => ({ type: 'stream_event', parent_tool_use_id: null, event: e });
const block = (index: number, text: string) => [
  event({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } }),
  event({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } }),
  event({ type: 'content_block_stop', index }),
];

it('keeps text written between tool calls as separate paragraphs', async () => {
  const emit = vi.fn();
  queryMock.mockImplementation(() => ({
    close() {},
    async *[Symbol.asyncIterator]() {
      yield* block(0, 'Checking the caption timing first.');
      yield event({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use' } });
      // The next assistant message starts its text block at index 0 again.
      yield* block(0, 'Now connecting the audio levels.');
      yield* block(0, ' ');
      yield { type: 'result', subtype: 'success', result: '' };
    },
  }));
  await new ClaudeAdapter().run({
    id: 'fixture',
    prompt: 'Test',
    attachments: [],
    signal: new AbortController().signal,
    emit,
    employee: { permissionMode: 'ask', instructions: '', cwd: '' },
    decide: async () => ({ allow: true }),
  } as any);
  const text = emit.mock.calls
    .filter(([e]) => e.type === 'text')
    .map(([e]) => e.text)
    .join('');
  expect(text).toBe('Checking the caption timing first.\n\nNow connecting the audio levels. ');
});
