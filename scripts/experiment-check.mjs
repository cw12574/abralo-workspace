import assert from 'node:assert/strict';
import { createExperiment } from '../website/assets/city/experiment.mjs';
const lab = createExperiment();
const initial = lab.snapshot();
assert.deepEqual(initial.baseline, initial.experiment);
lab.advance(300);
assert.deepEqual(
  lab.snapshot().baseline,
  lab.snapshot().experiment,
  'untouched branches must remain identical',
);
lab.command('demand', 'busy');
lab.advance(300);
assert.deepEqual(
  lab.snapshot().baseline,
  lab.snapshot().experiment,
  'shared demand should preserve equality without intervention',
);
lab.command('bridges', false);
lab.advance(1200);
let s = lab.snapshot();
assert.equal(
  s.baseline.bridges.every((b) => b.open),
  true,
);
assert.equal(
  s.experiment.bridges.every((b) => !b.open),
  true,
);
assert.ok(
  s.baseline.stats.arrived > s.experiment.stats.arrived,
  'closed crossings must affect completed trips',
);
assert.ok(s.experiment.stats.waiting > 0);
const closedArrivals = s.experiment.stats.arrived;
lab.command('bridges', true);
lab.advance(1200);
assert.ok(
  lab.snapshot().experiment.stats.arrived > closedArrivals,
  'reopening must resume arrivals',
);
for (const key of ['baseline', 'experiment']) {
  const stats = lab.snapshot()[key].stats;
  assert.equal(stats.spawned, stats.arrived + stats.active);
  assert.ok(stats.active <= 120);
}
const report = lab.report();
report.experiment.bridges[0].open = false;
assert.equal(lab.snapshot().experiment.bridges[0].open, true, 'export must not mutate model');
lab.reset();
assert.deepEqual(lab.snapshot(), initial, 'reset must exactly reproduce initial traffic');
const other = createExperiment();
for (const instance of [lab, other]) {
  instance.command('bridge', { id: 'central', open: false });
  instance.advance(300);
  instance.command('demand', 'busy');
  instance.advance(600);
}
assert.deepEqual(lab.report(), other.report(), 'same commands and ticks must reproduce result');
console.log(
  'Experiment: branch isolation, shared demand, disruption, recovery, counters, reset, export isolation and deterministic replay passed.',
);
