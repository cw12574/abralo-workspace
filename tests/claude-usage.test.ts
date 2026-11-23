import { describe, expect, it } from 'vitest';
import { claudeLimits } from '../apps/service/src/adapters/claude.js';

describe('Claude Code plan usage', () => {
  it('maps 5-hour, weekly and model windows onto the shared limit shape', () => {
    const limits = claudeLimits({
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 10, resets_at: '2026-11-11T18:00:00.424047+00:00' },
        seven_day: { utilization: 2, resets_at: '2026-11-13T04:00:00.424066+00:00' },
        seven_day_opus: null,
        seven_day_sonnet: { utilization: 140, resets_at: '2026-11-13T04:00:00Z' },
        model_scoped: [{ display_name: 'Fable', utilization: 5, resets_at: '2026-11-13T04:00:00Z' }],
      },
    });
    expect(limits?.rateLimitsByLimitId.plan).toEqual({
      primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: Math.round(Date.parse('2026-11-11T18:00:00.424Z') / 1000), label: 'This session' },
      secondary: { usedPercent: 2, windowDurationMins: 10080, resetsAt: Math.round(Date.parse('2026-11-13T04:00:00.424Z') / 1000), label: 'This week' },
    });
    expect(limits?.rateLimitsByLimitId.seven_day_opus).toBeUndefined();
    expect(limits?.rateLimitsByLimitId.seven_day_sonnet?.primary).toMatchObject({ usedPercent: 100, label: 'Sonnet this week' });
    expect(limits?.rateLimitsByLimitId['model.fable']?.primary).toMatchObject({ usedPercent: 5, label: 'Fable this week' });
  });

  it('reports nothing when plan limits do not apply or are incomplete', () => {
    expect(claudeLimits({ rate_limits_available: false, rate_limits: null })).toBeUndefined();
    expect(claudeLimits({ rate_limits_available: true, rate_limits: { five_hour: { utilization: null, resets_at: null } } })).toBeUndefined();
  });
});
