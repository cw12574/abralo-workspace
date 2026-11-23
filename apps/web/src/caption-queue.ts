/** Typical speaking rate in characters per millisecond (~15 characters/second). */
export const DEFAULT_RATE = 0.015;
const MIN_RATE = 0.008;
const MAX_RATE = 0.03;
/** Output level above which the Chief is audibly speaking. */
export const VOICE_GATE = 0.03;
/** Gaps shorter than this are part of speech (between words), not a pause. */
const HANGOVER = 220;
/** Without audio levels for this long, fall back to the playback clock. */
const METER_TIMEOUT = 400;
const FALLBACK_TICK = 40;
/** Analyser update interval; credit for the first audible frame after a pause. */
const FRAME = 32;

const RATE_KEY = 'abralo.captionRate';
function savedRate() {
  try {
    const value = Number(globalThis.localStorage?.getItem(RATE_KEY));
    return value >= MIN_RATE && value <= MAX_RATE ? value : DEFAULT_RATE;
  } catch {
    return DEFAULT_RATE;
  }
}

/**
 * Captions follow the audio the human actually hears. Text arrives well ahead
 * of WebRTC playback, and the stream carries no word timestamps, so the reveal
 * is driven by measured speaking time: it advances word by word only while the
 * output is audible, holds through the Chief's pauses, and stops exactly where
 * an interruption cut the audio. Each completed reply recalibrates the rate.
 */
export class CaptionQueue {
  private id = '';
  private text = '';
  private shown = 0;
  private complete = false;
  private playing = false;
  private discarded = false;
  private spoken = 0;
  private lastAt = 0;
  private voiceAt = -Infinity;
  private meterAt = -Infinity;
  private timer?: ReturnType<typeof setInterval>;
  rate: number;
  constructor(
    private publish: (id: string, text: string) => void,
    private now: () => number = () => performance.now(),
    rate?: number,
  ) {
    this.rate = rate ?? savedRate();
  }
  begin(id: string) {
    if (!this.discarded && this.complete && this.playing && this.shown < this.text.length)
      this.publish(this.id, this.text.trim());
    this.cancel();
    this.id = id;
    this.text = '';
    this.shown = 0;
    this.spoken = 0;
    this.complete = false;
    this.discarded = false;
  }
  append(text: string, complete = false) {
    if (this.discarded) return;
    this.text = text;
    this.complete = complete;
    this.step();
  }
  play() {
    if (this.discarded || this.playing) return;
    this.playing = true;
    this.lastAt = this.now();
    this.voiceAt = -Infinity;
    // Audio levels drive the reveal; this clock only covers browsers without Web Audio.
    this.timer = setInterval(() => this.step(), FALLBACK_TICK);
  }
  /** Output level from the analyser attached to the remote audio stream. */
  audio(level: number) {
    const at = this.now();
    this.meterAt = at;
    if (this.playing && level > VOICE_GATE) {
      // A short gap between words is speech; a longer one was a pause and is not counted.
      const gap = at - this.voiceAt;
      this.spoken += gap <= HANGOVER ? gap : FRAME;
      this.voiceAt = at;
    }
    this.step();
  }
  finish() {
    if (this.discarded) return;
    this.advanceClock();
    this.calibrate();
    this.stopClock();
    this.complete = true;
    // Playback has ended: the whole received transcript is now spoken.
    if (this.shown < this.text.length) {
      this.shown = this.text.length;
      this.publish(this.id, this.text.trim());
    }
  }
  discard() {
    // Freeze on the last word heard; never reveal what was cut off.
    this.cancel();
    this.discarded = true;
  }
  cancel() {
    this.stopClock();
  }
  private stopClock() {
    clearInterval(this.timer);
    this.timer = undefined;
    this.playing = false;
  }
  /** Without audio levels (no Web Audio, hidden tab), fall back to the playback clock. */
  private advanceClock() {
    if (!this.playing) return;
    const at = this.now();
    const elapsed = Math.max(0, at - this.lastAt);
    this.lastAt = at;
    if (at - this.meterAt >= METER_TIMEOUT) this.spoken += elapsed;
  }
  private calibrate() {
    // Learn this voice's pace from replies heard in full. Smoothed and bounded,
    // so one odd reply cannot throw later captions out of step.
    if (!this.complete || this.spoken < 1200 || this.text.trim().length < 30) return;
    const measured = this.text.trim().length / this.spoken;
    if (measured < MIN_RATE || measured > MAX_RATE) return;
    this.rate = this.rate * 0.6 + measured * 0.4;
    try {
      globalThis.localStorage?.setItem(RATE_KEY, String(this.rate));
    } catch {
      // Calibration is a refinement; captions still work without storage.
    }
  }
  private step() {
    if (this.discarded || !this.playing) return;
    this.advanceClock();
    const end = wordEnd(this.text, this.spoken * this.rate, this.complete);
    if (end > this.shown) {
      this.shown = end;
      this.publish(this.id, this.text.slice(0, end).trim());
    }
  }
}

/**
 * Show the word being spoken as it starts, never half a word, and never a word
 * whose text has not fully arrived yet.
 */
export function wordEnd(text: string, position: number, complete: boolean) {
  if (position <= 0 || !text) return 0;
  const at = Math.min(Math.floor(position), text.length);
  const start = text.slice(0, at).search(/\S*$/);
  let probe = start;
  while (probe < text.length && /\s/.test(text[probe])) probe++;
  const rest = text.slice(probe).match(/^\S+/);
  if (!rest) return text.length;
  const end = probe + rest[0].length;
  if (end === text.length && !complete) {
    // The final word may still be arriving; keep to the previous whole word.
    const before = text.slice(0, probe).trimEnd();
    return before.length;
  }
  return end;
}
