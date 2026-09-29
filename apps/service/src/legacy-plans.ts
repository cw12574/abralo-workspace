import type { Store } from './store.js';

// Preserve old plan documents in ordinary conversation history. Keep the source
// records intact for recovery; they no longer control routing or execution.
export function archiveLegacyPlans(store: Store) {
  if (store.setting('migration.plan-history')) return;
  store.db.transaction(() => {
    for (const row of store.all('SELECT message_id,data FROM plans')) {
      const plan = JSON.parse(row.data);
      const revisions = plan.revisions?.length ? plan.revisions : [plan];
      const text = revisions
        .map((revision: any, index: number) =>
          [
            `## ${revision.title || plan.title}`,
            `Archived plan · Version ${index + 1}${revision.at ? ' · ' + revision.at : ''}`,
            revision.body || '',
            ...(revision.responsibilities || []).map(
              (item: any) => `- ${item.name || item.employeeId}: ${item.responsibility}`,
            ),
          ].join('\n\n'),
        )
        .reverse()
        .join('\n\n---\n\n');
      store.run(
        'UPDATE messages SET text=? WHERE id=? AND deleted_at IS NULL',
        text,
        row.message_id,
      );
    }
    store.set('migration.plan-history', true);
  })();
}
