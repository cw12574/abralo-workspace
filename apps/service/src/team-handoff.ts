import { Store, uid, now, capitalizeInitial } from './store.js';

type KickoffAssignment = { employee: any; task: string; purpose?: string };

// A room kickoff is a Chief-authored post and the durable first assignment for each named agent.
export function postKickoff(
  s: Store,
  user: any,
  chief: any,
  conversationId: string,
  intro: string,
  assignments: KickoffAssignment[],
) {
  for (const { employee } of assignments)
    s.run('INSERT OR IGNORE INTO employee_conversations VALUES(?,?)', employee.id, conversationId);
  const text = [
    intro,
    ...assignments.map(({ employee, task }) => `@${employee.name} — ${task}`),
  ].join('\n\n');
  const message = s.addMessage(conversationId, chief.id, chief.name, 'agent', text);
  for (const { employee, purpose } of assignments) {
    const outboxId = uid();
    s.run(
      'INSERT INTO outbox VALUES(?,?,?,?,?,?)',
      outboxId,
      message.id,
      employee.id,
      user.id,
      'pending',
      now(),
    );
    s.set('outbox.mention.' + outboxId, true);
    s.set('delegation.lineage.' + message.id + '.' + employee.id, [chief.id, employee.id]);
    if (purpose) s.set('delegation.purpose.' + message.id, purpose);
  }
  return message;
}

// Runs within the proposal transaction: approval retries cannot hire or brief twice.
export function handoffTeam(s: Store, user: any, proposal: any) {
  if (proposal.handoffMessageId) return;
  const chief = s.employee(
    proposal.chiefId ||
      s.one('SELECT employee_id FROM conversations WHERE id=?', proposal.conversationId)
        ?.employee_id,
  );
  if (!chief || !s.canUseEmployee(user.id, chief.id)) return;
  const channelId =
    !proposal.rooms?.length && proposal.channelName && proposal.channelName.toLowerCase() !== 'team'
      ? uid()
      : s.ensureTeam();
  const base = capitalizeInitial(proposal.channelName || 'Team');
  let name = base,
    suffix = 2;
  if (channelId !== s.setting('workspace.team')) {
    while (s.one('SELECT id FROM conversations WHERE name=? AND kind=?', name, 'channel'))
      name = base + '-' + suffix++;
    s.run('INSERT INTO conversations VALUES(?,?,?,?,?)', channelId, name, 'channel', null, now());
    s.run('INSERT INTO members(conversation_id,user_id) VALUES(?,?)', channelId, user.id);
  }
  for (const e of [chief, ...proposal.employees]) {
    s.run('INSERT OR IGNORE INTO employee_conversations VALUES(?,?)', e.id, channelId);
  }
  const projectRooms: { id: string; name: string; purpose: string; employees: any[] }[] = [];
  for (const room of proposal.rooms || []) {
    let name = capitalizeInitial(room.name.trim());
    const baseName = name;
    let suffix = 2;
    while (
      s.one('SELECT id FROM conversations WHERE lower(name)=lower(?) AND kind=?', name, 'channel')
    )
      name = `${baseName} ${suffix++}`;
    const id = uid();
    s.run('INSERT INTO conversations VALUES(?,?,?,?,?)', id, name, 'channel', null, now());
    s.run('INSERT INTO members(conversation_id,user_id) VALUES(?,?)', id, user.id);
    const assigned = room.employeeIndexes
      .map((index: number) => proposal.employees[index])
      .filter(Boolean);
    for (const e of [chief, ...assigned])
      s.run('INSERT OR IGNORE INTO employee_conversations VALUES(?,?)', e.id, id);
    s.set('channel.purpose.' + id, room.purpose);
    postKickoff(
      s,
      user,
      chief,
      id,
      `I’ve opened this room for ${room.purpose}. I’ll coordinate the work here and keep the outcome visible to the team.`,
      assigned.map((e: any) => ({
        employee: e,
        purpose: room.purpose,
        task: `You’re joining this team as ${e.role}. Please onboard by briefly introducing your relevant approach, then make a useful first contribution toward: ${room.purpose}. Share progress and findings in this room, and flag blockers early.`,
      })),
    );
    projectRooms.push({ id, name, purpose: room.purpose, employees: assigned });
  }
  const assignedToProjects = new Set(projectRooms.flatMap((room) => room.employees.map((e) => e.id)));
  const purpose = postKickoff(
    s,
    user,
    chief,
    channelId,
    `I’ve brought this team together to work toward: ${proposal.purpose}. I’ll coordinate progress here, keep tasks focused, and share useful updates with the team.`,
    proposal.employees.filter((e: any) => !assignedToProjects.has(e.id)).map((e: any) => ({
      employee: e,
      purpose: proposal.purpose,
      task: `Welcome to the team. Your role is ${e.role}. Please onboard by briefly introducing your approach, then make a concrete first contribution toward the objective above. Post your progress and findings here, and flag blockers early.`,
    })),
  );
  const unbriefed = proposal.employees.filter(
    (e: any) =>
      !s.one(
        'SELECT 1 FROM runs WHERE employee_id=? AND conversation_id=?',
        e.id,
        proposal.conversationId,
      ),
  );
  const message = s.addMessage(
    proposal.conversationId,
    chief.id,
    chief.name,
    'system',
    `The team is ready in [#${name}](/?conversation=${channelId}).${projectRooms.length ? ' Project rooms: ' + projectRooms.map((room) => `[#${room.name}](/?conversation=${room.id}) (${room.employees.map((e) => e.name).join(', ')})`).join('; ') + '.' : ''} ${chief.name} will ${unbriefed.length ? 'coordinate the requested work there' : 'gather the existing findings there'}.`,
  );
  const threads = s
    .all(
      'SELECT DISTINCT thread_id FROM runs WHERE conversation_id=? AND thread_id IS NOT NULL AND state=?',
      proposal.conversationId,
      'completed',
    )
    .map((r) => r.thread_id);
  s.set(
    'message.context.' + purpose.id,
    'Continue the user’s request for this purpose: ' +
      proposal.purpose +
      '. State which existing agent is responsible for each part: ' +
      [chief, ...proposal.employees].map((e: any) => e.name + ': ' + e.id).join(', ') +
      '. Project rooms already exist: ' +
      (projectRooms.length
        ? projectRooms
            .map(
              (room) =>
                `${room.name} (${room.purpose}; ${[chief, ...room.employees].map((e) => e.name).join(', ')})`,
            )
            .join('; ')
        : name) +
      '. Follow the user’s requested scope. If they requested a plan or review, return that in ordinary conversation. Otherwise coordinate the authorized work with the existing team.',
  );
  // The Chief also coordinates the original request after the team has been welcomed.
  s.run(
    'INSERT INTO outbox VALUES(?,?,?,?,?,?)',
    uid(),
    purpose.id,
    chief.id,
    user.id,
    'pending',
    now(),
  );
  proposal.channelId = channelId;
  proposal.handoffMessageId = message.id;
  proposal.channelMessageId = purpose.id;
  s.emit('workspace.changed', null, {}, user.id);
}
