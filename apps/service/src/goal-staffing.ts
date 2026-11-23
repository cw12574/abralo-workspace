import { EmployeeInput } from '../../../packages/contracts/src/index.js';
import { savedDefaultProvider } from './provider-default.js';
import { ApiError, Store } from './store.js';

export function assignedGoal(store: Store, employeeId: string, except = '') {
  return store.one(
    "SELECT id,title FROM goals WHERE lead_agent_id=? AND status<>'complete' AND id<>? LIMIT 1",
    employeeId,
    except,
  );
}

// The caller holds the goal transaction, so choosing a lead and reserving their
// capacity are atomic. Staffing copies no folder, provider or bypass grants.
export function staffGoal(
  store: Store,
  ownerId: string,
  title: string,
  preferred?: string,
  except = '',
) {
  const people = store
    .all('SELECT id FROM employees ORDER BY rowid')
    .map((row) => store.employee(row.id)!)
    .filter((employee) => employee && store.canUseEmployee(ownerId, employee.id));
  const available = people.filter((employee) => !assignedGoal(store, employee.id, except));
  const preferredEmployee = available.find((employee) => employee.id === preferred);
  if (preferredEmployee) return preferredEmployee;
  const chiefId = store.setting('workspace.chiefOfStaff.' + ownerId);
  const chief = chiefId
    ? people.find((employee) => employee.id === chiefId)
    : people.find((employee) => /\bchief of staff\b/i.test(employee.name + ' ' + employee.role));
  // Keep the Chief of Staff available for coordination when another lead is free.
  const terms = new Set(title.toLowerCase().match(/[a-z]{4,}/g) || []);
  const score = (employee: (typeof people)[number]) =>
    [...terms].filter((term) => (employee.name + ' ' + employee.role).toLowerCase().includes(term))
      .length;
  const candidate =
    available
      .filter((employee) => employee.id !== chief?.id)
      .sort((a, b) => score(b) - score(a))[0] ||
    available.find((employee) => employee.id === chief?.id);
  if (candidate) return candidate;
  if (store.user(ownerId)?.role !== 'owner')
    throw new ApiError(
      409,
      'No employee is free. Ask the workspace owner to have the Chief of Staff add a project lead.',
    );
  const coordinator =
    chief ||
    store.createEmployee(
      ownerId,
      EmployeeInput.parse({
        name: 'Chief of Staff',
        canDelegate: true,
        role: 'Coordinate projects and make sure each has a dedicated lead.',
        harness: people[0]?.harness || savedDefaultProvider(store) || 'codex',
        model: people[0]?.model || '',
      }),
    );
  if (!chief) store.set('workspace.chiefOfStaff.' + ownerId, coordinator.id);
  const base = ('Lead — ' + title).slice(0, 72);
  let name = base,
    suffix = 2;
  const names = new Set(people.map((employee) => employee.name));
  while (names.has(name)) name = `${base} ${suffix++}`;
  const employee = store.createEmployee(
    ownerId,
    EmployeeInput.parse({
      name,
      role: `Lead this project: ${title}`,
      harness: coordinator.harness,
      model: coordinator.model,
      cwd: '',
      permissionMode: 'auto',
      instructions:
        'Focus on your assigned durable goal. Keep its progress and next action accurate, verify completed milestones, and ask for input only when needed. Use only existing approved access.',
    }),
  );
  store.addMessage(
    coordinator.dmId,
    coordinator.id,
    coordinator.name,
    'agent',
    `I created ${employee.name} to lead “${title}”. Every existing project lead is already assigned. The new employee will use the normal access and approval process.`,
  );
  return employee;
}

export function protectGoalLead(store: Store, employeeId: string, deleting = false) {
  const goal = store.one(
    'SELECT title FROM goals WHERE lead_agent_id=?' +
      (deleting ? '' : " AND status<>'complete'") +
      ' LIMIT 1',
    employeeId,
  );
  if (goal)
    throw new ApiError(
      409,
      `Reassign “${goal.title}” before ${deleting ? 'deleting' : 'deactivating'} its lead.`,
    );
}
