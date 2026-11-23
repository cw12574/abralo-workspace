// Audio interpretation and transcription are separate provider streams. Bind
// actions to input item IDs, never to a model's reconstruction of the words.
type Turn = {
  id: string;
  ready: Promise<void>;
  complete: (text: string) => void;
  fail: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  received?: boolean;
};

export class SpokenActionTurns {
  private turns = new Map<string, Turn>();
  private responses = new Map<string, Turn | undefined>();
  private latest?: Turn;
  private writes: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private save: (id: string, text: string) => void | Promise<void>) {}

  start(id: string) {
    if (!id || this.closed || this.turns.has(id)) return;
    let complete!: Turn['complete'], fail!: Turn['fail'];
    const transcript = new Promise<string>((resolve, reject) => {
      complete = resolve;
      fail = reject;
    });
    void transcript.catch(() => {});
    // Preserve speaking order even when transcriptions arrive out of order.
    const ready = this.writes.catch(() => {}).then(() => transcript).then((text) => this.save(id, text));
    void ready.catch(() => {});
    this.latest = { id, ready, complete, fail };
    this.turns.set(id, this.latest);
    this.writes = ready;
  }

  stopped(id: string) {
    const turn = this.turns.get(id);
    if (turn && !turn.timer && !turn.received) turn.timer = setTimeout(() => turn.fail(new Error('The spoken turn could not be transcribed. Please say it again.')), 30000);
  }

  transcribed(id: string, text: string) {
    if (!this.turns.has(id)) this.start(id);
    const turn = this.turns.get(id);
    if (!turn) return;
    turn.received = true;
    clearTimeout(turn.timer);
    if (text.trim()) turn.complete(text);
    else turn.fail(new Error('The spoken turn was empty. Please say it again.'));
    return turn.ready;
  }

  failed(id: string) {
    const turn = this.turns.get(id);
    if (!turn) return;
    turn.received = true;
    clearTimeout(turn.timer);
    turn.fail(new Error('The spoken turn could not be transcribed. Please say it again.'));
  }

  response(id: string) {
    if (id) this.responses.set(id, this.latest);
  }

  flush() {
    return this.writes;
  }

  async source(responseId: string) {
    const turn = this.responses.get(responseId);
    if (!turn) throw new Error('This action has no spoken instruction attached.');
    this.assertCurrent(turn.id);
    this.stopped(turn.id);
    await turn.ready;
    this.assertCurrent(turn.id);
    return turn.id;
  }

  assertCurrent(id: string) {
    if (this.closed) throw new Error('This voice session has closed.');
    if (id !== this.latest?.id)
      throw Object.assign(new Error('The instruction changed. Follow the latest spoken turn before assigning work.'), { code: 'spoken_turn_superseded' });
  }

  close() {
    this.closed = true;
    for (const turn of this.turns.values()) {
      clearTimeout(turn.timer);
      turn.fail(new Error('This voice session has closed.'));
    }
    this.turns.clear();
    this.responses.clear();
  }
}
