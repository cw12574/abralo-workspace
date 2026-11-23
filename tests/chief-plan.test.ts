import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../apps/service/src/store.js';
import { Goals } from '../apps/service/src/goals.js';
import { Briefings } from '../apps/service/src/briefings.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});

/** Every existing employee already leads a goal: the plan must still go through. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'abralo-plan-'));
  const store = new Store(dir),
    owner = store.createOwner('Chris');
  const employee = (name: string, extra = {}) =>
    store.createEmployee(owner.id, {
      name,
      role: 'Product',
      harness: 'codex',
      model: '',
      cwd: '',
      instructions: '',
      ...extra,
    });
  const chief = employee('Chief of Staff', { canDelegate: true, role: 'Organizes the team' });
  const people = [employee('Abralo Engineer'), employee('Abralo Engineer 2')];
  const supervisor = {
    active: new Map(),
    dispatch: vi.fn(),
    cancel: vi.fn(),
    closing: false,
    maintenance: false,
  } as any;
  const goals = new Goals(store);
  supervisor.goals = goals.runner;
  for (const [i, person] of [chief, ...people].entries())
    goals.create(owner.id, { title: `Existing work ${i}`, leadAgentId: person.id, start: true });
  const briefings = new Briefings(store, supervisor);
  const b = briefings.create(owner.id, people.map((p) => p.id), people[0].dmId, 'chief');
  cleanups.push(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const say = (id: string, text: string, speaker = 'You') =>
    briefings.turn(b.id, owner.id, { id, speaker: speaker === 'You' ? 'You' : chief.id, text });
  const state = (id: string) => goals.get(id, owner.id).execution;
  return { store, owner, chief, people, goals, briefings, b, say, state };
}

// What Chris actually said on 11 November 2026, as saved by the briefing.
const morning = [
  'Good morning, so we want to get Abralo into GitHub so that people can download it for Linux, Mac, and Windows.',
  'Today.',
  'Then we want to try ChatGPT ads. We want to do an experiment where we try to get some tech companies using Abralo',
  'And we want to build, actually before we do the OpenAI ads, we should create a cloud version of this platform that we can try to sell to companies. And then we do the ChatGPT ads where we try to sell it to companies with all of the core features. Then we should record a great demo.',
  "video where we're doing a morning meeting and it shows the goals and tasks in a way that will capture the imagination of the whole world.",
  'Then we will post that on social media, and then we will apply for YC and speedrun.',
];
const plan = [
  {
    title: 'Publish cross-platform preview on GitHub',
    success: 'Verified Windows, macOS and Linux downloads with checksums on GitHub Releases',
    nextStep: 'Build and verify installers for all three platforms; label them as a preview.',
    after: '',
    employeeId: '',
  },
  {
    title: 'Launch a cloud version for companies',
    success: 'Companies can sign up and use the core features in a hosted version',
    nextStep: 'Agree the minimum cloud scope with Chris, then outline the architecture.',
    after: '',
    employeeId: '',
  },
  {
    title: 'Run a ChatGPT ads experiment for tech companies',
    success: 'Ads experiment run with measured sign-ups from tech companies',
    nextStep: 'Draft the experiment, budget and success metric for Chris to approve before spending.',
    after: 'Launch a cloud version for companies',
    employeeId: '',
  },
  {
    title: 'Record the morning meeting demo video',
    success: 'Demo video showing a morning meeting with goals and tasks is ready to publish',
    nextStep: 'Write a storyboard of the morning meeting demo.',
    after: 'Run a ChatGPT ads experiment for tech companies',
    employeeId: '',
  },
  {
    title: 'Post the demo and apply to YC and Speedrun',
    success: 'Demo posted on social media; YC and Speedrun applications submitted',
    nextStep: 'Draft the social posts and applications for Chris to review before anything is published.',
    after: 'Record the morning meeting demo video',
    employeeId: '',
  },
];

it('replays the 11 November briefing: every stated goal is set, in order, without capacity talk', () => {
  const f = fixture();
  for (const [i, text] of morning.entries()) f.say('morning-' + i, text);
  f.say('chief-1', 'Here is how I would sequence that.', 'chief');
  f.say('agreed', 'Yes, please, and I remembered one more goal.');
  const input = { name: 'set_plan', callId: 'plan', sourceTurnId: 'agreed', args: { goals: plan } };
  const { result } = f.briefings.act(f.b.id, f.owner.id, input) as any;

  expect(result.status).toBe('planned');
  expect(result.goals.map((g: any) => g.title)).toEqual(plan.map((p) => p.title));
  // Independent work starts now; dependent work is lined up behind its predecessor.
  expect(result.goals.map((g: any) => g.state)).toEqual([
    'queued',
    'queued',
    'sequenced',
    'sequenced',
    'sequenced',
  ]);
  expect(result.goals[2].startsAfter).toBe('Launch a cloud version for companies');
  expect(result.goals[4].startsAfter).toBe('Record the morning meeting demo video');
  // Everyone was busy, so the workspace added leads instead of refusing.
  expect(new Set(result.goals.map((g: any) => g.employeeId)).size).toBe(5);
  expect(result.recap).toMatch(/^5 goals set\. Starting now: .*Then, in order: /);

  const saved = f.briefings.get(f.b.id, f.owner.id);
  expect(saved.executedActions?.filter((a) => a.goalId)).toHaveLength(5);
  const receipt = f.store.one('SELECT text FROM messages WHERE id=?', result.receiptMessageId);
  expect(receipt.text).toContain('5. Post the demo and apply to YC and Speedrun');

  // Lost acknowledgements and model retries never duplicate the plan.
  expect((f.briefings.act(f.b.id, f.owner.id, input) as any).result.receiptMessageId).toBe(
    result.receiptMessageId,
  );
  expect(
    (f.briefings.act(f.b.id, f.owner.id, { ...input, callId: 'retry' }) as any).result.goals[0]
      .goalId,
  ).toBe(result.goals[0].goalId);
  expect(f.store.all("SELECT * FROM goals WHERE title NOT LIKE 'Existing work%'")).toHaveLength(5);

  // The model never sees capacity, so it cannot invent a limit.
  const session = f.briefings.chiefContext(f.b.id, f.owner.id);
  expect(session.instructions).not.toContain('availableForGoal');
  expect(session.instructions).not.toMatch(/each employee leads at most one/i);
  expect(session.instructions).toContain('never talk about capacity');
  expect(session.tools.map((t) => t.name)).toEqual([
    'read_goals',
    'delegate_goal',
    'set_plan',
    'remove_goal',
    'create_employee',
    'delegate_task',
    'save_recap',
  ]);
});

it('starts each waiting goal automatically when the goal before it completes', () => {
  const f = fixture();
  f.say('agreed', 'Do these in order.');
  const { result } = f.briefings.act(f.b.id, f.owner.id, {
    name: 'set_plan',
    callId: 'plan',
    sourceTurnId: 'agreed',
    args: { goals: plan.slice(1, 4) },
  }) as any;
  const [cloud, ads, demo] = result.goals.map((g: any) => g.goalId);
  expect(f.state(ads)).toMatchObject({
    state: 'sequenced',
    reason: 'Starts after “Launch a cloud version for companies” is complete.',
    startsAfter: { id: cloud },
  });
  f.goals.runner.tick();
  expect(f.state(ads).state).toBe('sequenced');
  expect(f.store.one('SELECT 1 FROM goal_cycles WHERE goal_id=?', ads)).toBeUndefined();

  f.store.run("UPDATE goals SET status='complete' WHERE id=?", cloud);
  f.goals.runner.tick();
  expect(f.state(ads).state).not.toBe('sequenced');
  expect(f.state(ads).startsAfter).toBeNull();
  expect(f.state(demo)).toMatchObject({ state: 'sequenced', startsAfter: { id: ads } });
});

it('treats a paused predecessor as still pending, and Start now skips the wait', () => {
  const f = fixture();
  f.say('agreed', 'Go.');
  const { result } = f.briefings.act(f.b.id, f.owner.id, {
    name: 'set_plan',
    callId: 'plan',
    sourceTurnId: 'agreed',
    args: { goals: plan.slice(1, 3) },
  }) as any;
  const [cloud, ads] = result.goals.map((g: any) => g.goalId);
  f.goals.change(cloud, f.owner.id, { version: f.goals.get(cloud, f.owner.id).version, status: 'paused' });
  f.goals.runner.tick();
  expect(f.state(ads).state).toBe('sequenced');
  // Pausing and resuming a waiting goal keeps its place in line.
  f.goals.change(ads, f.owner.id, { version: f.goals.get(ads, f.owner.id).version, status: 'paused' });
  f.goals.change(ads, f.owner.id, { version: f.goals.get(ads, f.owner.id).version, status: 'active' });
  expect(f.state(ads).state).toBe('sequenced');
  // Starting a waiting goal from the Goals page means "don't wait".
  f.goals.change(ads, f.owner.id, { version: f.goals.get(ads, f.owner.id).version, status: 'active' });
  expect(f.state(ads)).toMatchObject({ state: 'queued', startsAfter: null });
});

it('rejects loops and unknown predecessors without creating partial plans', () => {
  const f = fixture();
  const a = f.goals.create(f.owner.id, { title: 'A' });
  const b = f.goals.create(f.owner.id, { title: 'B', startsAfter: a.id });
  expect(() => f.goals.runner.sequence(a.id, b.id)).toThrow('loop');
  expect(() => f.goals.runner.sequence(a.id, a.id)).toThrow('loop');
  f.say('agreed', 'Go.');
  const before = f.store.all('SELECT id FROM goals').length;
  expect(() =>
    f.briefings.act(f.b.id, f.owner.id, {
      name: 'set_plan',
      callId: 'bad',
      sourceTurnId: 'agreed',
      args: { goals: [plan[0], { ...plan[1], after: 'Something never mentioned' }] },
    }),
  ).toThrow('not an earlier goal');
  expect(f.store.all('SELECT id FROM goals')).toHaveLength(before);
});

it('reuses an existing goal named in the plan and puts a saved one back in line', () => {
  const f = fixture();
  const yc = f.goals.create(f.owner.id, {
    title: 'Post the demo and apply to YC and Speedrun',
    conversationId: f.chief.dmId,
  });
  f.say('agreed', 'Then the YC application after the demo.');
  const { result } = f.briefings.act(f.b.id, f.owner.id, {
    name: 'set_plan',
    callId: 'plan',
    sourceTurnId: 'agreed',
    args: { goals: [{ ...plan[3], after: '' }, plan[4]] },
  }) as any;
  expect(result.goals[1]).toMatchObject({ goalId: yc.id, reused: true, state: 'sequenced' });
  expect(f.state(yc.id).startsAfter?.id).toBe(result.goals[0].goalId);
  expect(f.store.all('SELECT * FROM goals WHERE title=?', yc.title)).toHaveLength(1);
});

it('undoes a goal by voice or click; followers inherit its place; started work is protected', () => {
  const f = fixture();
  f.say('agreed', 'Go.');
  const { result } = f.briefings.act(f.b.id, f.owner.id, {
    name: 'set_plan',
    callId: 'plan',
    sourceTurnId: 'agreed',
    args: { goals: plan.slice(1, 4) },
  }) as any;
  const [cloud, ads, demo] = result.goals.map((g: any) => g.goalId);
  f.say('change', 'Actually drop the ads experiment.');
  const removed = f.briefings.act(f.b.id, f.owner.id, {
    name: 'remove_goal',
    callId: 'drop-ads',
    sourceTurnId: 'change',
    args: { goalId: ads },
  }) as any;
  expect(removed.result.status).toBe('removed');
  expect(f.store.one('SELECT 1 FROM goals WHERE id=?', ads)).toBeUndefined();
  expect(f.state(demo)).toMatchObject({ state: 'sequenced', startsAfter: { id: cloud } });
  expect(
    f.briefings.get(f.b.id, f.owner.id).executedActions?.find((a) => a.goalId === ads)?.status,
  ).toBe('removed');

  // A click on Undo needs no spoken source turn; removing the head releases the next goal.
  f.goals.runner.tick(); // the cloud goal starts work
  expect(() => f.briefings.removeGoal(f.b.id, f.owner.id, cloud)).toThrow('Pause it instead');
  f.store.run('DELETE FROM goal_cycles WHERE goal_id=?', cloud);
  f.briefings.removeGoal(f.b.id, f.owner.id, cloud);
  expect(f.state(demo)).toMatchObject({ state: 'queued', startsAfter: null });

  // Only goals set in this conversation can be undone here.
  const other = f.goals.create(f.owner.id, { title: 'Unrelated' });
  expect(() => f.briefings.removeGoal(f.b.id, f.owner.id, other.id)).toThrow(
    'set during this conversation',
  );
});
