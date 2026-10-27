import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { realpathSync, statSync, copyFileSync, existsSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, basename, extname, dirname } from 'node:path';
import { Store, uid, hash, now, capitalizeInitial } from './store.js';
import { Supervisor } from './supervisor.js';
import { ConnectionBroker } from './connections.js';
import { execFileAsync, ensureDirectory } from '../../../packages/host/src/index.js';
import { collaborationRoom, mentionedEmployees } from './room-routing.js';
import { postKickoff } from './team-handoff.js';
import type { createMaintenance } from './maintenance.js';
import { Goals } from './goals.js';
import { Work } from './work.js';
import { ComputerUse } from './computer-use.js';
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
    const employee = s.employee(run.employee_id)!;
    s.authorizeEmployee(employee.id, run.conversation_id);
    const server = new McpServer({ name: 'workspace', version: '0.1.0' });
    const result = (v: any) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v) }] });
    computer?.register(server, run, employee);
    server.registerTool(
      'workspace_maintenance',
      {
        description:
          'Prepare a local update or restart, inspect its saved result, or request explicit owner approval to execute a prepared job. Preparation never restarts the app. Execution starts an independent helper and waits for active work (including this turn) to finish. End your turn after a successful handoff. Never use execution when the human asked only to build or prepare.',
        inputSchema: {
          action: z.enum(['status', 'prepare', 'execute']),
          candidateRoot: z.string().optional(),
          jobId: z.string().uuid().optional(),
        },
      },
      async ({ action, candidateRoot, jobId }) => {
        if (s.user(run.user_id)?.role !== 'owner' || !maintenance)
          return result({
            error: 'Owner access and an installed maintenance-capable build are required.',
          });
        if (action === 'status') return result(maintenance.status());
        if (s.setting('run.readOnly.' + run.id, false))
          return result({
            error: 'Maintenance changes are unavailable during a review or research task.',
          });
        if (action === 'prepare') return result(maintenance.prepare(candidateRoot));
        if (!jobId) return result({ error: 'Prepare a job first.' });
        const current = maintenance.status();
        if (current.job?.id !== jobId || current.job.phase !== 'prepared')
          return result({ error: 'Prepare a fresh job before requesting approval.' });
        const decision = await sup.decision(run.id, {
          kind: 'permission',
          title: `Restart Abralo: ${current.job.from} → ${current.job.to}`,
          detail: {
            jobId,
            action: current.job.action,
            explanation:
              'Waits for active work, saves a verified backup, then hands restart to an independent helper.',
          },
        });
        if (!decision.allow)
          return result({ error: 'Declined. The running app was left unchanged.' });
        return result(await maintenance.execute(jobId));
      },
    );
    const postingActivity = (message: any, title: string) => {
      const room = s.one('SELECT name FROM conversations WHERE id=?', message.conversationId);
      const activity = {
        id: `${run.id}:post:${message.id}`,
        type: 'workspace_post',
        title: `${title} · ${room.name}`,
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
        description:
          'List employees you can delegate to. Their IDs are needed for a direct handoff.',
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
      'workspace_activity',
      {
        description:
          'Scan recent messages in shared channels you are authorized to read. Use when a human asks about open work, blockers, or follow-ups. This returns a compact recent snapshot; use workspace_read for a relevant thread or room before acting. Private direct messages are never included.',
        inputSchema: { maxRooms: z.number().int().min(1).max(20).default(6) },
      },
      async ({ maxRooms }) => {
        const rooms = s.all(
          `SELECT c.id,c.name,COALESCE(MAX(CASE WHEN msg.kind!='system' THEN msg.created_at END),c.created_at) lastActivity
           FROM conversations c
           JOIN members m ON m.conversation_id=c.id AND m.user_id=?
           JOIN employee_conversations ec ON ec.conversation_id=c.id AND ec.employee_id=?
           LEFT JOIN messages msg ON msg.conversation_id=c.id AND msg.thread_id IS NULL
           WHERE c.kind='channel' GROUP BY c.id,c.name,c.created_at ORDER BY lastActivity DESC LIMIT ?`,
          run.user_id,
          employee.id,
          maxRooms,
        );
        const activity = rooms.flatMap((room) =>
          s
            .messages(room.id, undefined, undefined, true)
            .filter((message) => message.kind !== 'system' && message.text.trim())
            .slice(-4)
            .map((message) => ({
              conversationId: room.id,
              room: room.name,
              messageId: message.id,
              threadId: message.threadId,
              author: message.authorName,
              kind: message.kind,
              createdAt: message.createdAt,
              text: message.text.slice(0, 600),
            })),
        );
        return result(activity.sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
      },
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
        if (
          id !== run.conversation_id &&
          !s.one(
            'SELECT 1 FROM employee_conversations WHERE employee_id=? AND conversation_id=?',
            employee.id,
            id,
          )
        )
          return result({
            error:
              'Only the current conversation is available to this run. Ask the human to share other context here.',
          });
        return result(s.messages(id, undefined, threadId || run.thread_id).slice(-25));
      },
    );
    server.registerTool(
      'workspace_create_channel',
      {
        description:
          'Create a channel for the requested work. New channels include the requesting human and you; additional trusted humans can be selected by ID. No private messages are copied. You must provide the purpose and write the opening post; it is published as your first authored message as part of channel creation. If you add agents, each receives a role-specific welcome and concrete first task in that post.',
        inputSchema: {
          name: z.string().min(1).max(80),
          purpose: z.string().min(1).max(1000),
          openingPost: z.string().min(1).max(4000),
          humans: z.array(z.string()).default([]),
          employees: z.array(z.string()).default([]),
        },
      },
      async ({ name, purpose, openingPost, humans, employees }) => {
        const id = uid();
        name = capitalizeInitial(name.trim());
        const invitees: any[] = [];
        s.db.transaction(() => {
          s.run('INSERT INTO conversations VALUES(?,?,?,?,?)', id, name, 'channel', null, now());
          for (const human of new Set([run.user_id, ...humans])) {
            if (!s.user(human)) throw new Error('Unknown human');
            s.run('INSERT INTO members(conversation_id,user_id) VALUES(?,?)', id, human);
            s.emit('workspace.changed', null, {}, human);
          }
          s.run('INSERT INTO employee_conversations VALUES(?,?)', employee.id, id);
          for (const employeeId of employees) {
            if (!s.canUseEmployee(run.user_id, employeeId)) throw new Error('Employee unavailable');
            s.run('INSERT OR IGNORE INTO employee_conversations VALUES(?,?)', employeeId, id);
            const invited = s.employee(employeeId);
            if (invited && invited.id !== employee.id) invitees.push(invited);
          }
          postKickoff(
            s,
            s.user(run.user_id),
            employee,
            id,
            `${openingPost.trim()}\n\nRoom purpose: ${purpose.trim()}`,
            invitees.map((invited) => ({
              employee: invited,
              purpose,
              task: `Welcome. Your role is ${invited.role}. Please take the first useful step toward this room’s purpose, share your progress here, and flag any blocker early.`,
            })),
          );
        })();
        if (invitees.length) queueMicrotask(() => void sup.dispatch());
        return result({ id, name });
      },
    );
    server.registerTool(
      'workspace_mention_decision',
      {
        description:
          'When a live @mention arrives while you are already working, choose whether to handle it now or leave it queued. For handle_now, answer in the mention’s shared room/thread, then call complete with the message ID you posted. If you cannot safely finish it in this turn, choose queue. Unfinished claims return to the durable queue automatically.',
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
          'Post a useful question, finding or result. @mentioning an existing employee in a shared room creates a durable task for them: they should join the discussion in the same thread, acknowledge it, and do useful requested work when appropriate. A bare acknowledgment is not enough when action is requested. If they are busy, it is queued and may be offered to their active Codex turn to decide whether to handle now or queue. From a private DM, an agent-directed post is routed to the most relevant shared room (or Team) and only the text you post is shared. Use workspace_delegate when you need an explicitly bounded review/research/execute contribution. Keep replies in the existing thread. Do not narrate routine tool work here.',
        inputSchema: {
          conversationId: z.string(),
          text: z.string().min(1).max(20000),
          threadId: z.string().nullable().optional(),
        },
      },
      async ({ conversationId, text, threadId }) => {
        s.authorize(run.user_id, conversationId);
        const originalDestination = conversationId;
        const kind = s.one('SELECT kind FROM conversations WHERE id=?', conversationId)?.kind;
        const taggedEmployees = mentionedEmployees(s, run.user_id, text).filter(
          (target) => target.id !== employee.id,
        );
        const lineage = s.setting('run.lineage.' + run.id, [employee.id]);
        const mentionTargets =
          !s.setting('run.readOnly.' + run.id, false) && lineage.length < 5
            ? taggedEmployees.filter((target) => !lineage.includes(target.id))
            : [];
        if (kind !== 'channel' && taggedEmployees.length)
          conversationId = collaborationRoom(s, run, text);
        s.authorizeEmployee(employee.id, conversationId);
        if (
          !s.one(
            'SELECT 1 FROM employee_conversations WHERE employee_id=? AND conversation_id=?',
            employee.id,
            conversationId,
          ) &&
          conversationId !== run.conversation_id
        )
          return result({ error: 'You are not a member of this channel.' });
        if (
          taggedEmployees.length &&
          s.one('SELECT kind FROM conversations WHERE id=?', conversationId)?.kind !== 'channel'
        )
          return result({ error: 'Messages to other employees must be posted in a shared room.' });
        const destinationThread =
          conversationId !== originalDestination
            ? null
            : threadId === undefined && conversationId === run.conversation_id
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
        for (const target of taggedEmployees)
          if (!s.canUseEmployee(run.user_id, target.id))
            return result({ error: `Employee unavailable: ${target.name}` });
        const m = s.db.transaction(() => {
          for (const target of mentionTargets)
            s.run(
              'INSERT OR IGNORE INTO employee_conversations VALUES(?,?)',
              target.id,
              conversationId,
            );
          const message = s.addMessage(
            conversationId,
            employee.id,
            employee.name,
            'agent',
            text,
            destinationThread,
          );
          for (const target of mentionTargets) {
            const outboxId = uid();
            s.run(
              'INSERT INTO outbox VALUES(?,?,?,?,?,?)',
              outboxId,
              message.id,
              target.id,
              run.user_id,
              'pending',
              now(),
            );
            s.set('outbox.mention.' + outboxId, true);
            s.set(`delegation.lineage.${message.id}.${target.id}`, [...lineage, target.id]);
            s.set(`delegation.parent.${message.id}.${target.id}`, {
              runId: run.id,
              employeeId: employee.id,
            });
          }
          return message;
        })();
        postingActivity(m, 'Posted');
        s.set('run.posted.' + run.id, true);
        queueMicrotask(() => void sup.dispatch());
        const response: any = {
          id: m.id,
          url: `/?conversation=${conversationId}${m.threadId ? '&thread=' + m.threadId : ''}`,
          ...(originalDestination !== conversationId ? { routedFrom: originalDestination } : {}),
          queuedMentions: mentionTargets.map((target) => target.name),
        };
        if (taggedEmployees.length > mentionTargets.length) {
          const reason = s.setting('run.readOnly.' + run.id, false)
            ? 'This bounded review/research run cannot start additional work.'
            : lineage.length >= 5
              ? 'The collaboration handoff depth limit was reached.'
              : 'This agent is already earlier in the same collaboration path.';
          response.unqueuedMentions = taggedEmployees
            .filter((target) => !mentionTargets.some((queued) => queued.id === target.id))
            .map((target) => ({ name: target.name, reason }));
        }
        return result(response);
      },
    );
    server.registerTool(
      'workspace_schedule',
      {
        description: `Schedule your own work for a future time. Interpret relative dates in ${Intl.DateTimeFormat().resolvedOptions().timeZone} and pass an exact ISO 8601 timestamp with timezone offset. Choose the current shared room; if this run is in a private DM, route the scheduled work to the most relevant shared room. The scheduled run is visible there and runs once. Schedule only when the human asked for work at a later time. If the request is ambiguous, clarify before scheduling.`,
        inputSchema: {
          at: z.iso.datetime(),
          prompt: z.string().trim().min(1).max(20000),
        },
      },
      async ({ at, prompt }) => {
        const atMs = Date.parse(at);
        if (!Number.isFinite(atMs) || atMs <= Date.now() + 30_000)
          return result({ error: 'Choose a future time at least 30 seconds from now.' });

        const currentKind = s.one(
          'SELECT kind FROM conversations WHERE id=?',
          run.conversation_id,
        )?.kind;
        const destination =
          currentKind === 'channel' ? run.conversation_id : collaborationRoom(s, run, prompt);
        s.authorize(run.user_id, destination);
        s.authorizeEmployee(employee.id, destination);
        if (s.one('SELECT kind FROM conversations WHERE id=?', destination)?.kind !== 'channel')
          return result({ error: 'Scheduled work needs a shared room.' });
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
    server.registerTool(
      'workspace_propose_team',
      {
        description:
          'Propose a small workforce for the human to review when requested or when current work reveals a specific, recurring skill or capacity gap. This does not hire anyone; approval is still required. For distinct projects, include one room per project in rooms and assign proposed employees by zero-based employeeIndexes. Keep the Chief of Staff in every room. Avoid duplicating employees across rooms unless their role truly serves both. The approval card shows the team and project room membership together.',
        inputSchema: {
          purpose: z.string(),
          channelName: z.string().min(1).max(80).optional(),
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
          rooms: z
            .array(
              z.object({
                name: z.string().trim().min(1).max(80),
                purpose: z.string().trim().min(1).max(1000),
                employeeIndexes: z.array(z.number().int().min(0).max(15)).min(1).max(16),
              }),
            )
            .max(8)
            .default([]),
        },
      },
      async ({ purpose, employees, channelName, rooms }) => {
        if (rooms.some((room) => room.employeeIndexes.some((index) => index >= employees.length)))
          return result({ error: 'Each project room must reference a proposed employee.' });
        const roomNames = rooms.map((room) => room.name.toLocaleLowerCase());
        if (new Set(roomNames).size !== roomNames.length)
          return result({ error: 'Give every project room a distinct name.' });
        const proposals = s.setting('proposals.' + run.user_id, []);
        for (const p of proposals)
          if (p.conversationId === run.conversation_id && !p.approved) p.superseded = true;
        const proposal = {
          id: uid(),
          version: 1,
          purpose,
          conversationId: run.conversation_id,
          chiefId: employee.id,
          channelName,
          rooms,
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
    server.registerTool(
      'workspace_delegate',
      {
        description: `Send a focused task to an existing employee in a shared room. From a private DM, the task is routed to the most relevant shared room (or Team). Share only the task brief, never the private transcript. Returns immediately; completion appears in the destination room/thread.`,
        inputSchema: {
          employeeId: z.string(),
          task: z.string().min(1),
          conversationId: z.string().optional(),
          purpose: z.enum(['review', 'research', 'execute']).default('execute'),
        },
      },
      async ({ employeeId, task, conversationId, purpose }) => {
        if (s.setting('run.readOnly.' + run.id, false))
          return result({
            error:
              'This is a bounded review or research task. Return your findings to the requester.',
          });
        let destination = conversationId || run.conversation_id;
        s.authorize(run.user_id, destination);
        if (s.one('SELECT kind FROM conversations WHERE id=?', destination)?.kind !== 'channel')
          destination = collaborationRoom(s, run, task);
        s.authorizeEmployee(employee.id, destination);
        if (s.one('SELECT kind FROM conversations WHERE id=?', destination)?.kind !== 'channel')
          return result({
            error:
              'Delegation requires a shared channel. Use workspace_create_channel or the default team channel.',
            teamChannelId: s.setting('workspace.team'),
          });
        if (
          destination !== run.conversation_id &&
          !s.one(
            'SELECT 1 FROM employee_conversations WHERE employee_id=? AND conversation_id=?',
            employee.id,
            destination,
          )
        )
          return result({ error: 'You are not a member of this conversation.' });
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
        const operation = hash(run.id + destination + employeeId + task);
        if (s.setting('delegated.' + operation)) return result({ status: 'Already delegated' });
        const m = s.db.transaction(() => {
          const message = s.addMessage(
            destination,
            employee.id,
            employee.name,
            'agent',
            `@${target.name} — ${task}`,
            destination === run.conversation_id ? run.thread_id || run.message_id : null,
          );
          if (destination === run.conversation_id) {
            const workingDirectory = s.setting('message.workingDirectory.' + run.message_id);
            if (workingDirectory) s.set('message.workingDirectory.' + message.id, workingDirectory);
            const modelOverride = s.setting('message.modelOverride.' + run.message_id);
            if (modelOverride) s.set('message.modelOverride.' + message.id, modelOverride);
          }
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
          s.run(
            'INSERT OR IGNORE INTO employee_conversations VALUES(?,?)',
            employeeId,
            destination,
          );
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
          'Save a useful durable note with its message source. Use workspace scope for stable company, product, customer, pricing, goals, constraints or user preferences that should follow the work across rooms. Use conversation scope for local details. Never store credentials, secrets or permissions.',
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
        const goal = goals.get(id, run.user_id);
        if (s.one('SELECT kind FROM conversations WHERE id=?', run.conversation_id)?.kind === 'channel' &&
            goal.conversationId !== run.conversation_id)
          throw new Error('A private goal cannot be used in a shared room.');
        if (goal.leadAgentId !== employee.id &&
            !(goal.leadAgentId === null && goal.conversationId === run.conversation_id))
          throw new Error('This goal is led by another agent. Ask the human to change its lead if needed.');
        return goal;
      };
      const canChangeGoal = () => {
        if (s.setting('run.readOnly.' + run.id, false))
          throw new Error('Goals cannot be changed during a review or research task.');
      };
      server.registerTool('workspace_goals', {
        description: 'Read durable goals you lead, including progress, next steps and checks. The human controls which agent leads each goal.',
        inputSchema: {},
      }, async () => result(goals.listForAgent(run.user_id, employee.id, run.conversation_id)));
      server.registerTool('workspace_goal_create', {
        description: 'Create a durable goal when the human asks for an ongoing outcome across multiple work sessions. For a small one-off request, just do the work. State what success looks like and the next concrete step in plain language.',
        inputSchema: { title: z.string().min(1).max(240), success: z.string().min(1).max(240), current: z.string().max(2000).optional(), nextStep: z.string().max(2000).optional() },
      }, async (input) => {
        canChangeGoal();
        return result(goals.create(run.user_id, { ...input, conversationId: run.conversation_id, sourceMessageId: run.message_id, leadAgentId: employee.id }));
      });
      server.registerTool('workspace_goal_change', {
        description: 'Update a durable goal after reading its current version. Keep its current position and next step accurate; pause or complete only when justified by evidence or the human request. Change the named lead only when the human asks; use workspace_team to find the agent ID.',
        inputSchema: { goalId: z.string().uuid(), version: z.number().int().positive(), title: z.string().min(1).max(240).optional(), success: z.string().min(1).max(240).optional(), current: z.string().max(2000).optional(), nextStep: z.string().max(2000).optional(), status: z.enum(['active', 'paused', 'complete']).optional(), leadAgentId: z.string().uuid().optional() },
      }, async ({ goalId, ...change }) => {
        canChangeGoal(); goalForRun(goalId);
        return result(goals.change(goalId, run.user_id, change));
      });
      server.registerTool('workspace_goal_step', {
        description: 'Add or update one clear step toward a goal. Describe how it will be checked. A done step requires a result or evidence.',
        inputSchema: { goalId: z.string().uuid(), stepId: z.string().uuid().optional(), title: z.string().min(1).max(240).optional(), doneWhen: z.string().max(2000).optional(), status: z.enum(['todo', 'doing', 'blocked', 'done']).optional(), evidence: z.string().max(2000).optional() },
      }, async ({ goalId, stepId, ...change }) => {
        canChangeGoal(); goalForRun(goalId);
        return result(stepId
          ? goals.changeStep(goalId, stepId, run.user_id, change)
          : goals.addStep(goalId, run.user_id, { title: change.title, doneWhen: change.doneWhen }));
      });
      server.registerTool('workspace_goal_update', {
        description: 'Record a dated, factual progress update with a result or evidence. Use this after material work, learning or a changed measurement.',
        inputSchema: { goalId: z.string().uuid(), summary: z.string().min(1).max(2000), evidence: z.string().max(2000).optional() },
      }, async ({ goalId, ...update }) => {
        canChangeGoal(); goalForRun(goalId);
        return result(goals.addUpdate(goalId, run.user_id, employee.id, update));
      });
    }
    if (work) {
      server.registerTool('workspace_work_start', {
        description: 'Create one compact work card for a substantial execution request. State what will count as done and how you will check it before implementing. Do not create one for a simple answer or tiny task.',
        inputSchema: { title: z.string().min(1).max(240), doneWhen: z.array(z.string().min(1).max(240)).min(1).max(6), proofPlan: z.array(z.string().min(1).max(240)).min(1).max(6), goalId: z.string().uuid().optional() },
      }, async (input) => {
        if (s.setting('run.readOnly.' + run.id, false)) throw new Error('A review or research task cannot start implementation work.');
        return result(work.start(run, input));
      });
      server.registerTool('workspace_work_update', {
        description: 'Keep an existing work card accurate. Record real check results and a concise summary. Mark complete only after at least one passing check; leave it waiting when a decision or another work session is needed.',
        inputSchema: { workId: z.string().uuid(), status: z.enum(['working', 'waiting', 'checking', 'complete']).optional(), summary: z.string().max(2000).optional(), checks: z.array(z.object({ label: z.string().min(1).max(240), result: z.enum(['passed', 'failed', 'pending']), detail: z.string().max(1000).optional() })).max(12).optional() },
      }, async ({ workId, ...change }) => {
        if (s.setting('run.readOnly.' + run.id, false)) throw new Error('A review or research task cannot change implementation work.');
        return result(work.change(workId, run.user_id, run.conversation_id, change));
      });
    }
    server.registerTool(
      'workspace_connection',
      {
        description:
          'Request a supported connection through the conversation. Reuses a granted existing account when available; otherwise creates an inline setup request.',
        inputSchema: {
          service: z.enum(['railway', 'stripe', 'gmail']),
          access: z.enum(['read', 'write']).default('read'),
        },
      },
      async ({ service, access }) => result(broker.request(run, service, access)),
    );
    server.registerTool(
      'workspace_connection_status',
      {
        description:
          'Read Abralo connection and grant status before asking for setup. Accepts account or setup-request IDs. Never creates a request.',
        inputSchema: {
          connectionId: z.string().optional(),
          service: z.enum(['railway', 'stripe', 'gmail']).optional(),
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
        inputSchema: { connectionId: z.string(), query: z.string().max(120).optional(), refresh: z.boolean().default(false) },
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
        const matches = words.length
          ? available.filter((tool: any) => words.every((word: string) => `${tool.name} ${tool.description || ''}`.toLocaleLowerCase().includes(word)))
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
          'Read through a granted account or prepare a durable write approval in Abralo. Writes return an actionId immediately; approval executes exactly the saved arguments. Use workspace_connection_action for its result, never reconnect or resubmit.',
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
      .all('SELECT id,service,label,state,data FROM connections WHERE owner_id=?', req.user.id)
      .map((c) => ({ ...c, data: JSON.parse(c.data) })),
  );
}
