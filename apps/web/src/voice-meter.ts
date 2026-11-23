export type VoiceLevels = { input: number[]; output: number };

// These analysis branches have no destination: microphone audio is never played
// locally, and remote audio is still played exactly once by the audio element.
export class VoiceMeter {
  private context?: AudioContext;
  private nodes = new Map<
    'input' | 'output',
    {
      source: MediaStreamAudioSourceNode;
      analyser: AnalyserNode;
      samples: Float32Array<ArrayBuffer>;
    }
  >();
  private frame = 0;
  private last = 0;
  private closed = false;
  private levels: VoiceLevels = { input: Array(24).fill(0), output: 0 };
  constructor(private update: (levels: VoiceLevels) => void) {}

  attach(kind: 'input' | 'output', stream: MediaStream) {
    if (this.closed) return;
    try {
      this.context ||= new AudioContext();
      void this.context.resume().catch(() => {});
      this.nodes.get(kind)?.source.disconnect();
      this.nodes.get(kind)?.analyser.disconnect();
      const source = this.context.createMediaStreamSource(stream);
      const analyser = this.context.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      this.nodes.set(kind, { source, analyser, samples: new Float32Array(analyser.fftSize) });
      if (!this.frame) this.frame = requestAnimationFrame(this.tick);
    } catch {
      // Visual feedback is optional on browsers without Web Audio support.
    }
  }

  private tick = (time: number) => {
    if (this.closed) return;
    this.frame = requestAnimationFrame(this.tick);
    if (time - this.last < 32) return;
    this.last = time;
    for (const [kind, node] of this.nodes) {
      node.analyser.getFloatTimeDomainData(node.samples);
      const count = kind === 'input' ? this.levels.input.length : 1;
      const size = Math.floor(node.samples.length / count);
      for (let i = 0; i < count; i++) {
        let sum = 0;
        for (let j = i * size; j < (i + 1) * size; j++) sum += node.samples[j] ** 2;
        const value = Math.min(1, Math.max(0, Math.sqrt(sum / size) - 0.008) * 6);
        const prior = kind === 'input' ? this.levels.input[i] : this.levels.output;
        const level = prior + (value - prior) * (value > prior ? 0.65 : 0.24);
        if (kind === 'input') this.levels.input[i] = level;
        else this.levels.output = level;
      }
    }
    this.update(this.levels);
  };

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.frame) cancelAnimationFrame(this.frame);
    for (const { source, analyser } of this.nodes.values()) {
      source.disconnect();
      analyser.disconnect();
    }
    this.nodes.clear();
    void this.context?.close().catch(() => {});
    this.update({ input: Array(24).fill(0), output: 0 });
  }
}
