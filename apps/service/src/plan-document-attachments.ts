import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from './store.js';

// Retired plans are ordinary read-only documents. Keep the original records and
// conversation text intact, including installations already migrated to text.
export function attachArchivedPlanDocuments(store: Store) {
  if (store.setting('migration.plan-preview-documents')) return;
  store.db.transaction(() => {
    const records = store.all(`SELECT p.*, m.attachments, e.owner_id
      FROM plans p JOIN messages m ON m.id=p.message_id
      LEFT JOIN employees e ON e.id=p.employee_id WHERE m.deleted_at IS NULL`);
    for (const row of records) {
      let plan;
      try {
        plan = JSON.parse(row.data);
      } catch {
        continue;
      }
      if (!plan || typeof plan !== 'object') continue;
      const revisions =
        Array.isArray(plan.revisions) && plan.revisions.length ? plan.revisions : [plan];
      const text = [
        `# ${plan.title || 'Archived plan'}`,
        `Prepared by ${plan.authorName || 'Agent'} · Archived plan`,
        `Status when archived: ${plan.state === 'review' ? 'For discussion' : plan.state === 'agreed' ? 'Agreed' : 'Not recorded'}. ${revisions.length} ${revisions.length === 1 ? 'version' : 'versions'}.`,
        ...revisions
          .map((revision: any, index: number) =>
            [
              `## Version ${index + 1}${index === revisions.length - 1 ? ' — latest' : ''}`,
              `### ${revision.title || plan.title || 'Plan'}`,
              revision.at || '',
              revision.body || '',
              '### Responsibilities',
              ...(revision.responsibilities || []).map(
                (entry: any) =>
                  `- **${entry.name || entry.employeeId}**: ${entry.responsibility || ''}`,
              ),
            ]
              .filter(Boolean)
              .join('\n\n'),
          )
          .reverse(),
      ].join('\n\n');
      // Stable UUID-shaped IDs make a retry after an interrupted migration safe.
      const digest = createHash('sha256')
        .update('plan-document:' + row.id)
        .digest('hex');
      const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
      const path = join(store.dir, 'artifacts', id);
      const name = `${String(plan.title || 'Archived plan')
        .replace(/[\\/\x00-\x1f]/g, '_')
        .slice(0, 160)} — plan history.md`;
      writeFileSync(path, text, { mode: 0o600 });
      store.run(
        'INSERT OR IGNORE INTO attachments VALUES(?,?,?,?,?,?,?,?)',
        id,
        row.owner_id || row.employee_id,
        row.conversation_id,
        name,
        'text/markdown',
        Buffer.byteLength(text),
        path,
        row.updated_at,
      );
      const attachments: string[] = JSON.parse(row.attachments || '[]');
      if (!attachments.includes(id)) {
        attachments.push(id);
        store.run(
          'UPDATE messages SET attachments=? WHERE id=?',
          JSON.stringify(attachments),
          row.message_id,
        );
      }
    }
    store.set('migration.plan-preview-documents', true);
  })();
}
