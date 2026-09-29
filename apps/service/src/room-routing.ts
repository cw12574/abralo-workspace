import type { Store } from './store.js';

function escaped(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mentions(text: string, name: string, prefix: '#' | '@') {
  return new RegExp(
    `(^|[^\\p{L}\\p{N}_${prefix}])${prefix}${escaped(name)}(?=$|[^\\p{L}\\p{N}_-])`,
    'iu',
  ).test(text);
}

/** Finds a shared room for work that must leave a private agent conversation. */
export function collaborationRoom(s: Store, run: any, taskText: string) {
  const request = s.one('SELECT text,thread_id FROM messages WHERE id=?', run.message_id);
  const threadRoot = request?.thread_id
    ? s.one('SELECT text FROM messages WHERE id=?', request.thread_id)?.text || ''
    : '';
  // Private text is used only to choose a destination; it is never copied into the room.
  const context = `${taskText}\n${request?.text || ''}\n${threadRoot}`;
  const rooms = s.all(
    `SELECT c.id,c.name FROM conversations c
     JOIN employee_conversations ec ON ec.conversation_id=c.id AND ec.employee_id=?
     WHERE c.kind='channel' AND NOT EXISTS (SELECT 1 FROM settings WHERE key='channel.archived.' || c.id)`,
    run.employee_id,
  );
  if (!rooms.length) return s.setting('workspace.team');

  const explicit = rooms.find((room) => mentions(context, room.name, '#'));
  if (explicit) return explicit.id;

  const words = (value: string) =>
    new Set(
      value
        .toLocaleLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .split(/\s+/)
        .filter((word) => word.length > 2 && !['room', 'team', 'channel', 'please'].includes(word)),
    );
  const contextWords = words(context);
  const scored = rooms
    .map((room: { id: string; name: string }) => {
      const roomWords = words(room.name);
      const overlap = [...roomWords].filter((word) => contextWords.has(word)).length;
      return { ...room, overlap, coverage: overlap / Math.max(roomWords.size, 1) };
    })
    .filter((room) => room.overlap > 0)
    .sort((a, b) => b.coverage - a.coverage || b.overlap - a.overlap);
  if (scored.length && (scored.length === 1 || scored[0].coverage > scored[1].coverage))
    return scored[0].id;

  const current = rooms.find((room: { id: string }) => room.id === run.conversation_id);
  return current?.id || s.setting('workspace.team');
}

export function mentionedEmployees(s: Store, userId: string, text: string) {
  return s
    .all(
      'SELECT id,data FROM employees WHERE owner_id=? OR id IN (SELECT employee_id FROM employee_grants WHERE user_id=?)',
      userId,
      userId,
    )
    .map((row: { id: string; data: string }) => ({ id: row.id, ...JSON.parse(row.data) }))
    .filter(
      (employee: { id: string; name: string; deactivatedAt?: string }) =>
        !employee.deactivatedAt && mentions(text, employee.name, '@'),
    );
}
