import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../apps/web/src/api';
import { BriefingVoice } from '../apps/web/src/briefing-voice';

vi.mock('../apps/web/src/api', () => ({ api: vi.fn() }));
let client: BriefingVoice;
let peer: any;
let channel: any;
let track: any;
let callbacks: any;

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(api).mockReset();
  vi.mocked(api).mockImplementation(async (path) =>
    path === '/briefings/voice' ? { configured: true } : { sdp: 'answer-sdp' },
  );
  track = { enabled: true, stop: vi.fn() };
  channel = { readyState: 'open', send: vi.fn(), close: vi.fn() };
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getUserMedia: vi.fn(async () => ({
        getTracks: () => [track],
        getAudioTracks: () => [track],
      })),
    },
  });
  class Peer {
    constructor() {
      peer = this;
    }
    addTrack = vi.fn();
    createDataChannel = () => channel;
    createOffer = async () => ({ type: 'offer', sdp: 'offer-sdp' });
    setLocalDescription = vi.fn();
    setRemoteDescription = vi.fn();
    close = vi.fn();
  }
  vi.stubGlobal('RTCPeerConnection', Peer);
  vi.stubGlobal('window', { RTCPeerConnection: Peer });
  vi.stubGlobal(
    'Audio',
    class {
      play = async () => {};
      pause = vi.fn();
    },
  );
  callbacks = {
    state: vi.fn(),
    transcript: vi.fn(),
    next: vi.fn(async () => {}),
    readbackDone: vi.fn(),
    error: vi.fn(),
  };
  client = new BriefingVoice(callbacks);
});
afterEach(() => {
  client.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function event(value: object) {
  channel.onmessage({ data: JSON.stringify(value) });
}
function opening() {
  return JSON.parse(channel.send.mock.calls[0][0]);
}
it('retains an interrupted reply separately from the captions already shown and ignores late text', async () => {
  callbacks.readableCaption = vi.fn();
  callbacks.playback = vi.fn();
  await client.connect('briefing');
  event({ type: 'response.created', response: { id: 'reply' } });
  event({ type: 'output_audio_buffer.started', response_id: 'reply' });
  event({ type: 'response.output_audio_transcript.delta', response_id: 'reply', item_id: 'item', delta: 'First thought. Unspoken continuation.' });
  // Captions follow the audio heard: about 950 ms of speech covers the first thought.
  vi.advanceTimersByTime(950);
  event({ type: 'input_audio_buffer.speech_started', item_id: 'human' });
  event({ type: 'response.output_audio_transcript.done', response_id: 'reply', item_id: 'item', transcript: 'First thought. Unspoken continuation.' });
  event({ type: 'response.output_audio_transcript.delta', response_id: 'reply', item_id: 'item', delta: 'Late words.' });
  event({ type: 'output_audio_buffer.stopped', response_id: 'reply' });
  await Promise.resolve(); await Promise.resolve();
  // Word by word as heard, ending on the last word before the interruption.
  expect(callbacks.readableCaption.mock.calls).toEqual([
    ['reply', 'First'],
    ['reply', 'First thought.'],
  ]);
  expect(callbacks.playback).toHaveBeenCalledExactlyOnceWith('item', 'First thought.', 'reply');
  expect(callbacks.transcript).toHaveBeenCalledWith('item', 'First thought. Unspoken continuation.', false);
});
it('does not mark a completed spoken reply as interrupted when the human takes their turn', async () => {
  callbacks.playback = vi.fn();
  await client.connect('briefing');
  event({ type: 'response.created', response: { id: 'reply' } });
  event({ type: 'output_audio_buffer.started', response_id: 'reply' });
  event({ type: 'response.output_audio_transcript.done', response_id: 'reply', item_id: 'item', transcript: 'A complete thought.' });
  event({ type: 'output_audio_buffer.stopped', response_id: 'reply' });
  event({ type: 'input_audio_buffer.speech_started', item_id: 'human' });
  await Promise.resolve(); await Promise.resolve();
  expect(callbacks.playback).not.toHaveBeenCalled();
});

it('keeps speaking through late transcription and listening through interrupted audio cleanup', async () => {
  await client.connect('briefing');
  event({ type: 'output_audio_buffer.started' });
  event({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'late',
    transcript: 'Hello',
  });
  expect(callbacks.state).toHaveBeenLastCalledWith('speaking');
  event({ type: 'input_audio_buffer.speech_started' });
  event({ type: 'output_audio_buffer.cleared' });
  expect(callbacks.state).toHaveBeenLastCalledWith('listening');
  event({ type: 'input_audio_buffer.speech_stopped' });
  expect(callbacks.state).toHaveBeenLastCalledWith('transcribing');
});

it('streams captions and stops the microphone immediately while requesting a final recap', async () => {
  callbacks.caption = vi.fn();
  await client.connect('briefing');
  event({ type: 'response.created', response: { id: 'welcome' } });
  event({ type: 'response.output_audio_transcript.delta', delta: 'What good ' });
  event({ type: 'response.output_audio_transcript.delta', delta: 'shall we do this day?' });
  expect(callbacks.caption).toHaveBeenLastCalledWith('What good shall we do this day?');
  client.endInput();
  expect(track.stop).toHaveBeenCalledOnce();
  expect(channel.close).not.toHaveBeenCalled();
  client.requestRecap();
  event({ type: 'response.done' });
  expect(
    channel.send.mock.calls.some(([raw]: [string]) =>
      JSON.parse(raw).response?.instructions?.includes('Call save_recap'),
    ),
  ).toBe(true);
  client.close();
  expect(channel.close).toHaveBeenCalledOnce();
});

it('waits for the final transcript before asking for the ended conversation recap', async () => {
  await client.connect('briefing');
  event({ type: 'input_audio_buffer.speech_started' });
  client.endInput();
  client.requestRecap();
  const recapRequests = () =>
    channel.send.mock.calls.filter(([raw]: [string]) =>
      JSON.parse(raw).response?.instructions?.includes('Call save_recap'),
    );
  expect(track.stop).toHaveBeenCalled();
  expect(recapRequests()).toHaveLength(0);
  event({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'last',
    transcript: 'No outreach.',
  });
  expect(callbacks.transcript).toHaveBeenCalledWith('last', 'No outreach.', true);
  expect(recapRequests()).toHaveLength(1);
});

it('requests a spoken welcome as soon as the initial briefing channel opens', async () => {
  await client.connect('briefing');
  expect(channel.send).not.toHaveBeenCalled();
  channel.onopen();
  expect(opening().type).toBe('response.create');
  expect(opening().response.instructions).toContain('welcome the human');
  expect(peer.setRemoteDescription).toHaveBeenCalledWith({ type: 'answer', sdp: 'answer-sdp' });
  event({ type: 'output_audio_buffer.started' });
  expect(callbacks.state).toHaveBeenLastCalledWith('speaking');
  event({
    type: 'response.output_audio_transcript.done',
    item_id: 'welcome',
    transcript: 'Good morning.',
  });
  expect(callbacks.transcript).toHaveBeenCalledWith('welcome', 'Good morning.', false);
});

it('still opens with the employee question and records the answer only once', async () => {
  await client.connect('briefing', 'question');
  channel.onopen();
  expect(opening().response.instructions).toContain('ask your prepared question');
  expect(api).toHaveBeenCalledWith('/briefings/briefing/voice', {
    sdp: 'offer-sdp',
    questionId: 'question',
  });
  const answer = {
    type: 'response.function_call_arguments.done',
    name: 'next_question',
    call_id: 'answer',
    arguments: JSON.stringify({ answer: 'Existing customers', defer: false }),
  };
  event(answer);
  event(answer);
  expect(callbacks.next).toHaveBeenCalledExactlyOnceWith('Existing customers', false);
});

it('allows interruption and never marks an interrupted readback complete', async () => {
  await client.connect('briefing', undefined, 'Proposed work.');
  channel.onopen();
  expect(opening().response.instructions).toContain('Proposed work.');
  event({ type: 'response.created', response: { id: 'recap' } });
  event({ type: 'output_audio_buffer.started' });
  event({ type: 'input_audio_buffer.speech_started' });
  expect(callbacks.state).toHaveBeenLastCalledWith('listening');
  client.stopSpeaking();
  expect(channel.send.mock.calls.slice(-2).map((call: any[]) => JSON.parse(call[0]).type)).toEqual([
    'response.cancel',
    'output_audio_buffer.clear',
  ]);
  event({ type: 'output_audio_buffer.cleared' });
  event({ type: 'output_audio_buffer.stopped', response_id: 'recap' });
  expect(callbacks.readbackDone).not.toHaveBeenCalled();
});

it('marks the final readback ready only after its audio finishes', async () => {
  await client.connect('briefing', undefined, 'Proposed work.');
  channel.onopen();
  event({ type: 'response.created', response: { id: 'recap' } });
  event({ type: 'output_audio_buffer.stopped', response_id: 'other' });
  expect(callbacks.readbackDone).not.toHaveBeenCalled();
  event({ type: 'output_audio_buffer.stopped', response_id: 'recap' });
  expect(callbacks.readbackDone).toHaveBeenCalledOnce();
});

it('does not speak after the session has closed and releases the microphone', async () => {
  await client.connect('briefing');
  client.close();
  channel.onopen();
  expect(channel.send).not.toHaveBeenCalled();
  expect(track.stop).toHaveBeenCalled();
  expect(peer.close).toHaveBeenCalled();
});

it('reports missing voice setup before requesting microphone access', async () => {
  vi.mocked(api).mockResolvedValue({ configured: false });
  await client.connect('briefing');
  expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  expect(callbacks.error).toHaveBeenCalledWith(expect.stringContaining('Connect voice'));
});

it('keeps chief recap and correction on the same connection and acknowledges tool results', async () => {
  callbacks.recap = vi.fn(async () => 'Saved recap. No outreach.');
  callbacks.interrupted = vi.fn();
  await client.connect('briefing', undefined, undefined, true);
  channel.onopen();
  expect(opening().response.instructions).toContain('Chief of Staff');
  event({ type: 'response.created', response: { id: 'tool-response' } });
  const call = {
    type: 'response.function_call_arguments.done',
    name: 'save_recap',
    call_id: 'recap-call',
    arguments: JSON.stringify({ summary: 'Internal list only.', actions: [] }),
  };
  event(call);
  event(call);
  await vi.waitFor(() => expect(callbacks.recap).toHaveBeenCalledOnce());
  await Promise.resolve();
  await Promise.resolve();
  event({ type: 'response.done' });
  const sent = channel.send.mock.calls.map((c: any[]) => JSON.parse(c[0]));
  expect(
    sent.some(
      (e: any) => e.item?.type === 'function_call_output' && e.item.call_id === 'recap-call',
    ),
  ).toBe(true);
  expect(sent.at(-1).response.instructions).toContain('No outreach');
  expect(peer.close).not.toHaveBeenCalled();
  event({
    type: 'response.created',
    response: { id: 'read', metadata: { briefing_readback: 'true' } },
  });
  event({ type: 'output_audio_buffer.stopped', response_id: 'read' });
  expect(callbacks.readbackDone).toHaveBeenCalledOnce();
  event({ type: 'input_audio_buffer.speech_started' });
  expect(callbacks.interrupted).not.toHaveBeenCalled();
});
it('invalidates a chief readback at speech onset before a delayed audio-clear event', async () => {
  callbacks.interrupted = vi.fn();
  await client.connect('briefing', undefined, 'Read this.', true);
  channel.onopen();
  event({
    type: 'response.created',
    response: { id: 'read', metadata: { briefing_readback: 'true' } },
  });
  event({ type: 'input_audio_buffer.speech_started' });
  event({ type: 'output_audio_buffer.stopped', response_id: 'read' });
  expect(callbacks.readbackDone).not.toHaveBeenCalled();
  expect(callbacks.interrupted).toHaveBeenCalledOnce();
});
it('returns a failed tool result when recap persistence fails and allows a retry', async () => {
  callbacks.recap = vi.fn(async () => {
    throw new Error('Save failed');
  });
  await client.connect('briefing', undefined, undefined, true);
  channel.onopen();
  event({
    type: 'response.function_call_arguments.done',
    name: 'save_recap',
    call_id: 'bad-save',
    arguments: JSON.stringify({ summary: 'Summary', actions: [] }),
  });
  await vi.waitFor(() => expect(callbacks.error).toHaveBeenCalledWith('Save failed'));
  expect(
    channel.send.mock.calls
      .map((c: any[]) => JSON.parse(c[0]))
      .some((e: any) => e.item?.output?.includes('"saved":false')),
  ).toBe(true);
});

it('does not speak a stale recap when the human continues while it is saving', async () => {
  let resolveSave!: (text: string) => void;
  callbacks.recap = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        resolveSave = resolve;
      }),
  );
  await client.connect('briefing', undefined, undefined, true);
  channel.onopen();
  event({
    type: 'response.function_call_arguments.done',
    name: 'save_recap',
    call_id: 'slow',
    arguments: JSON.stringify({ summary: 'Old recap', actions: [] }),
  });
  event({ type: 'input_audio_buffer.speech_started' });
  await vi.waitFor(() => expect(callbacks.recap).toHaveBeenCalledOnce());
  resolveSave('Old readback');
  await Promise.resolve();
  await Promise.resolve();
  expect(
    channel.send.mock.calls
      .map((c: any[]) => JSON.parse(c[0]))
      .some((e: any) => e.response?.instructions?.includes('Old readback')),
  ).toBe(false);
});

it('executes a live action once and resumes with its real result on the same voice connection', async () => {
  callbacks.action = vi.fn(async () => ({ status: 'queued', name: 'Maya' }));
  await client.connect('briefing', undefined, undefined, true);
  channel.onopen();
  event({ type: 'input_audio_buffer.speech_started', item_id: 'human-action' });
  event({ type: 'input_audio_buffer.speech_stopped', item_id: 'human-action' });
  event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'human-action', transcript: 'Please do the requested work.' });
  event({ type: 'response.created', response: { id: 'action-source' } });
  event({ type: 'response.created', response: { id: 'action-response' } });
  const call = {
    type: 'response.function_call_arguments.done',
    name: 'create_employee',
    response_id: 'action-source',
    call_id: 'create',
    arguments: JSON.stringify({
      userRequest: 'Create Maya',
      name: 'Maya',
      role: 'Research',
      task: '',
    }),
  };
  event(call);
  event(call);
  await vi.waitFor(() => expect(callbacks.action).toHaveBeenCalledOnce());
  await Promise.resolve();
  event({ type: 'response.done' });
  const sent = channel.send.mock.calls.map((c: any[]) => JSON.parse(c[0]));
  expect(
    sent.some((e: any) => e.item?.call_id === 'create' && e.item.output.includes('queued')),
  ).toBe(true);
  expect(sent.at(-1)).toEqual({ type: 'response.create', response: {} });
  expect(peer.close).not.toHaveBeenCalled();
});
it('returns failed workspace actions to the voice without inventing success', async () => {
  callbacks.action = vi.fn(async () => {
    throw new Error('Employee unavailable');
  });
  await client.connect('briefing', undefined, undefined, true);
  channel.onopen();
  event({ type: 'input_audio_buffer.speech_started', item_id: 'human-action' });
  event({ type: 'input_audio_buffer.speech_stopped', item_id: 'human-action' });
  event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'human-action', transcript: 'Please do the requested work.' });
  event({ type: 'response.created', response: { id: 'action-source' } });
  event({
    type: 'response.function_call_arguments.done',
    name: 'delegate_task',
    response_id: 'action-source',
    call_id: 'bad-action',
    arguments: '{}',
  });
  await vi.waitFor(() => expect(callbacks.error).toHaveBeenCalledWith('Employee unavailable'));
  expect(
    channel.send.mock.calls
      .map((c: any[]) => JSON.parse(c[0]))
      .some((e: any) => e.item?.output?.includes('failed')),
  ).toBe(true);
});

it('batches simultaneous goal results into one response and never replays the actions', async () => {
  const resolvers: ((value: unknown) => void)[] = [];
  callbacks.action = vi.fn(() => new Promise((resolve) => resolvers.push(resolve)));
  await client.connect('briefing', undefined, undefined, true);
  channel.onopen();
  event({ type: 'input_audio_buffer.speech_started', item_id: 'human-action' });
  event({ type: 'input_audio_buffer.speech_stopped', item_id: 'human-action' });
  event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'human-action', transcript: 'Please do the requested work.' });
  event({ type: 'response.created', response: { id: 'action-source' } });
  event({ type: 'response.created', response: { id: 'goals' } });
  for (const call_id of ['first', 'second']) event({ type: 'response.function_call_arguments.done', name: 'delegate_goal', response_id: 'action-source', call_id, arguments: '{}' });
  event({ type: 'response.done' });
  const responses = () => channel.send.mock.calls.map(([raw]: [string]) => JSON.parse(raw)).filter((e: any) => e.type === 'response.create');
  await vi.waitFor(() => expect(resolvers).toHaveLength(2));
  resolvers[0]({ status: 'queued' });
  await Promise.resolve(); await Promise.resolve();
  expect(responses()).toHaveLength(1);
  resolvers[1]({ status: 'queued' });
  await Promise.resolve(); await Promise.resolve();
  expect(responses()).toHaveLength(2);
  event({ type: 'error', event_id: 'error-1', error: { code: 'conversation_already_has_active_response', type: 'invalid_request_error' } });
  expect(peer.close).not.toHaveBeenCalled();
  expect(callbacks.action).toHaveBeenCalledTimes(2);
  expect(api).toHaveBeenCalledWith('/briefings/briefing/voice-diagnostics', expect.objectContaining({ code: 'conversation_already_has_active_response' }));
});
it('keeps recoverable errors open without storing provider prose or retrying committed work', async () => {
  await client.connect('briefing', undefined, undefined, true);
  event({ type: 'error', event_id: 'err', error: { code: 'invalid_event', type: 'invalid_request_error', event_id: 'request', message: 'Sensitive provider detail' } });
  expect(peer.close).not.toHaveBeenCalled();
  expect(track.stop).not.toHaveBeenCalled();
  expect(api).toHaveBeenCalledWith('/briefings/briefing/voice-diagnostics', { code: 'invalid_event', type: 'invalid_request_error', eventId: 'err', requestEventId: 'request' });
  expect(callbacks.error).toHaveBeenCalledWith(expect.stringContaining('try speaking again'));
});
it('allows a transient network disconnect to recover before releasing the microphone', async () => {
  await client.connect('briefing');
  peer.connectionState = 'disconnected'; peer.onconnectionstatechange();
  vi.advanceTimersByTime(4000);
  peer.connectionState = 'connected'; peer.onconnectionstatechange();
  vi.advanceTimersByTime(2000);
  expect(track.stop).not.toHaveBeenCalled();
  peer.connectionState = 'failed'; peer.onconnectionstatechange();
  expect(track.stop).toHaveBeenCalled();
});

it('quietly cancels an interrupted action instead of showing an approval error', async () => {
  callbacks.action = vi.fn(async () => ({ status: 'queued' }));
  await client.connect('briefing', undefined, undefined, true);
  event({ type: 'input_audio_buffer.speech_started', item_id: 'old-request' });
  event({ type: 'input_audio_buffer.speech_stopped', item_id: 'old-request' });
  event({ type: 'response.created', response: { id: 'old-response' } });
  event({ type: 'input_audio_buffer.speech_started', item_id: 'correction' });
  event({ type: 'response.function_call_arguments.done', response_id: 'old-response', name: 'delegate_goal', call_id: 'cancelled-action', arguments: '{}' });
  await vi.waitFor(() => expect(channel.send).toHaveBeenCalled());
  expect(callbacks.action).not.toHaveBeenCalled();
  expect(callbacks.error).not.toHaveBeenCalled();
  expect(channel.send.mock.calls.map(([raw]: [string]) => JSON.parse(raw)).some((e: any) => e.item?.output?.includes('cancelled'))).toBe(true);
});
