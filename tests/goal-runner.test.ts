import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, now, uid } from '../apps/service/src/store.js';
import { Goals } from '../apps/service/src/goals.js';
import { GoalRunner } from '../apps/service/src/goal-runner.js';
import { Supervisor } from '../apps/service/src/supervisor.js';
import { ConnectionBroker } from '../apps/service/src/connections.js';
import { ProviderLimitError } from '../apps/service/src/adapters/provider-limit.js';
import type { RunInput } from '../packages/contracts/src/index.js';

const fixtures: { dir: string; store: Store; sup: Supervisor }[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.sup.dispose();
    if (f.store.db.open) f.store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'abralo-goal-loop-')),
    store = new Store(dir);
  const owner = store.createOwner('Owner');
  const employee = store.createEmployee(owner.id, {
    name: 'Lead',
    harness: 'codex',
    model: '',
    role: '',
    instructions: '',
    cwd: '',
  });
  const sup = new Supervisor(store),
    runner = new GoalRunner(store, sup),
    goals = new Goals(store, runner);
  sup.goals = runner;
  const f = { dir, store, owner, employee, sup, runner, goals };
  fixtures.push(f);
  return f;
}
function create(f: ReturnType<typeof fixture>, extra: any = {}) {
  return f.goals.create(f.owner.id, {
    conversationId: f.employee.dmId,
    title: 'Improve activation',
    success: 'Measured activation improves',
    start: true,
    ...extra,
  });
}
function adapter(f: ReturnType<typeof fixture>, work: (input: RunInput) => unknown) {
  f.sup.adapters.codex = {
    info: async () => ({
      harness: 'codex',
      installed: true,
      authenticated: true,
      version: 'test',
      detail: '',
    }),
    run: async (input) => {
      const run = f.store.one('SELECT * FROM runs WHERE id=?', input.id);
      const review = f.runner.review.forMessage(run.message_id);
      if (review)
        f.runner.review.report(run, {
          verdict: 'passed',
          summary: 'Outcome independently verified',
          checks: review.criteria.map((c: any) => ({
            criterion: c.id,
            passed: true,
            evidence: 'Fixture result independently checked',
          })),
        });
      else await work(input);
      input.emit({ type: 'complete', data: { cancelled: input.signal.aborted } });
    },
    dispose: async () => {},
  };
}
async function drain(f: ReturnType<typeof fixture>) {
  await f.sup.dispatch();
  await Promise.all([...f.sup.inflight]);
  f.runner.tick();
  if (f.store.one("SELECT 1 FROM goal_execution WHERE state='checking'")) {
    await f.sup.dispatch();
    await Promise.all([...f.sup.inflight]);
    f.runner.tick();
  }
}
function due(f: ReturnType<typeof fixture>, id: string) {
  f.store.run(
    'UPDATE goal_execution SET next_at=? WHERE goal_id=?',
    new Date(Date.now() - 1000).toISOString(),
    id,
  );
}

describe('goal continuation', () => {
  it('continues past four sessions by default and completes only with evidence', async () => {
    const f = fixture(),
      goal = create(f, { success: undefined });
    expect(goal.success).toBe(goal.title);
    expect(goal.execution.dailySessions).toBe(0);
    let calls = 0;
    adapter(f, (input) => {
      calls++;
      expect(input.prompt).toContain('no daily session cap');
      expect(input.employee.instructions).toContain('Users may create as many durable goals');
      f.runner.checkpoint(goal.id, f.store.one('SELECT * FROM runs WHERE id=?', input.id), {
        outcome: calls === 6 ? 'complete' : 'continue',
        summary: `Verified increment ${calls}`,
        evidence: `Check ${calls} passed`,
        nextStep: 'Verify the next increment',
      });
    });
    for (let i = 0; i < 6; i++) {
      due(f, goal.id);
      await drain(f);
    }
    f.runner.tick();
    expect(calls).toBe(6);
    const saved = f.goals.get(goal.id, f.owner.id);
    expect(saved.status).toBe('complete');
    expect(saved.updates).toHaveLength(7);
    expect(f.store.all('SELECT * FROM goal_cycles')).toHaveLength(7);
  });

  it('moves multiple goals forward with a different dedicated lead for each', async () => {
    const f = fixture();
    const goals = Array.from({ length: 8 }, (_, index) => create(f, { title: `Outcome ${index}` }));
    const worked: string[] = [];
    adapter(f, (input) => {
      const run = f.store.one('SELECT * FROM runs WHERE id=?', input.id);
      const cycle = f.runner.cycle(run.message_id);
      worked.push(cycle.goal_id);
      expect(
        f.store.all("SELECT * FROM runs WHERE state='running' AND employee_id=?", run.employee_id),
      ).toHaveLength(1);
      f.runner.checkpoint(cycle.goal_id, run, {
        outcome: 'continue',
        summary: 'First increment verified',
        evidence: 'Check passed',
        nextStep: 'Take the next step',
      });
    });
    for (let i = 0; i < goals.length; i++) await drain(f);
    expect(new Set(worked)).toEqual(new Set(goals.map((g) => g.id)));
    expect(new Set(goals.map((goal) => goal.leadAgentId)).size).toBe(8);
    expect(f.goals.listForAgent(f.owner.id, f.employee.id, f.employee.dmId)).toHaveLength(1);
  });

  it('preserves saved work limits when updating and restarting an existing goal', () => {
    const f = fixture(),
      goal = create(f, { dailySessions: 4, start: false });
    f.runner.configure(goal.id, { sessionMinutes: 20 });
    f.runner.start(goal.id);
    const saved = f.goals.get(goal.id, f.owner.id);
    expect(saved.execution.dailySessions).toBe(4);
    expect(saved.execution.sessionMinutes).toBe(20);
  });

  it('resumes a goal after pausing a provider-limited session without reviving the old retry', async () => {
    const f = fixture(),
      goal = create(f);
    let calls = 0;
    adapter(f, (input) => {
      if (++calls === 1)
        throw new ProviderLimitError(
          'Rate limit',
          'Codex',
          'rate',
          new Date(Date.now() + 3600000).toISOString(),
        );
      f.runner.checkpoint(goal.id, f.store.one('SELECT * FROM runs WHERE id=?', input.id), {
        outcome: 'complete',
        summary: 'Success checked',
        evidence: 'Measurement verified',
      });
    });
    await drain(f);
    const old = f.store.one("SELECT * FROM runs WHERE state='provider_limited'");
    expect(old).toBeTruthy();
    const paused = f.goals.change(goal.id, f.owner.id, { version: goal.version, status: 'paused' });
    expect(f.store.setting('run.autoResume.' + old.id)).toBe(false);
    f.goals.change(goal.id, f.owner.id, { version: paused.version, status: 'active' });
    await drain(f);
    expect(calls).toBe(2);
    expect(f.goals.get(goal.id, f.owner.id).status).toBe('complete');
  });
  it('leaves saved goals idle and queues a started goal exactly once', () => {
    const f = fixture();
    f.store.createEmployee(f.owner.id, { name: 'Available lead', harness: 'codex' });
    create(f, { start: false });
    f.runner.tick();
    expect(f.store.all('SELECT * FROM outbox')).toHaveLength(0);
    const goal = create(f);
    f.runner.tick();
    f.runner.tick();
    expect(f.store.all('SELECT * FROM outbox')).toHaveLength(1);
    expect(f.goals.get(goal.id, f.owner.id).execution.state).toBe('queued');
    expect(f.store.all('SELECT * FROM inbox')).toHaveLength(0);
  });

  it('runs useful work, saves evidence and a timed review, and reloads it without duplicate work', async () => {
    const f = fixture(),
      goal = create(f);
    adapter(f, (input) => {
      expect(input.prompt).toContain(goal.id);
      expect(input.employee.instructions).toContain('Active goals you lead:\n- ' + goal.id);
      f.runner.checkpoint(goal.id, f.store.one('SELECT * FROM runs WHERE id=?', input.id), {
        outcome: 'wait',
        summary: 'Baseline verified',
        evidence: '42 of 100 activated',
        nextStep: 'Review experiment results',
        nextAt: new Date(Date.now() + 3600000).toISOString(),
      });
    });
    await drain(f);
    let saved = f.goals.get(goal.id, f.owner.id);
    expect(saved.execution.state).toBe('waiting_external');
    expect(saved.current).toBe('Baseline verified');
    expect(saved.updates).toHaveLength(1);
    await f.sup.dispose();
    f.store.close();
    const reopened = new Store(f.dir);
    try {
      const runner = new GoalRunner(reopened);
      runner.tick();
      saved = new Goals(reopened, runner).get(goal.id, f.owner.id);
      expect(saved.execution.state).toBe('waiting_external');
      expect(reopened.all('SELECT * FROM outbox')).toHaveLength(1);
      expect(saved.updates).toHaveLength(1);
    } finally {
      reopened.close();
    }
  });

  it('checks in once, waits without work, and resumes from an explicit answer', async () => {
    const f = fixture(),
      goal = create(f);
    adapter(f, (input) =>
      f.runner.checkpoint(goal.id, f.store.one('SELECT * FROM runs WHERE id=?', input.id), {
        outcome: 'needs_input',
        summary: 'Two audiences identified',
        question: 'Which audience should we prioritise?',
        evidence: 'Interview findings',
      }),
    );
    await drain(f);
    f.runner.tick();
    f.runner.tick();
    expect(f.goals.get(goal.id, f.owner.id).execution.state).toBe('needs_input');
    expect(f.store.all("SELECT * FROM messages WHERE text LIKE '@Owner%'")).toHaveLength(1);
    expect(f.store.all('SELECT * FROM goal_cycles')).toHaveLength(1);
    f.goals.reply(goal.id, f.owner.id, { answer: 'Small teams first' });
    expect(() => f.goals.reply(goal.id, f.owner.id, { answer: 'Duplicate' })).toThrow(
      /not waiting/,
    );
    expect(f.goals.get(goal.id, f.owner.id).execution.state).toBe('queued');
    expect(f.store.all('SELECT * FROM goal_cycles')).toHaveLength(2);
  });

  it('honours the rolling work allowance and does not repeatedly queue work', async () => {
    const f = fixture(),
      goal = create(f, { dailySessions: 1 });
    adapter(f, (input) =>
      f.runner.checkpoint(goal.id, f.store.one('SELECT * FROM runs WHERE id=?', input.id), {
        outcome: 'continue',
        summary: 'Baseline ready',
        evidence: 'Report checked',
        nextStep: 'Prepare experiment',
      }),
    );
    await drain(f);
    due(f, goal.id);
    f.runner.tick();
    f.runner.tick();
    const saved = f.goals.get(goal.id, f.owner.id);
    expect(saved.execution.sessionsUsed).toBe(1);
    expect(saved.execution.reason).toMatch(/allowance/);
    expect(Date.parse(saved.execution.nextAt)).toBeGreaterThan(Date.now());
    expect(f.store.all('SELECT * FROM goal_cycles')).toHaveLength(1);
  });

  it('cancels queued work on pause and creates a fresh continuation on resume', () => {
    const f = fixture(),
      goal = create(f);
    f.runner.tick();
    const paused = f.goals.change(goal.id, f.owner.id, { version: goal.version, status: 'paused' });
    expect(f.store.one('SELECT status FROM outbox').status).toBe('cancelled');
    f.runner.tick();
    expect(f.store.all('SELECT * FROM goal_cycles')).toHaveLength(1);
    f.goals.change(goal.id, f.owner.id, { version: paused.version, status: 'active' });
    f.runner.tick();
    expect(f.store.all("SELECT * FROM outbox WHERE status='pending'")).toHaveLength(1);
  });

  it('stops a live session and rejects a late checkpoint after pause', async () => {
    const f = fixture(),
      goal = create(f);
    let started!: () => void;
    const ready = new Promise<void>((resolve) => (started = resolve));
    adapter(f, async (input) => {
      started();
      await new Promise<void>((resolve) =>
        input.signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      expect(() =>
        f.runner.checkpoint(goal.id, f.store.one('SELECT * FROM runs WHERE id=?', input.id), {
          outcome: 'complete',
          summary: 'Late',
          evidence: 'Late',
        }),
      ).toThrow();
    });
    await f.sup.dispatch();
    await ready;
    f.goals.change(goal.id, f.owner.id, { version: goal.version, status: 'paused' });
    await Promise.all([...f.sup.inflight]);
    f.runner.tick();
    expect(f.goals.get(goal.id, f.owner.id).execution.state).toBe('paused');
    expect(f.store.all('SELECT * FROM goal_updates')).toHaveLength(0);
  });

  it('recovers interrupted work with a fresh inspection and backs off repeated failures', async () => {
    const f = fixture(),
      goal = create(f);
    adapter(f, () => {
      throw new Error('Connection lost after an uncertain action');
    });
    for (let i = 0; i < 3; i++) {
      due(f, goal.id);
      await drain(f);
    }
    const saved = f.goals.get(goal.id, f.owner.id);
    expect(saved.execution.state).toBe('needs_input');
    expect(saved.execution.question).toMatch(/Three work sessions/);
    expect(f.store.all("SELECT * FROM messages WHERE text LIKE '@Owner%'")).toHaveLength(1);
  });

  it('requires completion evidence and enforces research mode in the harness', async () => {
    const f = fixture(),
      goal = create(f, { autonomy: 'research' });
    adapter(f, (input) => {
      expect(input.readOnly).toBe(true);
      const run = f.store.one('SELECT * FROM runs WHERE id=?', input.id);
      expect(() =>
        f.runner.checkpoint(goal.id, run, { outcome: 'complete', summary: 'Done' }),
      ).toThrow(/evidence/);
      f.runner.checkpoint(goal.id, run, {
        outcome: 'complete',
        summary: 'Measured activation improved',
        evidence: 'Activation 42% to 55%, report checked',
      });
    });
    await drain(f);
    expect(f.goals.get(goal.id, f.owner.id).status).toBe('complete');
  });

  it('keeps human work ahead of goals and does not expose private goals to another agent', () => {
    const f = fixture();
    const goal = create(f);
    f.store.accept(f.owner, f.employee.dmId, {
      text: 'Quick question',
      key: uid(),
      recipients: [f.employee.id],
      attachments: [],
      newTask: false,
    });
    f.runner.tick();
    expect(f.store.all('SELECT * FROM goal_cycles')).toHaveLength(0);
    f.store.run("UPDATE outbox SET status='done'");
    f.runner.tick();
    const c = f.store.one('SELECT * FROM goal_cycles WHERE goal_id=?', goal.id);
    expect(
      f.store.one('SELECT conversation_id FROM messages WHERE id=?', c.message_id).conversation_id,
    ).toBe(f.employee.dmId);
    expect(
      f.goals.listForAgent(
        f.owner.id,
        f.employee.id,
        f.store.createEmployee(f.owner.id, { name: 'Other agent', harness: 'codex' }).dmId,
      ),
    ).toEqual([]);
  });

  it('does not start legacy goals merely because their lead changes', () => {
    const f = fixture(),
      goal = create(f, { start: false });
    f.store.run('DELETE FROM goal_execution WHERE goal_id=?', goal.id);
    const next = f.store.createEmployee(f.owner.id, {
      name: 'Next lead',
      harness: 'codex',
      model: '',
      cwd: '',
      role: '',
      instructions: '',
    });
    f.goals.change(goal.id, f.owner.id, { version: goal.version, leadAgentId: next.id });
    f.runner.tick();
    expect(f.goals.get(goal.id, f.owner.id).execution.state).toBe('saved');
    expect(f.store.all('SELECT * FROM outbox')).toHaveLength(0);
  });

  it('recovers a crash during work without replaying the claimed request', async () => {
    const f = fixture(),
      goal = create(f);
    f.runner.tick();
    const cycle = f.store.one('SELECT * FROM goal_cycles');
    f.store.run("UPDATE outbox SET status='claimed'");
    f.store.run(
      'INSERT INTO runs(id,message_id,response_id,conversation_id,employee_id,user_id,state,created_at,updated_at,context_key) VALUES(?,?,?,?,?,?,?,?,?,?)',
      uid(),
      cycle.message_id,
      uid(),
      f.employee.dmId,
      f.employee.id,
      f.owner.id,
      'running',
      now(),
      now(),
      uid(),
    );
    await f.sup.dispose();
    f.store.close();
    const reopened = new Store(f.dir),
      sup = new Supervisor(reopened),
      runner = new GoalRunner(reopened, sup);
    try {
      runner.tick();
      runner.tick();
      expect(reopened.one('SELECT state FROM runs').state).toBe('interrupted');
      expect(reopened.one('SELECT status FROM outbox').status).toBe('interrupted');
      expect(reopened.one('SELECT reason FROM goal_execution').reason).toMatch(
        /Inspect saved work/,
      );
      expect(reopened.all('SELECT * FROM goal_cycles')).toHaveLength(1);
      reopened.run(
        'UPDATE goal_execution SET next_at=?',
        new Date(Date.now() - 1000).toISOString(),
      );
      runner.tick();
      expect(reopened.all('SELECT * FROM goal_cycles')).toHaveLength(2);
      expect(
        reopened.one("SELECT message_id FROM outbox WHERE status='pending'").message_id,
      ).not.toBe(cycle.message_id);
    } finally {
      await sup.dispose();
      reopened.close();
    }
  });

  it('yields an active background session to a new human message', async () => {
    const f = fixture(),
      goal = create(f, { dailySessions: 1 });
    let started!: () => void;
    const ready = new Promise<void>((resolve) => (started = resolve));
    adapter(f, async (input) => {
      const run = f.store.one('SELECT * FROM runs WHERE id=?', input.id);
      if (!f.runner.cycle(run.message_id)) return;
      started();
      await new Promise<void>((resolve) =>
        input.signal.addEventListener('abort', () => resolve(), { once: true }),
      );
    });
    await f.sup.dispatch();
    await ready;
    const message = f.store.accept(f.owner, f.employee.dmId, {
      text: 'What have you learned?',
      key: uid(),
      recipients: [f.employee.id],
      attachments: [],
      newTask: false,
    });
    await drain(f);
    await drain(f);
    expect(f.store.one('SELECT state FROM runs WHERE message_id=?', message.id).state).toBe(
      'completed',
    );
    expect(f.goals.get(goal.id, f.owner.id).status).toBe('active');
    expect(f.store.one('SELECT cancelled FROM goal_cycles').cancelled).toBe(1);
  });

  it('honours a quick pause/resume while cancellation is still finishing', async () => {
    const f = fixture(),
      goal = create(f, { dailySessions: 1 });
    let started!: () => void;
    const ready = new Promise<void>((resolve) => (started = resolve));
    adapter(f, async (input) => {
      started();
      await new Promise<void>((resolve) =>
        input.signal.addEventListener('abort', () => resolve(), { once: true }),
      );
    });
    await f.sup.dispatch();
    await ready;
    const paused = f.goals.change(goal.id, f.owner.id, { version: goal.version, status: 'paused' });
    f.goals.change(goal.id, f.owner.id, { version: paused.version, status: 'active' });
    await Promise.all([...f.sup.inflight]);
    f.runner.tick();
    expect(f.goals.get(goal.id, f.owner.id).status).toBe('active');
    expect(f.goals.get(goal.id, f.owner.id).execution.state).toBe('scheduled');
  });

  it('cancels sessions at the time limit and schedules recovery within the allowance', async () => {
    const f = fixture(),
      goal = create(f, { sessionMinutes: 1 });
    let started!: () => void;
    const ready = new Promise<void>((resolve) => (started = resolve));
    adapter(f, async (input) => {
      f.store.run(
        'UPDATE runs SET created_at=? WHERE id=?',
        new Date(Date.now() - 61000).toISOString(),
        input.id,
      );
      started();
      await new Promise<void>((resolve) =>
        input.signal.addEventListener('abort', () => resolve(), { once: true }),
      );
    });
    await f.sup.dispatch();
    await ready;
    f.runner.tick();
    await Promise.all([...f.sup.inflight]);
    f.runner.tick();
    expect(f.store.one('SELECT state FROM runs').state).toBe('cancelled');
    const saved = f.goals.get(goal.id, f.owner.id);
    expect(saved.status).toBe('active');
    expect(saved.execution.nextAt).toBeTruthy();
  });

  it('wakes from a connected result once, while a paused goal ignores late results', async () => {
    const f = fixture(),
      goal = create(f);
    adapter(f, (input) =>
      f.runner.checkpoint(goal.id, f.store.one('SELECT * FROM runs WHERE id=?', input.id), {
        outcome: 'needs_input',
        summary: 'Waiting for setup',
        question: 'Connect the analytics account.',
      }),
    );
    await drain(f);
    const run = f.store.one('SELECT * FROM runs'),
      broker = new ConnectionBroker(f.store, () => 'http://localhost', f.sup);
    f.runner.enabled = false;
    const connection = { id: uid(), owner_id: f.owner.id, service: 'stripe' };
    const setup = {
      employeeId: f.employee.id,
      conversationId: f.employee.dmId,
      requestMessageId: run.message_id,
      runId: run.id,
      continuation: 'The requested account is connected. Read the receipt.',
    };
    try {
      await broker.resumeWaitingTask(connection, setup);
      await broker.resumeWaitingTask(connection, setup);
      expect(f.store.setting('goal.signal.' + goal.id).context).toContain('Read the receipt');
      f.runner.enabled = true;
      f.runner.tick();
      f.runner.tick();
      expect(f.store.all('SELECT * FROM goal_cycles')).toHaveLength(2);
      const current = f.goals.get(goal.id, f.owner.id);
      f.goals.change(goal.id, f.owner.id, { version: current.version, status: 'paused' });
      f.store.run('DELETE FROM settings WHERE key=?', 'goal.signal.' + goal.id);
      await broker.resumeWaitingTask(connection, setup, 'another-result');
      expect(f.store.setting('goal.signal.' + goal.id)).toBeNull();
      expect(f.goals.get(goal.id, f.owner.id).status).toBe('paused');
    } finally {
      await broker.close();
    }
  });
});
