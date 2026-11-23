import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../apps/service/src/store.js';
import {
  REPLAY_EVENTS,
  REPLAY_AGE_MS,
  REPLAY_EVENT_BYTES,
} from '../apps/service/src/event-replay.js';

const fixtures: Store[] = [];
function fixture() {
  const store = new Store(mkdtempSync(join(tmpdir(), 'abralo-replay-')));
  fixtures.push(store);
  const owner = store.createOwner('Owner');
  const agent = store.createEmployee(owner.id, {
    name: 'Assistant',
    harness: 'codex',
    model: '',
    cwd: '',
    role: '',
    instructions: '',
  });
  return { store, owner, cid: agent.dmId };
}
afterEach(() => {
  for (const s of fixtures.splice(0)) {
    s.close();
    rmSync(s.dir, { recursive: true, force: true });
  }
});

describe('bounded event replay', () => {
  it('stores tool metadata once per event, leaving the full durable result intact', () => {
    const { store, owner, cid } = fixture();
    const detail = 'x'.repeat(1024 * 1024);
    const activity = {
      id: 'tool',
      title: 'Inspect',
      type: 'tool',
      time: new Date().toISOString(),
      detail,
    };
    store.run('INSERT INTO activities VALUES(?,?,?)', 'tool', 'run', JSON.stringify(activity));
    const e = store.emit('activity.updated', cid, { messageId: 'message', activity });
    const saved = store.one('SELECT payload FROM events WHERE cursor=?', e.cursor).payload;
    expect(Buffer.byteLength(saved)).toBeLessThan(1000);
    expect(JSON.parse(saved).activity).toMatchObject({ hasDetail: true, id: 'tool' });
    expect(JSON.parse(saved).activity.detail).toBeUndefined();
    expect(
      JSON.parse(store.one('SELECT data FROM activities WHERE id=?', 'tool').data).detail,
    ).toBe(detail);
    expect(store.eventsAfter(owner.id, e.cursor - 1)[0].payload.activity.hasDetail).toBe(true);
  });
  it('keeps oversized updates as scoped reconciliation signals', () => {
    const { store, owner, cid } = fixture();
    const other = store.createOwner('Other');
    const e = store.emit(
      'message.finished',
      cid,
      { id: 'missing', text: 'x'.repeat(REPLAY_EVENT_BYTES + 1) },
      owner.id,
    );
    expect(store.eventsAfter(owner.id, e.cursor - 1)[0]).toMatchObject({
      type: 'workspace.resync',
      conversationId: cid,
      payload: { reason: 'large_update' },
    });
    expect(store.eventsAfter(other.id, e.cursor - 1)).toEqual([]);
  });
  it('caps replay by count, expires old entries, and preserves monotonically increasing IDs', () => {
    const { store, owner, cid } = fixture();
    store.db.transaction(() => {
      for (let i = 0; i < REPLAY_EVENTS + 20; i++) store.emit('workspace.changed', cid, { i });
    })();
    expect(store.replay.resetAfter(0)).toBe(true);
    expect(store.replay.resetAfter(store.replay.head())).toBe(false);
    store.replay.maintain();
    expect(store.one('SELECT COUNT(*) n FROM events').n).toBeLessThanOrEqual(REPLAY_EVENTS);
    const head = store.replay.head();
    store.replay.maintain(Date.now() + REPLAY_AGE_MS + 1000);
    expect(store.one('SELECT COUNT(*) n FROM events').n).toBe(0);
    expect(store.replay.head()).toBe(head);
    expect(store.replay.resetAfter(head - 1)).toBe(true);
    expect(store.replay.resetAfter(head + 100)).toBe(true);
    expect(store.emit('workspace.changed', cid, {}).cursor).toBeGreaterThan(head);
    expect(store.eventsAfter(owner.id, head)).toHaveLength(1);
  });
  it('retires legacy replay immediately but cleans physical rows in small batches', () => {
    const { store, cid } = fixture();
    store.db.transaction(() => {
      for (let i = 0; i < 100; i++) store.emit('workspace.changed', cid, { i });
    })();
    store.run("DELETE FROM settings WHERE key='events.compact.v1'");
    const head = store.replay.head(),
      dir = store.dir;
    store.close();
    fixtures.splice(fixtures.indexOf(store), 1);
    const reopened = new Store(dir);
    fixtures.push(reopened);
    expect(reopened.replay.floor()).toBe(head);
    const before = reopened.one('SELECT COUNT(*) n FROM events').n;
    reopened.replay.maintain();
    expect(reopened.one('SELECT COUNT(*) n FROM events').n).toBe(before - 32);
  });
});
