import { existsSync, mkdirSync, cpSync, readFileSync, copyFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import Database from 'better-sqlite3';
const [sourceArg, targetArg] = process.argv.slice(2);
if (!sourceArg || !targetArg)
  throw new Error('Usage: node scripts/restore.mjs BACKUP_DIRECTORY NEW_DATA_DIRECTORY');
const source = resolve(sourceArg),
  target = resolve(targetArg);
if (existsSync(target))
  throw new Error('Restore to a new directory; existing data is never overwritten.');
if (JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8')).version !== 1)
  throw new Error('Unsupported backup version');
const input = new Database(join(source, 'workspace.db'), { readonly: true });
if (input.pragma('integrity_check', { simple: true }) !== 'ok')
  throw new Error('Backup database integrity check failed');
input.close();
mkdirSync(target, { recursive: true, mode: 0o700 });
copyFileSync(join(source, 'workspace.db'), join(target, 'workspace.db'));
cpSync(join(source, 'artifacts'), join(target, 'artifacts'), { recursive: true });
const db = new Database(join(target, 'workspace.db'));
db.transaction(() => {
  db.exec(
    "DELETE FROM sessions;DELETE FROM invites;DELETE FROM subscriptions;DELETE FROM native_sessions;DELETE FROM grants;UPDATE schedules SET enabled=0;UPDATE connections SET state='disconnected';UPDATE decisions SET state='expired' WHERE state='pending';UPDATE runs SET state='interrupted' WHERE state NOT IN ('completed','failed','cancelled','interrupted');UPDATE outbox SET status='interrupted' WHERE status IN ('pending','new','claimed');DELETE FROM settings WHERE key='push.keys' OR key LIKE 'worktree.%' OR key LIKE 'run.folder.%' OR key LIKE 'presence.%';",
  );
  for (const a of db.prepare('SELECT id FROM attachments').all())
    db.prepare('UPDATE attachments SET path=? WHERE id=?').run(
      join(target, 'artifacts', a.id),
      a.id,
    );
})();
db.close();
console.log(
  'Restored to ' +
    target +
    '. Launch with WORKSPACE_DATA_DIR set to this directory. Reconnect accounts and explicitly re-enable schedules.',
);
