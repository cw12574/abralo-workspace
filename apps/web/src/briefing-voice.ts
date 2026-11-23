import { api } from './api';
import { CaptionQueue } from './caption-queue';
import { VoiceMeter, type VoiceLevels } from './voice-meter';
import { SpokenActionTurns } from './spoken-action-turns';

export type VoiceState = 'off' | 'connecting' | 'ready' | 'listening' | 'transcribing' | 'speaking';
export class BriefingVoice {
  private peer?: RTCPeerConnection;
  private channel?: RTCDataChannel;
  private stream?: MediaStream;
  private audio = new Audio();
  private closed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private idle?: ReturnType<typeof setTimeout>;
  private calls = new Set<string>();
  private readbackResponse?: string;
  private reading = false;
  private chief = false;
  private utterance = 0;
  private generating = false;
  private pendingResponse?: any;
  private recapTimer?: ReturnType<typeof setTimeout>;
  private meter?: VoiceMeter;
  private inputActive = false;
  private awaitingTranscript = false;
  private recapPending = false;
  private outputActive = false;
  private caption = '';
  private captionResponse = '';
  private deliveries = new Map<
    string,
    {
      itemId?: string;
      heard: string;
      interrupted: boolean;
      finished?: boolean;
      saved?: Promise<void>;
      reported?: boolean;
    }
  >();
  private actionsPending = 0;
  private briefingId = '';
  private disconnectTimer?: ReturnType<typeof setTimeout>;
  private actionTurns = new SpokenActionTurns((id, text) =>
    this.callbacks.transcript(id, text, true),
  );
  private captionQueue = new CaptionQueue((id, text) => {
    const delivery = this.deliveries.get(id);
    if (delivery) delivery.heard = text;
    this.callbacks.readableCaption?.(id, text);
  });
  constructor(
    private callbacks: {
      state: (state: VoiceState) => void;
      transcript: (id: string, text: string, human: boolean) => void | Promise<void>;
      next: (answer: string, defer: boolean) => Promise<void>;
      revise?: (
        actions: { employeeId: string; text: string; selected: boolean }[],
      ) => Promise<void>;
      recap?: (summary: string, actions: { employeeId: string; text: string }[]) => Promise<string>;
      action?: (
        name: 'create_employee' | 'delegate_task' | 'delegate_goal' | 'read_goals' | 'set_plan' | 'remove_goal',
        callId: string,
        args: any,
        sourceTurnId?: string,
      ) => Promise<any>;
      interrupted?: () => void;
      readbackDone?: () => void;
      levels?: (levels: VoiceLevels) => void;
      caption?: (text: string) => void;
      readableCaption?: (id: string, text: string) => void;
      playback?: (id: string, heardText: string, captionId?: string) => void;
      error: (message: string) => void;
    },
  ) {}
  async connect(briefingId: string, questionId?: string, readback?: string, chief = false) {
    this.chief = chief;
    this.briefingId = briefingId;
    this.callbacks.state('connecting');
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection)
        throw new Error(
          'Voice needs a supported browser on localhost or HTTPS. You can still type your briefing.',
        );
      const setup = await api('/briefings/voice');
      if (!setup.configured)
        throw new Error('Connect voice before starting the microphone, or continue by typing.');
      if (this.closed) return;
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (this.closed) {
        this.stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const peer = (this.peer = new RTCPeerConnection());
      // The output level also clocks captions, so they follow the audio actually heard.
      this.meter = new VoiceMeter((levels) => {
        this.captionQueue.audio(levels.output);
        this.callbacks.levels?.(levels);
      });
      this.meter.attach('input', this.stream);
      this.audio.autoplay = true;
      peer.ontrack = (event) => {
        if (this.closed) return;
        this.audio.srcObject = event.streams[0];
        this.meter?.attach('output', event.streams[0]);
        void this.audio
          .play()
          .catch(() =>
            this.fail('Your browser blocked audio. Reconnect voice to enable playback.'),
          );
      };
      for (const track of this.stream.getTracks()) peer.addTrack(track, this.stream);
      const channel = (this.channel = peer.createDataChannel('oai-events'));
      channel.onmessage = (event) => this.event(event.data);
      channel.onerror = () =>
        this.fail('Voice disconnected. Your saved brief and answers are still here.');
      peer.onconnectionstatechange = () => {
        clearTimeout(this.disconnectTimer);
        if (peer.connectionState === 'failed') {
          this.diagnostic({ code: 'connection_failed', type: 'transport' });
          this.fail('Voice connection lost. Reconnect when ready; your saved work is still here.');
        } else if (peer.connectionState === 'disconnected') {
          this.disconnectTimer = setTimeout(() => {
            this.diagnostic({ code: 'connection_disconnected', type: 'transport' });
            this.fail(
              'Voice connection lost. Reconnect when ready; your saved work is still here.',
            );
          }, 5000);
        }
      };
      this.timer = setTimeout(
        () =>
          this.fail('Voice connection timed out. Check your microphone, network and API setup.'),
        30000,
      );
      channel.onopen = () => {
        if (this.closed) return;
        clearTimeout(this.timer);
        this.timer = setTimeout(
          () => this.fail('This voice session reached 20 minutes. Reconnect to continue.'),
          20 * 60000,
        );
        this.touch();
        this.callbacks.state('ready');
        this.reading = !!readback;
        this.send({
          type: 'response.create',
          response: {
            ...(readback ? { metadata: { briefing_readback: 'true' } } : {}),
            instructions: readback
              ? `Read this proposed recap verbatim, without adding work or omitting constraints: ${readback}`
              : chief
                ? 'As their Chief of Staff, for a new morning briefing your first spoken words must be exactly: "What good shall we do this day?" Then pause for the human to respond. If resuming, continue from the saved discussion without repeating the opening or old questions. Have a real back-and-forth; no instructions about stages or magic phrases.'
                : questionId
                  ? 'Introduce yourself briefly by name, then ask your prepared question. Do not answer it for the human.'
                  : 'Briefly welcome the human to the morning briefing, or welcome them back if there is a saved brief. Invite them to tell you what matters today or continue where they left off. Mention once that saying "That\'s everything" brings in employee questions. Keep this opening to two short sentences, then listen.',
          },
        });
      };
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      const answer = await api(`/briefings/${briefingId}/voice`, { sdp: offer.sdp, questionId });
      if (this.closed) return;
      await peer.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
    } catch (error: any) {
      if (!this.closed)
        this.fail(
          error.name === 'NotAllowedError'
            ? 'Microphone access was denied. Allow it in your browser or type your brief.'
            : error.message,
        );
    }
  }
  private send(event: any) {
    if (this.channel?.readyState === 'open' && !this.closed) {
      // Reserve the response before sending, not when response.created returns.
      if (event.type === 'response.create') this.generating = true;
      this.channel.send(JSON.stringify(event));
    }
  }
  private touch() {
    clearTimeout(this.idle);
    this.idle = setTimeout(
      () => this.fail('Voice paused after five quiet minutes. Reconnect whenever you are ready.'),
      5 * 60000,
    );
  }
  private event(raw: string) {
    if (this.closed) return;
    let e: any;
    try {
      e = JSON.parse(raw);
    } catch {
      return;
    }
    if (e.type === 'input_audio_buffer.speech_started') {
      if (this.chief) this.actionTurns.start(e.item_id);
      this.inputActive = true;
      this.awaitingTranscript = true;
      this.utterance++;
      this.pendingResponse = undefined;
      this.interruptCaptions();
      this.touch();
      if (this.reading) this.callbacks.interrupted?.();
      this.reading = false;
      this.callbacks.state('listening');
    }
    if (e.type === 'response.created') {
      if (this.chief) this.actionTurns.response(e.response?.id);
      // Keep the final caption visible through pauses and tool-only responses.
      this.captionResponse = '';
      this.caption = '';
      this.generating = true;
      if (
        this.reading &&
        !this.readbackResponse &&
        (!this.chief || e.response?.metadata?.briefing_readback === 'true')
      )
        this.readbackResponse = e.response?.id;
    }
    if (e.type === 'response.done') {
      this.generating = false;
      if (e.response?.status === 'failed') {
        this.diagnostic(e.response.status_details?.error || { code: 'response_failed' });
        this.callbacks.error('That reply could not finish. You can ask me to try again.');
      }
      this.drainResponse();
    }
    if (e.type === 'output_audio_buffer.cleared' && e.response_id === this.readbackResponse)
      this.reading = false;
    if (
      e.type === 'output_audio_buffer.stopped' &&
      this.reading &&
      e.response_id === this.readbackResponse
    ) {
      this.reading = false;
      this.callbacks.readbackDone?.();
    }
    if (e.type === 'input_audio_buffer.speech_stopped') {
      if (this.chief) this.actionTurns.stopped(e.item_id);
      this.inputActive = false;
      this.callbacks.state(this.outputActive ? 'speaking' : 'transcribing');
    }
    if (e.type === 'conversation.item.input_audio_transcription.completed') {
      if (this.chief) {
        void this.actionTurns
          .transcribed(e.item_id, e.transcript || '')
          ?.then(() => {
            this.awaitingTranscript = false;
            this.finishRecapRequest();
          })
          .catch((error) => {
            if (!this.closed) this.callbacks.error(error.message);
          });
      } else {
        this.awaitingTranscript = false;
        this.callbacks.transcript(e.item_id, e.transcript || '', true);
        this.finishRecapRequest();
      }
      if (!this.closed)
        this.callbacks.state(
          this.inputActive ? 'listening' : this.outputActive ? 'speaking' : 'ready',
        );
    }
    if (e.type === 'conversation.item.input_audio_transcription.failed') {
      if (this.chief) this.actionTurns.failed(e.item_id);
      this.awaitingTranscript = false;
      this.diagnostic(e.error || { code: 'transcription_failed' });
      this.callbacks.error('I could not hear that turn clearly. Please say it again.');
      this.callbacks.state('ready');
    }
    if (e.type === 'output_audio_buffer.started') {
      this.outputActive = true;
      this.captionQueue.play();
      this.touch();
      this.callbacks.state(this.inputActive ? 'listening' : 'speaking');
    }
    if (e.type === 'output_audio_buffer.stopped' || e.type === 'output_audio_buffer.cleared') {
      this.outputActive = false;
      if (e.type === 'output_audio_buffer.cleared') this.interruptCaptions(e.response_id);
      else {
        const key = e.response_id || this.captionResponse;
        if (key && !this.deliveries.has(key))
          this.deliveries.set(key, { heard: '', interrupted: false });
        const delivery = this.deliveries.get(key);
        if (delivery) delivery.finished = true;
        if (!e.response_id || e.response_id === this.captionResponse) this.captionQueue.finish();
      }
      this.callbacks.state(this.inputActive ? 'listening' : 'ready');
    }
    if (e.type === 'response.output_audio_transcript.delta') {
      const key = e.response_id || e.item_id || 'current';
      if (this.deliveries.get(key)?.interrupted) return;
      if (this.captionResponse !== (e.response_id || e.item_id || 'current')) {
        this.captionResponse = e.response_id || e.item_id || 'current';
        if (!this.deliveries.has(this.captionResponse))
          this.deliveries.set(this.captionResponse, {
            itemId: e.item_id,
            heard: '',
            interrupted: false,
          });
        this.caption = '';
        this.captionQueue.begin(this.captionResponse);
        if (this.outputActive) this.captionQueue.play();
      }
      this.caption += e.delta || '';
      this.captionQueue.append(this.caption);
      if (this.deliveries.get(this.captionResponse)?.finished) this.captionQueue.finish();
      this.callbacks.caption?.(this.caption);
    }
    if (e.type === 'response.output_audio_transcript.done') {
      const key = e.response_id || e.item_id || 'current';
      if (!this.deliveries.has(key))
        this.deliveries.set(key, { itemId: e.item_id, heard: '', interrupted: false });
      const delivery = this.deliveries.get(key)!;
      delivery.itemId = e.item_id;
      if (!this.captionResponse && !delivery.interrupted) {
        this.captionResponse = e.response_id || e.item_id || 'current';
        this.captionQueue.begin(this.captionResponse);
        if (this.outputActive) this.captionQueue.play();
      }
      if (!delivery.interrupted) {
        this.caption = e.transcript || '';
        this.captionQueue.append(this.caption, true);
        if (delivery.finished) this.captionQueue.finish();
        this.callbacks.caption?.(this.caption);
      }
      delivery.saved = Promise.resolve(
        this.callbacks.transcript(e.item_id, e.transcript || '', false),
      );
      this.reportInterruption(key);
      void delivery.saved.catch((error) => {
        if (!this.closed) this.callbacks.error(error.message);
      });
    }
    if (
      e.type === 'response.function_call_arguments.done' &&
      e.name === 'next_question' &&
      !this.calls.has(e.call_id)
    ) {
      this.calls.add(e.call_id);
      try {
        const args = JSON.parse(e.arguments);
        if (typeof args.answer !== 'string' || typeof args.defer !== 'boolean')
          throw new Error('Invalid voice answer. Use the answer controls below.');
        void this.callbacks
          .next(args.answer, args.defer)
          .catch((error) => this.callbacks.error(error.message));
      } catch (error: any) {
        this.callbacks.error(error.message);
      }
    }
    if (
      e.type === 'response.function_call_arguments.done' &&
      e.name === 'revise_actions' &&
      !this.calls.has(e.call_id)
    ) {
      this.calls.add(e.call_id);
      try {
        const args = JSON.parse(e.arguments);
        if (
          !Array.isArray(args.actions) ||
          args.actions.some(
            (a: any) =>
              typeof a.employeeId !== 'string' ||
              typeof a.text !== 'string' ||
              typeof a.selected !== 'boolean',
          )
        )
          throw new Error('Could not save that correction. Please edit the proposed work.');
        void this.callbacks
          .revise?.(args.actions)
          .catch((error) => this.callbacks.error(error.message));
      } catch (error: any) {
        this.callbacks.error(error.message);
      }
    }
    if (
      e.type === 'response.function_call_arguments.done' &&
      e.name === 'save_recap' &&
      !this.calls.has(e.call_id)
    ) {
      this.calls.add(e.call_id);
      clearTimeout(this.recapTimer);
      const utterance = this.utterance;
      void (async () => {
        try {
          const args = JSON.parse(e.arguments);
          if (
            typeof args.summary !== 'string' ||
            !args.summary.trim() ||
            !Array.isArray(args.actions) ||
            args.actions.some(
              (a: any) => typeof a.employeeId !== 'string' || typeof a.text !== 'string',
            ) ||
            !this.callbacks.recap
          )
            throw new Error('Could not save that recap. Please try again.');
          if (this.chief) await this.actionTurns.flush();
          const text = await this.callbacks.recap(args.summary, args.actions);
          if (this.closed) return;
          this.send({
            type: 'conversation.item.create',
            item: {
              type: 'function_call_output',
              call_id: e.call_id,
              output: JSON.stringify({ saved: true, dispatched: false }),
            },
          });
          if (utterance === this.utterance) this.readRecap(text);
        } catch (error: any) {
          this.send({
            type: 'conversation.item.create',
            item: {
              type: 'function_call_output',
              call_id: e.call_id,
              output: JSON.stringify({ saved: false, error: error.message }),
            },
          });
          this.callbacks.error(error.message);
        }
      })();
    }
    if (
      e.type === 'response.function_call_arguments.done' &&
      this.chief &&
      ['create_employee', 'delegate_task', 'delegate_goal', 'read_goals', 'set_plan', 'remove_goal'].includes(e.name) &&
      !this.calls.has(e.call_id)
    ) {
      this.calls.add(e.call_id);
      this.actionsPending++;
      const utterance = this.utterance;
      void (async () => {
        let result;
        try {
          if (!this.callbacks.action) throw new Error('Workspace actions are unavailable.');
          const args = JSON.parse(e.arguments);
          const sourceTurnId =
            e.name === 'read_goals' ? undefined : await this.actionTurns.source(e.response_id);
          if (this.closed) return;
          result = await this.callbacks.action(e.name, e.call_id, args, sourceTurnId);
        } catch (error: any) {
          const superseded = error.code === 'spoken_turn_superseded';
          result = { status: superseded ? 'cancelled' : 'failed', error: error.message };
          if (!superseded && !this.closed) this.callbacks.error(error.message);
        }
        if (this.closed) return;
        this.send({
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id: e.call_id,
            output: JSON.stringify(result),
          },
        });
        this.actionsPending--;
        // One follow-up after the entire batch commits; never replay actions.
        if (utterance === this.utterance) this.respond({});
        else this.drainResponse();
      })();
    }
    if (e.type === 'error') {
      this.diagnostic(e.error || {}, e.event_id);
      const code = e.error?.code;
      if (['response_cancel_not_active', 'output_audio_buffer_empty'].includes(code)) return;
      if (code === 'conversation_already_has_active_response') {
        this.generating = true;
        return; // Wait for that response's done event; keep the call open.
      }
      this.pendingResponse = undefined;
      this.callbacks.error(
        'Voice could not finish that request. Please try speaking again. Your saved actions are safe.',
      );
    }
  }
  private diagnostic(error: any, eventId?: string) {
    // Do not store audio, transcripts, credentials or provider error prose.
    void api(`/briefings/${this.briefingId}/voice-diagnostics`, {
      code: String(error.code || 'unknown').slice(0, 120),
      type: String(error.type || 'realtime').slice(0, 80),
      eventId: String(eventId || '').slice(0, 200),
      requestEventId: String(error.event_id || '').slice(0, 200),
    }).catch(() => {});
  }
  private interruptCaptions(id = this.captionResponse) {
    if (id === this.captionResponse) this.captionQueue.discard();
    const delivery = this.deliveries.get(id);
    if (delivery && !delivery.finished) {
      delivery.interrupted = true;
      this.reportInterruption(id);
    }
  }
  private reportInterruption(id: string) {
    const delivery = this.deliveries.get(id);
    if (!delivery?.interrupted || !delivery.itemId || !delivery.saved || delivery.reported) return;
    delivery.reported = true;
    // The view queues this idempotent metadata write after the transcript,
    // retaining both for retry if that transcript has not committed yet.
    this.callbacks.playback?.(delivery.itemId, delivery.heard, id);
  }
  private respond(response: any) {
    this.pendingResponse = response;
    this.drainResponse();
  }
  private drainResponse() {
    if (
      this.generating ||
      this.actionsPending ||
      this.inputActive ||
      this.pendingResponse === undefined
    )
      return;
    const response = this.pendingResponse;
    this.pendingResponse = undefined;
    this.send({ type: 'response.create', response });
  }
  requestRecap() {
    this.stopSpeaking();
    this.recapPending = true;
    this.finishRecapRequest();
    clearTimeout(this.recapTimer);
    this.recapTimer = setTimeout(() => {
      this.recapPending = false;
      this.callbacks.error(
        this.awaitingTranscript
          ? 'Your final words could not be transcribed. Resume voice or add them in the conversation notes before finishing.'
          : 'The recap did not arrive. Resume voice and try again; your saved conversation is still here.',
      );
    }, 30000);
  }
  private finishRecapRequest() {
    if (!this.recapPending || this.awaitingTranscript || this.closed) return;
    this.recapPending = false;
    this.stopSpeaking();
    this.respond({
      instructions:
        'The human pressed End conversation. Call save_recap now with a concise summary of what was agreed and any open questions, and only explicit assignments from this conversation that no tool has performed yet; they are sent when the recap saves. Keep tentative ideas out of assignments. Do not ask another question.',
    });
  }
  readRecap(text: string) {
    this.reading = true;
    this.readbackResponse = undefined;
    this.respond({
      metadata: { briefing_readback: 'true' },
      instructions: `Read this saved recap verbatim, then listen for corrections or confirmation: ${text}`,
    });
  }
  updateContext(session: any) {
    this.send({
      type: 'session.update',
      session: { type: 'realtime', instructions: session.instructions, tools: session.tools },
    });
  }
  assertActionSource(id: string) {
    this.actionTurns.assertCurrent(id);
  }
  mute(muted: boolean) {
    this.stream?.getAudioTracks().forEach((t) => {
      t.enabled = !muted;
    });
  }
  endInput() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.inputActive = false;
    this.meter?.close();
  }
  stopSpeaking() {
    this.interruptCaptions();
    this.send({ type: 'response.cancel' });
    this.send({ type: 'output_audio_buffer.clear' });
  }
  close() {
    if (this.closed) return;
    if (this.outputActive || this.generating) this.interruptCaptions();
    this.closed = true;
    this.actionTurns.close();
    clearTimeout(this.timer);
    clearTimeout(this.idle);
    clearTimeout(this.recapTimer);
    clearTimeout(this.disconnectTimer);
    this.captionQueue.cancel();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.meter?.close();
    this.channel?.close();
    this.peer?.close();
    this.audio.pause();
    this.audio.srcObject = null;
    this.callbacks.state('off');
  }
  private fail(message: string) {
    if (this.closed) return;
    this.close();
    this.callbacks.error(message);
  }
}
