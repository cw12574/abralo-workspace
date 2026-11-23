export const REVEAL_INTERVAL = 50;
export const REVEAL_BUFFER = 150;
export const MAX_BUFFERED_CHARS = 4096;

type Arrival = { from: number; to: number; at: number };

/** A short moving average of received text, not a reading-speed typewriter.
 * Each arrival contributes evenly over 150 ms, so isolated bursts have a
 * constant pace and overlapping arrivals blend without a growing backlog. */
export class StreamingTextPacer {
  private arrivals: Arrival[] = [];
  private settled: number;
  private received: number;
  constructor(length = 0) {
    this.settled = this.received = length;
  }
  reset(length: number) {
    this.arrivals = [];
    this.settled = this.received = length;
  }
  receive(length: number, at: number) {
    // Large snapshots/pastes should not incur several expensive Markdown passes.
    if (length - this.settled > MAX_BUFFERED_CHARS) this.reset(length);
    if (length < this.received) this.reset(length);
    if (length === this.received) return;
    this.arrivals.push({ from: this.received, to: length, at });
    this.received = length;
  }
  position(at: number) {
    while (this.arrivals.length && at - this.arrivals[0].at >= REVEAL_BUFFER)
      this.settled = this.arrivals.shift()!.to;
    let position = this.settled;
    for (const arrival of this.arrivals)
      position += (arrival.to - arrival.from) * Math.max(0, (at - arrival.at) / REVEAL_BUFFER);
    return Math.min(this.received, Math.floor(position));
  }
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Prefer a nearby word boundary; long words, URLs and CJK still make progress.
 * Segment only the newly visible suffix, keeping emoji/combining marks intact. */
export function revealEnd(text: string, start: number, position: number) {
  if (position >= text.length) return text.length;
  let end = Math.max(start, position);
  if (end === start) return start;
  if (!/\s/u.test(text[end])) {
    const tail = text.slice(Math.max(start, end - 24), end);
    const boundary = tail.match(/\s+\S*$/u);
    if (boundary) end = end - tail.length + boundary.index! + boundary[0].match(/^\s+/u)![0].length;
  }
  let safe = start;
  for (const segment of graphemes.segment(text.slice(start))) {
    const next = start + segment.index + segment.segment.length;
    if (next > end) break;
    safe = next;
  }
  return safe;
}
