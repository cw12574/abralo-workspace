let context: AudioContext | undefined;
let lastMessageSound = 0;

export function unlockSound() {
  try {
    context ??= new AudioContext();
    void context.resume();
  } catch {}
}

export function messageSound(mention = false) {
  if (!context || context.state !== 'running') return;

  // A small, warm two-note cue, with one quiet note added for a mention.
  // Ignore rapid bursts so a busy team does not turn into a notification chorus.
  const now = context.currentTime;
  if (now - lastMessageSound < 0.8) return;
  lastMessageSound = now;

  const notes = mention ? [392, 493.88, 587.33] : [392, 493.88];
  notes.forEach((frequency, index) => {
    const start = now + index * 0.105;
    const level = index === 2 ? 0.009 : 0.012;
    const oscillator = context!.createOscillator();
    const envelope = context!.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(frequency, start);
    oscillator.frequency.exponentialRampToValueAtTime(frequency * 0.985, start + 0.24);
    envelope.gain.setValueAtTime(0.0001, start);
    envelope.gain.linearRampToValueAtTime(level, start + 0.022);
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + 0.25);
    oscillator.connect(envelope);
    envelope.connect(context!.destination);
    oscillator.start(start);
    oscillator.stop(start + 0.26);
  });
}
