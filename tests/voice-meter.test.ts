import { afterEach, expect, it, vi } from 'vitest';
import { VoiceMeter } from '../apps/web/src/voice-meter';

afterEach(() => vi.unstubAllGlobals());

it('measures independent streams, settles on silence, and releases its analysis graph', () => {
  let frame: FrameRequestCallback;
  const sources: any[] = [],
    analysers: any[] = [];
  const close = vi.fn(async () => {}),
    cancel = vi.fn();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frame = callback;
    return 42;
  });
  vi.stubGlobal('cancelAnimationFrame', cancel);
  vi.stubGlobal(
    'AudioContext',
    class {
      resume = async () => {};
      close = close;
      createMediaStreamSource = () => {
        const source = { connect: vi.fn(), disconnect: vi.fn() };
        sources.push(source);
        return source;
      };
      createAnalyser = () => {
        const node = {
          fftSize: 0,
          amplitude: 0,
          disconnect: vi.fn(),
          getFloatTimeDomainData: (buffer: Float32Array) => buffer.fill(node.amplitude),
        };
        analysers.push(node);
        return node;
      };
    },
  );
  const update = vi.fn();
  const meter = new VoiceMeter(update);
  meter.attach('input', {} as MediaStream);
  meter.attach('output', {} as MediaStream);
  analysers[0].amplitude = 0.15;
  analysers[1].amplitude = 0.04;
  frame!(40);
  let value = update.mock.calls.at(-1)![0];
  expect(value.input.every((v: number) => v > 0.4)).toBe(true);
  expect(value.output).toBeGreaterThan(0.1);
  expect(value.output).toBeLessThan(0.2);
  // Neither stream is connected to speakers; only the corresponding analyser.
  expect(sources[0].connect).toHaveBeenCalledExactlyOnceWith(analysers[0]);
  expect(sources[1].connect).toHaveBeenCalledExactlyOnceWith(analysers[1]);
  analysers[0].amplitude = 0.004;
  analysers[1].amplitude = 0;
  for (let time = 80; time < 1600; time += 40) frame!(time);
  value = update.mock.calls.at(-1)![0];
  expect(value.input[0]).toBeLessThan(0.001);
  expect(value.output).toBeLessThan(0.001);
  meter.close();
  meter.close();
  expect(cancel).toHaveBeenCalledExactlyOnceWith(42);
  expect(close).toHaveBeenCalledOnce();
  for (const node of [...sources, ...analysers]) expect(node.disconnect).toHaveBeenCalledOnce();
  expect(update.mock.calls.at(-1)![0]).toEqual({ input: Array(24).fill(0), output: 0 });
  const count = update.mock.calls.length;
  frame!(1640);
  expect(update).toHaveBeenCalledTimes(count);
});
