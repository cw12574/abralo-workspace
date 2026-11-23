import { z } from 'zod';
import { EmployeeInput } from '../../../packages/contracts/src/index.js';
import { Store, ApiError, hash, uid, now } from './store.js';
import { chiefFor } from './chief-briefing.js';
import { Goals } from './goals.js';
import { staffGoal } from './goal-staffing.js';
import type { GoalRunner } from './goal-runner.js';
import type { Briefing } from './briefings.js';

const request = z.string().trim().min(2).max(6000);
const sourceTurnId = z.string().min(1).max(200).optional();
export const chiefAction = z.discriminatedUnion('name', [
  z.object({
    name: z.literal('read_goals'),
    sourceTurnId,
    callId: z.string().min(1).max(200),
    args: z.object({}).strict(),
  }),
  z.object({
    name: z.literal('delegate_goal'),
    sourceTurnId,
    callId: z.string().min(1).max(200),
    args: z
      .object({
        userRequest: request.optional(),
        employeeId: z.union([z.string().uuid(), z.literal('')]),
        goalId: z.union([z.string().uuid(), z.literal('')]),
        version: z.number().int().min(0),
        title: z.string().trim().min(1).max(240),
        success: z.string().trim().min(1).max(240),
        nextStep: z.string().trim().min(1).max(2000),
        start: z.boolean().default(true),
      })
      .strict(),
  }),
  z.object({
    name: z.literal('set_plan'),
    sourceTurnId,
    callId: z.string().min(1).max(200),
    args: z
      .object({
        goals: z
          .array(
            z
              .object({
                title: z.string().trim().min(1).max(240),
                success: z.string().trim().min(1).max(240),
                nextStep: z.string().trim().min(1).max(2000),
                after: z.string().trim().max(240).default(''),
                employeeId: z.union([z.string().uuid(), z.literal('')]).default(''),
              })
              .strict(),
          )
          .min(1)
          .max(12),
      })
      .strict(),
  }),
  z.object({
    name: z.literal('remove_goal'),
    sourceTurnId,
    callId: z.string().min(1).max(200),
    args: z.object({ goalId: z.string().uuid() }).strict(),
  }),
  z.object({
    name: z.literal('create_employee'),
    sourceTurnId,
    callId: z.string().min(1).max(200),
    args: z
      .object({
        userRequest: request.optional(),
        name: z.string().trim().min(1).max(80),
        role: z.string().trim().min(1).max(4000),
        task: z.string().trim().max(3000).default(''),
      })
      .strict(),
  }),
  z.object({
    name: z.literal('delegate_task'),
    sourceTurnId,
    callId: z.string().min(1).max(200),
    args: z
      .object({
        userRequest: request.optional(),
        employeeId: z.string().uuid(),
        task: z.string().trim().min(1).max(3000),
      })
      .strict(),
  }),
]);
const normalize = (text: string) => text.trim().replace(/\s+/g, ' ').toLowerCase();

// Called inside the briefing transaction. No filesystem, account or bypass grants
// are copied to a new employee. The normal supervisor enforces execution access.
export function executeChiefAction(store: Store, b: Briefing, input: unknown, runner?: GoalRunner) {
  const d = chiefAction.parse(input);
  const chief = chiefFor(store, b.ownerId, b.hostId);
  const goals = new Goals(store, runner);
  const visibleGoals = () =>
    goals
      .list(b.ownerId)
      .filter((g) => g.conversationId === chief.dmId || g.leadAgentId === chief.id);
  if (d.name === 'read_goals')
    return {
      goals: visibleGoals().map((g) => ({
        id: g.id,
        version: g.version,
        title: g.title,
        success: g.success,
        leadAgentId: g.leadAgentId,
        leadAgentName: g.leadAgentName,
        current: g.current,
        nextStep: g.nextStep,
        status: g.status,
        execution: g.execution,
        updatedAt: g.updatedAt,
        updates: g.updates.slice(0, 3),
      })),
    };
  if (!chief.canDelegate)
    throw new ApiError(403, 'Enable delegation in agent settings to create employees or assign work.');
  // Legacy clients still send an exact quote. New clients attach the actual
  // input item, so wording differences cannot change authorization or retries.
  const { userRequest, ...work } = d.args as typeof d.args & { userRequest?: string };
  const fingerprint = hash(JSON.stringify(d.sourceTurnId
    ? { name: d.name, args: work, sourceTurnId: d.sourceTurnId }
    : { name: d.name, args: d.args }));
  const callKey = `briefing.action.${b.id}.${d.callId}`;
  const previous = store.setting(callKey);
  if (previous) {
    if (previous.fingerprint !== fingerprint)
      throw new ApiError(409, 'This action ID already belongs to another request.');
    return previous.result;
  }
  if (b.mode !== 'chief' || b.phase === 'complete')
    throw new ApiError(409, 'This conversation has ended.');
  const human = [...b.turns].reverse().find((t) => t.speaker === 'You');
  if (d.sourceTurnId && (!human || human.id !== d.sourceTurnId || !human.text.trim()))
    throw new ApiError(409, 'This action must reference the latest saved human turn in this conversation.');
  if (!d.sourceTurnId && (!human || !userRequest || !normalize(human.text).includes(normalize(userRequest))))
    throw new ApiError(
      409,
      'The spoken request could not be linked to this action. Resume voice to use the saved conversation.',
    );
  if (!human) throw new ApiError(409, 'A saved human turn is required.');
  const operation = `briefing.action.request.${hash(b.id + human.id + fingerprint)}`;
  const existing = store.setting(operation);
  if (existing) {
    store.set(callKey, { fingerprint, result: existing });
    return existing;
  }
  if (d.name === 'set_plan' || d.name === 'remove_goal') {
    const result =
      d.name === 'set_plan'
        ? executePlan(store, b, chief, goals, visibleGoals, d.args.goals)
        : removePlannedGoal(store, b, chief, goals, d.args.goalId);
    store.set(callKey, { fingerprint, result });
    store.set(operation, result);
    return result;
  }
  let target;
  if (d.name === 'create_employee') {
    const duplicate = store
      .all('SELECT id FROM employees')
      .map((r) => store.employee(r.id)!)
      .find(
        (e) =>
          store.canUseEmployee(b.ownerId, e.id) && normalize(e.name) === normalize(d.args.name),
      );
    if (duplicate)
      throw new ApiError(
        409,
        `${duplicate.name} already exists. Use the existing employee or ask for a different name.`,
      );
    target = store.createEmployee(
      b.ownerId,
      EmployeeInput.parse({
        name: d.args.name,
        role: d.args.role,
        harness: chief.harness,
        model: chief.model,
        cwd: '',
        permissionMode: 'auto',
        instructions: '',
      }),
    );
  } else if (d.name === 'delegate_goal' && !d.args.employeeId) {
    const existingGoal = d.args.goalId
      ? visibleGoals().find((g) => g.id === d.args.goalId)
      : undefined;
    if (d.args.goalId && !existingGoal)
      throw new ApiError(403, 'This goal is not available in the Chief of Staff conversation.');
    target = staffGoal(
      store,
      b.ownerId,
      d.args.title,
      existingGoal?.leadAgentId || undefined,
      d.args.goalId,
    );
  } else {
    target = store.employee(d.args.employeeId);
    if (!target || !store.canUseEmployee(b.ownerId, target.id))
      throw new ApiError(403, 'This employee is unavailable.');
    if (target.id === chief.id) throw new ApiError(400, 'Choose another employee for a handoff.');
  }
  store.authorize(b.ownerId, target.dmId);
  store.authorizeEmployee(target.id, target.dmId);
  let messageId: string | undefined;
  const task = d.name === 'delegate_goal' ? '' : d.args.task;
  const note =
    d.name === 'delegate_goal'
      ? `I assigned ${target.name} the goal: ${d.args.title}. ${d.args.start ? 'They will work towards it and check in when needed.' : 'It is saved for later.'}`
      : d.name === 'create_employee'
        ? `I created ${target.name} as ${target.role}${task ? ` and sent them this task: ${task}` : '.'}`
        : `I asked ${target.name} to ${task}`;
  const receipt = store.addMessage(chief.dmId, chief.id, chief.name, 'agent', note);
  let goalId: string | undefined;
  let goalState: string | undefined;
  if (d.name === 'delegate_goal') {
    const args = d.args;
    // The schema defaults agreed work to starting now. Preserve an explicit
    // deferral; interpreting conversational consent belongs to the voice turn.
    const start = args.start;
    let goal;
    if (args.goalId) {
      const existingGoal = visibleGoals().find((g) => g.id === args.goalId);
      if (!existingGoal)
        throw new ApiError(403, 'This goal is not available in the Chief of Staff conversation.');
      if (existingGoal.status === 'complete')
        throw new ApiError(409, 'This goal is complete. Create a new goal for new work.');
      goal = goals.change(args.goalId, b.ownerId, {
        version: args.version,
        leadAgentId: target.id,
        title: args.title,
        success: args.success,
        nextStep: args.nextStep,
        ...(start ? { status: 'active' } : {}),
      });
    } else {
      if (
        visibleGoals().some(
          (g) => g.status !== 'complete' && normalize(g.title) === normalize(args.title),
        )
      )
        throw new ApiError(
          409,
          'This goal already exists. Read its current version and assign that goal instead.',
        );
      goal = goals.create(b.ownerId, {
        conversationId: chief.dmId,
        sourceMessageId: receipt.id,
        leadAgentId: target.id,
        title: args.title,
        success: args.success,
        nextStep: args.nextStep,
        start,
      });
    }
    goalId = goal.id;
    goalState = goal.execution.state;
    // Ownership can change without pausing a running goal. Report its actual state.
    const accurateNote = `I assigned ${target.name} the goal: ${goal.title}. ${goalState === 'saved' ? 'It is saved for later.' : goalState === 'paused' ? 'It remains paused.' : 'They will work towards it and check in when needed.'}`;
    store.run('UPDATE messages SET text=? WHERE id=?', accurateNote, receipt.id);
    store.emit('message.updated', chief.dmId, { id: receipt.id, text: accurateNote });
  }
  if (task) {
    const message = store.addMessage(target.dmId, chief.id, chief.name, 'agent', task);
    messageId = message.id;
    store.set(
      'message.context.' + message.id,
      'The workspace owner explicitly requested this task during a voice conversation with the Chief of Staff. Continue within existing access and approval requirements. Return only the task result, without unrelated private conversation history.',
    );
    store.set('delegation.parent.' + message.id, { messageId: receipt.id, employeeId: chief.id });
    store.set('delegation.lineage.' + message.id, [chief.id, target.id]);
    store.set('delegation.purpose.' + message.id, 'execute');
    store.run(
      'INSERT INTO outbox VALUES(?,?,?,?,?,?)',
      uid(),
      message.id,
      target.id,
      b.ownerId,
      'pending',
      now(),
    );
  }
  if (!b.participants.some((p) => p.id === target.id))
    b.participants.push({
      id: target.id,
      name: target.name,
      role: target.role,
      voice: 'marin',
      state: 'ready',
    });
  const result = {
    status: goalState || (task ? 'queued' : 'created'),
    goalId,
    employeeId: target.id,
    name: target.name,
    conversationId: target.dmId,
    messageId,
    receiptMessageId: receipt.id,
    summary: store.one('SELECT text FROM messages WHERE id=?', receipt.id).text as string,
  };
  b.executedActions = [...(b.executedActions || []), {
    ...result,
      title: d.name === 'delegate_goal' ? d.args.title : undefined,
    task: d.name === 'delegate_goal' ? d.args.nextStep : task,
  }];
  // A live handoff supersedes a pending proposal for that same exact task.
  const committed = d.name === 'delegate_goal' ? [d.args.title, d.args.nextStep] : [task];
  b.actions = b.actions.filter(
    (a) => a.employeeId !== target.id || !committed.some((text) => normalize(a.text) === normalize(text)),
  );
  store.set(callKey, { fingerprint, result });
  store.set(operation, result);
  return result;
}

type PlanItem = {
  title: string;
  success: string;
  nextStep: string;
  after: string;
  employeeId: string;
};
const waiting = (state: string) => ['sequenced', 'saved', 'paused'].includes(state);
const stateLabel = (state: string) =>
  state === 'sequenced'
    ? 'up next'
    : state === 'saved'
      ? 'saved'
      : state === 'paused'
        ? 'paused'
        : 'starting now';

/**
 * Turns everything the human asked for into goals in one step. New goals start
 * now or wait for the goal they follow; existing unfinished goals are reused,
 * and a paused or saved goal named in the plan is put back in line. Capacity is
 * the workspace's job: staffGoal adds a lead whenever everyone is busy.
 */
function executePlan(
  store: Store,
  b: Briefing,
  chief: ReturnType<typeof chiefFor>,
  goals: Goals,
  visibleGoals: () => ReturnType<Goals['list']>,
  items: PlanItem[],
) {
  const titles = items.map((item) => normalize(item.title));
  if (new Set(titles).size !== titles.length)
    throw new ApiError(400, 'Each goal in a plan needs a distinct title.');
  const receipt = store.addMessage(chief.dmId, chief.id, chief.name, 'agent', 'Setting the plan…');
  const placed: { id: string; title: string }[] = [];
  const resolveAfter = (after: string, index: number) => {
    const wanted = after.trim();
    if (!wanted) return undefined;
    if (/^\d+$/.test(wanted)) {
      const position = Number(wanted) - 1;
      if (position >= 0 && position < index) return placed[position].id;
    }
    const key = normalize(wanted);
    const earlier = placed.find((p) => p.id === wanted || normalize(p.title) === key);
    if (earlier) return earlier.id;
    const known = visibleGoals().find(
      (g) => g.status !== 'complete' && (g.id === wanted || normalize(g.title) === key),
    );
    if (known) return known.id;
    throw new ApiError(
      400,
      `“${wanted}” is not an earlier goal in this plan or an existing goal. Use an earlier title, or leave it empty to start now.`,
    );
  };
  const results = items.map((item, index) => {
    const afterId = resolveAfter(item.after, index);
    const existing = visibleGoals().find(
      (g) => g.status !== 'complete' && normalize(g.title) === normalize(item.title),
    );
    let goal;
    if (existing) {
      // Reuse rather than duplicate. Naming a saved or paused goal in a plan puts it in line.
      if (existing.status === 'paused' || existing.execution.state === 'saved') {
        if (afterId) goals.runner.sequence(existing.id, afterId);
        goal = goals.change(existing.id, b.ownerId, {
          version: existing.version,
          status: 'active',
        });
      } else goal = existing;
    } else {
      let leadAgentId: string;
      if (item.employeeId) {
        const chosen = store.employee(item.employeeId);
        if (!chosen || !store.canUseEmployee(b.ownerId, chosen.id))
          throw new ApiError(403, 'This employee is unavailable.');
        leadAgentId = chosen.id;
      } else leadAgentId = staffGoal(store, b.ownerId, item.title).id;
      goal = goals.create(b.ownerId, {
        conversationId: chief.dmId,
        sourceMessageId: receipt.id,
        leadAgentId,
        title: item.title,
        success: item.success,
        nextStep: item.nextStep,
        start: true,
        startsAfter: afterId,
      });
    }
    placed.push({ id: goal.id, title: goal.title });
    const lead = store.employee(goal.leadAgentId!)!;
    store.authorize(b.ownerId, lead.dmId);
    store.authorizeEmployee(lead.id, lead.dmId);
    if (!b.participants.some((p) => p.id === lead.id))
      b.participants.push({
        id: lead.id,
        name: lead.name,
        role: lead.role,
        voice: 'marin',
        state: 'ready',
      });
    const execution = goal.execution as { state: string; startsAfter?: { title: string } | null };
    return {
      goalId: goal.id,
      title: goal.title,
      employeeId: lead.id,
      name: lead.name,
      conversationId: lead.dmId,
      state: execution.state,
      startsAfter: execution.startsAfter?.title,
      reused: !!existing,
      nextStep: goal.nextStep as string,
    };
  });
  const describe = (r: (typeof results)[number]) =>
    `${r.name} · ${stateLabel(r.state)}${r.startsAfter ? ` after “${r.startsAfter}”` : ''}`;
  const starting = results.filter((r) => !waiting(r.state));
  const later = results.filter((r) => waiting(r.state));
  // One short line the Chief can say aloud; the screen shows the full checklist.
  const recap = [
    `${results.length} ${results.length === 1 ? 'goal' : 'goals'} set.`,
    starting.length
      ? `Starting now: ${starting.map((r) => `${r.title} with ${r.name}`).join('; ')}.`
      : '',
    later.length ? `Then, in order: ${later.map((r) => r.title).join(', then ')}.` : '',
  ]
    .filter(Boolean)
    .join(' ');
  const text = `I set the plan from our conversation:\n${results
    .map((r, i) => `${i + 1}. ${r.title} — ${describe(r)}.`)
    .join('\n')}`;
  store.run('UPDATE messages SET text=? WHERE id=?', text, receipt.id);
  store.emit('message.updated', chief.dmId, { id: receipt.id, text });
  b.executedActions = [
    ...(b.executedActions || []),
    ...results.map((r) => ({
      status: r.state,
      title: r.title,
      goalId: r.goalId,
      employeeId: r.employeeId,
      name: r.name,
      conversationId: r.conversationId,
      receiptMessageId: receipt.id,
      summary: describe(r),
      task: r.nextStep,
    })),
  ];
  const committed = new Set(results.flatMap((r) => [normalize(r.title), normalize(r.nextStep)]));
  b.actions = b.actions.filter((a) => !committed.has(normalize(a.text)));
  return {
    status: 'planned',
    receiptMessageId: receipt.id,
    recap,
    goals: results.map(({ nextStep: _n, conversationId: _c, ...r }) => r),
  };
}

/** Undo a goal set during this conversation before it has done any work. */
export function removePlannedGoal(
  store: Store,
  b: Briefing,
  chief: ReturnType<typeof chiefFor>,
  goals: Goals,
  goalId: string,
) {
  const entry = (b.executedActions || []).find(
    (a) => a.goalId === goalId && a.status !== 'removed',
  );
  if (!entry)
    throw new ApiError(
      403,
      'Only goals set during this conversation can be removed here. Pause other goals on the Goals page.',
    );
  goals.remove(goalId, b.ownerId);
  const text = `I removed the goal: ${entry.title}.`;
  const receipt = store.addMessage(chief.dmId, chief.id, chief.name, 'agent', text);
  b.executedActions = (b.executedActions || []).map((a) =>
    a.goalId === goalId ? { ...a, status: 'removed', summary: 'Removed' } : a,
  );
  return { status: 'removed', goalId, title: entry.title, receiptMessageId: receipt.id };
}
