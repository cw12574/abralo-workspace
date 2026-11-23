import { Store, ApiError, uid, now } from './store.js';

// Called inside the proposal transaction so retries cannot hire or brief twice.
export function handoffTeam(s: Store, user: any, proposal: any) {
  if (proposal.handoffMessageId) return;
  const chief = s.employee(
    proposal.chiefId ||
      s.one('SELECT employee_id FROM conversations WHERE id=?', proposal.conversationId)
        ?.employee_id,
  );
  if (!chief || !s.canUseEmployee(user.id, chief.id)) return;
  if (!chief.canDelegate)
    throw new ApiError(403, 'Enable delegation for the proposing agent before creating these employees.');
  s.authorize(user.id, proposal.conversationId);
  s.authorizeEmployee(chief.id, proposal.conversationId);
  for (const employee of proposal.employees) {
    s.authorize(user.id, employee.dmId);
    const brief = s.addMessage(
      employee.dmId,
      chief.id,
      chief.name,
      'agent',
      'Your role is ' +
        employee.role +
        '. Make a useful first contribution toward: ' +
        proposal.purpose +
        '. Stay within the requested scope and report your findings here.',
    );
    s.set('delegation.lineage.' + brief.id, [chief.id, employee.id]);
    s.run(
      'INSERT INTO outbox VALUES(?,?,?,?,?,?)',
      uid(),
      brief.id,
      employee.id,
      user.id,
      'pending',
      now(),
    );
  }
  const message = s.addMessage(
    proposal.conversationId,
    chief.id,
    chief.name,
    'system',
    (proposal.employees.length === 1 ? 'Employee created: ' : 'Employees created: ') +
      proposal.employees
        .map((e: any) => '[' + e.name + '](/?conversation=' + e.dmId + ')')
        .join(', ') +
      (proposal.employees.length === 1 ? '. They have their own conversation.' : '. Each employee has their own conversation.'),
  );
  proposal.handoffMessageId = message.id;
  s.emit('workspace.changed', null, {}, user.id);
}
