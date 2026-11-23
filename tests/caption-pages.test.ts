import { expect, it } from 'vitest';
import { captionPages } from '../apps/web/src/caption-pages';
it('retains every word across long thoughts and natural phrase boundaries', () => {
  const text =
    'First, a useful observation. ' +
    'A longer thought with enough detail to read comfortably. '.repeat(15);
  const pages = captionPages(text);
  expect(pages.length).toBeGreaterThan(3);
  expect(pages.join(' ')).toBe(text.trim());
  expect(pages.every((page) => page.length <= 180)).toBe(true);
  const more = captionPages(text + 'One final thought.');
  expect(more.slice(0, pages.length - 1)).toEqual(pages.slice(0, -1));
});
it('handles unpunctuated speech, empty input and long single words without truncation', () => {
  expect(captionPages('')).toEqual([]);
  const text = 'word '.repeat(100).trim();
  expect(captionPages(text).join(' ')).toBe(text);
  const long = 'a'.repeat(400);
  expect(captionPages(long)).toEqual([long]);
});
it('preserves decimals, quotes, punctuation and earlier page boundaries during streaming', () => {
  const text =
    '“Revenue grew 3.5%, and the address is example.com.” ' +
    'Please keep each word exactly as it was spoken. '.repeat(8);
  expect(captionPages(text).join(' ')).toBe(text.trim());
  for (let end = 30; end < text.length; end += 20) {
    const boundary = text.indexOf(' ', end);
    if (boundary < 0) break;
    const earlier = captionPages(text.slice(0, boundary));
    expect(captionPages(text).slice(0, earlier.length - 1)).toEqual(earlier.slice(0, -1));
  }
});
