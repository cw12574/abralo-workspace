import type { Store } from './store.js';

// Persist defaults once. Names and prompt text must never grant capabilities later.
export function migrateAgentCapabilities(store: Store) {
  if (store.setting('migration.agent-capabilities')) return;
  store.db.transaction(() => {
    for (const owner of store.all('SELECT id FROM humans')) {
      const people = store
        .all('SELECT data FROM employees WHERE owner_id=? ORDER BY rowid', owner.id)
        .map((row) => JSON.parse(row.data));
      const configured = store.setting('workspace.chiefOfStaff.' + owner.id);
      const chief = configured
        ? people.find((e) => e.id === configured)
        : people.find((e) => e.name.trim().toLowerCase() === 'chief of staff');
      if (chief) store.set('workspace.chiefOfStaff.' + owner.id, chief.id);
      for (const employee of people) {
        if (typeof employee.canDelegate === 'boolean') continue;
        employee.canDelegate = employee.id === chief?.id;
        store.run('UPDATE employees SET data=? WHERE id=?', JSON.stringify(employee), employee.id);
      }
    }
    store.set('migration.agent-capabilities', true);
  })();
}
