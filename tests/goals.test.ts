import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../apps/service/src/store.js';
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
    expect(f.goals.listForAgent(f.owner.id, second.id, f.store.setting('workspace.team'))).toEqual(
      [],
    );
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
