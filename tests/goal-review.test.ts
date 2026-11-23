import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, now, uid } from '../apps/service/src/store.js';
import { Supervisor } from '../apps/service/src/supervisor.js';
import { GoalRunner } from '../apps/service/src/goal-runner.js';
import { Goals } from '../apps/service/src/goals.js';
import type { RunInput } from '../packages/contracts/src/index.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0)) await clean();
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'abralo-independent-review-'));
  const s = new Store(dir),
    owner = s.createOwner('Owner');
  const employee = s.createEmployee(owner.id, {
    name: 'Lead',
    harness: 'codex',
    model: '',
    cwd: '',
    instructions: 'Private lead reasoning should not reach the reviewer.',
  });
  const sup = new Supervisor(s),
    runner = new GoalRunner(s, sup),
    goals = new Goals(s, runner);
  sup.goals = runner;
  let dispatchAllowed = false;
  const dispatch = sup.dispatch.bind(sup);
  sup.dispatch = async () => {
    if (dispatchAllowed) {
      dispatchAllowed = false;
      await dispatch();
    }
  };
  let work: (input: RunInput, run: any) => unknown = () => {};
  sup.adapters.codex = {
    info: async () => ({
      harness: 'codex',
      installed: true,
      authenticated: true,
      version: 'test',
      detail: '',
    }),
    run: async (input) => {
      await work(input, s.one('SELECT * FROM runs WHERE id=?', input.id));
      input.emit({ type: 'complete', data: { cancelled: input.signal.aborted } });
    },
    dispose: async () => {},
  };
  const goal = goals.create(owner.id, {
    title: 'Deliver a working result',
    success: 'Artifact contains verified result',
    start: true,
    leadAgentId: employee.id,
  });
  cleanups.push(async () => {
    await sup.dispose();
    if (s.db.open) s.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    s,
    owner,
    employee,
    sup,
    runner,
    goals,
    goal,
    adapter: (fn: typeof work) => {
      work = fn;
    },
    step: async () => {
      dispatchAllowed = true;
      await sup.dispatch();
      await Promise.all([...sup.inflight]);
      runner.tick();
    },
    due: () => s.run('UPDATE goal_execution SET next_at=? WHERE goal_id=?', now(), goal.id),
  };
}
const pass = (evidence = 'Read the output and verified the result') => ({
  verdict: 'passed',
  summary: 'Required result verified',
  checks: [{ criterion: 'outcome', passed: true, evidence }],
});

describe('independent completion review', () => {
  it('uses a fresh read-only context, checks the actual artifact, returns defects internally and completes after correction', async () => {
    const f = fixture();
    let iterations = 0;
    let leadContext = '';
    let folder = '';
    f.s.addMessage(f.employee.dmId, f.owner.id, 'Owner', 'human', 'PRIVATE_CHAT_SENTINEL');
    f.adapter((input, run) => {
      if (f.runner.review.forMessage(run.message_id)) {
        expect(input.readOnly).toBe(true);
        expect(input.sessionId).toBeUndefined();
        expect(input.resumeContext).toBeUndefined();
        expect(input.employee.instructions).not.toContain('Private lead reasoning');
        expect(input.prompt).not.toContain('PRIVATE_CHAT_SENTINEL');
        expect(input.employee.cwd).toBe(folder);
        expect(run.context_key).not.toBe(leadContext);
        expect(() =>
          f.runner.checkpoint(f.goal.id, run, {
            outcome: 'complete',
            summary: 'Bypass',
            evidence: 'Fake',
          }),
        ).toThrow(/verdict/);
        const content = readFileSync(join(folder, 'result.txt'), 'utf8');
        input.emit({ type: 'text', text: 'INTERNAL_REVIEW_SENTINEL' });
        f.runner.review.report(
          run,
          content === 'verified result'
            ? pass()
            : {
                verdict: 'changes_requested',
                summary: 'The result is still a placeholder.',
                checks: [
                  { criterion: 'outcome', passed: false, evidence: 'Read result.txt: placeholder' },
                ],
                nextStep: 'Replace the placeholder with the verified result and check the file.',
              },
        );
      } else {
        iterations++;
        folder = input.employee.cwd!;
        leadContext = run.context_key;
        if (iterations === 2) expect(input.prompt).toContain('Replace the placeholder');
        writeFileSync(
          join(folder, 'result.txt'),
          iterations === 1 ? 'placeholder' : 'verified result',
        );
        input.emit({ type: 'session', data: { id: 'lead-session' } });
        f.runner.checkpoint(f.goal.id, run, {
          outcome: 'complete',
          summary: 'Result prepared',
          evidence: 'Output saved in result.txt',
          facts: ['Output is in result.txt'],
          uncertainties: [],
        });
      }
    });
    await f.step();
    expect(f.goals.get(f.goal.id, f.owner.id).execution.state).toBe('checking');
    expect(f.goals.get(f.goal.id, f.owner.id).status).toBe('active');
    await f.step();
    expect(f.goals.get(f.goal.id, f.owner.id).nextStep).toContain('Replace the placeholder');
    expect(f.s.all('SELECT * FROM decisions')).toHaveLength(0);
    f.due();
    await f.step();
    await f.step();
    const final = f.goals.get(f.goal.id, f.owner.id);
    expect(final.status).toBe('complete');
    expect(final.execution.review.verdict).toBe('passed');
    expect(final.knowledge.facts).toEqual(['Output is in result.txt']);
    expect(f.s.all('SELECT * FROM employees')).toHaveLength(1);
    expect(
      f.s.messages(f.employee.dmId).some((m) => m.text.includes('INTERNAL_REVIEW_SENTINEL')),
    ).toBe(false);
    expect(
      f.s.all("SELECT * FROM events WHERE payload LIKE '%INTERNAL_REVIEW_SENTINEL%'"),
    ).toHaveLength(0);
    expect(
      f.s.all(
        "SELECT * FROM inbox i JOIN messages m ON m.id=i.message_id WHERE m.text LIKE '%INTERNAL_REVIEW_SENTINEL%'",
      ),
    ).toHaveLength(0);
    expect(
      f.s.messages(f.employee.dmId).filter((m) => m.text.startsWith('Completed:')),
    ).toHaveLength(1);
  });

  it('requires every criterion, rejects stale review and does not let the lead issue a verdict', async () => {
    const f = fixture();
    f.goals.addStep(f.goal.id, f.owner.id, {
      title: 'Check the second requirement',
      doneWhen: 'Second artifact verified',
    });
    f.adapter((_input, run) => {
      if (!f.runner.review.forMessage(run.message_id)) {
        expect(() => f.runner.review.report(run, pass())).toThrow(/active independent review/);
        f.runner.checkpoint(f.goal.id, run, {
          outcome: 'complete',
          summary: 'Ready',
          evidence: 'Prepared output',
        });
      } else {
        expect(() => f.runner.review.report(run, pass())).toThrow(/every completion criterion/);
        const g = f.goals.get(f.goal.id, f.owner.id);
        f.goals.change(g.id, f.owner.id, { version: g.version, success: 'Changed requirement' });
        expect(() => f.runner.review.report(run, pass())).toThrow(/requirements changed/);
      }
    });
    await f.step();
    await f.step();
    expect(f.goals.get(f.goal.id, f.owner.id).status).toBe('active');
    expect(f.runner.review.pending(f.goal.id)).toBeNull();
  });

  it('recovers a queued review from the durable store without creating duplicate jobs', async () => {
    const f = fixture();
    f.adapter((_input, run) =>
      f.runner.checkpoint(f.goal.id, run, {
        outcome: 'complete',
        summary: 'Ready',
        evidence: 'Saved file',
      }),
    );
    await f.step();
    const count = f.s.all('SELECT * FROM outbox').length;
    const recovered = new GoalRunner(f.s, f.sup);
    recovered.tick();
    recovered.tick();
    expect(f.s.all('SELECT * FROM outbox')).toHaveLength(count);
    expect(recovered.review.pending(f.goal.id).candidate.evidence).toBe('Saved file');
    f.adapter((_input, run) => recovered.review.report(run, pass()));
    await f.step();
    expect(f.goals.get(f.goal.id, f.owner.id).status).toBe('complete');
  });

  it('does not complete after a reviewer fails, and preserves explicit user pause', async () => {
    const f = fixture();
    f.adapter((_input, run) => {
      if (f.runner.review.forMessage(run.message_id)) throw Error('Reviewer unavailable');
      f.runner.checkpoint(f.goal.id, run, {
        outcome: 'complete',
        summary: 'Ready',
        evidence: 'Saved file',
      });
    });
    await f.step();
    await f.step();
    expect(f.goals.get(f.goal.id, f.owner.id).status).toBe('active');
    expect(f.runner.policy(f.goal.id).state).toBe('checking');
    const g = f.goals.get(f.goal.id, f.owner.id);
    f.goals.change(g.id, f.owner.id, { version: g.version, status: 'paused' });
    f.due();
    await f.step();
    expect(f.runner.policy(g.id).state).toBe('paused');
    expect(f.runner.review.pending(g.id)).toBeNull();
  });
});

describe('durable continuation and waiting', () => {
  it('has no default timer cutoff, preserves facts at checkpoints and changes approach after repeated evidence', async () => {
    const f = fixture();
    let count = 0;
    f.adapter((input, run) => {
      expect(input.prompt).toContain('no fixed session cutoff');
      f.s.run(
        'UPDATE runs SET created_at=? WHERE id=?',
        new Date(Date.now() - 3600000).toISOString(),
        run.id,
      );
      f.runner.tick();
      expect(input.signal.aborted).toBe(false);
      if (count >= 2) expect(input.prompt).toContain('Change approach');
      f.runner.checkpoint(f.goal.id, run, {
        outcome: 'continue',
        summary: 'Investigated',
        evidence: 'Same observation',
        nextStep: 'Try a different source',
        ...(count === 0 ? { facts: ['Known fact'], uncertainties: ['Missing measurement'] } : {}),
      });
      expect(f.goals.get(f.goal.id, f.owner.id).current).toBe('Investigated');
      count++;
    });
    for (let i = 0; i < 4; i++) {
      f.due();
      await f.step();
    }
    expect(f.runner.policy(f.goal.id).state).toBe('needs_input');
    expect(f.goals.get(f.goal.id, f.owner.id).knowledge.facts).toEqual(['Known fact']);
    expect(f.goals.get(f.goal.id, f.owner.id).knowledge.uncertainties).toEqual([
      'Missing measurement',
    ]);
  });

  it('resumes from an ordinary chat answer without losing its goal association', async () => {
    const f = fixture();
    let calls = 0;
    f.adapter((input, run) => {
      if (calls++ === 0)
        f.runner.checkpoint(f.goal.id, run, {
          outcome: 'needs_input',
          summary: 'Need the target audience',
          question: 'Which audience?',
        });
      else {
        expect(input.prompt).toContain('Which audience?');
        expect(input.prompt).toContain('Small teams');
        expect(f.runner.cycle(run.message_id).goal_id).toBe(f.goal.id);
        f.runner.checkpoint(f.goal.id, run, {
          outcome: 'wait',
          summary: 'Awaiting measurement',
          nextStep: 'Read the result',
          nextAt: new Date(Date.now() + 3600000).toISOString(),
        });
      }
    });
    await f.step();
    await f.step();
    expect(calls).toBe(1);
    f.s.accept(f.owner, f.employee.dmId, {
      text: 'Small teams',
      key: uid(),
      recipients: [f.employee.id],
      attachments: [],
    });
    await f.step();
    expect(calls).toBe(2);
    expect(f.runner.policy(f.goal.id).state).toBe('waiting_external');
  });

  it('preserves native approval waits across restart and links the scoped answer to the goal', async () => {
    const f = fixture();
    f.adapter((_input, run) => {
      f.s.run(
        'INSERT INTO decisions(id,run_id,user_id,state,data) VALUES(?,?,?,?,?)',
        uid(),
        run.id,
        f.owner.id,
        'pending',
        JSON.stringify({
          kind: 'permission',
          title: 'Execute the prepared command',
          detail: { command: 'approved-check' },
        }),
      );
    });
    await f.step();
    expect(f.runner.policy(f.goal.id).state).toBe('needs_permission');
    const decision = f.s.one('SELECT * FROM decisions');
    const restarted = new Supervisor(f.s);
    restarted.goals = f.runner;
    restarted.dispatch = async () => {};
    try {
      await restarted.resolve(f.owner.id, decision.id, decision.version, { allow: true });
      const reply = f.s.setting('decision.continuation.' + decision.id);
      expect(f.s.one('SELECT goal_id FROM goal_cycles WHERE message_id=?', reply).goal_id).toBe(
        f.goal.id,
      );
      expect(f.runner.policy(f.goal.id).state).toBe('queued');
      await expect(
        restarted.resolve(f.owner.id, decision.id, decision.version, { allow: true }),
      ).rejects.toThrow(/already resolved/);
    } finally {
      await restarted.dispose();
    }
  });

  it('recovers a finished external action even if its wake-up event was lost', async () => {
    const f = fixture();
    let actionId = '';
    f.adapter((_input, run) => {
      actionId = uid();
      f.s.run(
        'INSERT INTO connection_actions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        actionId,
        f.owner.id,
        f.employee.id,
        f.employee.dmId,
        run.message_id,
        run.id,
        uid(),
        'fingerprint',
        'write',
        '{}',
        'running',
        null,
        now(),
        now(),
      );
      f.runner.checkpoint(f.goal.id, run, {
        outcome: 'wait',
        summary: 'Waiting for action',
        nextStep: 'Inspect saved result',
        actionIds: [actionId],
      });
    });
    await f.step();
    const before = f.s.all('SELECT * FROM outbox').length;
    f.runner.tick();
    expect(f.s.all('SELECT * FROM outbox')).toHaveLength(before);
    f.s.run(
      "UPDATE connection_actions SET state='succeeded',result=? WHERE id=?",
      JSON.stringify({ verified: true }),
      actionId,
    );
    new GoalRunner(f.s, f.sup).tick();
    f.runner.tick();
    expect(f.s.all('SELECT * FROM outbox')).toHaveLength(before + 1);
  });
});
