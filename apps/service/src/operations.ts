import { z } from 'zod';
import { join } from 'node:path';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { Store, ApiError, uid, now } from './store.js';
import type { Supervisor } from './supervisor.js';
import Database from 'better-sqlite3';
import { startupInfo, setStartup } from './startup.js';
const proactiveInterval = 24 * 60 * 60 * 1000;
const proactiveIdleGrace = 2 * 60 * 1000;
const proactiveMaxFollowups = 2;

function tickProactiveReviews(s: Store, sup: Supervisor) {
  if (sup.maintenance) return;
  const clock = Date.now();
  for (const { id: userId } of s.all("SELECT id FROM humans WHERE role='owner'")) {
    if (!s.setting('workspace.onboarded', false)) continue;
    const purpose = s.setting('workspace.purpose', '');
    const objectives = s.setting('workspace.objectives.' + userId, purpose ? [purpose] : []);
    const employeeId =
      s.setting('workspace.chiefOfStaff.' + userId) ||
      s
        .all('SELECT id,data FROM employees WHERE owner_id=?', userId)
        .map((row) => ({ id: row.id, ...JSON.parse(row.data) }))
        .find((employee) => employee.name === 'Chief of Staff')?.id;
    const employee = employeeId && s.employee(employeeId);
    if (!Array.isArray(objectives) || !objectives.length || !employee || employee.deactivatedAt)
      continue;
    const conversation = s.one(
      "SELECT id FROM conversations WHERE employee_id=? AND kind='dm'",
      employeeId,
    );
    if (!conversation) continue;

    const stateKey = 'proactive.state.' + userId;
    const state = s.setting(stateKey, {
      nextAt: s.setting('proactive.nextAt.' + userId),
      idleSince: null,
      lastReviewAt: null,
      lastHumanAt: null,
      followup: false,
      chainDepth: 0,
    });
    const busy =
      s.one(
        "SELECT 1 FROM runs WHERE user_id=? AND state IN ('accepted','dispatching','running','waiting_input','waiting_permission','cancelling') LIMIT 1",
        userId,
      ) ||
      s.one(
        "SELECT 1 FROM outbox WHERE user_id=? AND status IN ('pending','new','claimed','steered') LIMIT 1",
        userId,
      );
    if (busy) {
      if (state.idleSince) s.set(stateKey, { ...state, idleSince: null });
      continue;
    }

    const idleSince = state.idleSince || now();
    if (!state.idleSince) {
      s.set(stateKey, { ...state, idleSince });
      continue;
    }
    if (clock - Date.parse(idleSince) < proactiveIdleGrace) continue;

    const latestHuman = s.one(
      "SELECT created_at,text FROM messages WHERE author_id=? AND kind='human' ORDER BY created_at DESC LIMIT 1",
      userId,
    );
    const acknowledgement =
      /^(?:thanks?(?:\s+(?:a lot|very much))?|thank you(?: so much)?|ok(?:ay)?|great|sounds good|got it|perfect|nice)[.!? ]*$/i;
    const newHumanActivity =
      !!latestHuman &&
      latestHuman.created_at > (state.lastReviewAt || '') &&
      !acknowledgement.test(latestHuman.text.trim());
    const due =
      state.followup || newHumanActivity || (state.nextAt && Date.parse(state.nextAt) <= clock);
    if (!due) continue;

    const chainDepth = state.followup
      ? Math.min(proactiveMaxFollowups, (state.chainDepth || 0) + 1)
      : newHumanActivity
        ? 0
        : state.chainDepth || 0;
    const reviewedAt = now();
    s.db.transaction(() => {
      const message = s.addMessage(
        conversation.id,
        'system',
        'Workspace',
        'system',
        'The workspace is idle. The Chief of Staff is checking for a useful next step toward your objectives.',
      );
      s.run(
        'INSERT INTO outbox VALUES(?,?,?,?,?,?)',
        uid(),
        message.id,
        employeeId,
        userId,
        'new',
        reviewedAt,
      );
      s.set('proactive.review.' + message.id, true);
      s.set(stateKey, {
        lastReviewAt: reviewedAt,
        lastHumanAt: latestHuman?.created_at || state.lastHumanAt,
        nextAt: new Date(clock + proactiveInterval).toISOString(),
        idleSince,
        followup: false,
        chainDepth,
      });
      return message;
    })();
    s.emit('workspace.changed', null, {}, userId);
  }
}

export function tickSchedules(s: Store, sup: Supervisor) {
  if (sup.maintenance) return;
  for (const row of s.all("SELECT id FROM runs WHERE state='provider_limited' ORDER BY updated_at"))
    void sup.resumeProviderLimited(row.id);
  for (const row of s.all('SELECT * FROM schedules WHERE enabled=1 AND next_at<=?', now())) {
    s.db.transaction(() => {
      const due = s.one(
        'SELECT * FROM schedules WHERE id=? AND enabled=1 AND next_at<=?',
        row.id,
        now(),
      );
      if (!due) return;
      const u = s.user(due.user_id);
      try {
        s.accept(u, due.conversation_id, {
          key: 'schedule.' + due.id + '.' + due.next_at,
          text: due.prompt,
          recipients: [due.employee_id],
          attachments: [],
          newTask: true,
        });
      } catch (e) {
        s.run('UPDATE schedules SET enabled=0 WHERE id=?', due.id);
        s.emit('workspace.changed', null, {}, u.id);
        s.emit(
          'schedule.failed',
          null,
          { id: due.id, error: e instanceof Error ? e.message : 'Schedule failed' },
          u.id,
        );
        return;
      }
      if (due.interval_minutes)
        s.run(
          'UPDATE schedules SET next_at=? WHERE id=?',
          new Date(Date.now() + due.interval_minutes * 60000).toISOString(),
          due.id,
        );
      else s.run('UPDATE schedules SET enabled=0 WHERE id=?', due.id);
      s.emit('workspace.changed', null, {}, u.id);
    })();
  }
  tickProactiveReviews(s, sup);
  void sup.dispatch();
}
export function registerOperations(app: any, s: Store, sup: Supervisor) {
  app.get('/api/startup', async (req: any) => {
    if (req.user.role !== 'owner') throw new ApiError(403, 'Owner access required');
    return startupInfo();
  });
  app.put('/api/startup', async (req: any) => {
    if (req.user.role !== 'owner') throw new ApiError(403, 'Owner access required');
    return setStartup(z.object({ enabled: z.boolean() }).parse(req.body).enabled);
  });
  app.get('/api/schedules', async (req: any) =>
    s.all('SELECT * FROM schedules WHERE user_id=?', req.user.id),
  );
  app.post('/api/schedules', async (req: any) => {
    const b = z
      .object({
        conversationId: z.string(),
        employeeId: z.string(),
        prompt: z.string().min(1).max(20000),
        nextAt: z.iso.datetime(),
        intervalMinutes: z.number().int().min(1).nullable().default(null),
      })
      .parse(req.body);
    s.authorize(req.user.id, b.conversationId);
    if (
      !s.canUseEmployee(req.user.id, b.employeeId) ||
      s.employee(b.employeeId)?.ownerId !== req.user.id
    )
      throw new ApiError(403, 'Employee unavailable');
    const id = uid();
    s.run(
      'INSERT INTO schedules VALUES(?,?,?,?,?,?,?,1)',
      id,
      req.user.id,
      b.conversationId,
      b.employeeId,
      b.prompt,
      b.nextAt,
      b.intervalMinutes,
    );
    s.emit('workspace.changed', null, {}, req.user.id);
    return { id };
  });
  app.patch('/api/schedules/:id', async (req: any) => {
    const b = z.object({ enabled: z.boolean() }).parse(req.body);
    s.run(
      'UPDATE schedules SET enabled=? WHERE id=? AND user_id=?',
      b.enabled ? 1 : 0,
      req.params.id,
      req.user.id,
    );
    s.emit('workspace.changed', null, {}, req.user.id);
    return { ok: true };
  });
  app.delete('/api/schedules/:id', async (req: any) => {
    s.run('DELETE FROM schedules WHERE id=? AND user_id=?', req.params.id, req.user.id);
    s.emit('workspace.changed', null, {}, req.user.id);
    return { ok: true };
  });
  app.get('/api/diagnostics', async (req: any) => {
    if (req.user.role !== 'owner') throw new ApiError(403, 'Owner access required');
    return {
      version: '0.1.0-preview',
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      activeRuns: sup.active.size,
      serviceMemory: process.memoryUsage(),
      counts: Object.fromEntries(
        ['messages', 'runs', 'events', 'attachments'].map((t) => [
          t,
          s.one(`SELECT COUNT(*) n FROM ${t}`).n,
        ]),
      ),
    };
  });
  app.post('/api/backups', async (req: any) => {
    if (req.user.role !== 'owner') throw new ApiError(403, 'Owner access required');
    const path = join(s.dir, 'backups', new Date().toISOString().replaceAll(':', '-'));
    mkdirSync(path, { recursive: true, mode: 0o700 });
    await s.db.backup(join(path, 'workspace.db'));
    const copy = new Database(join(path, 'workspace.db'));
    copy.exec(
      "DELETE FROM sessions; DELETE FROM invites; DELETE FROM subscriptions; DELETE FROM settings WHERE key='push.keys' OR key LIKE 'presence.%';",
    );
    copy.close();
    cpSync(join(s.dir, 'artifacts'), join(path, 'artifacts'), { recursive: true });
    writeFileSync(
      join(path, 'manifest.json'),
      JSON.stringify({
        version: 1,
        createdAt: now(),
        credentialsIncluded: false,
        workingRepositoriesIncluded: false,
      }),
    );
    return {
      path,
      message:
        'Saved conversations, settings and attachments. Provider credentials and working repositories are excluded.',
    };
  });
  const timer = setInterval(() => tickSchedules(s, sup), 30000);
  timer.unref();
  app.addHook('onReady', async () => tickSchedules(s, sup));
  app.addHook('onClose', async () => clearInterval(timer));
}
