import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../apps/web/src/api';
import { briefingWrite } from '../apps/web/src/briefing-write';
vi.mock('../apps/web/src/api', () => ({ api: vi.fn() }));
beforeEach(() => { vi.useFakeTimers(); vi.mocked(api).mockReset(); });
afterEach(() => vi.useRealTimers());

it('retries lost acknowledgements with the exact same idempotency key and payload', async () => {
  vi.mocked(api).mockRejectedValueOnce(new TypeError('Network lost')).mockResolvedValue({ status: 'queued' });
  const body = { callId: 'same-call', sourceTurnId: 'same-turn', args: { title: 'One goal' } };
  const request = briefingWrite('/briefings/b/act', body);
  await vi.advanceTimersByTimeAsync(250);
  await expect(request).resolves.toEqual({ status: 'queued' });
  expect(api).toHaveBeenCalledTimes(2);
  for (const call of vi.mocked(api).mock.calls) expect(call.slice(0, 2)).toEqual(['/briefings/b/act', body]);
});
it('does not retry validation or authorization failures', async () => {
  vi.mocked(api).mockRejectedValue(Object.assign(new Error('Unavailable'), { status: 403 }));
  await expect(briefingWrite('/briefings/b/act', {})).rejects.toThrow('Unavailable');
  expect(api).toHaveBeenCalledOnce();
});
it('bounds transient retries and aborts stalled requests', async () => {
  vi.mocked(api).mockImplementation((_path, _body, _method, signal) => new Promise((_resolve, reject) => {
    signal!.addEventListener('abort', () => reject(new Error('Timed out')));
  }));
  const failed = expect(briefingWrite('/briefings/b/turns', { id: 'turn' })).rejects.toThrow('Timed out');
  await vi.advanceTimersByTimeAsync(31000); await failed;
  expect(api).toHaveBeenCalledTimes(3);
});

it('does not retry an unacknowledged action after the human changes the instruction', async () => {
  vi.mocked(api).mockRejectedValue(new TypeError('Network lost'));
  const current = vi.fn().mockImplementationOnce(() => {}).mockImplementation(() => { throw new Error('Instruction changed'); });
  const failed = expect(briefingWrite('/briefings/b/act', { callId: 'old' }, current)).rejects.toThrow('Instruction changed');
  await vi.advanceTimersByTimeAsync(250); await failed;
  expect(api).toHaveBeenCalledOnce();
});
