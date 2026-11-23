import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, uid, now } from '../apps/service/src/store.js';
import { Supervisor } from '../apps/service/src/supervisor.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'durable-decisions-'));
  const s = new Store(dir),
    user = s.createOwner('Owner');
  s.set('notifications.' + user.id, { enabled: false, sound: false });
  const employee = s.createEmployee(user.id, {
    name: 'Engineer',
    harness: 'codex',
    model: '',
    role: '',
    cwd: '',
    instructions: '',
  });
  const sup = new Supervisor(s);
  const message = s.addMessage(employee.dmId, user.id, user.name, 'human', 'Prepare a change.');
  const response = s.addMessage(employee.dmId, employee.id, employee.name, 'agent', 'Prepared.');
  const runId = uid();
  s.run(
    `INSERT INTO runs(id,conversation_id,user_id,employee_id,message_id,response_id,state,created_at,updated_at,context_key)
    VALUES(?,?,?,?,?,?,?,?,?,?)`,
    runId,
    employee.dmId,
    user.id,
    employee.id,
    message.id,
    response.id,
    'running',
    now(),
    now(),
    uid(),
  );
  sup.active.set(runId, new AbortController());
  cleanups.push(async () => {
    await sup.dispose();
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, s, user, employee, sup, runId };
}
const action = {
  kind: 'permission',
  actionType: 'maintenance',
  title: 'Install the reviewed build',
  detail: { jobId: 'prepared-job' },
};

it('keeps live approvals pending after a month and resolves the original waiter', async () => {
  const f = fixture();
  const waiting = f.sup.decision(f.runId, {
    kind: 'permission',
    title: 'Run checks',
    detail: { command: 'pnpm test' },
  });
  const d = f.s.one('SELECT * FROM decisions');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 31 * 86400000);
  expect(f.s.one('SELECT state FROM decisions').state).toBe('pending');
  await f.sup.resolve(f.user.id, d.id, d.version, { allow: true });
  expect(await waiting).toEqual({ allow: true });
});

it('returns a deduplicated durable card, survives supervisor restart and executes once', async () => {
  const f = fixture(),
    handler = vi.fn(async () => ({ started: true }));
  f.sup.approvalActions.set('maintenance', handler);
  const card = f.sup.requestApproval(f.runId, action);
  expect(f.sup.requestApproval(f.runId, action).decisionId).toBe(card.decisionId);
  expect(f.sup.resolvers.size).toBe(0);
  await f.sup.dispose();
  const restarted = new Supervisor(f.s);
  restarted.approvalActions.set('maintenance', handler);
  try {
    expect(f.s.one('SELECT state FROM decisions').state).toBe('pending');
    await restarted.resolve(f.user.id, card.decisionId, 1, { allow: true });
    await expect(restarted.resolve(f.user.id, card.decisionId, 1, { allow: true })).rejects.toThrow(
      'already resolved',
    );
    expect(handler).toHaveBeenCalledOnce();
  } finally {
    await restarted.dispose();
  }
});

it('retains the card if revalidation fails and permits decline without executing', async () => {
  const f = fixture(),
    handler = vi.fn(async () => {
      throw new Error('Prepared build changed');
    });
  f.sup.approvalActions.set('maintenance', handler);
  const card = f.sup.requestApproval(f.runId, action);
  await expect(f.sup.resolve(f.user.id, card.decisionId, 1, { allow: true })).rejects.toThrow(
    'build changed',
  );
  expect(f.s.one('SELECT state FROM decisions').state).toBe('pending');
  await f.sup.resolve(f.user.id, card.decisionId, 1, { allow: false });
  expect(handler).toHaveBeenCalledOnce();
  expect(f.s.all('SELECT * FROM outbox')).toHaveLength(0);
});

it('blocks concurrent clicks and another human from approving the same action', async () => {
  const f = fixture();
  let finish!: () => void;
  f.sup.approvalActions.set(
    'maintenance',
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ started: true });
      }),
  );
  const card = f.sup.requestApproval(f.runId, action);
  await expect(
    f.sup.resolve(f.s.createOwner('Other').id, card.decisionId, 1, { allow: true }),
  ).rejects.toThrow('another human');
  const first = f.sup.resolve(f.user.id, card.decisionId, 1, { allow: true });
  await expect(f.sup.resolve(f.user.id, card.decisionId, 1, { allow: true })).rejects.toThrow(
    'already resolved',
  );
  finish();
  await first;
});

it('delivers a saved native decision as one scoped continuation after its worker is gone', async () => {
  const f = fixture();
  const waiting = f.sup.decision(f.runId, {
    kind: 'workspace_access',
    title: 'Open this folder',
    detail: { type: 'directory' },
  });
  const d = f.s.one('SELECT * FROM decisions');
  await f.sup.dispose();
  await waiting;
  const restarted = new Supervisor(f.s);
  // Inspect the queue without starting a real provider.
  restarted.maintenance = true;
  try {
    await restarted.resolve(f.user.id, d.id, 1, { allow: true, path: 'C:\\reviewed-project' });
    expect(f.s.all('SELECT * FROM outbox')).toHaveLength(1);
    const m = f.s.one(
      'SELECT text FROM messages WHERE id=?',
      f.s.setting('decision.continuation.' + d.id),
    );
    expect(m.text).toContain('reviewed-project');
    expect(m.text).toContain('not approval for changed arguments');
    await expect(restarted.resolve(f.user.id, d.id, 1, { allow: true })).rejects.toThrow();
    expect(f.s.all('SELECT * FROM outbox')).toHaveLength(1);
  } finally {
    await restarted.dispose();
  }
});

it('preserves approvals on automatic session limits but cancels them on an explicit stop', async () => {
  const f = fixture();
  const waiting = f.sup.decision(f.runId, { kind: 'permission', title: 'Run checks' });
  f.sup.cancel(f.user.id, f.runId, 'limit');
  await waiting;
  expect(f.s.one('SELECT state FROM decisions').state).toBe('pending');
  // A later explicit user stop cancels the still-pending request.
  f.sup.cancel(f.user.id, f.runId, 'user');
  expect(f.s.one('SELECT state FROM decisions').state).toBe('cancelled');
});

it('keeps a card actionable after the agent finishes its normal turn', async () => {
  const f = fixture();
  f.sup.active.clear();
  f.s.run("UPDATE runs SET state='completed' WHERE id=?", f.runId);
  f.sup.adapters.codex = {
    info: async () => ({ installed: true, authenticated: true, harness: 'codex', detail: '' }),
    run: async (input: any) => {
      void input.decide({ kind: 'permission', title: 'A request left for later' });
      input.emit({ type: 'complete', data: { cancelled: false } });
    },
    dispose: async () => {},
  } as any;
  f.s.accept(f.user, f.employee.dmId, {
    key: 'new-request',
    text: 'Prepare it for my decision.',
    recipients: [f.employee.id],
    attachments: [],
  });
  await f.sup.dispatch();
  await Promise.allSettled([...f.sup.inflight]);
  const d = f.s.one('SELECT * FROM decisions');
  expect(d.state).toBe('pending');
  expect(f.sup.resolvers.has(d.id)).toBe(false);
  f.sup.maintenance = true;
  await f.sup.resolve(f.user.id, d.id, d.version, { allow: true });
  expect(f.s.setting('decision.continuation.' + d.id)).toBeTruthy();
});
