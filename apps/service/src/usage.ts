import type { Store } from './store.js';
export function forecast(samples: { at: number; used: number; reset: number }[], at = Date.now()) {
  const last = samples.at(-1);
  if (!last || at - last.at > 300000) return null;
  const current = samples.filter((s) => s.reset === last.reset && at - s.at < 3600000);
  if (current.length < 3 || last.at - current[0].at < 120000) return null;
  const first = current[0],
    change = last.used - first.used;
  if (change <= 0 || current.some((s, i) => i && s.used < current[i - 1].used)) return null;
  const remaining = (100 - last.used) / (change / (last.at - first.at));
  if (remaining < 0 || at + remaining >= last.reset * 1000) return null;
  return {
    earliest: at + remaining * 0.6,
    latest: at + remaining * 1.4,
    basis: 'Recent account-wide pace; other apps and changes in work can move this estimate.',
  };
}
export function quotaForecasts(s: Store, providers: any[]) {
  const output: any = {};
  const trends: Record<string, { at: number; used: number }[]> = {};
  for (const p of providers) {
    const buckets = p.limits?.rateLimitsByLimitId || { default: p.limits?.rateLimits };
    for (const [bucket, value] of Object.entries(buckets)) {
      if (!value) continue;
      for (const window of ['primary', 'secondary']) {
        const w = (value as any)[window];
        if (!w || typeof w.usedPercent !== 'number' || typeof w.resetsAt !== 'number') continue;
        const key = p.harness + '.' + bucket + '.' + window,
          setting = 'quota.' + key;
        let samples = s.setting(setting, []);
        if (!samples.length || Date.now() - samples.at(-1).at >= 60000) {
          samples = [...samples, { at: Date.now(), used: w.usedPercent, reset: w.resetsAt }].slice(
            -60,
          );
          s.set(setting, samples);
        }
        const f = forecast(samples);
        if (f) output[key] = f;
        trends[key] = samples
          .filter((sample: { at: number; reset: number }) => sample.reset === w.resetsAt)
          .map((sample: { at: number; used: number }) => ({ at: sample.at, used: sample.used }));
      }
    }
  }
  return { forecasts: output, trends };
}
