import { z } from 'zod';
import { ApiError, Store, now, uid } from './store.js';
import { GoalReview } from './goal-review.js';
import type { Supervisor } from './supervisor.js';

export const goalPolicy = {
  autonomy: z.enum(['research', 'prepare']).optional(),
  // Zero keeps ready work moving without a daily session cap.
  dailySessions: z.number().int().min(0).max(12).optional(),
  sessionMinutes: z.number().int().min(0).max(60).optional(),
  reviewMinutes: z.number().int().min(60).max(10080).optional(),
};
export const goalReport = z
  .object({
    outcome: z.enum(['continue', 'wait', 'needs_input', 'needs_permission', 'complete']),
    summary: z.string().trim().min(1).max(2000),
    evidence: z.string().trim().max(2000).default(''),
    nextStep: z.string().trim().max(2000).default(''),
    nextAt: z.iso.datetime({ offset: true }).optional(),
    question: z.string().trim().max(2000).default(''),
    facts: z.array(z.string().trim().min(1).max(1000)).max(20).optional(),
    uncertainties: z.array(z.string().trim().min(1).max(1000)).max(20).optional(),
    actionIds: z.array(z.string().uuid()).max(20).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.outcome === 'complete' && !v.evidence)
      ctx.addIssue({
        code: 'custom',
        message: 'Completion requires evidence against the success measure.',
      });
    if (['continue', 'wait'].includes(v.outcome) && !v.nextStep)
      ctx.addIssue({ code: 'custom', message: 'Record the next useful action.' });
    if (
      v.outcome === 'wait' &&
      !v.actionIds?.length &&
      (!v.nextAt || Date.parse(v.nextAt) <= Date.now())
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Waiting requires a future review time or a tracked external action.',
      });
    if (v.outcome === 'needs_input' && !v.question)
      ctx.addIssue({ code: 'custom', message: 'Ask the specific question that blocks progress.' });
  });

const live = [
  'accepted',
  'dispatching',
  'running',
  'waiting_input',
  'waiting_permission',
  'cancelling',
];
const after = (minutes: number) => new Date(Date.now() + minutes * 60000).toISOString();

/** Persistent continuation owned by the workspace. The model chooses work, never its limits. */
export class GoalRunner {
  enabled = true;
  review: GoalReview;
  constructor(
    public store: Store,
    public supervisor?: Supervisor,
  ) {
    this.review = new GoalReview(store);
  }

  policy(id: string) {
    return this.store.one('SELECT * FROM goal_execution WHERE goal_id=?', id);
  }

  receipts(goalId: string) {
    return this.store.all(
      `SELECT a.id actionId,a.tool,a.state status,a.result FROM connection_actions a
      JOIN goal_cycles c ON c.message_id=a.request_id WHERE c.goal_id=? ORDER BY a.created_at DESC LIMIT 30`,
      goalId,
    );
  }

  pendingDecision(goalId: string) {
    const row = this.store.one(
      `SELECT d.id,d.data FROM decisions d JOIN runs r ON r.id=d.run_id
      JOIN goal_cycles c ON c.message_id=r.message_id WHERE c.goal_id=? AND c.cancelled=0 AND d.state IN ('pending','executing')
      ORDER BY r.created_at DESC LIMIT 1`,
      goalId,
    );
    return row ? { ...JSON.parse(row.data), id: row.id } : null;
  }

  requestReview(goalId: string, candidate: any, sourceMessageId?: string) {
    const g = this.store.one('SELECT * FROM goals WHERE id=?', goalId);
    this.review.prepare(g, candidate, sourceMessageId);
    this.configure(goalId, {});
    this.setState(goalId, 'checking', 'The result is ready for independent verification.', now());
  }

  private finishReview(g: any, c: any, run: any, review: any) {
    const s = this.store;
    if (this.review.pending(g.id)?.id !== review.id) return;
    const verdict = run?.state === 'completed' && review.runId === run.id ? review.verdict : null;
    if (review.signature !== this.review.signature(g)) {
      this.review.clear(g.id);
      this.setState(
        g.id,
        'queued',
        'The requirements changed. Recheck the result before completion.',
        now(),
      );
      return;
    }
    if (s.setting('run.stopSource.' + run?.id) === 'user') {
      s.run("UPDATE goals SET status='paused',version=version+1 WHERE id=?", g.id);
      this.stop(g.id, 'paused', 'Review was stopped. Resume when ready.');
      return;
    }
    if (!verdict) {
      if (review.attempts >= 3) {
        this.review.clear(g.id);
        this.checkIn(
          g,
          `Independent verification could not finish after three attempts: ${run?.error || 'No valid verdict was returned'}. Can you resolve this blocker or clarify how the result can be checked?`,
        );
      } else
        this.setState(
          g.id,
          'checking',
          'Verification was interrupted. Retrying from saved evidence.',
          after(5),
        );
      return;
    }
    this.review.clear(g.id);
    s.set('goal.review.last.' + g.id, { ...verdict, at: now() });
    if (verdict.verdict === 'passed') {
      for (const check of verdict.checks)
        if (check.criterion.startsWith('step:'))
          s.run(
            "UPDATE goal_steps SET status='done',evidence=?,updated_at=? WHERE id=? AND goal_id=?",
            check.evidence,
            now(),
            check.criterion.slice(5),
            g.id,
          );
      const evidence = verdict.checks
        .map((check: any) => `${check.criterion}: ${check.evidence}`)
        .join('\n');
      s.run(
        'INSERT INTO goal_updates VALUES(?,?,?,?,?,?)',
        uid(),
        g.id,
        g.lead_agent_id,
        verdict.summary,
        evidence,
        now(),
      );
      s.run(
        "UPDATE goals SET status='complete',current=?,next_step='',version=version+1,updated_at=? WHERE id=?",
        verdict.summary,
        now(),
        g.id,
      );
      this.setState(g.id, 'complete', 'Independently checked against the completion criteria.');
      const { e, cid, threadId } = this.destination(g);
      s.addMessage(
        cid,
        e.id,
        e.name,
        'agent',
        `Completed: ${g.title}\n\n${verdict.summary}\n\nIndependently checked against the completion criteria.`,
        threadId,
      );
    } else if (verdict.verdict === 'needs_input') this.checkIn(g, verdict.question);
    else {
      s.run(
        'INSERT INTO goal_updates VALUES(?,?,?,?,?,?)',
        uid(),
        g.id,
        g.lead_agent_id,
        'Completion check found work remaining.',
        JSON.stringify(verdict.checks),
        now(),
      );
      s.run(
        'UPDATE goals SET current=?,next_step=?,version=version+1,updated_at=? WHERE id=?',
        verdict.summary,
        verdict.nextStep,
        now(),
        g.id,
      );
      const previous = s.setting('goal.review.failure.' + g.id);
      const signature = JSON.stringify(
        verdict.checks
          .filter((check: any) => !check.passed)
          .map((check: any) => check.criterion)
          .sort(),
      );
      const repeats = previous?.signature === signature ? previous.repeats + 1 : 1;
      s.set('goal.review.failure.' + g.id, { signature, repeats });
      // Keep defects internal. Repeated failure calls for a new approach, not automatic user approval.
      s.run('UPDATE goal_execution SET stalls=? WHERE goal_id=?', repeats >= 2 ? 1 : 0, g.id);
      s.set('goal.signal.' + g.id, {
        context: `Independent review found required work: ${JSON.stringify(verdict)}. Fix within the existing scope, then propose completion again.${repeats >= 2 ? ' This criterion failed repeatedly; change the approach and investigate the underlying cause before another attempt.' : ''}`,
        handled: true,
        at: now(),
      });
      this.setState(g.id, 'queued', 'The lead is addressing the completion check.', after(0.1));
    }
  }

  /** A normal reply in the same DM/thread is also a durable goal answer.
   * It starts work to interpret the reply; it never grants a pending permission. */
  private attachAnswer(job: any) {
    const m = this.store.one("SELECT * FROM messages WHERE id=? AND kind='human'", job.message_id);
    if (!m) return;
    const g = this.store.one(
      `SELECT g.* FROM goals g JOIN goal_execution x ON x.goal_id=g.id
      WHERE g.owner_id=? AND g.lead_agent_id=? AND g.status='active' AND x.state='needs_input' AND x.question<>''`,
      job.user_id,
      job.employee_id,
    );
    if (!g || this.pendingDecision(g.id)) return;
    const p = this.policy(g.id),
      destination = this.destination(g);
    if (
      m.conversation_id !== destination.cid ||
      m.thread_id !== destination.threadId ||
      m.created_at < p.updated_at
    )
      return;
    if (this.store.one('SELECT 1 FROM goal_cycles WHERE goal_id=? AND finished_at IS NULL', g.id))
      return;
    this.store.run(
      'INSERT INTO goal_cycles(message_id,goal_id,employee_id,outbox_id,created_at) VALUES(?,?,?,?,?)',
      m.id,
      g.id,
      job.employee_id,
      job.id,
      now(),
    );
    this.store.set(
      'message.context.' + m.id,
      `The goal was waiting for: ${p.question}. Interpret this reply. If it does not answer the question, keep that question unresolved. It does not approve any pending action.`,
    );
    this.store.set(
      'delegation.purpose.' + m.id,
      p.autonomy === 'research' ? 'research' : 'execute',
    );
    this.setState(g.id, 'queued', 'The lead is reading your answer.', now());
  }

  decisionResolved(run: any, decisionId: string, continuationId?: string) {
    const c = this.store.one('SELECT * FROM goal_cycles WHERE message_id=?', run.message_id);
    if (!c || c.cancelled) return;
    const g = this.store.one('SELECT * FROM goals WHERE id=?', c.goal_id);
    if (!g || g.status !== 'active') return;
    if (continuationId) {
      this.store.run(
        'UPDATE goal_cycles SET finished_at=? WHERE message_id=?',
        now(),
        c.message_id,
      );
      const job = this.store.one(
        'SELECT id FROM outbox WHERE message_id=? AND employee_id=?',
        continuationId,
        run.employee_id,
      );
      this.store.run(
        'INSERT OR IGNORE INTO goal_cycles(message_id,goal_id,employee_id,outbox_id,created_at) VALUES(?,?,?,?,?)',
        continuationId,
        g.id,
        run.employee_id,
        job?.id,
        now(),
      );
      this.setState(g.id, 'queued', 'Your decision is saved. Work can continue.', now());
    } else if (!this.supervisor?.active.has(run.id)) {
      this.store.set('goal.signal.' + g.id, {
        context: `Decision ${decisionId} is resolved. Read its exact saved resolution and any action receipt. A denial is not permission; choose an allowed alternative or explain the specific remaining blocker.`,
        at: now(),
      });
    }
    this.changed(g.id);
  }

  configure(id: string, input: unknown) {
    const p = z.object(goalPolicy).parse(input),
      old = this.policy(id);
    this.store.run(
      `INSERT INTO goal_execution(goal_id,autonomy,daily_sessions,session_minutes,review_minutes,updated_at)
       VALUES(?,?,?,?,?,?) ON CONFLICT(goal_id) DO UPDATE SET autonomy=excluded.autonomy,
       daily_sessions=excluded.daily_sessions,session_minutes=excluded.session_minutes,
       review_minutes=excluded.review_minutes,updated_at=excluded.updated_at`,
      id,
      p.autonomy ?? old?.autonomy ?? 'prepare',
      p.dailySessions ?? old?.daily_sessions ?? 0,
      p.sessionMinutes ?? old?.session_minutes ?? 0,
      p.reviewMinutes ?? old?.review_minutes ?? 1440,
      now(),
    );
  }

  changed(id: string) {
    const g = this.store.one('SELECT * FROM goals WHERE id=?', id);
    if (!g) return;
    for (const cid of new Set([g.conversation_id, this.store.employee(g.lead_agent_id)?.dmId]))
      if (cid) this.store.emit('goal.changed', cid, { id }, g.owner_id);
  }

  setState(id: string, state: string, reason: string, nextAt: string | null = null, question = '') {
    const old = this.policy(id);
    if (
      old?.state === state &&
      old.reason === reason &&
      old.next_at === nextAt &&
      old.question === question
    )
      return;
    this.store.run(
      'UPDATE goal_execution SET state=?,reason=?,next_at=?,question=?,updated_at=? WHERE goal_id=?',
      state,
      reason,
      nextAt,
      question,
      now(),
      id,
    );
    this.changed(id);
  }

  destination(g: any) {
    const e = this.store.employee(g.lead_agent_id);
    if (!e || !this.store.canUseEmployee(g.owner_id, e.id))
      throw new ApiError(409, 'Choose an available lead agent to continue.');
    this.store.authorize(g.owner_id, g.conversation_id);
    const cid = e.dmId;
    this.store.authorize(g.owner_id, cid);
    this.store.authorizeEmployee(e.id, cid);
    const source =
      g.source_message_id &&
      this.store.one(
        'SELECT conversation_id,thread_id FROM messages WHERE id=?',
        g.source_message_id,
      );
    return { e, cid, threadId: source?.conversation_id === cid ? source.thread_id : null };
  }

  /** The unfinished goal this one waits for, if any. Missing or complete predecessors release it. */
  predecessor(id: string) {
    const afterId = this.store.setting('goal.after.' + id, '');
    if (!afterId) return null;
    const before = this.store.one('SELECT id,title,status FROM goals WHERE id=?', afterId);
    return before && before.status !== 'complete' ? before : null;
  }

  /**
   * Starts a goal now, or lines it up behind its predecessor. `force` starts it
   * immediately and drops the dependency (the human chose not to wait).
   */
  start(id: string, force = false) {
    const g = this.store.one('SELECT * FROM goals WHERE id=?', id);
    this.destination(g);
    this.configure(id, {});
    this.store.run('UPDATE goal_execution SET stalls=0 WHERE goal_id=?', id);
    const before = force ? null : this.predecessor(id);
    if (before) {
      this.setState(id, 'sequenced', `Starts after “${before.title}” is complete.`);
      return;
    }
    this.store.run('DELETE FROM settings WHERE key=?', 'goal.after.' + id);
    this.setState(id, 'queued', 'The lead will take the next useful step.', now());
  }

  /** Persist an ordering dependency. Rejects cycles and goals from other owners. */
  sequence(id: string, afterId: string) {
    const g = this.store.one('SELECT owner_id FROM goals WHERE id=?', id);
    const seen = new Set([id]);
    for (let cursor: string = afterId; cursor; ) {
      if (seen.has(cursor)) throw new ApiError(400, 'Goals cannot wait for each other in a loop.');
      seen.add(cursor);
      const before = this.store.one('SELECT owner_id FROM goals WHERE id=?', cursor);
      if (!before || before.owner_id !== g?.owner_id)
        throw new ApiError(400, 'Choose an existing goal to start after.');
      cursor = this.store.setting('goal.after.' + cursor, '');
    }
    this.store.set('goal.after.' + id, afterId);
  }

  /** When a goal is removed, its followers wait for whatever it was waiting for. */
  unlink(id: string) {
    const inherited = this.store.setting('goal.after.' + id, '');
    const followers: string[] = [];
    for (const row of this.store.all(
      "SELECT key FROM settings WHERE key LIKE 'goal.after.%' AND value=?",
      JSON.stringify(id),
    )) {
      if (inherited) this.store.set(row.key, inherited);
      else this.store.run('DELETE FROM settings WHERE key=?', row.key);
      followers.push(row.key.slice('goal.after.'.length));
    }
    this.store.run('DELETE FROM settings WHERE key=?', 'goal.after.' + id);
    return followers;
  }

  /** Release followers whose turn has come. Safe to call repeatedly. */
  releaseFollowers(ids: string[]) {
    for (const id of ids) {
      const g = this.store.one('SELECT * FROM goals WHERE id=?', id);
      if (g && this.policy(id)?.state === 'sequenced') {
        if (this.predecessor(id)) {
          const before = this.predecessor(id)!;
          this.setState(id, 'sequenced', `Starts after “${before.title}” is complete.`);
        } else this.release(g);
      }
    }
  }

  private release(g: any) {
    if (g.status !== 'active' || this.predecessor(g.id)) return;
    const afterId = this.store.setting('goal.after.' + g.id, '');
    const before = afterId && this.store.one('SELECT title FROM goals WHERE id=?', afterId);
    this.store.run('DELETE FROM settings WHERE key=?', 'goal.after.' + g.id);
    this.setState(
      g.id,
      'queued',
      before ? `“${before.title}” is complete. Starting now.` : 'The lead will take the next useful step.',
      now(),
    );
  }

  stop(id: string, state: 'paused' | 'complete', reason: string) {
    this.configure(id, {});
    this.review.clear(id);
    this.setState(id, state, reason);
    for (const c of this.store.all(
      'SELECT * FROM goal_cycles WHERE goal_id=? AND finished_at IS NULL',
      id,
    )) {
      this.store.run('UPDATE goal_cycles SET cancelled=1 WHERE message_id=?', c.message_id);
      if (c.outbox_id)
        this.store.run(
          "UPDATE outbox SET status='cancelled' WHERE id=? AND status IN ('pending','new')",
          c.outbox_id,
        );
      for (const r of this.store.all(
        'SELECT * FROM runs WHERE message_id=? AND employee_id=?',
        c.message_id,
        c.employee_id,
      )) {
        this.store.set('run.autoResume.' + r.id, false);
        if (this.supervisor?.active.has(r.id) && r.state !== 'cancelling')
          this.supervisor.cancel(r.user_id, r.id, 'goal');
      }
      // Keep live cycles until their cancellation finishes; they cannot update the paused goal.
      if (!this.liveRun(c))
        this.store.run(
          'UPDATE goal_cycles SET finished_at=? WHERE message_id=?',
          now(),
          c.message_id,
        );
    }
  }

  runFor(c: any) {
    return this.store.one(
      'SELECT * FROM runs WHERE message_id=? AND employee_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1',
      c.message_id,
      c.employee_id,
    );
  }
  liveRun(c: any) {
    const r = this.runFor(c);
    return r && (live.includes(r.state) || this.supervisor?.active.has(r.id)) ? r : null;
  }
  elapsed(c: any, activeRunId?: string) {
    return this.store
      .all(
        'SELECT id,created_at,updated_at FROM runs WHERE message_id=? AND employee_id=?',
        c.message_id,
        c.employee_id,
      )
      .reduce(
        (total, r) =>
          total +
          Math.max(
            0,
            (r.id === activeRunId ? Date.now() : Date.parse(r.updated_at)) -
              Date.parse(r.created_at),
          ),
        0,
      );
  }
  cycle(messageId: string) {
    return this.store.one(
      'SELECT * FROM goal_cycles WHERE message_id=? AND finished_at IS NULL',
      messageId,
    );
  }

  yieldToHuman(run: any) {
    const c = this.cycle(run.message_id);
    if (!c || c.cancelled || !this.supervisor?.active.has(run.id) || run.state !== 'running')
      return;
    this.store.run('UPDATE goal_cycles SET cancelled=1 WHERE message_id=?', c.message_id);
    this.review.clear(c.goal_id);
    this.setState(
      c.goal_id,
      'queued',
      'The lead is responding to your message before continuing this goal.',
      now(),
    );
    this.supervisor.cancel(run.user_id, run.id, 'goal');
  }

  view(g: any) {
    const p = this.policy(g.id);
    if (!p)
      return {
        state: g.status === 'active' ? 'saved' : g.status,
        reason: 'Saved for later. Start this goal to begin ongoing work.',
        nextAt: null,
        question: '',
        autonomy: 'prepare',
        dailySessions: 0,
        sessionMinutes: 0,
        reviewMinutes: 1440,
        sessionsUsed: 0,
      };
    const c = this.store.one(
      'SELECT * FROM goal_cycles WHERE goal_id=? AND finished_at IS NULL ORDER BY created_at DESC LIMIT 1',
      g.id,
    );
    const r = c && this.runFor(c);
    let state = p.state,
      reason = p.reason || 'Saved for later. Start this goal to begin ongoing work.',
      nextAt = p.next_at;
    if (g.status !== 'active') state = r && live.includes(r.state) ? 'stopping' : g.status;
    else if (r && live.includes(r.state)) {
      state = ['waiting_input', 'waiting_permission'].includes(r.state)
        ? r.state === 'waiting_permission'
          ? 'needs_permission'
          : 'needs_input'
        : r.state === 'cancelling'
          ? 'stopping'
          : this.review.forMessage(c.message_id)
            ? 'checking'
            : 'working';
      reason = ['needs_input', 'needs_permission'].includes(state)
        ? 'A decision is waiting in the conversation.'
        : state === 'stopping'
          ? 'Stopping the current work session.'
          : state === 'checking'
            ? 'An independent session is checking the result.'
            : 'The lead is working on the next step.';
    } else if (r?.state === 'provider_limited') {
      state = 'scheduled';
      reason = 'Waiting for the provider allowance to reset.';
      nextAt = this.store.setting('run.limit.' + r.id)?.retryAt || null;
    }
    const sessionsUsed = this.store.one(
      'SELECT COUNT(*) n FROM goal_cycles WHERE goal_id=? AND started_at>=?',
      g.id,
      new Date(Date.now() - 86400000).toISOString(),
    ).n;
    const lastReview = this.store.setting('goal.review.last.' + g.id, null);
    const before = this.predecessor(g.id);
    return {
      startsAfter: before ? { id: before.id, title: before.title } : null,
      review: lastReview,
      state,
      reason,
      nextAt,
      question: p.question,
      autonomy: p.autonomy,
      dailySessions: p.daily_sessions,
      sessionMinutes: p.session_minutes,
      reviewMinutes: p.review_minutes,
      sessionsUsed,
      runId: r?.id || null,
      conversationId:
        r?.conversation_id || this.store.employee(g.lead_agent_id)?.dmId || g.conversation_id,
      lastWorkedAt:
        this.store.one('SELECT MAX(started_at) at FROM goal_cycles WHERE goal_id=?', g.id)?.at ||
        null,
    };
  }

  context(messageId: string) {
    const c = this.cycle(messageId);
    if (!c) return '';
    const reviewing = this.review.forMessage(messageId);
    if (reviewing) return this.review.context(reviewing);
    const g = this.store.one('SELECT * FROM goals WHERE id=?', c.goal_id),
      p = this.policy(c.goal_id);
    return `\nYou are continuing an explicitly started workspace goal ${g.id}: ${g.title}.
Success measure: ${g.success}\nCurrent evidence: ${g.current || 'Not yet established'}\nNext action: ${g.next_step || 'Establish the baseline and choose a useful first action'}
${p.session_minutes > 0 ? `Respect the saved session limit of ${p.session_minutes} minutes.` : 'There is no fixed session cutoff. Continue productive work naturally and checkpoint at meaningful milestones.'} ${p.daily_sessions > 0 ? `The saved work limit is ${p.daily_sessions} sessions per rolling 24 hours.` : 'There is no daily session cap; the workspace continues useful work automatically.'} Save durable checkpoints before ending.
Authority: ${p.autonomy === 'research' ? 'Research and analysis only. Do not change files or execute external writes.' : 'Research, analyse, draft, and prepare local changes within already approved access.'} Publishing, deployment, contacting external people, spending, and expanded access require explicit human instruction. Existing approvals remain required. The lead remains responsible for this goal. The workspace arranges independent completion review automatically.
Inspect current state and saved action receipts before continuing. Never replay an uncertain external write. Make useful progress and verify it. A completed task is not proof the goal is achieved. Completion is provisional until independent review passes. Keep the original outcome and criteria; never weaken them to obtain a pass.
Completion criteria: ${JSON.stringify(this.review.criteria(g))}
Durable facts and uncertainties: ${JSON.stringify(this.store.setting('goal.state.' + g.id, {}))}
Recent evidence: ${JSON.stringify(this.store.all('SELECT summary,evidence FROM goal_updates WHERE goal_id=? ORDER BY created_at DESC,rowid DESC LIMIT 5', g.id))}
External action receipts: ${JSON.stringify(this.receipts(g.id))}
${p.stalls > 0 ? 'Recent sessions repeated work or produced no new evidence. Change approach: identify the failed assumption and choose a different test or action. Ask a specific question only if human input truly blocks progress.' : ''}
Before ending, call workspace_goal_checkpoint with this goalId, a factual summary/evidence, and outcome continue, wait (with nextAt), needs_input (with a concrete question), needs_permission (for an existing approval), or complete (propose independent review with success evidence). Use continue only for a concrete useful next action; use wait when evidence needs time. If blocked, prepare the decision before asking. Never manufacture activity or repeat unproductive work.
The workspace schedules continuation. Do not use workspace_schedule for this goal. Report meaningful results concisely; routine monitoring should be quiet. If a material decision blocks all progress, checkpoint needs_input so the user receives one durable check-in.\n`;
  }

  beforeDispatch(job: any) {
    const c = this.store.one('SELECT * FROM goal_cycles WHERE message_id=?', job.message_id);
    if (!c) {
      this.attachAnswer(job);
      return true;
    }
    if (!this.enabled) return false;
    const g = this.store.one('SELECT * FROM goals WHERE id=?', c.goal_id),
      p = this.policy(c.goal_id);
    if (
      !g ||
      g.status !== 'active' ||
      c.finished_at ||
      c.cancelled ||
      g.lead_agent_id !== job.employee_id ||
      [
        'paused',
        'complete',
        'needs_input',
        'needs_permission',
        'waiting_external',
        'saved',
      ].includes(p?.state)
    ) {
      this.store.run("UPDATE outbox SET status='cancelled' WHERE id=?", job.id);
      return false;
    }
    try {
      this.destination(g);
    } catch (e) {
      this.checkIn(g, e instanceof Error ? e.message : 'The lead is unavailable.');
      return false;
    }
    const previous = this.runFor(c);
    if (
      previous?.state === 'provider_limited' &&
      p.session_minutes > 0 &&
      this.elapsed(c) >= p.session_minutes * 60000
    ) {
      this.store.set('run.autoResume.' + previous.id, false);
      this.store.run(
        'UPDATE goal_cycles SET finished_at=? WHERE message_id=?',
        now(),
        c.message_id,
      );
      this.setState(
        g.id,
        'scheduled',
        'This session used its time allowance. The next session will inspect saved work.',
        this.store.setting('run.limit.' + previous.id)?.retryAt || after(5),
      );
      return false;
    }
    if (previous?.state === 'provider_limited')
      this.store.run('UPDATE goal_cycles SET report=NULL WHERE message_id=?', c.message_id);
    this.store.set(
      'delegation.purpose.' + job.message_id,
      this.review.forMessage(job.message_id)
        ? 'review'
        : p.autonomy === 'research'
          ? 'research'
          : 'execute',
    );
    if (!c.started_at) {
      const recent = this.store.all(
        'SELECT started_at FROM goal_cycles WHERE goal_id=? AND started_at>=? ORDER BY started_at',
        g.id,
        new Date(Date.now() - 86400000).toISOString(),
      );
      if (p.daily_sessions > 0 && recent.length >= p.daily_sessions) {
        this.setState(
          g.id,
          'scheduled',
          'The work allowance is used. Your queued work will continue when a session becomes available.',
          new Date(
            Date.parse(recent[recent.length - p.daily_sessions].started_at) + 86400000,
          ).toISOString(),
        );
        return false;
      }
      this.store.run('UPDATE goal_cycles SET started_at=? WHERE message_id=?', now(), c.message_id);
    }
    this.changed(g.id);
    return true;
  }

  checkpoint(goalId: string, run: any, input: unknown) {
    if (this.review.forMessage(run.message_id))
      throw new ApiError(403, 'Submit the independent review verdict instead.');
    const report = goalReport.parse(input),
      g = this.store.one('SELECT * FROM goals WHERE id=? AND owner_id=?', goalId, run.user_id);
    if (!g || g.lead_agent_id !== run.employee_id)
      throw new ApiError(403, 'Only the goal lead can report this work.');
    if (
      g.status !== 'active' ||
      !this.policy(goalId) ||
      ['saved', 'paused', 'complete'].includes(this.policy(goalId).state)
    )
      throw new ApiError(409, 'Start or resume this goal before reporting ongoing work.');
    const current = this.store.one('SELECT * FROM runs WHERE id=?', run.id);
    if (!current || !live.includes(current.state) || current.state === 'cancelling')
      throw new ApiError(409, 'This work session has ended.');
    if (
      this.store.one('SELECT cancelled FROM goal_cycles WHERE message_id=?', run.message_id)
        ?.cancelled
    )
      throw new ApiError(409, 'This goal session was stopped.');
    const other = this.store.one(
      'SELECT * FROM goal_cycles WHERE goal_id=? AND finished_at IS NULL AND message_id<>?',
      goalId,
      run.message_id,
    );
    if (other)
      throw new ApiError(409, 'Another work session is already responsible for this goal.');
    this.store.run(
      'INSERT OR IGNORE INTO goal_cycles(message_id,goal_id,employee_id,created_at,started_at) VALUES(?,?,?,?,?)',
      run.message_id,
      goalId,
      run.employee_id,
      now(),
      now(),
    );
    if (this.cycle(run.message_id)?.goal_id !== goalId)
      throw new ApiError(409, 'This session is already linked to a different goal.');
    for (const actionId of report.actionIds || []) {
      if (!this.receipts(goalId).some((a: any) => a.actionId === actionId))
        throw new ApiError(400, 'Only actions belonging to this goal may wake it.');
    }
    if (
      report.outcome === 'needs_permission' &&
      !this.pendingDecision(goalId) &&
      !this.receipts(goalId).some((a: any) => a.status === 'awaiting_approval')
    )
      throw new ApiError(400, 'Request the concrete approval before waiting for permission.');
    const state = this.store.setting('goal.state.' + goalId, {});
    this.store.set('goal.state.' + goalId, {
      ...state,
      ...(report.facts === undefined ? {} : { facts: report.facts }),
      ...(report.uncertainties === undefined ? {} : { uncertainties: report.uncertainties }),
      summary: report.summary,
      evidence: report.evidence,
      nextStep: report.nextStep,
      question: report.question,
      updatedAt: now(),
    });
    this.store.run(
      'UPDATE goal_cycles SET report=? WHERE message_id=?',
      JSON.stringify(report),
      run.message_id,
    );
    this.store.run(
      'UPDATE goals SET current=?,next_step=?,version=version+1,updated_at=? WHERE id=?',
      report.summary,
      report.nextStep,
      now(),
      goalId,
    );
    this.changed(goalId);
    return {
      status: 'checkpoint_saved',
      next:
        report.outcome === 'complete'
          ? 'Completion will be checked independently after this session. Do not declare the goal complete yet.'
          : 'The checkpoint is durable. The workspace continues when the session finishes.',
    };
  }

  checkIn(g: any, question: string) {
    const old = this.policy(g.id);
    this.setState(
      g.id,
      'needs_input',
      'Your decision is needed before more work can continue.',
      null,
      question,
    );
    if (old?.state === 'needs_input' && old.question === question) return;
    // Deliver privately when the original conversation or lead is unavailable; never broaden visibility.
    const e = this.store.employee(g.lead_agent_id);
    let cid: string,
      threadId: string | null = null;
    try {
      ({ cid, threadId } = this.destination(g));
    } catch {
      cid = g.conversation_id;
      try {
        this.store.authorize(g.owner_id, cid);
      } catch {
        return;
      }
    }
    const human = this.store.user(g.owner_id);
    this.store.addMessage(
      cid,
      e?.id || 'workspace',
      e?.name || 'Workspace',
      'agent',
      `@${human?.name || 'Owner'} — ${g.title}\n\n${question}`,
      threadId,
    );
  }

  reply(g: any, text: string) {
    const p = this.policy(g.id);
    if (
      g.status !== 'active' ||
      p?.state !== 'needs_input' ||
      !p.question ||
      this.pendingDecision(g.id)
    )
      throw new ApiError(409, 'This goal is not waiting for an answer.');
    const { e, cid, threadId } = this.destination(g);
    const answer = z.string().trim().min(1).max(4000).parse(text);
    this.store.db.transaction(() => {
      const m = this.store.accept(this.store.user(g.owner_id), cid, {
        text: answer,
        key: uid(),
        recipients: [e.id],
        attachments: [],
        newTask: false,
        threadId,
      });
      const job = this.store.one(
        'SELECT id FROM outbox WHERE message_id=? AND employee_id=?',
        m.id,
        e.id,
      );
      if (p.autonomy === 'research') this.store.set('delegation.purpose.' + m.id, 'research');
      this.store.run(
        'INSERT INTO goal_cycles(message_id,goal_id,employee_id,outbox_id,created_at) VALUES(?,?,?,?,?)',
        m.id,
        g.id,
        e.id,
        job.id,
        now(),
      );
      this.store.set(
        'message.context.' + m.id,
        `Reply to the goal check-in: ${p.question}. Interpret this answer within existing authority; it does not grant blanket permission.`,
      );
      this.store.run('UPDATE goal_execution SET stalls=0 WHERE goal_id=?', g.id);
      this.setState(g.id, 'queued', 'Your answer is saved. The lead will continue.', now());
    })();
  }

  tick() {
    if (
      !this.enabled ||
      this.supervisor?.closing ||
      this.supervisor?.maintenance ||
      !this.store.db.open
    )
      return;
    for (const g of this.store.all(
      "SELECT g.* FROM goals g JOIN goal_execution x ON x.goal_id=g.id WHERE x.state<>'saved'",
    )) {
      try {
        if (this.policy(g.id)?.state === 'sequenced') {
          this.release(g);
          continue;
        }
        this.advance(g);
      } catch (e) {
        this.checkIn(
          g,
          `Work could not continue: ${e instanceof Error ? e.message : 'Unexpected error'}. Please review the goal and its access.`,
        );
      }
    }
  }

  private advance(g: any) {
    const s = this.store;
    for (const c of s.all(
      'SELECT * FROM goal_cycles WHERE goal_id=? AND finished_at IS NULL',
      g.id,
    )) {
      const r = this.runFor(c),
        p = this.policy(g.id);
      if (r && (live.includes(r.state) || this.supervisor?.active.has(r.id))) {
        if (
          this.supervisor?.active.has(r.id) &&
          r.state === 'running' &&
          p.session_minutes > 0 &&
          this.elapsed(c, r.id) >= p.session_minutes * 60000
        ) {
          s.set('goal.timeout.' + r.id, true);
          this.supervisor.cancel(r.user_id, r.id, 'limit');
        }
        return;
      }
      if (g.status !== 'active' || c.cancelled || c.employee_id !== g.lead_agent_id) {
        s.run('UPDATE goal_cycles SET finished_at=? WHERE message_id=?', now(), c.message_id);
        continue;
      }
      if (r?.state === 'provider_limited' && s.setting('run.autoResume.' + r.id, true)) return;
      const job = c.outbox_id && s.one('SELECT status FROM outbox WHERE id=?', c.outbox_id);
      if (!r && job && ['pending', 'new', 'claimed'].includes(job.status)) return;
      s.db.transaction(() => {
        s.run('UPDATE goal_cycles SET finished_at=? WHERE message_id=?', now(), c.message_id);
        if (r && s.setting('run.stopSource.' + r.id) === 'user') {
          s.run("UPDATE goals SET status='paused',version=version+1 WHERE id=?", g.id);
          this.stop(g.id, 'paused', 'Work was stopped. Resume when you are ready.');
          return;
        }
        const reviewing = this.review.forMessage(c.message_id);
        if (reviewing) {
          this.finishReview(g, c, r, reviewing);
          return;
        }
        const report =
          c.report && !['failed', 'cancelled'].includes(r?.state) ? JSON.parse(c.report) : null;
        const previousEvidence = s.one(
          'SELECT evidence FROM goal_updates WHERE goal_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1',
          g.id,
        )?.evidence;
        const progressed =
          report?.evidence?.trim() && report.evidence.trim() !== previousEvidence?.trim();
        const stalls = progressed ? 0 : p.stalls + 1;
        s.run('UPDATE goal_execution SET stalls=? WHERE goal_id=?', stalls, g.id);
        if (report) {
          s.run(
            'INSERT INTO goal_updates VALUES(?,?,?,?,?,?)',
            uid(),
            g.id,
            c.employee_id,
            report.summary,
            report.evidence,
            now(),
          );
          s.run(
            'UPDATE goals SET current=?,next_step=?,version=version+1,updated_at=? WHERE id=?',
            report.summary,
            report.nextStep,
            now(),
            g.id,
          );
          if (report.outcome === 'complete') {
            this.requestReview(g.id, report, c.message_id);
            return;
          }
          if (report.outcome === 'needs_input') {
            this.checkIn(g, report.question);
            return;
          }
        }
        const pending = this.pendingDecision(g.id);
        const pendingActions = this.receipts(g.id).filter((a: any) =>
          ['awaiting_approval', 'running'].includes(a.status),
        );
        if (
          report?.outcome === 'needs_permission' ||
          (!report && (pending || pendingActions.length))
        ) {
          s.set(
            'goal.wait.actions.' + g.id,
            pendingActions.map((a: any) => a.actionId),
          );
          this.setState(
            g.id,
            pending?.kind === 'question' ? 'needs_input' : 'needs_permission',
            pending?.title || 'Waiting for the prepared action to be resolved.',
          );
          return;
        }
        if (stalls >= 3) {
          this.checkIn(
            g,
            `Three work sessions ended without new verified progress after a change of approach. Last result: ${report?.summary || r?.error || 'No usable checkpoint'}. What information or change to the next step would unblock this goal?`,
          );
          return;
        }
        if (
          r &&
          (r.state === 'cancelled' || s.setting('run.stopSource.' + r.id) === 'user') &&
          !s.setting('goal.timeout.' + r.id, false)
        ) {
          s.run("UPDATE goals SET status='paused',version=version+1 WHERE id=?", g.id);
          this.setState(g.id, 'paused', 'Work was stopped. Resume when you are ready.');
          return;
        }
        const wait = report?.outcome === 'wait';
        if (wait) s.set('goal.wait.actions.' + g.id, report.actionIds || []);
        this.setState(
          g.id,
          wait ? 'waiting_external' : 'queued',
          wait
            ? report.summary
            : report
              ? 'The next useful step is ready.'
              : 'The session was interrupted or ended without a checkpoint. Inspect saved work before continuing.',
          wait ? report.nextAt || null : after(report ? 0.1 : 5),
        );
      })();
    }
    g = s.one('SELECT * FROM goals WHERE id=?', g.id);
    const signal = s.setting('goal.signal.' + g.id);
    const pendingDecision = this.pendingDecision(g.id);
    if (pendingDecision && !['saved', 'paused', 'complete'].includes(this.policy(g.id).state)) {
      this.setState(
        g.id,
        pendingDecision.kind === 'question' ? 'needs_input' : 'needs_permission',
        pendingDecision.title || 'Waiting for your decision.',
      );
      return;
    }
    const waiting = this.policy(g.id);
    if (g.status === 'active' && ['needs_permission', 'waiting_external'].includes(waiting.state)) {
      const ids: string[] = s.setting('goal.wait.actions.' + g.id, []);
      const receipts = this.receipts(g.id);
      // Recover even when a crash happened after the receipt was saved but before its wake-up event.
      if (
        ids.length &&
        ids.every((id) =>
          receipts.some(
            (a: any) => a.actionId === id && !['awaiting_approval', 'running'].includes(a.status),
          ),
        )
      )
        this.setState(
          g.id,
          this.review.pending(g.id) ? 'checking' : 'queued',
          'The saved action results are ready to inspect.',
          now(),
        );
    }
    if (
      signal &&
      !signal.handled &&
      g.status === 'active' &&
      !['saved', 'paused', 'complete'].includes(this.policy(g.id).state)
    ) {
      this.setState(g.id, 'queued', 'A requested result is ready. The lead will review it.', now());
      s.set('goal.signal.' + g.id, { ...signal, handled: true });
    }
    const p = this.policy(g.id);
    if (
      g.status !== 'active' ||
      !['queued', 'scheduled', 'checking', 'waiting_external'].includes(p.state) ||
      !p.next_at ||
      Date.parse(p.next_at) > Date.now()
    )
      return;
    const { e, cid, threadId } = this.destination(g);
    // Human requests and other work retain priority. Never create overlapping sessions.
    if (
      s.one(
        "SELECT 1 FROM runs WHERE employee_id=? AND state IN ('accepted','dispatching','running','waiting_input','waiting_permission','cancelling')",
        e.id,
      ) ||
      s
        .all("SELECT id FROM runs WHERE employee_id=? AND state='provider_limited'", e.id)
        .some((run) => s.setting('run.autoResume.' + run.id, true)) ||
      s.one(
        "SELECT 1 FROM outbox WHERE employee_id=? AND status IN ('pending','new','claimed')",
        e.id,
      )
    )
      return;
    const recent = s.all(
      'SELECT started_at FROM goal_cycles WHERE goal_id=? AND started_at>=? ORDER BY started_at',
      g.id,
      new Date(Date.now() - 86400000).toISOString(),
    );
    if (p.daily_sessions > 0 && recent.length >= p.daily_sessions) {
      const nextAt = new Date(
        Date.parse(recent[recent.length - p.daily_sessions].started_at) + 86400000,
      ).toISOString();
      this.setState(
        g.id,
        'scheduled',
        'The work allowance is used. Work resumes when a session becomes available.',
        nextAt,
      );
      return;
    }
    s.db.transaction(() => {
      let review = this.review.pending(g.id);
      if (review && review.signature !== this.review.signature(g)) {
        this.review.clear(g.id);
        review = null;
      }
      const message = s.addMessage(
        cid,
        e.id,
        'Workspace',
        'system',
        review
          ? `Check completion of goal: ${g.title}.`
          : `Continue goal: ${g.title}. Read its latest state, make useful progress, and save a checkpoint.`,
        threadId,
        [],
        null,
        !!review,
      );
      if (review) this.review.attach(message.id, review);
      const jobId = uid();
      s.run(
        'INSERT INTO outbox VALUES(?,?,?,?,?,?)',
        jobId,
        message.id,
        e.id,
        g.owner_id,
        'pending',
        now(),
      );
      s.run(
        'INSERT INTO goal_cycles(message_id,goal_id,employee_id,outbox_id,created_at) VALUES(?,?,?,?,?)',
        message.id,
        g.id,
        e.id,
        jobId,
        now(),
      );
      const folder = s.setting('conversation.workingFolder.' + cid);
      if (folder) s.set('message.workingDirectory.' + message.id, folder);
      if (signal) {
        s.set('message.context.' + message.id, signal.context);
        s.run('DELETE FROM settings WHERE key=?', 'goal.signal.' + g.id);
      }
      if (!review && p.autonomy === 'research')
        s.set('delegation.purpose.' + message.id, 'research');
      this.setState(
        g.id,
        review ? 'checking' : 'queued',
        review ? 'Independently checking completion.' : 'Queued for the lead agent.',
        now(),
      );
    })();
  }
}
