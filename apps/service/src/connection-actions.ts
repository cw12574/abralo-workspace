import { Store, ApiError, hash, uid, now } from './store.js';
import type { ConnectionBroker } from './connections.js';

// Stable across reordered JSON object keys, but preserves array order.
function canonical(value: any): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonical(value[k]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}

export class ConnectionActions {
  inflight = new Set<Promise<void>>();
  constructor(
    public store: Store,
    public broker: ConnectionBroker,
  ) {
    // A crash after dispatch cannot establish whether the provider committed a write.
    store.run(
      "UPDATE connection_actions SET state='unknown',updated_at=? WHERE state='running'",
      now(),
    );
  }
  get(id: string, ownerId: string, employeeId?: string) {
    const row = this.store.one(
      'SELECT * FROM connection_actions WHERE id=? AND owner_id=?',
      id,
      ownerId,
    );
    if (!row || (employeeId && row.employee_id !== employeeId))
      throw new ApiError(404, 'Action unavailable');
    this.store.authorize(ownerId, row.conversation_id);
    return row;
  }
  receipt(row: any) {
    return {
      actionId: row.id,
      connectionId: row.connection_id,
      status: row.state,
      tool: row.tool,
      result: row.result ? JSON.parse(row.result) : undefined,
      nextStep:
        row.state === 'awaiting_approval'
          ? 'The human sees an approval card for this action in the conversation, so do not mention approval in your reply. Setup is complete. Do not reconnect or resubmit. Continue when the action result arrives.'
          : row.state === 'unknown'
            ? 'The provider outcome is unknown. Inspect provider state using reads before proposing any further write. Do not replay this action.'
            : row.state === 'running'
              ? 'Execution is in progress. Use workspace_connection_action to check this action ID.'
              : 'Use this saved result; do not repeat the action.',
    };
  }
  isDismissed(row: any) {
    return (
      this.store.setting(`connection.action.dismissed.${row.owner_id}.${row.id}`) ===
      `${row.state}:${row.updated_at}`
    );
  }
  dismiss(id: string, ownerId: string, dismissed: boolean) {
    const row = this.get(id, ownerId);
    this.store.set(
      `connection.action.dismissed.${ownerId}.${id}`,
      dismissed ? `${row.state}:${row.updated_at}` : null,
    );
    this.store.emit('connection.action.dismissed', row.conversation_id, { id, dismissed }, ownerId);
    return { actionId: id, dismissed };
  }
  request(run: any, connectionId: string, tool: string, args: any) {
    const s = this.store;
    if (s.setting('run.readOnly.' + run.id, false))
      throw new ApiError(403, 'This task only permits reads.');
    s.authorize(run.user_id, run.conversation_id);
    s.authorizeEmployee(run.employee_id, run.conversation_id);
    const access = this.broker.access(connectionId, run.employee_id, run.user_id, tool);
    const fingerprint = hash(canonical({ connectionId: access.connection.id, tool, args }));
    const existing = s.one(
      'SELECT * FROM connection_actions WHERE owner_id=? AND employee_id=? AND request_id=? AND fingerprint=?',
      run.user_id,
      run.employee_id,
      run.message_id,
      fingerprint,
    );
    if (existing) return this.receipt(existing);
    // A recovered goal uses new messages. Confirmed and uncertain effects remain
    // the same action across all its sessions; a fresh session is not a retry key.
    const cycle = s.one('SELECT goal_id FROM goal_cycles WHERE message_id=?', run.message_id);
    if (cycle) {
      const prior = s.one(
        `SELECT a.* FROM connection_actions a JOIN goal_cycles c ON c.message_id=a.request_id
        WHERE c.goal_id=? AND a.owner_id=? AND a.employee_id=? AND a.fingerprint=?
        AND a.state IN ('succeeded','awaiting_approval','running','unknown') ORDER BY a.created_at DESC LIMIT 1`,
        cycle.goal_id,
        run.user_id,
        run.employee_id,
        fingerprint,
      );
      if (prior) return this.receipt(prior);
    }
    // Also coalesce unresolved writes when the human or a setup continuation starts a new run.
    const pending = s.one(
      "SELECT * FROM connection_actions WHERE owner_id=? AND employee_id=? AND conversation_id=? AND fingerprint=? AND state IN ('awaiting_approval','running','unknown')",
      run.user_id,
      run.employee_id,
      run.conversation_id,
      fingerprint,
    );
    if (pending) return this.receipt(pending);
    const id = uid(),
      time = now();
    s.run(
      'INSERT INTO connection_actions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      id,
      run.user_id,
      run.employee_id,
      run.conversation_id,
      run.message_id,
      run.id,
      access.connection.id,
      fingerprint,
      tool,
      JSON.stringify(args),
      'awaiting_approval',
      null,
      time,
      time,
    );
    this.changed(this.get(id, run.user_id));
    return this.receipt(this.get(id, run.user_id));
  }
  changed(row: any) {
    this.store.emit(
      'connection.action',
      row.conversation_id,
      { id: row.id, state: row.state },
      row.owner_id,
    );
  }
  decide(id: string, ownerId: string, allow: boolean) {
    const s = this.store,
      row = this.get(id, ownerId);
    if (row.state !== 'awaiting_approval') return this.receipt(row);
    if (allow) {
      const goal = s.one(
        'SELECT g.status,c.cancelled FROM goal_cycles c JOIN goals g ON g.id=c.goal_id WHERE c.message_id=?',
        row.request_id,
      );
      if (goal && (goal.status !== 'active' || goal.cancelled))
        throw new ApiError(
          409,
          'This goal was stopped. Resume it and review the prepared action before approving.',
        );
      if (!s.canUseEmployee(ownerId, row.employee_id))
        throw new ApiError(403, 'Employee access was removed.');
      s.authorizeEmployee(row.employee_id, row.conversation_id);
      this.broker.access(row.connection_id, row.employee_id, ownerId, row.tool);
    }
    const changed = s.run(
      "UPDATE connection_actions SET state=?,updated_at=? WHERE id=? AND state='awaiting_approval'",
      allow ? 'running' : 'declined',
      now(),
      id,
    );
    if (!changed.changes) return this.receipt(this.get(id, ownerId));
    this.changed(this.get(id, ownerId));
    const task = (allow ? this.execute(row) : this.resume(row)).finally(() =>
      this.inflight.delete(task),
    );
    this.inflight.add(task);
    return this.receipt(this.get(id, ownerId));
  }
  async execute(row: any) {
    let state = 'unknown',
      result: any;
    try {
      // Re-check grants immediately before dispatch; approval does not preserve revoked access.
      this.broker.access(row.connection_id, row.employee_id, row.owner_id, row.tool);
      result = await this.broker.call(
        row.connection_id,
        row.employee_id,
        row.owner_id,
        row.tool,
        JSON.parse(row.arguments),
      );
      state = result?.isError ? 'failed' : 'succeeded';
    } catch (error) {
      result = {
        error:
          error instanceof ApiError
            ? error.message
            : 'The provider did not return a confirmed result. Check provider state before trying again.',
      };
      // Only a pre-dispatch permission/availability rejection proves no write occurred.
      if (error instanceof ApiError && [400, 403, 409].includes(error.statusCode)) state = 'failed';
    }
    this.store.run(
      'UPDATE connection_actions SET state=?,result=?,updated_at=? WHERE id=?',
      state,
      JSON.stringify(result ?? null),
      now(),
      row.id,
    );
    this.changed({ ...row, state });
    await this.resume(row);
  }
  async resume(row: any) {
    const c = this.store.one('SELECT * FROM connections WHERE id=?', row.connection_id);
    if (!c) return;
    try {
      this.store.authorize(row.owner_id, row.conversation_id);
    } catch {
      return;
    }
    await this.broker
      .resumeWaitingTask(
        c,
        {
          employeeId: row.employee_id,
          conversationId: row.conversation_id,
          requestMessageId: row.request_id,
          runId: row.run_id,
          continuation: `The connected action ${row.id} is ${this.get(row.id, row.owner_id).state}. Read its saved result with workspace_connection_action and continue the existing task within the human's instructions. Do not repeat the action or reconnect.`,
        },
        'action.' + row.id,
      )
      .catch(() => {});
  }
}
