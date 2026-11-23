import { afterEach, expect, it, vi } from 'vitest';
import { CaptionQueue, wordEnd } from '../apps/web/src/caption-queue';
afterEach(() => vi.useRealTimers());

/** A simulated playback: audio levels arrive every 32 ms, like the analyser. */
function playback(rate = 0.015) {
  let clock = 0;
  const publish = vi.fn();
  const captions = new CaptionQueue(publish, () => clock, rate);
  const speak = (ms: number, level = 0.4) => {
    for (let t = 0; t < ms; t += 32) {
      clock += 32;
      captions.audio(level);
    }
  };
  const last = () => publish.mock.lastCall?.[1] ?? '';
  return { captions, publish, speak, last, wait: (ms: number) => speak(ms, 0) };
}

it('reveals whole words in step with audible speech, not when text arrives', () => {
  const p = playback();
  p.captions.begin('one');
  p.captions.append('What good shall we do this day? Let us begin.', true);
  expect(p.publish).not.toHaveBeenCalled(); // Text arrived; nothing is heard yet.
  p.captions.play();
  p.speak(320); // ~4.8 characters heard
  expect(p.last()).toBe('What');
  p.speak(320);
  expect(p.last()).toBe('What good');
  // Every update is a whole word extending the previous caption.
  for (const [, text] of p.publish.mock.calls) expect(text).toMatch(/^What( \S+)*$/);
});

it('holds the caption still while the Chief pauses, then continues', () => {
  const p = playback();
  p.captions.begin('one');
  p.captions.append('First thought. Then a second thought after a pause.', true);
  p.captions.play();
  p.speak(900);
  const beforePause = p.last();
  expect(beforePause).toBe('First thought.');
  p.wait(1500); // Silence in the audio: the text must not run ahead.
  expect(p.last()).toBe(beforePause);
  p.speak(500);
  expect(p.last()).toMatch(/^First thought\. Then/);
});

it('never shows a partly received word', () => {
  expect(wordEnd('Hello wor', 9, false)).toBe(5);
  expect(wordEnd('Hello wor', 9, true)).toBe(9);
  expect(wordEnd('Hello world', 7, false)).toBe(5);
  expect(wordEnd('Hello world ', 7, false)).toBe(11);
  expect(wordEnd('Hello', 0, true)).toBe(0);
});

it('freezes on the last word heard when interrupted, including a late stopped event', () => {
  const p = playback();
  p.captions.begin('one');
  p.captions.append('Heard this. Never heard this.', true);
  p.captions.play();
  p.speak(700);
  p.captions.discard();
  p.captions.append('Heard this. Never heard this. Late text.', true);
  p.captions.finish();
  p.captions.play();
  p.speak(2000);
  expect(p.last()).toBe('Heard this.');
});

it('completes the caption at the actual end of playback and learns the voice’s pace', () => {
  const p = playback(0.012);
  const text = 'This reply is spoken a little faster than the default estimate.';
  p.captions.begin('one');
  p.captions.append(text, true);
  p.captions.play();
  p.speak(2560); // Faster voice: the whole reply took 2.56 s of speech.
  expect(p.last().length).toBeLessThan(text.length);
  p.captions.finish();
  expect(p.last()).toBe(text);
  // Calibrated towards the measured ~0.025 chars/ms, smoothed and bounded.
  expect(p.captions.rate).toBeGreaterThan(0.015);
  expect(p.captions.rate).toBeLessThan(0.03);
});

it('retains the completed response when the next reply begins', () => {
  const p = playback();
  p.captions.begin('one');
  p.captions.append('First phrase. Rest of the spoken reply.', true);
  p.captions.play();
  p.speak(200);
  p.captions.begin('two');
  expect(p.publish).toHaveBeenLastCalledWith('one', 'First phrase. Rest of the spoken reply.');
  p.captions.cancel();
});

it('falls back to the playback clock when audio levels are unavailable', () => {
  vi.useFakeTimers();
  let clock = 0;
  const publish = vi.fn();
  const captions = new CaptionQueue(publish, () => clock, 0.015);
  captions.begin('one');
  captions.append('No analyser in this browser.', true);
  captions.play();
  for (let i = 0; i < 50; i++) {
    clock += 40;
    vi.advanceTimersByTime(40);
  }
  expect(publish.mock.lastCall?.[1]).toBe('No analyser in this browser.');
  captions.cancel();
});
