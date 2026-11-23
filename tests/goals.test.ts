import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, uid } from '../apps/service/src/store.js';
import { Goals } from '../apps/service/src/goals.js';

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'abralo-goals-'));
  roots.push(dir);
  const store = new Store(dir);
  const owner = store.createOwner('Owner');
  const employee = store.createEmployee(owner.id, {
    name: 'Assistant',
    harness: 'codex',
    model: '',
    cwd: '',
    role: '',
    instructions: '',
  });
  return { dir, store, owner, employee, goals: new Goals(store) };
}

describe('durable goals', () => {
  it('reserves saved and paused leads, releases completed capacity, and rejects a conflicting reopen', () => {
    const f = fixture();
    try {
      f.goals.reconcileAssignments();
      const first = f.goals.create(f.owner.id, { title: 'First', leadAgentId: f.employee.id });
      expect(first.leadAgentId).toBe(f.employee.id);
      expect(first.conversationId).toBe(f.employee.dmId);
      expect(() =>
        f.goals.create(f.owner.id, { title: 'Second', leadAgentId: f.employee.id }),
      ).toThrow(/already leads/);
      const paused = f.goals.change(first.id, f.owner.id, {
        version: first.version,
        status: 'paused',
      });
      expect(() =>
        f.goals.create(f.owner.id, { title: 'Second', leadAgentId: f.employee.id }),
      ).toThrow(/already leads/);
      const complete = f.goals.change(first.id, f.owner.id, {
        version: paused.version,
        status: 'complete',
      });
      expect(complete.status).toBe('active');
      expect(complete.execution.state).toBe('checking');
      expect(() =>
        f.goals.create(f.owner.id, { title: 'Second', leadAgentId: f.employee.id }),
      ).toThrow(/already leads/);
      // Completed fixture; independent transition is exercised through the runner in goal-review.test.ts.
      f.store.run("UPDATE goals SET status='complete' WHERE id=?", first.id);
      const next = f.goals.create(f.owner.id, { title: 'Second', leadAgentId: f.employee.id });
      expect(() =>
        f.goals.change(first.id, f.owner.id, { version: complete.version, status: 'active' }),
      ).toThrow(/already leads/);
      expect(f.goals.get(first.id, f.owner.id).status).toBe('complete');
      expect(f.goals.get(next.id, f.owner.id).leadAgentId).toBe(f.employee.id);
    } finally {
      f.store.close();
    }
  });

  it('uses available employees before the Chief of Staff creates a lead without inherited access', () => {
    const f = fixture();
    try {
      const chief = f.store.createEmployee(f.owner.id, {
        name: 'Chief of Staff',
        harness: 'codex',
        model: 'test-model',
        cwd: 'C:/private',
        permissionMode: 'bypass',
        role: 'Coordinator',
        instructions: 'private context',
      });
      const first = f.goals.create(f.owner.id, { title: 'First' });
      const second = f.goals.create(f.owner.id, { title: 'Second' });
      expect(new Set([first.leadAgentId, second.leadAgentId])).toEqual(
        new Set([f.employee.id, chief.id]),
      );
      const third = f.goals.create(f.owner.id, { title: 'Third' });
      const hire = f.store.employee(third.leadAgentId)!;
      expect(hire.id).not.toBe(chief.id);
      expect(hire.model).toBe('test-model');
      expect(hire.cwd).toBe('');
      expect(hire.permissionMode).toBe('auto');
      expect(hire.instructions).not.toContain('private context');
      expect(f.store.all('SELECT * FROM grants WHERE employee_id=?', hire.id)).toHaveLength(0);
      expect(
        f.store.one(
          'SELECT text FROM messages WHERE conversation_id=? ORDER BY seq DESC LIMIT 1',
          chief.dmId,
        ).text,
      ).toContain(hire.name);
      expect(f.store.all('SELECT * FROM outbox')).toHaveLength(0);
    } finally {
      f.store.close();
    }
  });

  it('reconciles old unassigned and duplicate goals once, retaining history and paused state', () => {
    const f = fixture();
    try {
      const first = f.goals.create(f.owner.id, { title: 'Original', leadAgentId: f.employee.id });
      const duplicateId = uid(),
        unassignedId = uid();
      for (const [id, lead] of [
        [duplicateId, f.employee.id],
        [unassignedId, null],
      ] as const) {
        f.store.run(
          "INSERT INTO goals SELECT ?,owner_id,conversation_id,title,success,current,next_step,'paused',source_message_id,version,created_at,updated_at,? FROM goals WHERE id=?",
          id,
          lead,
          first.id,
        );
        f.goals.runner.configure(id, {});
        f.goals.runner.setState(id, 'paused', 'Paused by request.');
      }
      f.goals.addUpdate(duplicateId, f.owner.id, f.employee.id, {
        summary: 'Existing progress',
        evidence: 'Recorded check',
      });
      const schema = f.store.all('SELECT type,name,sql FROM sqlite_master ORDER BY type,name');
      f.goals.reconcileAssignments();
      expect(f.store.all('SELECT type,name,sql FROM sqlite_master ORDER BY type,name')).toEqual(
        schema,
      );
      const goals = f.goals.list(f.owner.id);
      expect(goals).toHaveLength(3);
      expect(new Set(goals.map((goal) => goal.leadAgentId)).size).toBe(3);
      expect(goals.every((goal) => goal.leadAgentActive)).toBe(true);
      expect(f.goals.get(duplicateId, f.owner.id).updates[0].summary).toBe('Existing progress');
      expect(f.goals.get(duplicateId, f.owner.id).execution.state).toBe('paused');
      const count = f.store.all('SELECT id FROM employees').length;
      f.goals.reconcileAssignments();
      expect(f.store.all('SELECT id FROM employees')).toHaveLength(count);
      expect(() =>
        f.goals.change(goals[1].id, f.owner.id, {
          version: goals[1].version,
          leadAgentId: goals[0].leadAgentId!,
        }),
      ).toThrow(/already leads/);
    } finally {
      f.store.close();
    }
  });

  it('hands a goal to a named lead without sharing its private conversation', () => {
    const f = fixture();
    const second = f.store.createEmployee(f.owner.id, {
      name: 'Growth lead',
      harness: 'codex',
      model: '',
      cwd: '',
      role: '',
      instructions: '',
    });
    const created = f.goals.create(f.owner.id, {
      conversationId: f.employee.dmId,
      title: 'Grow PollyTalks',
      success: '$10K monthly revenue',
    });
    expect(created.leadAgentId).toBe(f.employee.id);
    const handedOff = f.goals.change(created.id, f.owner.id, {
      version: created.version,
      leadAgentId: second.id,
      nextStep: 'Establish current monthly revenue',
    });
    expect(handedOff.leadAgentName).toBe('Growth lead');
    expect(f.goals.listForAgent(f.owner.id, f.employee.id, f.employee.dmId)).toEqual([]);
    expect(f.goals.listForAgent(f.owner.id, second.id, second.dmId)[0].id).toBe(created.id);
    expect(f.goals.listForAgent(f.owner.id, second.id, f.employee.dmId)).toEqual([]);
    expect(f.goals.list(f.owner.id, second.dmId)[0].id).toBe(created.id);
    expect(f.goals.list(f.owner.id, f.employee.dmId)).toEqual([]);
    f.store.close();
    const reopened = new Store(f.dir);
    expect(new Goals(reopened).get(created.id, f.owner.id).leadAgentId).toBe(second.id);
    reopened.close();
  });

  it('rejects an inactive or inaccessible lead', () => {
    const f = fixture();
    const created = f.goals.create(f.owner.id, {
      conversationId: f.employee.dmId,
      title: 'Launch',
      success: 'First customer',
    });
    const other = f.store.createOwner('Other');
    const stranger = f.store.createEmployee(other.id, {
      name: 'Other agent',
      harness: 'codex',
      model: '',
      cwd: '',
      role: '',
      instructions: '',
    });
    expect(() =>
      f.goals.change(created.id, f.owner.id, {
        version: created.version,
        leadAgentId: stranger.id,
      }),
    ).toThrow(/active agent/);
    const inactive = { ...f.employee, deactivatedAt: new Date().toISOString() };
    f.store.run('UPDATE employees SET data=? WHERE id=?', JSON.stringify(inactive), f.employee.id);
    expect(() =>
      f.goals.change(created.id, f.owner.id, {
        version: created.version,
        leadAgentId: f.employee.id,
      }),
    ).toThrow(/active agent/);
    f.store.close();
  });

  it('keeps progress and checks across restarts', () => {
    const f = fixture();
    const created = f.goals.create(f.owner.id, {
      conversationId: f.employee.dmId,
      title: 'Grow PollyTalks',
      success: '$10K monthly revenue',
      nextStep: 'Measure current revenue',
    });
    const withStep = f.goals.addStep(created.id, f.owner.id, {
      title: 'Measure baseline',
      doneWhen: 'Revenue and customer count recorded',
    });
    expect(() =>
      f.goals.changeStep(created.id, withStep.steps[0].id, f.owner.id, { status: 'done' }),
    ).toThrow(/result or check/);
    f.goals.changeStep(created.id, withStep.steps[0].id, f.owner.id, {
      status: 'done',
      evidence: 'Revenue report reviewed',
    });
    f.goals.addUpdate(created.id, f.owner.id, f.employee.id, {
      summary: 'Baseline established',
      evidence: 'Revenue report',
    });
    f.store.close();
    const reopened = new Store(f.dir);
    const saved = new Goals(reopened).get(created.id, f.owner.id);
    expect(saved.steps[0].status).toBe('done');
    expect(saved.steps[0].evidence).toBe('Revenue report reviewed');
    expect(saved.updates[0].summary).toBe('Baseline established');
    reopened.close();
  });

  it('lets the owner delete a goal that is working: stops queued work, frees the lead, keeps the conversation', () => {
    const f = fixture();
    try {
      const goal = f.goals.create(f.owner.id, {
        title: 'Working goal',
        leadAgentId: f.employee.id,
        start: true,
      });
      (f.goals as any).runner.tick();
      const cycle = f.store.one('SELECT * FROM goal_cycles WHERE goal_id=?', goal.id);
      expect(cycle?.outbox_id).toBeTruthy();
      // Automatic undo keeps refusing goals that have already started.
      expect(() => f.goals.remove(goal.id, f.owner.id)).toThrow(/Pause it instead/);
      expect(f.goals.remove(goal.id, f.owner.id, { stopWork: true })).toEqual({ removed: true, id: goal.id });
      expect(f.store.one('SELECT status FROM outbox WHERE id=?', cycle.outbox_id).status).toBe('cancelled');
      for (const table of ['goals', 'goal_cycles', 'goal_execution', 'goal_steps', 'goal_updates'])
        expect(f.store.all(`SELECT * FROM ${table} WHERE ${table === 'goals' ? 'id' : 'goal_id'}=?`, goal.id)).toHaveLength(0);
      expect(() => f.goals.get(goal.id, f.owner.id)).toThrow();
      expect(f.store.one('SELECT id FROM conversations WHERE id=?', goal.conversationId)).toBeTruthy();
      const next = f.goals.create(f.owner.id, { title: 'Next goal', leadAgentId: f.employee.id });
      expect(next.leadAgentId).toBe(f.employee.id);
    } finally {
      f.store.close();
    }
  });

  it('rejects stale updates and access to another owner’s goal', () => {
    const f = fixture();
    const created = f.goals.create(f.owner.id, {
      conversationId: f.employee.dmId,
      title: 'Launch',
      success: 'First customer',
    });
    f.goals.change(created.id, f.owner.id, {
      version: created.version,
      nextStep: 'Interview buyers',
    });
    expect(() =>
      f.goals.change(created.id, f.owner.id, {
        version: created.version,
        nextStep: 'Overwrite newer work',
      }),
    ).toThrow(/changed/);
    expect(() => f.goals.get(created.id, 'someone-else')).toThrow(/unavailable/);
    f.store.close();
  });
});
