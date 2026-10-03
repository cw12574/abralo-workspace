import type { Adapter, Harness, ProviderInfo } from '../../../packages/contracts/src/index.js';

// One in-flight probe per runtime. A slow/broken runtime cannot prevent another
// provider from connecting, and polling cannot create an unbounded process queue.
export class ProviderChecks {
  private pending = new Map<string, Promise<ProviderInfo>>();
  private cache = new Map<string, ProviderInfo>();
  constructor(private timeoutMs = 25000) {}

  snapshot(harness: Harness): ProviderInfo {
    return (
      this.cache.get(harness) || {
        harness,
        installed: true,
        authenticated: null,
        version: '',
        detail: 'Select this provider to check its connection.',
      }
    );
  }

  check(harness: Harness, adapter: Adapter): Promise<ProviderInfo> {
    const prior = this.pending.get(harness);
    if (prior) return prior;
    let timer: ReturnType<typeof setTimeout>;
    const probe = Promise.resolve().then(() => adapter.info());
    const result = Promise.race([
      probe,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Provider check timed out')), this.timeoutMs);
      }),
    ])
      .catch(
        (): ProviderInfo => ({
          harness,
          installed: this.cache.get(harness)?.installed ?? true,
          authenticated: null,
          version: '',
          detail:
            'Connection check could not finish. Check your internet connection, then try again. If this continues, restart Abralo.',
        }),
      )
      .then((info) => {
        this.cache.set(harness, info);
        return info;
      })
      .finally(() => clearTimeout(timer));
    this.pending.set(harness, result);
    // Keep a timed-out probe single-flight until the underlying operation ends.
    void Promise.allSettled([probe, result]).then(() => this.pending.delete(harness));
    return result;
  }
}
