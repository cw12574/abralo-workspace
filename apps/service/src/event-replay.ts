import { summaryEvent } from '../../../packages/contracts/src/activity-summary.js';
import type { Store } from './store.js';

// Delivery history, not the durable record of work. 2,048 x 16 KiB <= 32 MiB
// of retained payload; old physical pages are reclaimed separately in maintenance.
export const REPLAY_EVENTS = 2048;
export const REPLAY_EVENT_BYTES = 16 * 1024;
export const REPLAY_AGE_MS = 24 * 60 * 60 * 1000;

export function compactReplay(type: string, payload: any) {
  const event = summaryEvent({ type, payload });
  const json = JSON.stringify(event.payload);
  return Buffer.byteLength(json) <= REPLAY_EVENT_BYTES
    ? { type: event.type, json }
    : { type: 'workspace.resync', json: '{"reason":"large_update"}' };
}

export class EventReplay {
  private timer: ReturnType<typeof setInterval>;
  constructor(private store: Store) {
    // Existing unbounded journals need not be replayed. A reconnect receives a
    // snapshot; batch removal avoids a multi-gigabyte startup write transaction.
    if (!store.setting('events.compact.v1', false)) {
      store.set('events.floor', this.head());
      store.set('events.legacyFloor', this.head());
      store.set('events.compact.v1', true);
    }
    this.timer = setInterval(() => {
      try {
        this.maintain();
      } catch {
        /* Busy/closing DB: retry on the next bounded tick. */
      }
    }, 2000);
    this.timer.unref();
  }
  head() {
    return this.store.one("SELECT seq FROM sqlite_sequence WHERE name='events'")?.seq || 0;
  }
  floor() {
    return Math.max(this.store.setting('events.floor', 0), this.head() - REPLAY_EVENTS);
  }
  resetAfter(cursor: number) {
    return cursor < this.floor() || cursor > this.head();
  }
  maintain(at = Date.now()) {
    if (!this.store.db.open) return;
    this.store.db.transaction(() => {
      const floor = this.floor();
      // This range contains at most REPLAY_EVENTS rows; never scan the old log.
      const expired =
        this.store.one(
          'SELECT MAX(cursor) cursor FROM events WHERE cursor>? AND created_at<?',
          floor,
          new Date(at - REPLAY_AGE_MS).toISOString(),
        )?.cursor || 0;
      const next = Math.max(floor, expired);
      if (next > this.store.setting('events.floor', 0)) this.store.set('events.floor', next);
      const legacy = this.store.setting('events.legacyFloor', 0);
      this.store.run('DELETE FROM events WHERE cursor>? AND cursor<=?', legacy, next);
      this.store.run(
        'DELETE FROM events WHERE cursor IN (SELECT cursor FROM events WHERE cursor<=? ORDER BY cursor LIMIT 32)',
        Math.min(legacy, next),
      );
    })();
  }
  close() {
    clearInterval(this.timer);
  }
}
