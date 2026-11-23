import { expect, it } from 'vitest';
import {
  StreamingTextPacer,
  REVEAL_BUFFER,
  REVEAL_INTERVAL,
  revealEnd,
} from '../apps/web/src/streaming-text-pacer';

it('spreads a single burst evenly over three display updates without an end dump', () => {
  const pacer = new StreamingTextPacer(10);
  pacer.receive(100, 0);
  expect([0, 50, 100, 150].map((time) => pacer.position(time))).toEqual([10, 40, 70, 100]);
  expect(pacer.position(5000)).toBe(100);
});

it('blends overlapping uneven arrivals and keeps every arrival within the buffer bound', () => {
  const pacer = new StreamingTextPacer();
  const receipts = [
    { at: 0, end: 60 },
    { at: 35, end: 66 },
    { at: 80, end: 150 },
    { at: 310, end: 160 },
  ];
  let last = 0;
  for (let at = 0; at <= 500; at += 5) {
    const receipt = receipts.find((item) => item.at === at);
    if (receipt) pacer.receive(receipt.end, at);
    const end = pacer.position(at);
    expect(end).toBeGreaterThanOrEqual(last);
    expect(end).toBeLessThanOrEqual(receipts.filter((item) => item.at <= at).at(-1)!.end);
    for (const old of receipts.filter((item) => item.at + REVEAL_BUFFER <= at))
      expect(end).toBeGreaterThanOrEqual(old.end);
    last = end;
  }
  expect(last).toBe(160);
});

it('smooths lumpy arrivals with lower display-step variance than flushing each network batch', () => {
  const pacer = new StreamingTextPacer();
  const sizes = [2, 30, 1, 17, 0, 25, 4, 12, 3, 20];
  let received = 0,
    shown = 0;
  const increments: number[] = [];
  for (const [index, size] of sizes.entries()) {
    received += size;
    pacer.receive(received, index * REVEAL_INTERVAL);
    const end = pacer.position((index + 1) * REVEAL_INTERVAL);
    increments.push(end - shown);
    shown = end;
  }
  const variance = (values: number[]) => {
    const mean = values.reduce((a, b) => a + b) / values.length;
    return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  };
  expect(variance(increments)).toBeLessThan(variance(sizes) / 2);
});

it('resets for replacements and does not replay earlier text after a long pause', () => {
  const pacer = new StreamingTextPacer(20);
  pacer.receive(100, 0);
  pacer.reset(12);
  expect(pacer.position(100)).toBe(12);
  pacer.receive(42, 10000);
  expect(pacer.position(10050)).toBe(22);
  expect(pacer.position(10150)).toBe(42);
});

it('uses nearby word boundaries without stalling long URLs or splitting graphemes', () => {
  expect(revealEnd('A calm conversation continues.', 0, 11)).toBe(7);
  const text = '静かな会話👩🏽‍💻e\u0301https://example.com/longpath';
  const boundaries = new Set([
    0,
    ...Array.from(
      new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text),
      (s) => s.index + s.segment.length,
    ),
  ]);
  let shown = 0;
  for (let position = 1; position <= text.length; position++) {
    const end = revealEnd(text, shown, position);
    expect(boundaries.has(end)).toBe(true);
    expect(end).toBeGreaterThanOrEqual(shown);
    shown = end;
  }
  expect(shown).toBe(text.length);
});

it('skips animation for very large bursts to avoid repeated expensive Markdown passes', () => {
  const pacer = new StreamingTextPacer();
  pacer.receive(100000, 0);
  expect(pacer.position(0)).toBe(100000);
  expect(pacer.position(REVEAL_BUFFER)).toBe(100000);
});
