import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SpokenActionTurns } from '../apps/web/src/spoken-action-turns';

let turns: SpokenActionTurns;
let save = vi.fn(async (_id: string, _text: string): Promise<void> => {});
beforeEach(() => {
  vi.useFakeTimers();
  save = vi.fn(async (_id: string, _text: string): Promise<void> => {});
  turns = new SpokenActionTurns(save);
});
afterEach(() => { turns.close(); vi.useRealTimers(); });

it('waits beyond the old four-second window and for persistence, without matching model words', async () => {
  let committed!: () => void;
  save.mockImplementation(() => new Promise<void>((resolve) => { committed = resolve; }));
  turns.start('human'); turns.response('reply');
  const source = turns.source('reply');
  const done = vi.fn(); void source.then(done);
  await vi.advanceTimersByTimeAsync(6000);
  expect(done).not.toHaveBeenCalled();
  const saved = turns.transcribed('human', 'Yes, go ahead with both goals.');
  await vi.advanceTimersByTimeAsync(0);
  expect(save).toHaveBeenCalledExactlyOnceWith('human', 'Yes, go ahead with both goals.');
  expect(done).not.toHaveBeenCalled();
  committed(); await saved;
  await expect(source).resolves.toBe('human');
});

it('preserves speaking order for out-of-order transcripts and rejects the interrupted response', async () => {
  turns.start('first'); turns.response('old');
  turns.start('correction'); turns.response('new');
  const correction = turns.transcribed('correction', 'Stop.');
  await vi.advanceTimersByTimeAsync(0);
  expect(save).not.toHaveBeenCalled();
  await turns.transcribed('first', 'Start.'); await correction;
  expect(save.mock.calls.map(([id]) => id)).toEqual(['first', 'correction']);
  await expect(turns.source('old')).rejects.toThrow('instruction changed');
  await expect(turns.source('new')).resolves.toBe('correction');
});

it('shares one saved instruction across parallel goals and follow-up tool responses', async () => {
  turns.start('yes'); turns.response('batch');
  await turns.transcribed('yes', 'Yes, do both.');
  await turns.transcribed('yes', 'Yes, do both.');
  await expect(Promise.all([turns.source('batch'), turns.source('batch')])).resolves.toEqual(['yes', 'yes']);
  turns.response('follow-up');
  await expect(turns.source('follow-up')).resolves.toBe('yes');
  expect(save).toHaveBeenCalledOnce();
});

it('never substitutes an earlier instruction when transcription fails', async () => {
  turns.start('old'); await turns.transcribed('old', 'Start.');
  turns.start('new'); turns.response('reply'); turns.failed('new');
  await expect(turns.source('reply')).rejects.toThrow('could not be transcribed');
  expect(save).toHaveBeenCalledOnce();
});

it('surfaces an actual persistence failure without authorizing the action', async () => {
  save.mockRejectedValue(new Error('Save unavailable'));
  turns.start('human'); turns.response('reply');
  await expect(turns.transcribed('human', 'Proceed.')).rejects.toThrow('Save unavailable');
  await expect(turns.source('reply')).rejects.toThrow('Save unavailable');
});

it('settles missing transcription on timeout and releases pending work on close', async () => {
  turns.start('missing'); turns.response('reply');
  const timeout = expect(turns.source('reply')).rejects.toThrow('could not be transcribed');
  await vi.advanceTimersByTimeAsync(30000); await timeout;
  turns.start('pending'); turns.response('later');
  const closed = expect(turns.source('later')).rejects.toThrow('closed');
  turns.close(); await closed;
  expect(save).not.toHaveBeenCalled();
});

it('cannot attach an opening or unknown response to a later human instruction', async () => {
  turns.response('opening');
  turns.start('later'); await turns.transcribed('later', 'Go ahead.');
  await expect(turns.source('opening')).rejects.toThrow('no spoken instruction');
  await expect(turns.source('unknown')).rejects.toThrow('no spoken instruction');
});

it('does not time out while the human is still delivering a long instruction', async () => {
  turns.start('long');
  await vi.advanceTimersByTimeAsync(60000);
  turns.stopped('long'); turns.response('reply');
  await turns.transcribed('long', 'The complete instruction and all its constraints.');
  await expect(turns.source('reply')).resolves.toBe('long');
});
