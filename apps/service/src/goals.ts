import { z } from 'zod';
import { ApiError, Store, now, uid } from './store.js';

const short = z.string().trim().min(1).max(240);
const detail = z.string().trim().max(2000);
const goalInput = z.object({
  conversationId: z.string().uuid(),
  title: short,
  success: short,
  current: detail.optional(),
  nextStep: detail.optional(),
  sourceMessageId: z.string().uuid().optional(),
  leadAgentId: z.string().uuid().optional(),
});
const goalChange = z.object({
  title: short.optional(),
  success: short.optional(),
  current: detail.optional(),
  nextStep: detail.optional(),
  status: z.enum(['active', 'paused', 'complete']).optional(),
  leadAgentId: z.string().uuid().optional(),
  version: z.number().int().positive(),
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
  constructor(private store: Store) {}

  private lead(ownerId: string, agentId: string) {
    const agent = this.store.employee(agentId);
    if (!agent || !this.store.canUseEmployee(ownerId, agentId) || !agent.dmId)
      throw new ApiError(400, 'Choose an active agent you can talk to.');
    this.store.authorize(ownerId, agent.dmId);
    return agent;
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
    this.store.authorize(ownerId, row.conversation_id, true);
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
    if (conversationId) this.store.authorize(ownerId, conversationId, true);
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
    this.store.authorize(ownerId, conversationId, true);
    const conversation = this.store.one(
      'SELECT kind FROM conversations WHERE id=?',
      conversationId,
    );
    return this.store
      .all(
        `SELECT * FROM goals WHERE owner_id=? AND
         ${
           conversation?.kind === 'dm'
             ? '(lead_agent_id=? OR (lead_agent_id IS NULL AND conversation_id=?))'
             : 'conversation_id=? AND (lead_agent_id=? OR lead_agent_id IS NULL)'
         }
         ORDER BY updated_at DESC`,
        ownerId,
        ...(conversation?.kind === 'dm' ? [agentId, conversationId] : [conversationId, agentId]),
      )
      .map((row) => this.shape(row));
  }

  get(id: string, ownerId: string) {
    return this.shape(this.owned(id, ownerId));
  }

  create(ownerId: string, input: unknown) {
    const data = goalInput.parse(input);
    this.store.authorize(ownerId, data.conversationId);
    const conversation = this.store.one(
      'SELECT kind,employee_id FROM conversations WHERE id=?',
      data.conversationId,
    );
    const leadAgentId =
      data.leadAgentId || (conversation?.kind === 'dm' ? conversation.employee_id : null);
    if (leadAgentId) this.lead(ownerId, leadAgentId);
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
    this.store.run(
      'INSERT INTO goals(id,owner_id,conversation_id,title,success,current,next_step,status,source_message_id,version,created_at,updated_at,lead_agent_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
      id,
      ownerId,
      data.conversationId,
      data.title,
      data.success,
      data.current || '',
      data.nextStep || '',
      'active',
      data.sourceMessageId || null,
      1,
      time,
      time,
      leadAgentId,
    );
    this.changed({ id, conversation_id: data.conversationId, lead_agent_id: leadAgentId }, ownerId);
    return this.get(id, ownerId);
  }

  change(id: string, ownerId: string, input: unknown) {
    const data = goalChange.parse(input),
      row = this.owned(id, ownerId);
    if (data.leadAgentId) this.lead(ownerId, data.leadAgentId);
    const changed = this.store.run(
      'UPDATE goals SET title=?,success=?,current=?,next_step=?,status=?,lead_agent_id=?,version=version+1,updated_at=? WHERE id=? AND version=?',
      data.title ?? row.title,
      data.success ?? row.success,
      data.current ?? row.current,
      data.nextStep ?? row.next_step,
      data.status ?? row.status,
      data.leadAgentId ?? row.lead_agent_id,
      now(),
      id,
      data.version,
    );
    if (!changed.changes) throw new ApiError(409, 'This goal changed. Refresh it and try again.');
    this.changed(
      { ...row, lead_agent_id: data.leadAgentId ?? row.lead_agent_id },
      ownerId,
      row.lead_agent_id,
    );
    return this.get(id, ownerId);
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
  app.post('/api/goals/:id/steps', async (req: any) =>
    goals.addStep(req.params.id, req.user.id, req.body),
  );
  app.patch('/api/goals/:id/steps/:stepId', async (req: any) =>
    goals.changeStep(req.params.id, req.params.stepId, req.user.id, req.body),
  );
  app.post('/api/goals/:id/updates', async (req: any) =>
    goals.addUpdate(req.params.id, req.user.id, req.user.id, req.body),
  );
}
