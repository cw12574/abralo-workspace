import { z } from 'zod';
import { ApiError, Store, now, uid } from './store.js';
import { GoalRunner, goalPolicy } from './goal-runner.js';
import { assignedGoal, staffGoal } from './goal-staffing.js';

const short = z.string().trim().min(1).max(240);
const detail = z.string().trim().max(2000);
const goalInput = z.object({
  conversationId: z.string().uuid().optional(),
  title: short,
  success: short.optional(),
  current: detail.optional(),
  nextStep: detail.optional(),
  sourceMessageId: z.string().uuid().optional(),
  leadAgentId: z.string().uuid().optional(),
  start: z.boolean().default(false),
  /** Start automatically once this goal is complete. */
  startsAfter: z.string().uuid().optional(),
  ...goalPolicy,
});
const goalChange = z.object({
  title: short.optional(),
  success: short.optional(),
  current: detail.optional(),
  nextStep: detail.optional(),
  status: z.enum(['active', 'paused', 'complete']).optional(),
  leadAgentId: z.string().uuid().optional(),
  version: z.number().int().positive(),
  ...goalPolicy,
});
const stepInput = z.object({ title: short, doneWhen: detail.optional() });
const stepChange = z.object({
  title: short.optional(),
  doneWhen: detail.optional(),
  status: z.enum(['todo', 'doing', 'blocked', 'done']).optional(),
  evidence: detail.optional(),
});
const updateInput = z.object({
  summary: detail.pipe(z.string().min(1)),
  evidence: detail.optional(),
});

export class Goals {
  runner: GoalRunner;
  constructor(
    private store: Store,
    runner?: GoalRunner,
  ) {
    this.runner = runner || new GoalRunner(store);
  }

  private lead(ownerId: string, agentId: string, goalId = '', reserve = true) {
    const agent = this.store.employee(agentId);
    if (!agent || !this.store.canUseEmployee(ownerId, agentId) || !agent.dmId)
      throw new ApiError(400, 'Choose an active agent you can talk to.');
    this.store.authorize(ownerId, agent.dmId);
    if (reserve && assignedGoal(this.store, agentId, goalId))
      throw new ApiError(
        409,
        `${agent.name} already leads another goal. Choose an available employee or let the Chief of Staff assign one.`,
      );
    return agent;
  }

  reconcileAssignments() {
    this.store.db.transaction(() => {
      const reserved = new Set<string>();
      for (const row of this.store.all(
        "SELECT * FROM goals ORDER BY CASE status WHEN 'complete' THEN 1 ELSE 0 END,created_at,id",
      )) {
        const employee = this.store.employee(row.lead_agent_id);
        const valid =
          employee &&
          (row.status === 'complete' || this.store.canUseEmployee(row.owner_id, employee.id));
        if (valid && (row.status === 'complete' || !reserved.has(employee.id))) {
          if (row.status !== 'complete') reserved.add(employee.id);
          continue;
        }
        const policy = this.runner.policy(row.id);
        const replacement = staffGoal(this.store, row.owner_id, row.title, undefined, row.id);
        if (policy) this.runner.stop(row.id, 'paused', 'Updating the project lead.');
        this.store.run(
          'UPDATE goals SET lead_agent_id=?,version=version+1,updated_at=? WHERE id=?',
          replacement.id,
          now(),
          row.id,
        );
        if (policy)
          this.runner.setState(
            row.id,
            policy.state === 'working' ? 'queued' : policy.state,
            'Assigned a dedicated project lead.',
            policy.next_at,
            policy.question,
          );
        reserved.add(replacement.id);
        this.changed({ ...row, lead_agent_id: replacement.id }, row.owner_id, row.lead_agent_id);
      }
      // Keep the workspace-v1 schema readable by the previous installed build.
      // Goal mutations reserve capacity inside the same synchronous transaction;
      // startup reconciliation handles legacy rows without SQL schema migration.
    })();
  }

  private changed(row: any, ownerId: string, previousLeadId?: string | null) {
    const conversations = new Set([row.conversation_id]);
    for (const id of [previousLeadId, row.lead_agent_id]) {
      if (!id) continue;
      const dmId = this.store.employee(id)?.dmId;
      if (dmId) conversations.add(dmId);
    }
    for (const conversationId of conversations)
      this.store.emit('goal.changed', conversationId, { id: row.id }, ownerId);
  }

  private owned(id: string, ownerId: string) {
    const row = this.store.one('SELECT * FROM goals WHERE id=? AND owner_id=?', id, ownerId);
    if (!row) throw new ApiError(404, 'Goal unavailable');
    this.store.authorize(ownerId, row.conversation_id);
    return row;
  }

  private shape(row: any) {
    return {
      id: row.id,
      conversationId: row.conversation_id,
      leadAgentId: row.lead_agent_id || null,
      leadAgentName: row.lead_agent_id
        ? this.store.employee(row.lead_agent_id)?.name || null
        : null,
      leadAgentActive: row.lead_agent_id
        ? !!this.store.employee(row.lead_agent_id) &&
          !this.store.employee(row.lead_agent_id)?.deactivatedAt
        : false,
      title: row.title,
      success: row.success,
      current: row.current,
      nextStep: row.next_step,
      status: row.status,
      sourceMessageId: row.source_message_id,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      execution: this.runner.view(row),
      knowledge: this.store.setting('goal.state.' + row.id, {}),
      steps: this.store
        .all('SELECT * FROM goal_steps WHERE goal_id=? ORDER BY position,id', row.id)
        .map((s) => ({
          id: s.id,
          title: s.title,
          doneWhen: s.done_when,
          status: s.status,
          evidence: s.evidence,
          updatedAt: s.updated_at,
        })),
      updates: this.store
        .all('SELECT * FROM goal_updates WHERE goal_id=? ORDER BY created_at DESC LIMIT 30', row.id)
        .map((u) => ({
          id: u.id,
          authorId: u.author_id,
          summary: u.summary,
          evidence: u.evidence,
          createdAt: u.created_at,
        })),
    };
  }

  list(ownerId: string, conversationId?: string) {
    if (conversationId) this.store.authorize(ownerId, conversationId);
    const conversation = conversationId
      ? this.store.one('SELECT kind,employee_id FROM conversations WHERE id=?', conversationId)
      : null;
    return this.store
      .all(
        'SELECT * FROM goals WHERE owner_id=?' +
          (conversationId
            ? conversation?.kind === 'dm'
              ? ' AND (lead_agent_id=? OR (lead_agent_id IS NULL AND conversation_id=?))'
              : ' AND conversation_id=?'
            : '') +
          " ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END,updated_at DESC",
        ...(conversationId
          ? conversation?.kind === 'dm'
            ? [ownerId, conversation.employee_id, conversationId]
            : [ownerId, conversationId]
          : [ownerId]),
      )
      .map((row) => this.shape(row));
  }

  listForAgent(ownerId: string, agentId: string, conversationId: string) {
    this.store.authorize(ownerId, conversationId);
    const conversation = this.store.one(
      'SELECT kind,employee_id FROM conversations WHERE id=?',
      conversationId,
    );
    if (conversation?.kind !== 'dm' || conversation.employee_id !== agentId) return [];
    return this.store
      .all(
        'SELECT * FROM goals WHERE owner_id=? AND (lead_agent_id=? OR (lead_agent_id IS NULL AND conversation_id=?)) ORDER BY updated_at DESC',
        ownerId,
        agentId,
        conversationId,
      )
      .map((row) => this.shape(row));
  }

  get(id: string, ownerId: string) {
    return this.shape(this.owned(id, ownerId));
  }

  create(ownerId: string, input: unknown) {
    const data = goalInput.parse(input);
    if (data.conversationId) this.store.authorize(ownerId, data.conversationId);
    if (data.sourceMessageId && !data.conversationId)
      throw new ApiError(400, 'A starting message needs its conversation.');
    const conversation = this.store.one(
      'SELECT kind,employee_id FROM conversations WHERE id=?',
      data.conversationId || '',
    );
    if (data.sourceMessageId) {
      const source = this.store.one(
        'SELECT 1 FROM messages WHERE id=? AND conversation_id=? AND deleted_at IS NULL',
        data.sourceMessageId,
        data.conversationId,
      );
      if (!source)
        throw new ApiError(400, 'The starting message is unavailable in this conversation.');
    }
    const id = uid(),
      time = now();
    this.store.db.transaction(() => {
      const lead = data.leadAgentId
        ? this.lead(ownerId, data.leadAgentId)
        : staffGoal(this.store, ownerId, data.title, conversation?.employee_id);
      const conversationId = data.conversationId || lead.dmId;
      this.store.run(
        'INSERT INTO goals(id,owner_id,conversation_id,title,success,current,next_step,status,source_message_id,version,created_at,updated_at,lead_agent_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
        id,
        ownerId,
        conversationId,
        data.title,
        data.success || data.title,
        data.current || '',
        data.nextStep || '',
        'active',
        data.sourceMessageId || null,
        1,
        time,
        time,
        lead.id,
      );
      this.runner.configure(id, data);
      if (data.startsAfter) {
        this.owned(data.startsAfter, ownerId);
        this.runner.sequence(id, data.startsAfter);
      }
      if (data.start) this.runner.start(id);
      this.changed({ id, conversation_id: conversationId, lead_agent_id: lead.id }, ownerId);
    })();
    return this.get(id, ownerId);
  }

  change(id: string, ownerId: string, input: unknown) {
    const data = goalChange.parse(input),
      row = this.owned(id, ownerId);
    const leadId = data.leadAgentId ?? row.lead_agent_id;
    const policyChanged = Object.keys(goalPolicy).some((key) => key in data);
    const restartForScope =
      data.autonomy &&
      data.autonomy !== this.runner.policy(id)?.autonomy &&
      row.status === 'active' &&
      !['saved', 'paused', 'complete', 'needs_input'].includes(
        this.runner.policy(id)?.state || 'saved',
      );
    this.store.db.transaction(() => {
      this.lead(
        ownerId,
        leadId,
        id,
        data.status === 'complete' || (data.status ?? row.status) !== 'complete',
      );
      const changed = this.store.run(
        'UPDATE goals SET title=?,success=?,current=?,next_step=?,status=?,lead_agent_id=?,version=version+1,updated_at=? WHERE id=? AND version=?',
        data.title ?? row.title,
        data.success ?? row.success,
        data.current ?? row.current,
        data.nextStep ?? row.next_step,
        data.status === 'complete' ? 'active' : (data.status ?? row.status),
        data.leadAgentId ?? row.lead_agent_id,
        now(),
        id,
        data.version,
      );
      if (!changed.changes) throw new ApiError(409, 'This goal changed. Refresh it and try again.');
      if (policyChanged) {
        this.runner.configure(id, data);
        const execution = this.runner.policy(id);
        if (
          row.status === 'active' &&
          execution.state === 'scheduled' &&
          execution.reason.includes('allowance')
        )
          this.runner.setState(
            id,
            'queued',
            'The work allowance changed. Rechecking the next step.',
            now(),
          );
      }
      if (data.status === 'complete') {
        this.runner.stop(id, 'paused', 'Preparing completion review.');
        const latestCycle = this.store.one(
          'SELECT message_id FROM goal_cycles WHERE goal_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1',
          id,
        );
        this.runner.requestReview(
          id,
          {
            summary: data.current || row.current || 'Completion requested by the user.',
            evidence: row.current,
            nextStep: row.next_step,
          },
          latestCycle?.message_id,
        );
      } else if (data.status === 'paused')
        this.runner.stop(id, data.status, 'Paused by request. No new work will start.');
      // Starting a goal that is waiting its turn means the human chose not to wait.
      else if (data.status === 'active')
        this.runner.start(id, this.runner.policy(id)?.state === 'sequenced');
      else if (restartForScope) {
        this.runner.stop(id, 'paused', 'Applying the updated authority.');
        this.runner.start(id);
      } else if (
        data.leadAgentId &&
        data.leadAgentId !== row.lead_agent_id &&
        row.status === 'active' &&
        this.runner.policy(id) &&
        this.runner.policy(id).state !== 'saved'
      ) {
        this.runner.stop(id, 'paused', 'Handing over to the new lead.');
        this.runner.start(id);
      }
    })();
    this.changed(
      { ...row, lead_agent_id: data.leadAgentId ?? row.lead_agent_id },
      ownerId,
      row.lead_agent_id,
    );
    return this.get(id, ownerId);
  }

  /**
   * Remove a goal. Automatic undo only removes goals that have not done any work;
   * the owner's explicit delete first stops any live work, then removes the goal
   * and its goal history. Conversations and work cards stay. Followers inherit
   * its place in line.
   */
  remove(id: string, ownerId: string, options: { stopWork?: boolean } = {}) {
    const row = this.owned(id, ownerId);
    if (this.store.one('SELECT 1 FROM goal_cycles WHERE goal_id=? LIMIT 1', id)) {
      if (!options.stopWork)
        throw new ApiError(409, 'This goal has already started work. Pause it instead.');
      // Cancels queued and running sessions so nothing continues for a deleted goal.
      this.runner.stop(id, 'paused', 'Deleting this goal.');
    }
    this.store.db.transaction(() => {
      const followers = this.runner.unlink(id);
      this.store.run('UPDATE work_items SET goal_id=NULL WHERE goal_id=?', id);
      for (const table of ['goal_steps', 'goal_updates', 'goal_execution', 'goal_cycles'])
        this.store.run(`DELETE FROM ${table} WHERE goal_id=?`, id);
      this.store.run(
        'DELETE FROM settings WHERE key IN (?,?)',
        'goal.state.' + id,
        'goal.review.last.' + id,
      );
      this.store.run('DELETE FROM goals WHERE id=?', id);
      this.runner.releaseFollowers(followers);
    })();
    this.changed(row, ownerId);
    return { removed: true, id };
  }

  addStep(id: string, ownerId: string, input: unknown) {
    const data = stepInput.parse(input),
      goal = this.owned(id, ownerId);
    const position = this.store.one(
      'SELECT COALESCE(MAX(position),0)+1 AS n FROM goal_steps WHERE goal_id=?',
      id,
    ).n;
    const stepId = uid();
    this.store.run(
      'INSERT INTO goal_steps VALUES(?,?,?,?,?,?,?,?)',
      stepId,
      id,
      data.title,
      data.doneWhen || '',
      'todo',
      '',
      position,
      now(),
    );
    this.store.run('UPDATE goals SET updated_at=? WHERE id=?', now(), id);
    this.store.emit('goal.changed', goal.conversation_id, { id }, ownerId);
    return this.get(id, ownerId);
  }

  changeStep(id: string, stepId: string, ownerId: string, input: unknown) {
    const data = stepChange.parse(input),
      goal = this.owned(id, ownerId);
    const step = this.store.one('SELECT * FROM goal_steps WHERE id=? AND goal_id=?', stepId, id);
    if (!step) throw new ApiError(404, 'Step unavailable');
    if ((data.status ?? step.status) === 'done' && !(data.evidence ?? step.evidence).trim())
      throw new ApiError(400, 'Add a brief result or check before marking a step done.');
    this.store.run(
      'UPDATE goal_steps SET title=?,done_when=?,status=?,evidence=?,updated_at=? WHERE id=?',
      data.title ?? step.title,
      data.doneWhen ?? step.done_when,
      data.status ?? step.status,
      data.evidence ?? step.evidence,
      now(),
      stepId,
    );
    this.store.run('UPDATE goals SET updated_at=? WHERE id=?', now(), id);
    this.store.emit('goal.changed', goal.conversation_id, { id }, ownerId);
    return this.get(id, ownerId);
  }

  addUpdate(id: string, ownerId: string, authorId: string, input: unknown) {
    const data = updateInput.parse(input),
      goal = this.owned(id, ownerId);
    this.store.run(
      'INSERT INTO goal_updates VALUES(?,?,?,?,?,?)',
      uid(),
      id,
      authorId,
      data.summary,
      data.evidence || '',
      now(),
    );
    this.store.run('UPDATE goals SET current=?,updated_at=? WHERE id=?', data.summary, now(), id);
    this.store.emit('goal.changed', goal.conversation_id, { id }, ownerId);
    return this.get(id, ownerId);
  }

  reply(id: string, ownerId: string, input: unknown) {
    const { answer } = z.object({ answer: z.string().trim().min(1).max(4000) }).parse(input);
    this.runner.reply(this.owned(id, ownerId), answer);
    return this.get(id, ownerId);
  }
}

export function registerGoalRoutes(app: any, goals: Goals) {
  app.get('/api/goals', async (req: any) =>
    goals.list(
      req.user.id,
      z.object({ conversationId: z.string().uuid().optional() }).parse(req.query).conversationId,
    ),
  );
  app.get('/api/goals/:id', async (req: any) => goals.get(req.params.id, req.user.id));
  app.post('/api/goals', async (req: any) => goals.create(req.user.id, req.body));
  app.patch('/api/goals/:id', async (req: any) =>
    goals.change(req.params.id, req.user.id, req.body),
  );
  app.delete('/api/goals/:id', async (req: any) =>
    goals.remove(req.params.id, req.user.id, { stopWork: true }),
  );
  app.post('/api/goals/:id/steps', async (req: any) =>
    goals.addStep(req.params.id, req.user.id, req.body),
  );
  app.patch('/api/goals/:id/steps/:stepId', async (req: any) =>
    goals.changeStep(req.params.id, req.params.stepId, req.user.id, req.body),
  );
  app.post('/api/goals/:id/updates', async (req: any) =>
    goals.addUpdate(req.params.id, req.user.id, req.user.id, req.body),
  );
  app.post('/api/goals/:id/reply', async (req: any) =>
    goals.reply(req.params.id, req.user.id, req.body),
  );
}
