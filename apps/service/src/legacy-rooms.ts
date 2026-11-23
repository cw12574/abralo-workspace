import { existsSync, realpathSync, unlinkSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import type { Store } from './store.js';

/** Upgrade old databases by removing rooms, not exposing a historical product mode. */
export function removeLegacyRooms(s: Store) {
  if (s.setting('migration.removed-rooms')) return;
  s.db.transaction(() => {
    const files: string[] = s.setting('migration.room-files', []);
    for (const room of s.all("SELECT id FROM conversations WHERE kind IN ('channel','archive')")) {
      const id = room.id;
      const messages = s.all('SELECT id FROM messages WHERE conversation_id=?', id);
      const runs = s.all('SELECT id,context_key FROM runs WHERE conversation_id=?', id);
      const removed = new Set<string>([
        id,
        ...messages.map((m) => m.id),
        ...runs.flatMap((r) => [r.id, r.context_key]),
      ]);
      for (const table of [
        'attachments',
        'schedules',
        'plans',
        'work_items',
        'memories',
        'connection_actions',
      ])
        for (const row of s.all(`SELECT id FROM ${table} WHERE conversation_id=?`, id))
          removed.add(row.id);
      for (const row of s.all(
        'SELECT id FROM outbox WHERE message_id IN (SELECT id FROM messages WHERE conversation_id=?)',
        id,
      ))
        removed.add(row.id);
      for (const row of s.all(
        'SELECT id FROM decisions WHERE run_id IN (SELECT id FROM runs WHERE conversation_id=?)',
        id,
      ))
        removed.add(row.id);
      // Goals survive the retired surface. Prefer their actual lead, then another
      // existing conversation belonging to the owner; never create new employees here.
      for (const goal of s.all('SELECT * FROM goals WHERE conversation_id=?', id)) {
        const destination = s.one(
          `SELECT c.id FROM conversations c JOIN members m ON m.conversation_id=c.id
          WHERE m.user_id=? AND c.kind IN ('dm','human_dm') ORDER BY CASE WHEN c.employee_id=? THEN 0 WHEN c.kind='dm' THEN 1 ELSE 2 END LIMIT 1`,
          goal.owner_id,
          goal.lead_agent_id,
        );
        if (!destination)
          throw new Error(
            'A goal needs an existing conversation before its old room can be removed.',
          );
        s.run(
          'UPDATE goals SET conversation_id=?,source_message_id=NULL WHERE id=?',
          destination.id,
          goal.id,
        );
      }
      s.run(
        'UPDATE goals SET source_message_id=NULL WHERE source_message_id IN (SELECT id FROM messages WHERE conversation_id=?)',
        id,
      );
      for (const row of s.all('SELECT path FROM attachments WHERE conversation_id=?', id))
        files.push(row.path);
      for (const table of ['inbox', 'operations', 'outbox', 'goal_cycles'])
        s.run(
          `DELETE FROM ${table} WHERE message_id IN (SELECT id FROM messages WHERE conversation_id=?)`,
          id,
        );
      for (const table of ['activities', 'decisions'])
        s.run(
          `DELETE FROM ${table} WHERE run_id IN (SELECT id FROM runs WHERE conversation_id=?)`,
          id,
        );
      s.run(
        'DELETE FROM native_sessions WHERE context_key IN (SELECT context_key FROM runs WHERE conversation_id=?)',
        id,
      );
      s.run(
        'DELETE FROM memory_fts WHERE id IN (SELECT id FROM memories WHERE conversation_id=?)',
        id,
      );
      for (const table of [
        'work_items',
        'runs',
        'connection_actions',
        'schedules',
        'drafts',
        'memories',
        'plans',
        'messages',
        'attachments',
        'events',
        'members',
      ])
        s.run(`DELETE FROM ${table} WHERE conversation_id=?`, id);
      // Remove per-room/run/message state, including stored prompts and checkpoints.
      for (const setting of s.all('SELECT key,value FROM settings')) {
        if ([...removed].some((key) => key && setting.key.includes(key))) {
          s.run('DELETE FROM settings WHERE key=?', setting.key);
          continue;
        }
        const value = JSON.parse(setting.value);
        if (
          value &&
          !Array.isArray(value) &&
          (value.conversationId === id || value.conversation_id === id)
        ) {
          // Briefings are still a supported feature; only detach their removed origin.
          if (setting.key.startsWith('briefing.')) {
            value.conversationId = undefined;
            s.set(setting.key, value);
          } else s.run('DELETE FROM settings WHERE key=?', setting.key);
        } else if (setting.key.startsWith('proposals.') && Array.isArray(value)) {
          s.set(
            setting.key,
            value.filter((proposal) => proposal.conversationId !== id),
          );
        } else if (typeof value === 'string' && removed.has(value)) {
          s.run('DELETE FROM settings WHERE key=?', setting.key);
        }
      }
      if (s.one("SELECT name FROM sqlite_master WHERE type='table' AND name='briefings'")) {
        for (const row of s.all('SELECT id,data FROM briefings')) {
          const briefing = JSON.parse(row.data);
          if (briefing.conversationId !== id) continue;
          delete briefing.conversationId;
          if (removed.has(briefing.recapMessageId)) delete briefing.recapMessageId;
          s.run('UPDATE briefings SET data=? WHERE id=?', JSON.stringify(briefing), row.id);
        }
      }
      s.run('DELETE FROM conversations WHERE id=?', id);
    }
    s.run('DROP TABLE IF EXISTS employee_conversations');
    s.run(
      "DELETE FROM settings WHERE key IN ('workspace.team','migration.retired-rooms') OR key LIKE 'channel.%' OR key LIKE 'archive.schedules.%' OR key LIKE 'run.quiet.%'",
    );
    s.set('migration.room-files', [...new Set(files)]);
  })();
  // A durable cleanup queue makes failed/locked file removal retry on restart.
  // Only unlink files inside the workspace artifact directory, never source files.
  const root = realpathSync(join(s.dir, 'artifacts'));
  for (const path of s.setting('migration.room-files', []) as string[]) {
    if (!existsSync(path)) continue;
    const resolved = realpathSync(path);
    const within = relative(root, resolved);
    if (
      !within ||
      isAbsolute(within) ||
      within === '..' ||
      within.startsWith('..\\') ||
      within.startsWith('../')
    )
      throw new Error('An old room attachment is outside the workspace artifact directory.');
    if (!s.one('SELECT 1 FROM attachments WHERE path=?', path)) unlinkSync(resolved);
  }
  s.db.transaction(() => {
    s.run("DELETE FROM settings WHERE key='migration.room-files'");
    s.set('migration.removed-rooms', true);
  })();
}
