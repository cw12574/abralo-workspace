import { createCity } from './city-engine.mjs';

// Presentation extension by the launch operator. The recorded team's engine is unchanged.
export function createExperiment(seed = 20261005) {
  const baseline = createCity({ seed });
  const experiment = createCity({ seed });
  let tick = 0,
    events = [],
    samples = [];
  function sample() {
    const a = baseline.snapshot(),
      b = experiment.snapshot();
    return { seconds: tick / 20, baseline: a.stats, experiment: b.stats };
  }
  function reset() {
    baseline.reset();
    experiment.reset();
    tick = 0;
    events = [];
    samples = [];
    for (let i = 0; i < 180; i++) {
      baseline.step(0.25);
      experiment.step(0.25);
    }
    samples.push(sample());
  }
  function advance(ticks = 1) {
    if (!Number.isInteger(ticks) || ticks < 0 || ticks > 1200)
      throw new RangeError('ticks must be 0–1200');
    for (let i = 0; i < ticks; i++) {
      baseline.step(0.05);
      experiment.step(0.05);
      tick++;
      if (tick % 20 === 0) {
        samples.push(sample());
        if (samples.length > 301) samples.shift();
      }
    }
  }
  function command(type, value) {
    if (type === 'bridge') experiment.setBridgeOpen(value.id, value.open);
    else if (type === 'demand') {
      baseline.setDemand(value);
      experiment.setDemand(value);
    } else if (type === 'bridges') {
      if (typeof value !== 'boolean') throw new TypeError('bridge state must be boolean');
      for (const id of ['north', 'central', 'south']) experiment.setBridgeOpen(id, value);
    } else throw new RangeError('Unknown command');
    events.push({ seconds: tick / 20, type, value: structuredClone(value) });
    if (events.length > 200) events.shift();
  }
  function snapshot() {
    return {
      seconds: tick / 20,
      baseline: baseline.snapshot(),
      experiment: experiment.snapshot(),
      events: structuredClone(events),
      samples: structuredClone(samples),
    };
  }
  function report() {
    const s = snapshot();
    return {
      format: 'abralo-city-experiment-v1',
      seed,
      warmupSeconds: 45,
      ...s,
      limits:
        'Illustrative traffic model, not a transport forecast. Both cities start from the same seed and receive the same demand setting. Capacity limits can change subsequent admitted trips. History retains the last 300 seconds and 200 interventions. No model calls.',
    };
  }
  reset();
  return { advance, command, snapshot, reset, report };
}
