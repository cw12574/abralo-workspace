import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, uid } from '../apps/service/src/store.js';
import { Work } from '../apps/service/src/work.js';
import { Goals } from '../apps/service/src/goals.js';

it('keeps one work card per request and requires a check before completion', () => {
  const dir = mkdtempSync(join(tmpdir(), 'abralo-work-'));
  const store = new Store(dir);
  try {
    const owner = store.createOwner('Owner');
    const employee = store.createEmployee(owner.id, {
      name: 'Agent',
      harness: 'codex',
      model: '',
      cwd: '',
      role: '',
      instructions: '',
    });
    const work = new Work(store);
    const run = { id: uid(), user_id: owner.id, conversation_id: employee.dmId, message_id: uid() };
    const item = work.start(run, {
      title: 'Improve signup',
      doneWhen: ['Form submits correctly'],
      proofPlan: ['Run the signup smoke check'],
    });
    expect(
      work.start(run, { title: 'Duplicate', doneWhen: ['Anything'], proofPlan: ['Anything'] }).id,
    ).toBe(item.id);
    expect(() => work.change(item.id, owner.id, employee.dmId, { status: 'complete' })).toThrow(
      /passing check/,
    );
    const complete = work.change(item.id, owner.id, employee.dmId, {
      status: 'complete',
      summary: 'Signup works',
      checks: [{ label: 'Signup smoke check', result: 'passed' }],
    });
    expect(complete.effectiveStatus).toBe('complete');
    expect(work.list(owner.id, employee.dmId)).toHaveLength(1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('links work after a lead handoff without exposing a private goal in a shared room', () => {
  const dir = mkdtempSync(join(tmpdir(), 'abralo-work-handoff-'));
  const store = new Store(dir);
  try {
    const owner = store.createOwner('Owner');
    const first = store.createEmployee(owner.id, {
      name: 'First',
      harness: 'codex',
      model: '',
      cwd: '',
      role: '',
      instructions: '',
    });
    const second = store.createEmployee(owner.id, {
      name: 'Second',
      harness: 'codex',
      model: '',
      cwd: '',
      role: '',
      instructions: '',
    });
    const goals = new Goals(store);
    const created = goals.create(owner.id, {
      conversationId: first.dmId,
      title: 'Grow PollyTalks',
      success: '$10K MRR',
    });
    goals.change(created.id, owner.id, { version: created.version, leadAgentId: second.id });
    const work = new Work(store);
    const input = {
      title: 'Measure revenue',
      goalId: created.id,
      doneWhen: ['Current revenue recorded'],
      proofPlan: ['Check the billing report'],
    };
    const run = (employeeId: string, conversationId: string) => ({
      id: uid(),
      user_id: owner.id,
      employee_id: employeeId,
      conversation_id: conversationId,
      message_id: uid(),
    });
    expect(() => work.start(run(first.id, first.dmId), input)).toThrow(/unavailable/);
    expect(() => work.start(run(second.id, store.setting('workspace.team')), input)).toThrow(
      /unavailable/,
    );
    expect(work.start(run(second.id, second.dmId), input).goalId).toBe(created.id);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
