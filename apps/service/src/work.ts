import { z } from 'zod';
import { ApiError, Store, now, uid } from './store.js';

const line = z.string().trim().min(1).max(240);
const startInput = z.object({
  title: line,
  doneWhen: z.array(line).min(1).max(6),
  proofPlan: z.array(line).min(1).max(6),
  goalId: z.string().uuid().optional(),
});
const changeInput = z.object({
  status: z.enum(['working', 'waiting', 'checking', 'complete']).optional(),
  summary: z.string().trim().max(2000).optional(),
  checks: z
    .array(
      z.object({
        label: line,
        result: z.enum(['passed', 'failed', 'pending']),
        detail: z.string().trim().max(1000).optional(),
      }),
    )
    .max(12)
    .optional(),
});

export class Work {
  constructor(private store: Store) {}
  private owned(id: string, ownerId: string) {
    const row = this.store.one('SELECT * FROM work_items WHERE id=? AND owner_id=?', id, ownerId);
    if (!row) throw new ApiError(404, 'Work unavailable');
    this.store.authorize(ownerId, row.conversation_id, true);
    return row;
  }
  private shape(row: any) {
    const run = this.store.one('SELECT state FROM runs WHERE id=?', row.run_id);
    return {
      id: row.id,
      conversationId: row.conversation_id,
      requestMessageId: row.request_message_id,
      goalId: row.goal_id,
      title: row.title,
      doneWhen: JSON.parse(row.done_when),
      proofPlan: JSON.parse(row.proof_plan),
      checks: JSON.parse(row.checks),
      status: row.status,
      // An interrupted run must never look like live progress forever.
      effectiveStatus:
        row.status === 'working' &&
        run &&
        !['accepted', 'dispatching', 'running', 'cancelling'].includes(run.state)
          ? 'waiting'
          : row.status,
      summary: row.summary,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
  list(ownerId: string, conversationId: string) {
    this.store.authorize(ownerId, conversationId, true);
    return this.store
      .all(
        'SELECT * FROM work_items WHERE owner_id=? AND conversation_id=? ORDER BY updated_at DESC LIMIT 20',
        ownerId,
        conversationId,
      )
      .map((row) => this.shape(row));
  }
  get(id: string, ownerId: string) {
    return this.shape(this.owned(id, ownerId));
  }
  start(run: any, input: unknown) {
    const data = startInput.parse(input);
    this.store.authorize(run.user_id, run.conversation_id);
    if (data.goalId) {
      const goal = this.store.one(
        'SELECT id,conversation_id,lead_agent_id FROM goals WHERE id=? AND owner_id=?',
        data.goalId,
        run.user_id,
      );
      const conversation = this.store.one(
        'SELECT kind,employee_id FROM conversations WHERE id=?',
        run.conversation_id,
      );
      const leadCanWork = goal?.lead_agent_id
        ? goal.lead_agent_id === run.employee_id
        : goal?.conversation_id === run.conversation_id;
      const inGoalRoom =
        conversation?.kind === 'channel' && goal?.conversation_id === run.conversation_id;
      const inLeadDm = conversation?.kind === 'dm' && conversation.employee_id === run.employee_id;
      if (!goal || !leadCanWork || (!inGoalRoom && !inLeadDm))
        throw new ApiError(400, 'This goal is unavailable to this agent here.');
    }
    const existing = this.store.one(
      'SELECT id FROM work_items WHERE owner_id=? AND request_message_id=?',
      run.user_id,
      run.message_id,
    );
    if (existing) return this.get(existing.id, run.user_id);
    const id = uid(),
      time = now();
    this.store.run(
      'INSERT INTO work_items VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      id,
      run.user_id,
      run.conversation_id,
      run.message_id,
      run.id,
      data.goalId || null,
      data.title,
      JSON.stringify(data.doneWhen),
      JSON.stringify(data.proofPlan),
      '[]',
      'working',
      '',
      time,
      time,
    );
    this.store.emit('work.changed', run.conversation_id, { id }, run.user_id);
    return this.get(id, run.user_id);
  }
  change(id: string, ownerId: string, conversationId: string, input: unknown) {
    const data = changeInput.parse(input),
      row = this.owned(id, ownerId);
    if (row.conversation_id !== conversationId)
      throw new ApiError(403, 'Work belongs to another conversation.');
    const checks = data.checks ?? JSON.parse(row.checks);
    if (
      (data.status ?? row.status) === 'complete' &&
      !checks.some((check: any) => check.result === 'passed')
    )
      throw new ApiError(400, 'Record at least one passing check before marking work complete.');
    this.store.run(
      'UPDATE work_items SET status=?,summary=?,checks=?,updated_at=? WHERE id=?',
      data.status ?? row.status,
      data.summary ?? row.summary,
      JSON.stringify(checks),
      now(),
      id,
    );
    this.store.emit('work.changed', row.conversation_id, { id }, ownerId);
    return this.get(id, ownerId);
  }
}

export function registerWorkRoutes(app: any, work: Work) {
  app.get('/api/work', async (req: any) => {
    const { conversationId } = z.object({ conversationId: z.string().uuid() }).parse(req.query);
    return work.list(req.user.id, conversationId);
  });
  app.get('/api/work/:id', async (req: any) => work.get(req.params.id, req.user.id));
}
