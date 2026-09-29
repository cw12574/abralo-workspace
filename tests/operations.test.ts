import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, uid, now } from '../apps/service/src/store.js';
import { tickSchedules } from '../apps/service/src/operations.js';
import { forecast } from '../apps/service/src/usage.js';
import { createApp } from '../apps/service/src/app.js';
import { Supervisor } from '../apps/service/src/supervisor.js';
describe('recovery and boundaries', () => {
  it('closes oversized event replay instead of looping on the same page', async () => {
    const s = new Store(mkdtempSync(join(tmpdir(), 'workspace-event-replay-')));
    const owner = s.createOwner('Owner');
    const session = s.newSession(owner.id);
    const { app } = await createApp(s);
    try {
      for (let i = 0; i < 500; i++) s.emit('replay.test', null, { body: 'x'.repeat(5000) }, owner.id);
      const response = await app.inject({
        method: 'GET',
        url: '/api/events?after=0',
        headers: { cookie: `workspace=${session}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.payload.length).toBeGreaterThan(0);
      expect(response.payload.length).toBeLessThan(2 * 1024 * 1024);
    } finally {
      await app.close();
    }
  }, 15000);

  it('cancels an active run when its account-owner grant is revoked', async () => {
    const s = new Store(mkdtempSync(join(tmpdir(), 'workspace-revoke-')));
    const owner = s.createOwner('Owner'),
      colleague = s.createOwner('Colleague');
    const e = s.createEmployee(owner.id, {
      name: 'Agent',
      harness: 'codex',
      model: '',
      role: '',
      instructions: '',
      cwd: '',
    });
    const sup = new Supervisor(s);
    let started!: () => void;
    const running = new Promise<void>((r) => (started = r));
    sup.adapters.codex = {
      info: async () => ({
        harness: 'codex',
        installed: true,
        authenticated: true,
        version: 'fixture',
        detail: 'Deterministic cancellation test fixture',
      }),
      run: async (input) => {
        started();
        await new Promise<void>((resolve) =>
          input.signal.addEventListener('abort', () => resolve(), { once: true }),
        );
        input.emit({ type: 'complete', data: { cancelled: true } });
      },
      dispose: async () => {},
    };
    const { app } = await createApp(s, { supervisor: sup });
    const headers = { cookie: 'workspace=' + s.newSession(owner.id), 'x-workspace-request': '1' };
    try {
      const grant = await app.inject({
        method: 'PUT',
        url: `/api/employees/${e.id}/grants`,
        headers,
        payload: { users: [colleague.id] },
      });
      expect(grant.statusCode).toBe(200);
      const dm = s.one(
        'SELECT c.id FROM conversations c JOIN members m ON m.conversation_id=c.id WHERE c.employee_id=? AND m.user_id=?',
        e.id,
        colleague.id,
      );
      s.accept(colleague, dm.id, {
        text: 'Wait until cancelled',
        key: uid(),
        attachments: [],
        recipients: [],
        newTask: false,
      });
      await sup.dispatch();
      await running;
      const revoke = await app.inject({
        method: 'PUT',
        url: `/api/employees/${e.id}/grants`,
        headers,
        payload: { users: [] },
      });
      expect(revoke.statusCode).toBe(200);
      await Promise.all([...sup.inflight]);
      expect(s.one('SELECT state FROM runs').state).toBe('cancelled');
      expect(sup.active.size).toBe(0);
    } finally {
      await app.close();
    }
  }, 15000);
  it('rechecks membership for targeted events and replay after access is removed', () => {
    const s = new Store(mkdtempSync(join(tmpdir(), 'workspace-events-')));
    const u = s.createOwner('Owner');
    const e = s.createEmployee(u.id, {
      name: 'Agent',
      harness: 'codex',
      model: '',
      role: '',
      instructions: '',
      cwd: '',
    });
    const event = s.emit('decision.created', e.dmId, { private: true }, u.id);
    expect(s.allowedEvent(u.id, event)).toBe(true);
    expect(s.eventsAfter(u.id, 0).some((x) => x.id === event.id)).toBe(true);
    s.run('DELETE FROM members WHERE conversation_id=?', e.dmId);
    expect(s.allowedEvent(u.id, event)).toBe(false);
    expect(s.eventsAfter(u.id, 0).some((x) => x.id === event.id)).toBe(false);
    s.close();
  });
  it('does not broadcast rolled back events', async () => {
    const s = new Store(mkdtempSync(join(tmpdir(), 'workspace-rollback-')));
    const events: any[] = [];
    s.bus.on('event', (e) => events.push(e));
    try {
      s.db.transaction(() => {
        s.emit('test', null, {});
        throw Error('rollback');
      })();
    } catch {}
    await Promise.resolve();
    expect(events).toEqual([]);
    s.close();
  });
  it('runs a missed schedule once after reopening and respects its off switch', () => {
    const dir = mkdtempSync(join(tmpdir(), 'workspace-schedule-')),
      s = new Store(dir),
      u = s.createOwner('Owner'),
      e = s.createEmployee(u.id, {
        name: 'Agent',
        harness: 'codex',
        model: '',
        role: '',
        instructions: '',
        cwd: '',
      }),
      id = uid();
    s.run(
      'INSERT INTO schedules VALUES(?,?,?,?,?,?,?,1)',
      id,
      u.id,
      e.dmId,
      e.id,
      'Read a report',
      '2020-01-01T00:00:00.000Z',
      60,
    );
    const sup: any = { dispatch: async () => {} };
    tickSchedules(s, sup);
    tickSchedules(s, sup);
    expect(s.all('SELECT * FROM outbox')).toHaveLength(1);
    s.close();
    const reopened = new Store(dir);
    tickSchedules(reopened, sup);
    expect(reopened.all('SELECT * FROM outbox')).toHaveLength(1);
    reopened.run(
      'UPDATE schedules SET enabled=0,next_at=? WHERE id=?',
      '2020-01-01T00:00:00.000Z',
      id,
    );
    tickSchedules(reopened, sup);
    expect(reopened.all('SELECT * FROM outbox')).toHaveLength(1);
    reopened.close();
  });
  it('requires an explicit account-owner grant for another human', () => {
    const s = new Store(mkdtempSync(join(tmpdir(), 'workspace-grant-'))),
      a = s.createOwner('A'),
      b = s.createOwner('B'),
      e = s.createEmployee(a.id, {
        name: 'Agent',
        harness: 'codex',
        model: '',
        role: '',
        instructions: '',
        cwd: '',
      });
    expect(s.canUseEmployee(b.id, e.id)).toBe(false);
    s.run('INSERT INTO employee_grants VALUES(?,?)', e.id, b.id);
    expect(s.canUseEmployee(b.id, e.id)).toBe(true);
    expect(() => s.authorize(b.id, e.dmId)).toThrow();
    s.run('DELETE FROM employee_grants');
    expect(s.canUseEmployee(b.id, e.id)).toBe(false);
    s.close();
  });
  it('withholds quota forecasts for resets, stale data or insufficient evidence', () => {
    const at = 1_000_000,
      reset = (at + 3600000) / 1000;
    expect(forecast([{ at, used: 20, reset }], at)).toBeNull();
    const samples = [
      { at: at - 120000, used: 50, reset },
      { at: at - 60000, used: 55, reset },
      { at, used: 60, reset },
    ];
    expect(forecast(samples, at)?.earliest).toBeGreaterThan(at);
    expect(forecast(samples, at + 360000)).toBeNull();
    expect(forecast([...samples.slice(0, 2), { at, used: 1, reset: reset + 3600 }], at)).toBeNull();
  });
});
