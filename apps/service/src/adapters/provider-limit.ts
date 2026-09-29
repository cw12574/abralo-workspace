export type LimitWindow = 'session' | 'weekly' | 'rate' | 'usage';

export class ProviderLimitError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly window: LimitWindow,
    readonly retryAt: string,
    readonly explicitReset = false,
  ) {
    super(message);
    this.name = 'ProviderLimitError';
  }
}

function resetTime(text: string, at = Date.now()) {
  const retryAfter = text.match(/retry[-_ ]after["'\s:=]+([\d.]+)/i);
  if (retryAfter) {
    const seconds = Number(retryAfter[1]);
    if (seconds > 0 && seconds < 7 * 24 * 3600) return at + seconds * 1000;
  }
  const iso = text.match(/\b20\d{2}-\d\d-\d\d[T ]\d\d:\d\d(?::\d\d)?(?:\.\d+)?(?:Z|[+-]\d\d:?\d\d)?\b/);
  if (iso) {
    const value = Date.parse(iso[0]);
    if (Number.isFinite(value) && value > at) return value;
  }
  const duration = text.match(/\b(?:retry[- ]after|try again in|reset(?:s)? in)\s+(?:(\d+(?:\.\d+)?)\s*h(?:ours?)?\s*)?(?:(\d+(?:\.\d+)?)\s*m(?:in(?:utes?)?)?\s*)?(?:(\d+(?:\.\d+)?)\s*s(?:ec(?:onds?)?)?)?/i);
  if (duration && (duration[1] || duration[2] || duration[3])) {
    const ms = Number(duration[1] || 0) * 3600000 + Number(duration[2] || 0) * 60000 + Number(duration[3] || 0) * 1000;
    if (ms > 0) return at + ms;
  }
  const clock = text.match(/\b(?:try again|resets? at|available at)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (clock) {
    let hour = Number(clock[1]) % 12;
    if (clock[3].toLowerCase() === 'pm') hour += 12;
    const target = new Date(at);
    target.setHours(hour, Number(clock[2] || 0), 0, 0);
    if (target.getTime() <= at) target.setDate(target.getDate() + 1);
    return target.getTime();
  }
  return undefined;
}

export function providerLimitFromError(
  error: unknown,
  harness: 'codex' | 'claude' | 'opencode',
  provider?: string,
) {
  const value: any = error;
  const message =
    error instanceof Error
      ? error.message
      : String(value?.message || value?.error?.message || error || '');
  const metadata = value?.data || value?.error || value?.cause || {};
  let details = '';
  try {
    details = JSON.stringify(metadata);
  } catch {
    details = String(metadata);
  }
  const evidence = `${message}\n${details}\nstatus ${value?.status || value?.statusCode || value?.response?.status || ''}`;
  const resetAt = resetTime(evidence);
  if (/\b(?:spend|billing|payment|credit balance|monthly budget|insufficient credits)\b/i.test(evidence) && !resetAt)
    return undefined;
  if (!/\b(?:usage|session|weekly|rate|5[- ]hour|five[- ]hour|7[- ]day)\s+(?:usage\s+)?limit\b|\btoo many requests\b|\b429\b/i.test(evidence))
    return undefined;

  const window: LimitWindow = /\bweekly\b|\b7[- ]day\b/i.test(evidence)
    ? 'weekly'
    : /\b(?:session|5[- ]hour|five[- ]hour)\b/i.test(evidence)
      ? 'session'
      : /\brate limit\b|\btoo many requests\b|\b429\b/i.test(evidence)
        ? 'rate'
        : 'usage';
  const retryAt = new Date(resetAt || Date.now() + (window === 'rate' ? 60000 : 15 * 60000)).toISOString();
  const providerName = provider || ({ codex: 'Codex', claude: 'Claude Code', opencode: 'Selected provider' } as const)[harness];
  return new ProviderLimitError(message, providerName, window, retryAt, !!resetAt);
}
