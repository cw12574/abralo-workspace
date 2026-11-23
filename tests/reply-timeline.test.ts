import { describe, expect, it } from 'vitest';
import { buildReplyTimeline } from '../apps/web/src/reply-timeline';

const step = (id: string, second: number, textOffset?: number) => ({
  id,
  type: 'tool',
  title: id,
  time: `2026-11-11T13:00:${String(second).padStart(2, '0')}.000Z`,
  textOffset,
});

const shape = (text: string, items: ReturnType<typeof buildReplyTimeline>) =>
  items.map((item) =>
    item.kind === 'text' ? text.slice(item.start, item.end) : item.steps.map((s) => s.id),
  );

describe('reply timeline', () => {
  it('interleaves steps and text in the order they happened', () => {
    const text = 'Checking.\n\nFound it.\n\nDone.';
    const items = buildReplyTimeline(text, [
      step('worktree', 1, 0),
      step('tools', 2, 0),
      step('read', 4, 9),
      step('thinking', 5, 9),
      step('edit', 7, 20),
    ]);
    expect(shape(text, items)).toEqual([
      ['worktree', 'tools'],
      'Checking.',
      ['read', 'thinking'],
      '\n\nFound it.',
      ['edit'],
      '\n\nDone.',
    ]);
  });

  it('orders by time, not by arrival order', () => {
    const text = 'Hello';
    const items = buildReplyTimeline(text, [step('second', 3, 5), step('first', 1, 0)]);
    expect(shape(text, items)).toEqual([['first'], 'Hello', ['second']]);
  });

  it('keeps older replies without offsets as one group above the text', () => {
    const text = 'Answer';
    const items = buildReplyTimeline(text, [step('a', 1), step('b', 2)]);
    expect(shape(text, items)).toEqual([['a', 'b'], 'Answer']);
  });

  it('does not split steps separated only by whitespace', () => {
    const text = 'Start\n\n';
    const items = buildReplyTimeline(text, [step('a', 1, 5), step('b', 2, 7)]);
    expect(shape(text, items)).toEqual(['Start', ['a', 'b']]);
  });

  it('places steps beyond the revealed text after it while streaming', () => {
    const text = 'Partly rev';
    const items = buildReplyTimeline(text, [step('later', 1, 40)]);
    expect(shape(text, items)).toEqual(['Partly rev', ['later']]);
  });
});
