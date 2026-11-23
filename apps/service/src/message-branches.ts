import { ApiError, Store, now } from './store.js';

// Editing a message sent to an agent and resending it works like other AI chat apps:
// the conversation continues from that message with the new wording, while the
// earlier version and everything that followed it stay saved as a version the
// author can switch back to. Agents act in the real world, so anything an earlier
// version already did is summarised for the author and the agent before resending.

const activeRunStates = [
  'accepted',
  'dispatching',
  'running',
  'waiting_input',
  'waiting_permission',
  'cancelling',
];
const placeholders = (values: unknown[]) => values.map(() => '?').join(',');

/** Turns a provider tool name such as `create-project` into "Create project". */
function actionTitle(tool: string) {
  const words = String(tool || '')
    .replace(/^mcp__[^_]+__/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => (/^[A-Z0-9]{2,}$/.test(word) ? word : word.toLowerCase()));
  return words.length ? words.join(' ').replace(/^./, (c) => c.toUpperCase()) : 'Action';
}
const serviceName = (service: string) =>
  String(service || 'Service').replace(/^./, (c) => c.toUpperCase());

export type ResendPreview = {
  /** An agent is still replying to this message or a later one in this version. */
  running: boolean;
  /** Visible messages after this one that resending moves into the earlier version. */
  laterMessages: number;
  /** Things the current version already did; resending does not undo them. */
  done: string[];
  /** Approvals still waiting; resending declines them because they belong to the old version. */
  pending: string[];
};

export class MessageBranches {
  constructor(
    private store: Store,
    private runs: {
      cancel(userId: string, runId: string, source?: 'user' | 'goal' | 'limit'): void;
      dispatch(): Promise<void> | void;
      active: Map<string, unknown>;
    },
    private actions?: { changed(row: any): void },
  ) {}

  private own(id: string, userId: string) {
    const s = this.store;
    const row = s.one('SELECT * FROM messages WHERE id=?', id);
    if (!row) throw new ApiError(404, 'Message unavailable');
    s.authorize(userId, row.conversation_id);
    if (row.kind !== 'human' || row.author_id !== userId)
      throw new ApiError(403, 'You can only edit your own messages.');
    if (row.deleted_at) throw new ApiError(409, 'This message has been deleted.');
    if (row.superseded) throw new ApiError(409, 'This message belongs to an earlier version.');
    return row;
  }

  private scope(row: any) {
    return {
      sql: row.thread_id ? 'thread_id=?' : 'thread_id IS NULL',
      params: row.thread_id ? [row.thread_id] : [],
    };
  }

  /** Visible messages after this one in the same conversation or thread. */
  private later(row: any): any[] {
    const scope = this.scope(row);
    return this.store.all(
      `SELECT id,seq,branch_root FROM messages msg WHERE conversation_id=? AND ${scope.sql} AND seq>? AND superseded=0 ORDER BY seq`,
      row.conversation_id,
      ...scope.params,
      row.seq,
    );
  }

  /** Runs that answered this message or a later one in the shown version. */
  private affectedRuns(row: any, later: any[]) {
    const ids = [row.id, ...later.map((m) => m.id)];
    return this.store.all(
      `SELECT r.* FROM runs r WHERE r.message_id IN (${placeholders(ids)}) AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.id=r.response_id AND m.superseded=1)`,
      ...ids,
    );
  }

  private summarise(row: any, later: any[], runs: any[]): ResendPreview {
    const s = this.store;
    const done: string[] = [];
    const pending: string[] = [];
    const runIds = runs.map((r) => r.id);
    if (runIds.length) {
      const files = new Set<string>();
      for (const activity of s.all(
        `SELECT data FROM activities WHERE run_id IN (${placeholders(runIds)}) AND json_extract(data,'$.type')='diff'`,
        ...runIds,
      ))
        for (const match of String(JSON.parse(activity.data).detail || '').matchAll(
          /^diff --git a\/(.+?) b\//gm,
        ))
          files.add(match[1]);
      if (files.size)
        done.push(
          files.size === 1
            ? `Changed 1 file (${[...files][0]})`
            : `Changed ${files.size} files`,
        );
      for (const action of s.all(
        `SELECT a.tool,a.state,c.service FROM connection_actions a JOIN connections c ON c.id=a.connection_id WHERE a.run_id IN (${placeholders(runIds)}) ORDER BY a.created_at`,
        ...runIds,
      )) {
        const label = `${serviceName(action.service)}: ${actionTitle(action.tool)}`;
        if (action.state === 'succeeded') done.push(label);
        else if (action.state === 'awaiting_approval') pending.push(label);
        else if (['running', 'unknown'].includes(action.state))
          done.push(`${label} (outcome not confirmed)`);
      }
      for (const work of s.all(
        `SELECT title FROM work_items WHERE run_id IN (${placeholders(runIds)})`,
        ...runIds,
      ))
        done.push(`Work card: ${work.title}`);
    }
    const messageIds = [row.id, ...later.map((m) => m.id)];
    for (const goal of s.all(
      `SELECT title FROM goals WHERE source_message_id IN (${placeholders(messageIds)})`,
      ...messageIds,
    ))
      done.push(`Goal: ${goal.title}`);
    const notes = s.one(
      `SELECT COUNT(*) n FROM memories WHERE deleted=0 AND source_id IN (${placeholders(messageIds)})`,
      ...messageIds,
    ).n;
    if (notes) done.push(notes === 1 ? 'Saved 1 note' : `Saved ${notes} notes`);
    return {
      running: runs.some((r) => activeRunStates.includes(r.state) || r.state === 'provider_limited'),
      laterMessages: later.length,
      done,
      pending,
    };
  }

  preview(id: string, userId: string): ResendPreview {
    const row = this.own(id, userId);
    const later = this.later(row);
    return this.summarise(row, later, this.affectedRuns(row, later));
  }

  /** Recomputes which messages are out of view from each message's version tag. */
  private recompute(conversationId: string) {
    const s = this.store;
    const rows = s.all(
      'SELECT id,thread_id,version,branch_root,branch_version,superseded FROM messages WHERE conversation_id=? ORDER BY seq',
      conversationId,
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    const hidden = new Map<string, boolean>();
    for (const r of rows) {
      const root = r.branch_root ? byId.get(r.branch_root) : undefined;
      const parent = r.thread_id ? byId.get(r.thread_id) : undefined;
      const value =
        (!!root && (!!hidden.get(root.id) || root.version !== r.branch_version)) ||
        (!!parent && !!hidden.get(parent.id));
      hidden.set(r.id, value);
      if (value !== !!r.superseded)
        s.run('UPDATE messages SET superseded=? WHERE id=?', value ? 1 : 0, r.id);
    }
    // Hidden replies should not wait in anyone's inbox.
    s.run(
      'DELETE FROM inbox WHERE message_id IN (SELECT id FROM messages WHERE conversation_id=? AND superseded=1)',
      conversationId,
    );
  }

  /** Agents start their next reply from the shown version, not from a session that saw another. */
  private forgetSessions(row: any) {
    this.store.run(
      "DELETE FROM native_sessions WHERE context_key IN (SELECT DISTINCT context_key FROM runs WHERE conversation_id=? AND COALESCE(thread_id,'')=?)",
      row.conversation_id,
      row.thread_id || '',
    );
  }

  /** Work cards belong to the version that created them. */
  private parkWork(id: string, from: number, to: number) {
    const s = this.store;
    s.run(
      'UPDATE work_items SET request_message_id=? WHERE request_message_id=?',
      `${id}:v${from}`,
      id,
    );
    s.run(
      'UPDATE work_items SET request_message_id=? WHERE request_message_id=?',
      id,
      `${id}:v${to}`,
    );
  }

  private stopRuns(userId: string, runs: any[]) {
    const s = this.store;
    for (const run of runs)
      try {
        this.stopRun(userId, run);
      } catch {
        // A run that finished meanwhile needs no stopping.
      }
  }
  private stopRun(userId: string, run: any) {
    const s = this.store;
    if (run.state === 'provider_limited') {
      s.set('run.autoResume.' + run.id, false);
      s.transition(run.id, 'interrupted', 'The message was edited and resent.');
    } else if (activeRunStates.includes(run.state) && run.state !== 'cancelling') {
      if (this.runs.active.has(run.id)) this.runs.cancel(run.user_id || userId, run.id, 'user');
      else s.transition(run.id, 'interrupted', 'The message was edited and resent.');
    }
  }

  resend(id: string, userId: string, text: string) {
    const s = this.store;
    const row = this.own(id, userId);
    if (!text.trim() && JSON.parse(row.attachments).length === 0)
      throw new ApiError(400, 'A message cannot be empty.');
    const jobs = s.all('SELECT * FROM outbox WHERE message_id=?', id);
    if (!jobs.length)
      throw new ApiError(400, 'This message was not sent to an agent. Save it without resending.');
    for (const job of jobs) {
      const employee = s.employee(job.employee_id);
      if (!employee || employee.deactivatedAt || !s.canUseEmployee(userId, employee.id))
        throw new ApiError(403, 'This agent is no longer available to you.');
    }
    const later = this.later(row);
    const runs = this.affectedRuns(row, later);
    const summary = this.summarise(row, later, runs);
    const runIds = runs.map((r) => r.id);
    const laterIds = later.map((m) => m.id);
    const from = row.version || 1;
    const to = row.version
      ? s.one('SELECT MAX(version) v FROM message_versions WHERE message_id=?', id).v + 1
      : 2;
    // Stop the old version first so nothing it is doing lands in the new one.
    this.stopRuns(userId, runs);
    const declined: any[] = [];
    s.db.transaction(() => {
      if (runIds.length)
        for (const action of s.all(
          `SELECT * FROM connection_actions WHERE run_id IN (${placeholders(runIds)}) AND state='awaiting_approval'`,
          ...runIds,
        )) {
          const changed = s.run(
            "UPDATE connection_actions SET state='declined',updated_at=? WHERE id=? AND state='awaiting_approval'",
            now(),
            action.id,
          );
          if (changed.changes) declined.push(action.id);
        }
      if (laterIds.length)
        s.run(
          `UPDATE outbox SET status='cancelled' WHERE message_id IN (${placeholders(laterIds)}) AND status IN ('pending','new','interrupted')`,
          ...laterIds,
        );
      const time = now();
      if (!row.version)
        s.run(
          'INSERT INTO message_versions VALUES(?,?,?,?,?)',
          id,
          1,
          row.text,
          row.attachments,
          row.created_at,
        );
      s.run('INSERT INTO message_versions VALUES(?,?,?,?,?)', id, to, text, row.attachments, time);
      s.run('UPDATE messages SET text=?,edited_at=?,version=? WHERE id=?', text, time, to, id);
      // Everything shown after this message now belongs to the version it followed.
      for (const m of later) {
        const root = m.branch_root
          ? s.one('SELECT seq FROM messages WHERE id=?', m.branch_root)
          : undefined;
        if (!root || root.seq < row.seq)
          s.run(
            'UPDATE messages SET branch_root=?,branch_version=? WHERE id=?',
            id,
            from,
            m.id,
          );
      }
      this.recompute(row.conversation_id);
      this.parkWork(id, from, to);
      this.forgetSessions(row);
      const previous = s.one(
        'SELECT text FROM message_versions WHERE message_id=? AND version=?',
        id,
        from,
      ).text;
      const already = [...summary.done, ...summary.pending.map((p) => `${p} (declined, not run)`)];
      s.set(
        'message.resendContext.' + id,
        `The human edited this message and resent it, so you are answering the new wording from this point in the conversation. Your earlier reply to the previous wording has been replaced.\nPrevious wording:\n${String(previous).slice(0, 2000)}\n` +
          (already.length
            ? `Anything the earlier reply did outside this conversation still stands; resending did not undo it:\n${already.map((d) => '- ' + d).join('\n')}\nInspect the current state before acting. Do not repeat completed actions unless the new wording needs them.`
            : 'The earlier reply took no recorded actions outside this conversation.'),
      );
      // Run the same request again from a fresh session built from the conversation up to here.
      for (const job of jobs) {
        s.run(
          "UPDATE outbox SET status='new',created_at=? WHERE id=?",
          time,
          job.id,
        );
        for (const key of ['outbox.nudged.', 'outbox.steeredRun.', 'outbox.decision.'])
          s.run('DELETE FROM settings WHERE key=?', key + job.id);
      }
    })();
    for (const actionId of declined)
      this.actions?.changed(s.one('SELECT * FROM connection_actions WHERE id=?', actionId));
    const message = s.message(s.one('SELECT * FROM messages WHERE id=?', id));
    s.emit('message.edited', row.conversation_id, message);
    s.emit('conversation.branched', row.conversation_id, { messageId: id, version: to });
    void this.runs.dispatch();
    return message;
  }

  /** Shows another saved version of an edited message and the replies that followed it. */
  switchVersion(id: string, userId: string, version: number) {
    const s = this.store;
    const row = this.own(id, userId);
    if (!row.version) throw new ApiError(409, 'This message has only one version.');
    if (version === row.version) return s.message(row);
    const saved = s.one(
      'SELECT * FROM message_versions WHERE message_id=? AND version=?',
      id,
      version,
    );
    if (!saved) throw new ApiError(404, 'That version is unavailable.');
    const later = this.later(row);
    if (
      this.affectedRuns(row, later).some(
        (r) => activeRunStates.includes(r.state) || r.state === 'provider_limited',
      )
    )
      throw new ApiError(
        409,
        'An agent is still replying. Wait for it to finish, or stop it, before switching versions.',
      );
    s.db.transaction(() => {
      s.run('UPDATE messages SET text=?,version=? WHERE id=?', saved.text, version, id);
      this.recompute(row.conversation_id);
      this.parkWork(id, row.version, version);
      this.forgetSessions(row);
    })();
    const message = s.message(s.one('SELECT * FROM messages WHERE id=?', id));
    s.emit('message.edited', row.conversation_id, message);
    s.emit('conversation.branched', row.conversation_id, { messageId: id, version });
    return message;
  }

  /** A plain edit keeps the saved copy of the shown version in step. */
  saved(id: string) {
    const row = this.store.one('SELECT text,version FROM messages WHERE id=?', id);
    if (row?.version)
      this.store.run(
        'UPDATE message_versions SET text=? WHERE message_id=? AND version=?',
        row.text,
        id,
        row.version,
      );
  }
}
