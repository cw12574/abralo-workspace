import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { realpathSync, statSync, copyFileSync, existsSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, basename, extname, dirname } from 'node:path';
import { Store, uid, hash, now } from './store.js';
import { Supervisor } from './supervisor.js';
import { ConnectionBroker } from './connections.js';
import { execFileAsync, ensureDirectory } from '../../../packages/host/src/index.js';
import type { createMaintenance } from './maintenance.js';
import { Goals } from './goals.js';
import { reviewReport } from './goal-review.js';
import { goalReport } from './goal-runner.js';
import { Work } from './work.js';
import { ComputerUse } from './computer-use.js';
import { briefingReport } from './briefings.js';
export async function registerWorkspaceTools(
  app: any,
  s: Store,
  sup: Supervisor,
  broker: ConnectionBroker,
  maintenance?: ReturnType<typeof createMaintenance>,
  goals?: Goals,
  work?: Work,
  computer?: ComputerUse,
) {
  app.post('/mcp', async (req: any, reply: any) => {
    const bearer = req.headers.authorization?.replace(/^Bearer /, '');
    const runId = bearer ? sup.tokens.get(hash(bearer)) : null;
    const run = runId ? s.one('SELECT * FROM runs WHERE id=?', runId) : null;
    if (!run) return reply.code(401).send({ error: 'Run credential expired' });
    const briefingId = s.setting('briefing.message.' + run.message_id);
    if (
      briefingId &&
      req.body?.method === 'tools/call' &&
      ![
        'workspace_read',
        'workspace_goals',
        'workspace_find_memory',
        'workspace_briefing_report',
      ].includes(req.body?.params?.name)
    )
      return reply.send({
        jsonrpc: '2.0',
        id: req.body.id,
        result: {
          isError: true,
          content: [
            {
              type: 'text',
              text: 'Briefing preparation is read-only. Read your context and return workspace_briefing_report; work starts only after human review.',
            },
          ],
        },
      });
    const reviewing = goals?.runner.review.forMessage(run.message_id);
    if (
      reviewing &&
      req.body?.method === 'tools/call' &&
      ![
        'workspace_goals',
        'workspace_goal_review',
        'workspace_connection_status',
        'workspace_connection_tools',
        'workspace_connection_call',
        'workspace_connection_action',
        'workspace_browser',
      ].includes(req.body?.params?.name)
    )
      return reply.send({
        jsonrpc: '2.0',
        id: req.body.id,
        result: {
          isError: true,
          content: [
            {
              type: 'text',
              text: 'Independent review only permits reading evidence and submitting workspace_goal_review.',
            },
          ],
        },
      });
    const goalSession = s.one(
      'SELECT c.goal_id,c.cancelled,g.status FROM goal_cycles c JOIN goals g ON g.id=c.goal_id WHERE c.message_id=?',
      run.message_id,
    );
    if (goalSession && (goalSession.cancelled || goalSession.status !== 'active'))
      return reply
        .code(403)
        .send({ error: 'This goal was stopped. No further tools may start in this session.' });
    if (
      goalSession &&
      req.body?.method === 'tools/call' &&
      ['workspace_delegate', 'workspace_schedule', 'workspace_goal_create'].includes(
        req.body?.params?.name,
      )
    )
      return reply.send({
        jsonrpc: '2.0',
        id: req.body.id,
        result: {
          isError: true,
          content: [
            {
              type: 'text',
              text: 'Goal sessions use one lead and the existing goal allowance. Save a checkpoint for the workspace to continue.',
            },
          ],
        },
      });
    const employee = s.employee(run.employee_id)!;
    s.authorizeEmployee(employee.id, run.conversation_id);
    const server = new McpServer({ name: 'workspace', version: '0.1.0' });
    const result = (v: any) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v) }] });
    if (briefingId && sup.briefings)
      server.registerTool(
        'workspace_briefing_report',
        {
          description:
            'Return your understanding and at most one necessary work-specific question for this morning briefing. nextStep is a proposal for human review, never execution permission.',
          inputSchema: briefingReport.shape,
        },
        async (input) => result(sup.briefings!.report(run, input)),
      );
    if (reviewing && goals)
      server.registerTool(
        'workspace_goal_review',
        {
          description:
            'Submit the independent completion verdict. Passing requires direct evidence for every supplied criterion. Return concrete defects to the lead; ask for input only when a human answer is necessary.',
          inputSchema: reviewReport.shape,
        },
        async (input) => result(goals.runner.review.report(run, input)),
      );
    computer?.register(server, run, employee);
    server.registerTool(
      'workspace_maintenance',
      {
        description:
          'Prepare a local update or restart, inspect its saved result, or request explicit owner approval to execute a prepared job. Preparation persists immediately, then builds and verifies in the background without a free-RAM threshold. Supply sourceRoot and the pinned pnpmCli to build and test sequentially, or candidateRoot for an already packaged version. Inspect status until prepared before requesting execution. Preparation never restarts the app or limits agents. Execution returns a durable approval card immediately. Approval starts an independent helper and waits for active work to finish. You may finish the turn while the card is pending; it does not expire. Never use execution when the human asked only to build or prepare.',
        inputSchema: {
          action: z.enum(['status', 'prepare', 'execute']),
          candidateRoot: z.string().optional(),
          sourceRoot: z.string().optional(),
          pnpmCli: z.string().optional(),
          jobId: z.string().uuid().optional(),
        },
      },
      async ({ action, candidateRoot, sourceRoot, pnpmCli, jobId }) => {
        if (s.user(run.user_id)?.role !== 'owner' || !maintenance)
          return result({
            error: 'Owner access and an installed maintenance-capable build are required.',
          });
        if (action === 'status') return result(maintenance.status());
        if (s.setting('run.readOnly.' + run.id, false))
          return result({
            error: 'Maintenance changes are unavailable during a review or research task.',
          });
        if (action === 'prepare') {
          if (sourceRoot) {
            const roots = [s.setting('run.folder.' + run.id), s.setting('conversation.workingFolder.' + run.conversation_id), employee.cwd].filter(Boolean);
            const source = realpathSync(sourceRoot);
            if (!roots.some(root => { const rel = relative(realpathSync(root), source); return !rel.startsWith('..') && !isAbsolute(rel); }))
              return result({ error: 'Choose a source directory already authorized for this conversation.' });
          }
          return result(maintenance.prepare(candidateRoot, sourceRoot, pnpmCli));
        }
        if (!jobId) return result({ error: 'Prepare a job first.' });
        const current = maintenance.status();
        if (current.job?.id !== jobId || current.job.phase !== 'prepared')
          return result({ error: 'Prepare a fresh job before requesting approval.' });
        return result(
          sup.requestApproval(run.id, {
            kind: 'permission',
            actionType: 'maintenance',
            title: `Restart Abralo: ${current.job.from} → ${current.job.to}`,
            detail: {
              jobId,
              action: current.job.action,
              explanation:
                'Waits for active work, saves a verified backup, then hands restart to an independent helper. This approval stays available until you decide.',
            },
          }),
        );
      },
    );
    const postingActivity = (message: any, title: string) => {
      const conversation = s.one(
        'SELECT name FROM conversations WHERE id=?',
        message.conversationId,
      );
      const activity = {
        id: `${run.id}:post:${message.id}`,
        type: 'workspace_post',
        title: `${title} · ${conversation.name}`,
        state: 'complete',
        time: now(),
        url: `/?conversation=${message.conversationId}${message.threadId ? '&thread=' + message.threadId : ''}`,
        detail: message.text,
      };
      s.run(
        'INSERT OR REPLACE INTO activities VALUES(?,?,?)',
        activity.id,
        run.id,
        JSON.stringify(activity),
      );
      s.emit('activity.updated', run.conversation_id, { messageId: run.response_id, activity });
    };
    server.registerTool(
      'workspace_request_project_access',
      {
        description:
          'Request a local directory or GitHub repository only when no working folder is selected in this conversation’s composer. A folder selected there is already authorized and persists for this conversation. Never guess a local path or claim access before approval. Local folders must be existing directories. GitHub clone uses this machine’s configured Git credentials. After a new access grant, continue in a new chat turn because this run started in its previous working folder.',
        inputSchema: {
          type: z.enum(['directory', 'github_repo']),
          reason: z.string().min(1).max(1000),
          suggestedPath: z.string().max(2000).optional(),
          suggestedRepo: z.string().max(500).optional(),
        },
      },
      async ({ type, reason, suggestedPath, suggestedRepo }) => {
        const selectedDirectory = s.setting('message.workingDirectory.' + run.message_id);
        if (selectedDirectory)
          return result({
            status:
              'This conversation already has a persistent working folder selected in the composer. It is available for this and future turns; no additional folder-access request is needed.',
            path: selectedDirectory,
          });
        const resolution = await sup.decision(run.id, {
          kind: 'workspace_access',
          title: `${employee.name} requests ${type === 'directory' ? 'a local folder' : 'a GitHub repository'}`,
          detail: {
            type,
            employeeId: employee.id,
            employeeName: employee.name,
            reason,
            suggestedPath: type === 'directory' ? suggestedPath : undefined,
            suggestedRepo: type === 'github_repo' ? suggestedRepo : undefined,
          },
        });
        if (!resolution.allow) return result({ status: 'The human declined workspace access.' });
        let directory: string;
        if (type === 'directory') {
          if (typeof resolution.path !== 'string' || !resolution.path.trim())
            return result({ error: 'The human did not provide a local folder path.' });
          try {
            directory = realpathSync(resolve(resolution.path.trim()));
            if (!statSync(directory).isDirectory())
              return result({ error: 'That path is not a directory.' });
          } catch {
            return result({ error: 'That directory is unavailable on this machine.' });
          }
        } else {
          if (typeof resolution.repo !== 'string')
            return result({ error: 'A GitHub repository is required.' });
          const repo = resolution.repo.trim();
          const validHttps =
            /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?\/?$/i.test(repo);
          const validSsh = /^git@github\.com:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/i.test(
            repo,
          );
          if (!validHttps && !validSsh)
            return result({
              error:
                'Enter a GitHub repository URL such as https://github.com/owner/repo or git@github.com:owner/repo.git.',
            });
          const canonical = repo.replace(/\.git\/?$/i, '').toLowerCase();
          directory = join(s.dir, 'projects', employee.id, hash(canonical).slice(0, 24));
          if (!existsSync(join(directory, '.git'))) {
            ensureDirectory(dirname(directory));
            const temporary = directory + '.clone-' + uid();
            try {
              await execFileAsync(
                'git',
                ['clone', '--filter=blob:none', '--depth', '1', '--', repo, temporary],
                { windowsHide: true, timeout: 180000 },
              );
              const resolved = realpathSync(temporary);
              if (
                !resolved.startsWith(
                  realpathSync(dirname(directory)) + (process.platform === 'win32' ? '\\' : '/'),
                )
              )
                throw new Error('Clone path escaped the project folder.');
              const { renameSync } = await import('node:fs');
              renameSync(temporary, directory);
            } catch (error: any) {
              return result({
                error: `Could not clone that repository: ${String(error.message || error).slice(0, 500)}`,
              });
            }
          }
        }
        const latest = s.employee(employee.id);
        if (!latest || !s.canUseEmployee(run.user_id, employee.id))
          return result({ error: 'Employee access was revoked.' });
        s.run(
          'UPDATE employees SET data=? WHERE id=?',
          JSON.stringify({ ...latest, cwd: directory }),
          employee.id,
        );
        s.emit('workspace.changed', null, {}, run.user_id);
        s.addMessage(
          run.conversation_id,
          'system',
          'Workspace',
          'system',
          `${employee.name} can use ${directory} starting with the next run.`,
        );
        return result({
          status: 'Workspace access granted for the next run.',
          path: directory,
          next: 'Ask the human to send the next task in this conversation before working in that folder.',
        });
      },
    );
    server.registerTool(
      'workspace_publish_artifact',
      {
        description:
          'Attach a result file from this task working folder to your reply. People can preview common documents and source files inside ZIP archives; include a README.md or index.html in a ZIP deliverable so it is easy to inspect.',
        inputSchema: { path: z.string(), name: z.string().max(200).optional() },
      },
      async ({ path, name }) => {
        const folder = s.setting('run.folder.' + run.id);
        if (!folder) return result({ error: 'Working folder unavailable' });
        const root = realpathSync(folder),
          file = realpathSync(resolve(root, path)),
          rel = relative(root, file);
        if (rel.startsWith('..') || isAbsolute(rel))
          return result({ error: 'Only files inside this task folder can be published.' });
        const stat = statSync(file);
        if (!stat.isFile() || stat.size > 25 * 1024 * 1024)
          return result({ error: 'Publish a file smaller than 25 MB.' });
        const id = uid(),
          target = join(s.dir, 'artifacts', id),
          label = (name || basename(file)).replace(/[\\/\x00-\x1f]/g, '_');
        const mime =
          (
            {
              '.png': 'image/png',
              '.jpg': 'image/jpeg',
              '.jpeg': 'image/jpeg',
              '.webp': 'image/webp',
              '.gif': 'image/gif',
              '.pdf': 'application/pdf',
              '.zip': 'application/zip',
              '.txt': 'text/plain',
              '.md': 'text/plain',
            } as Record<string, string>
          )[extname(file).toLowerCase()] || 'application/octet-stream';
        copyFileSync(file, target);
        s.run(
          'INSERT INTO attachments VALUES(?,?,?,?,?,?,?,?)',
          id,
          run.user_id,
          run.conversation_id,
          label,
          mime,
          stat.size,
          target,
          now(),
        );
        const current = s.one('SELECT attachments FROM messages WHERE id=?', run.response_id);
        const attachments = [...JSON.parse(current.attachments), id];
        s.run(
          'UPDATE messages SET attachments=? WHERE id=?',
          JSON.stringify(attachments),
          run.response_id,
        );
        s.emit('artifact.created', run.conversation_id, {
          messageId: run.response_id,
          id,
          name: label,
        });
        return result({ id, name: label, url: '/api/attachments/' + id });
      },
    );
    server.registerTool(
      'workspace_team',
      {
        description: 'List available employees, their roles and IDs.',
        inputSchema: {},
      },
      async () =>
        result(
          s
            .all(
              'SELECT data FROM employees WHERE owner_id=? OR id IN (SELECT employee_id FROM employee_grants WHERE user_id=?)',
              run.user_id,
              run.user_id,
            )
            .map((r) => {
              const e = JSON.parse(r.data);
              return { id: e.id, name: e.name, role: e.role, harness: e.harness };
            }),
        ),
    );
    server.registerTool(
      'workspace_read',
      {
        description:
          'Read recent messages from an authorized conversation. Defaults to the current conversation.',
        inputSchema: { conversationId: z.string().optional(), threadId: z.string().optional() },
      },
      async ({ conversationId, threadId }) => {
        const id = conversationId || run.conversation_id;
        s.authorize(run.user_id, id);
        s.authorizeEmployee(employee.id, id);
        return result(s.messages(id, undefined, threadId || run.thread_id).slice(-25));
      },
    );
    server.registerTool(
      'workspace_mention_decision',
      {
        description:
          'When a live @mention arrives while you are already working, choose whether to handle it now or leave it queued. For handle_now, answer in the mention’s conversation/thread, then call complete with the message ID you posted. If you cannot safely finish it in this turn, choose queue. Unfinished claims return to the durable queue automatically.',
        inputSchema: {
          action: z.enum(['handle_now', 'queue', 'complete']),
          messageId: z.string(),
          replyMessageId: z.string().optional(),
        },
      },
      async ({ action, messageId, replyMessageId }) => {
        try {
          return result(await sup.mentionDecision(run.id, messageId, action, replyMessageId));
        } catch (error) {
          return result({ error: error instanceof Error ? error.message : String(error) });
        }
      },
    );
    server.registerTool(
      'workspace_post_message',
      {
        description:
          'Post a useful question, finding or result in your own conversation. Keep replies in the existing thread. Mentioning another employee does not start work.',
        inputSchema: {
          conversationId: z.string(),
          text: z.string().min(1).max(20000),
          threadId: z.string().nullable().optional(),
        },
      },
      async ({ conversationId, text, threadId }) => {
        s.authorize(run.user_id, conversationId);
        s.authorizeEmployee(employee.id, conversationId);
        const destinationThread =
          threadId === undefined && conversationId === run.conversation_id
            ? run.thread_id
            : threadId || null;
        if (
          destinationThread &&
          !s.one(
            'SELECT 1 FROM messages WHERE id=? AND conversation_id=? AND thread_id IS NULL',
            destinationThread,
            conversationId,
          )
        )
          throw new Error('Thread unavailable.');
        const message = s.addMessage(
          conversationId,
          employee.id,
          employee.name,
          'agent',
          text,
          destinationThread,
        );
        postingActivity(message, 'Posted');
        s.set('run.posted.' + run.id, true);
        return result({
          id: message.id,
          url:
            '/?conversation=' +
            conversationId +
            (message.threadId ? '&thread=' + message.threadId : ''),
        });
      },
    );
    server.registerTool(
      'workspace_schedule',
      {
        description: `Schedule your own work for a future time. Interpret relative dates in ${Intl.DateTimeFormat().resolvedOptions().timeZone} and pass an exact ISO 8601 timestamp with timezone offset. The scheduled work stays in this conversation and runs once. Schedule only when the human asked for work at a later time. If the request is ambiguous, clarify before scheduling.`,
        inputSchema: {
          at: z.iso.datetime(),
          prompt: z.string().trim().min(1).max(20000),
        },
      },
      async ({ at, prompt }) => {
        const atMs = Date.parse(at);
        if (!Number.isFinite(atMs) || atMs <= Date.now() + 30_000)
          return result({ error: 'Choose a future time at least 30 seconds from now.' });

        const destination = run.conversation_id;
        s.authorize(run.user_id, destination);
        s.authorizeEmployee(employee.id, destination);
        const duplicate = s.one(
          'SELECT id FROM schedules WHERE user_id=? AND conversation_id=? AND employee_id=? AND prompt=? AND next_at=? AND enabled=1',
          run.user_id,
          destination,
          employee.id,
          prompt,
          new Date(atMs).toISOString(),
        );
        const scheduleId = duplicate?.id || uid();
        s.db.transaction(() => {
          if (!duplicate)
            s.run(
              'INSERT INTO schedules VALUES(?,?,?,?,?,?,?,1)',
              scheduleId,
              run.user_id,
              destination,
              employee.id,
              prompt,
              new Date(atMs).toISOString(),
              null,
            );
        })();
        s.emit('workspace.changed', null, {}, run.user_id);
        const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        return result({
          id: scheduleId,
          conversationId: destination,
          scheduledFor: new Intl.DateTimeFormat('en-GB', {
            timeZone,
            dateStyle: 'full',
            timeStyle: 'short',
          }).format(new Date(atMs)),
          timeZone,
          status: duplicate ? 'Already scheduled' : 'Scheduled once',
        });
      },
    );
    if (employee.canDelegate)
      server.registerTool(
        'workspace_propose_team',
        {
          description:
            'Propose one or more new employees for the human to review when requested or when current work reveals a specific, recurring skill or capacity gap. This does not hire anyone; approval is still required. Each employee has a direct conversation. Include only the roles needed for the requested work.',
          inputSchema: {
            purpose: z.string(),
            employees: z
              .array(
                z.object({
                  name: z.string(),
                  role: z.string(),
                  harness: z.enum(['codex', 'claude', 'opencode']),
                  model: z.string().optional(),
                  instructions: z.string().optional(),
                }),
              )
              .min(1)
              .max(16),
          },
        },
        async ({ purpose, employees }) => {
          const proposals = s.setting('proposals.' + run.user_id, []);
          for (const p of proposals)
            if (p.conversationId === run.conversation_id && !p.approved) p.superseded = true;
          const proposal = {
            id: uid(),
            version: 1,
            purpose,
            conversationId: run.conversation_id,
            chiefId: employee.id,
            employees: employees.map((e) => ({
              ...e,
              model: e.model || '',
              instructions: e.instructions || '',
              cwd: employee.cwd,
            })),
            approved: false,
          };
          proposals.push(proposal);
          s.set('proposals.' + run.user_id, proposals);
          s.emit('proposal.created', run.conversation_id, proposal, run.user_id);
          return result({
            id: proposal.id,
            status: 'Awaiting human approval; do not claim employees have been created.',
          });
        },
      );
    if (employee.canDelegate)
      server.registerTool(
        'workspace_delegate',
        {
          description: `Send a focused task to an existing employee in their own conversation. Share only the task brief, never the private transcript. Returns immediately; a completed contribution is returned to this conversation.`,
          inputSchema: {
            employeeId: z.string(),
            task: z.string().min(1),
            purpose: z.enum(['review', 'research', 'execute']).default('execute'),
          },
        },
        async ({ employeeId, task, purpose }) => {
          if (s.setting('run.readOnly.' + run.id, false))
            return result({
              error:
                'This is a bounded review or research task. Return your findings to the requester.',
            });
          if (employeeId === employee.id)
            return result({ error: 'Use your current run for your own work.' });
          const lineage = s.setting('run.lineage.' + run.id, [employee.id]);
          if (lineage.includes(employeeId))
            return result({
              error:
                'This would create a circular assignment. Send a result or question in the conversation instead.',
            });
          if (lineage.length >= 5)
            return result({ error: 'The collaboration handoff depth limit was reached.' });
          const target = s.employee(employeeId);
          if (!target || !s.canUseEmployee(run.user_id, target.id))
            return result({ error: 'Employee unavailable' });
          const destination = s.one(
            "SELECT c.id FROM conversations c JOIN members m ON m.conversation_id=c.id WHERE c.kind='dm' AND c.employee_id=? AND m.user_id=?",
            target.id,
            run.user_id,
          )?.id;
          if (!destination) return result({ error: 'Employee conversation unavailable.' });

          s.authorize(run.user_id, destination);
          s.authorizeEmployee(target.id, destination);
          const operation = hash(run.id + destination + employeeId + task);
          if (s.setting('delegated.' + operation)) return result({ status: 'Already delegated' });
          const m = s.db.transaction(() => {
            const message = s.addMessage(
              destination,
              employee.id,
              employee.name,
              'agent',
              `@${target.name} — ${task}`,
              null,
            );
            s.run(
              'INSERT INTO outbox VALUES(?,?,?,?,?,?)',
              uid(),
              message.id,
              employeeId,
              run.user_id,
              'pending',
              now(),
            );
            s.set('delegated.' + operation, message.id);

            s.set('delegation.lineage.' + message.id, [...lineage, employeeId]);
            s.set('delegation.parent.' + message.id, { runId: run.id, employeeId: employee.id });
            s.set('delegation.purpose.' + message.id, purpose);
            return message;
          })();
          postingActivity(m, purpose === 'execute' ? 'Delegated' : 'Invited review');
          queueMicrotask(() => void sup.dispatch());
          return result({
            messageId: m.id,
            conversationId: destination,
            threadId: m.threadId,
            status: 'Delivered; do not claim completion until a result arrives.',
          });
        },
      );
    server.registerTool(
      'workspace_remember',
      {
        description:
          'Save a useful durable note with its message source. Use workspace scope for stable company, product, customer, pricing, goals, constraints or user preferences that should follow the work across conversations. Use conversation scope for local details. Never store credentials, secrets or permissions.',
        inputSchema: {
          content: z.string().max(8000),
          sourceId: z.string(),
          scope: z.enum(['conversation', 'workspace']).default('conversation'),
        },
      },
      async ({ content, sourceId, scope }) => {
        const source = s.one(
          'SELECT id,kind FROM messages WHERE id=? AND conversation_id=?',
          sourceId,
          run.conversation_id,
        );
        if (!source) return result({ error: 'Source must be a message in this conversation.' });
        if (scope === 'workspace' && source.kind !== 'human')
          return result({
            error: 'Workspace facts must cite a human message in this conversation.',
          });
        const ownerId = scope === 'workspace' ? run.user_id : null;
        const existing = s.one(
          'SELECT id FROM memories WHERE source_id=? AND scope=? AND owner_id IS ? AND deleted=0',
          sourceId,
          scope,
          ownerId,
        );
        const id = existing?.id || uid();
        s.db.transaction(() => {
          if (existing)
            s.run(
              'UPDATE memories SET content=?,version=version+1,created_at=? WHERE id=?',
              content,
              now(),
              id,
            );
          else
            s.run(
              'INSERT INTO memories(id,conversation_id,author_id,content,source_id,created_at,scope,owner_id) VALUES(?,?,?,?,?,?,?,?)',
              id,
              run.conversation_id,
              employee.id,
              content,
              sourceId,
              now(),
              scope,
              ownerId,
            );
          if (existing) s.run('DELETE FROM memory_fts WHERE id=?', id);
          s.run('INSERT INTO memory_fts VALUES(?,?)', id, content);
        })();
        s.emit('memory.saved', run.conversation_id, { id, content, sourceId });
        return result({ id });
      },
    );
    server.registerTool(
      'workspace_find_memory',
      {
        description: 'Search saved notes you are permitted to see.',
        inputSchema: { query: z.string().max(200) },
      },
      async ({ query }) => {
        const words = query.match(/[\p{L}\p{N}]+/gu) || [];
        if (!words.length) return result([]);
        return result(
          s.all(
            "SELECT n.* FROM memory_fts f JOIN memories n ON n.id=f.id WHERE memory_fts MATCH ? AND (n.conversation_id=? OR (n.scope='workspace' AND n.owner_id=?)) AND n.deleted=0 LIMIT 15",
            words.map((w) => '"' + w + '"').join(' OR '),
            run.conversation_id,
            run.user_id,
          ),
        );
      },
    );
    if (goals) {
      const goalForRun = (id: string) => {
        if (goalSession && goalSession.goal_id !== id)
          throw new Error('This session may only update its assigned goal.');
        const goal = goals.get(id, run.user_id);
        if (
          goal.leadAgentId !== employee.id &&
          !(goal.leadAgentId === null && goal.conversationId === run.conversation_id)
        )
          throw new Error(
            'This goal is led by another agent. Ask the human to change its lead if needed.',
          );
        return goal;
      };
      const canChangeGoal = () => {
        if (s.setting('run.readOnly.' + run.id, false))
          throw new Error('Goals cannot be changed during a review or research task.');
      };
      server.registerTool(
        'workspace_goals',
        {
          description:
            'Read durable goals you lead, including progress, next steps and checks. The human controls which agent leads each goal.',
          inputSchema: {},
        },
        async () => result(goals.listForAgent(run.user_id, employee.id, run.conversation_id)),
      );
      server.registerTool(
        'workspace_goal_create',
        {
          description:
            'Create a durable goal for requested work that needs a long-term outcome. Read existing goals first to avoid duplicates. Each employee may lead only one unfinished goal, including saved and paused goals. Stay within the requested scope; for a small one-off request, just do the work. ' +
            (employee.canDelegate
              ? 'The workspace assigns an available lead or creates an employee when capacity is full. Check the actual lead returned.'
              : 'This agent can create a goal only for itself. If already assigned, ask the human to use the Chief of Staff or Goals page for another goal.'),
          inputSchema: {
            title: z.string().min(1).max(240),
            success: z.string().min(1).max(240).optional(),
            current: z.string().max(2000).optional(),
            nextStep: z.string().max(2000).optional(),
            start: z
              .boolean()
              .default(false)
              .describe(
                'Use true for long-term work the human has asked you to execute; they do not need to explicitly request a goal. Use false for an idea saved for later. Creating a goal does not expand the task or its permissions.',
              ),
          },
        },
        async (input) => {
          canChangeGoal();
          return result(
            goals.create(run.user_id, {
              ...input,
              conversationId: run.conversation_id,
              sourceMessageId: run.message_id,
              ...(!employee.canDelegate ? { leadAgentId: employee.id } : {}),
            }),
          );
        },
      );
      server.registerTool(
        'workspace_goal_change',
        {
          description:
            'Update a durable goal after reading its current version. Keep its current position and next step accurate; pause or complete only when justified by evidence or the human request. Change the named lead only when the human asks; use workspace_team to find the agent ID.',
          inputSchema: {
            goalId: z.string().uuid(),
            version: z.number().int().positive(),
            title: z.string().min(1).max(240).optional(),
            success: z.string().min(1).max(240).optional(),
            current: z.string().max(2000).optional(),
            nextStep: z.string().max(2000).optional(),
            status: z.enum(['active', 'paused', 'complete']).optional(),
            leadAgentId: z.string().uuid().optional(),
          },
        },
        async ({ goalId, ...change }) => {
          canChangeGoal();
          const goal = goalForRun(goalId);
          if (
            !employee.canDelegate &&
            change.leadAgentId &&
            change.leadAgentId !== goal.leadAgentId
          )
            throw new Error(
              'Enable delegation in agent settings to assign work to another employee.',
            );
          if (change.status === 'complete')
            throw new Error(
              'Propose completion with workspace_goal_checkpoint and evidence; the workspace arranges independent review.',
            );
          return result(goals.change(goalId, run.user_id, change));
        },
      );
      server.registerTool(
        'workspace_goal_step',
        {
          description:
            'Add or update one clear step toward a goal. Describe how it will be checked. A done step requires a result or evidence.',
          inputSchema: {
            goalId: z.string().uuid(),
            stepId: z.string().uuid().optional(),
            title: z.string().min(1).max(240).optional(),
            doneWhen: z.string().max(2000).optional(),
            status: z.enum(['todo', 'doing', 'blocked', 'done']).optional(),
            evidence: z.string().max(2000).optional(),
          },
        },
        async ({ goalId, stepId, ...change }) => {
          canChangeGoal();
          goalForRun(goalId);
          return result(
            stepId
              ? goals.changeStep(goalId, stepId, run.user_id, change)
              : goals.addStep(goalId, run.user_id, {
                  title: change.title,
                  doneWhen: change.doneWhen,
                }),
          );
        },
      );
      server.registerTool(
        'workspace_goal_update',
        {
          description:
            'Record a dated, factual progress update with a result or evidence. Use this after material work, learning or a changed measurement.',
          inputSchema: {
            goalId: z.string().uuid(),
            summary: z.string().min(1).max(2000),
            evidence: z.string().max(2000).optional(),
          },
        },
        async ({ goalId, ...update }) => {
          canChangeGoal();
          goalForRun(goalId);
          return result(goals.addUpdate(goalId, run.user_id, employee.id, update));
        },
      );
      server.registerTool(
        'workspace_goal_checkpoint',
        {
          description:
            'Save the outcome of one active goal work session. The workspace continues after this run finishes: continue for a concrete next action, wait with nextAt for a scheduled review, needs_input for a durable user check-in, needs_permission for an existing approval, or complete to request independent verification with evidence. Optional facts and uncertainties preserve decision-relevant state; actionIds link waiting to existing external actions. Does not grant new authority or increase the work allowance.',
          inputSchema: { goalId: z.string().uuid(), ...goalReport.shape },
        },
        async ({ goalId, ...checkpoint }) => {
          goalForRun(goalId);
          return result(goals.runner.checkpoint(goalId, run, checkpoint));
        },
      );
    }
    if (work) {
      server.registerTool(
        'workspace_work_start',
        {
          description:
            'Create one compact work card for a substantial execution request. State what will count as done and how you will check it before implementing. Do not create one for a simple answer or tiny task.',
          inputSchema: {
            title: z.string().min(1).max(240),
            doneWhen: z.array(z.string().min(1).max(240)).min(1).max(6),
            proofPlan: z.array(z.string().min(1).max(240)).min(1).max(6),
            goalId: z.string().uuid().optional(),
          },
        },
        async (input) => {
          if (s.setting('run.readOnly.' + run.id, false))
            throw new Error('A review or research task cannot start implementation work.');
          if (goalSession && input.goalId && input.goalId !== goalSession.goal_id)
            throw new Error('This session may only work on its assigned goal.');
          return result(
            work.start(run, { ...input, goalId: input.goalId || goalSession?.goal_id }),
          );
        },
      );
      server.registerTool(
        'workspace_work_update',
        {
          description:
            'Keep an existing work card accurate. Record real check results and a concise summary. Mark complete only after at least one passing check; leave it waiting when a decision or another work session is needed.',
          inputSchema: {
            workId: z.string().uuid(),
            status: z.enum(['working', 'waiting', 'checking', 'complete']).optional(),
            summary: z.string().max(2000).optional(),
            checks: z
              .array(
                z.object({
                  label: z.string().min(1).max(240),
                  result: z.enum(['passed', 'failed', 'pending']),
                  detail: z.string().max(1000).optional(),
                }),
              )
              .max(12)
              .optional(),
          },
        },
        async ({ workId, ...change }) => {
          if (s.setting('run.readOnly.' + run.id, false))
            throw new Error('A review or research task cannot change implementation work.');
          return result(work.change(workId, run.user_id, run.conversation_id, change));
        },
      );
    }
    server.registerTool(
      'workspace_connection',
      {
        description:
          'Connect any service you need by name (e.g. "resend", "linear"), domain, or MCP server address. Call it yourself whenever a task needs the service. An account the human already connected is ready immediately. Otherwise the human sees one Sign in button with your reason, and this task resumes automatically after they sign in. The human may connect several accounts per service: you get their default unless you name one in account. If the connected account is the wrong one (for example the domain or data you need is not there), call again with newAccount: true; the human then picks another account or signs in to one. If it is unclear which account a task needs, ask the human. Never ask for secrets in chat.',
        inputSchema: {
          service: z.string().trim().min(2).max(300),
          reason: z
            .string()
            .trim()
            .max(200)
            .optional()
            .describe('Short phrase shown to the human, e.g. "check your email domain setup".'),
          access: z.enum(['read', 'write']).default('read'),
          account: z
            .string()
            .trim()
            .max(120)
            .optional()
            .describe('Name, email or connectionId of a specific connected account.'),
          newAccount: z
            .boolean()
            .default(false)
            .describe('Ask the human for a different account than the ones you can see.'),
        },
      },
      async ({ service, access, reason, account, newAccount }) =>
        result(await broker.requestAny(run, service, access, reason, { account, newAccount })),
    );
    server.registerTool(
      'workspace_connection_status',
      {
        description:
          'Read Abralo connection and grant status before asking for setup. Accepts account or setup-request IDs. Never creates a request.',
        inputSchema: {
          connectionId: z.string().optional(),
          service: z.string().trim().max(60).optional(),
        },
      },
      async ({ connectionId, service }) =>
        result(
          connectionId
            ? broker.status(connectionId, employee.id, run.user_id)
            : s
                .all(
                  'SELECT id FROM connections WHERE owner_id=?' + (service ? ' AND service=?' : ''),
                  run.user_id,
                  ...(service ? [service] : []),
                )
                .map((c) => broker.status(c.id, employee.id, run.user_id)),
        ),
    );
    server.registerTool(
      'workspace_connection_tools',
      {
        description:
          'Find tools on a granted account by name or task. Use query for large catalogs so only relevant definitions enter context. Refresh repairs stale discovery; it never changes grants.',
        inputSchema: {
          connectionId: z.string(),
          query: z.string().max(120).optional(),
          refresh: z.boolean().default(false),
        },
      },
      async ({ connectionId, query, refresh }) => {
        let status = broker.status(connectionId, employee.id, run.user_id);
        if (refresh && status.capabilities.length) {
          await broker.ensure(status.connectionId, run.user_id);
          status = broker.status(connectionId, employee.id, run.user_id);
        }
        const c = broker.resolve(connectionId, run.user_id);
        const available = status.status === 'ready' ? JSON.parse(c.data).tools || [] : [];
        const words = (query || '').toLocaleLowerCase().split(/\s+/).filter(Boolean);
        const score = (tool: any) => {
          const text = `${tool.name} ${tool.description || ''}`.toLocaleLowerCase();
          return words.filter((word: string) => text.includes(word)).length;
        };
        const matches = words.length
          ? available
              .map((tool: any) => ({ tool, score: score(tool) }))
              .filter((m: any) => m.score > 0)
              .sort((a: any, b: any) => b.score - a.score)
              .map((m: any) => m.tool)
          : available;
        return result({
          ...status,
          tools: matches.slice(0, 25),
          totalTools: available.length,
          matchedTools: matches.length,
          truncated: matches.length > 25,
        });
      },
    );
    server.registerTool(
      'workspace_connection_action',
      {
        description:
          'Read the durable status/result of a connected action. Pending means an Abralo approval, not a provider login. Never resubmit an unknown or pending action.',
        inputSchema: { actionId: z.string() },
      },
      async ({ actionId }) =>
        result(broker.actions.receipt(broker.actions.get(actionId, run.user_id, employee.id))),
    );
    server.registerTool(
      'workspace_connection_call',
      {
        description:
          'Read through a granted account or prepare a durable write approval in Abralo. Writes return an actionId immediately; approval executes exactly the saved arguments. Use workspace_connection_action for its result, never reconnect or resubmit. The human sees each approval as a card, so do not tell them about approvals in your reply.',
        inputSchema: {
          connectionId: z.string(),
          tool: z.string(),
          arguments: z.record(z.string(), z.any()).default({}),
        },
      },
      async ({ connectionId, tool, arguments: args }) => {
        const access = broker.access(connectionId, employee.id, run.user_id, tool);
        if (!access.read) return result(broker.actions.request(run, connectionId, tool, args));
        return result(await broker.call(connectionId, employee.id, run.user_id, tool, args));
      },
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });
  app.get('/api/connections', async (req: any) =>
    s
      .all(
        'SELECT id,service,label,state,data FROM connections WHERE owner_id=? ORDER BY rowid',
        req.user.id,
      )
      .map((c) => {
        const data = JSON.parse(c.data);
        const accounts = broker.accountSummary(req.user.id, c.service);
        return {
          ...c,
          data,
          account: broker.accountName(c),
          ...(c.state === 'ready'
            ? {
                isDefault: accounts.find((a) => a.connectionId === c.id)?.isDefault || false,
                // Who can use this account, so the page shows one row per account.
                usedBy: s
                  .all(
                    "SELECT e.id,json_extract(e.data,'$.name') name FROM grants g JOIN employees e ON e.id=g.employee_id WHERE g.connection_id=? ORDER BY name",
                    c.id,
                  )
                  .filter((e: any) => s.canUseEmployee(req.user.id, e.id))
                  .map((e: any) => ({ id: e.id, name: e.name })),
              }
            : { accounts }),
          accountCount: accounts.length,
        };
      }),
  );
}
