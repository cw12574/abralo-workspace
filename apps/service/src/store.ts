import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { randomUUID, createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { ensureDirectory } from '../../../packages/host/src/index.js';
import type {
  Message,
  WorkspaceEvent,
  Employee,
  RunState,
} from '../../../packages/contracts/src/index.js';
import { validTransition } from '../../../packages/contracts/src/index.js';
import * as schema from './schema.js';
import { archiveLegacyPlans } from './legacy-plans.js';
import { attachArchivedPlanDocuments } from './plan-document-attachments.js';
export const uid = () => randomUUID();
export const now = () => new Date().toISOString();
export function capitalizeInitial(value: string) {
  const [first, ...rest] = Array.from(value);
  return first ? first.toUpperCase() + rest.join('') : value;
}
export const sharedMessageSql = `(msg.run_id IS NULL OR NOT EXISTS (SELECT 1 FROM settings WHERE key='run.quiet.' || msg.run_id) OR EXISTS (SELECT 1 FROM settings WHERE key='run.sharedText.' || msg.run_id AND value NOT IN ('""','null')))`;
export function mentionsChannel(text: string, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}_@#])[@#]${escaped}(?=$|[^\\p{L}\\p{N}_-])`, 'iu').test(text);
}
export function mentionsRoom(text: string, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}_#])#${escaped}(?=$|[^\\p{L}\\p{N}_-])`, 'iu').test(text);
}
function mentionsAtName(text: string, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}_@])@${escaped}(?=$|[^\\p{L}\\p{N}_-])`, 'iu').test(text);
}
export const hash = (v: string) => createHash('sha256').update(v).digest('hex');
export function passwordHash(p: string) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(p, salt, 32).toString('hex')}`;
}
export function verifyPassword(p: string, stored: string) {
  try {
    const [salt, digest] = stored.split(':');
    return timingSafeEqual(scryptSync(p, salt, 32), Buffer.from(digest, 'hex'));
  } catch {
    return false;
  }
}
export class ApiError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
export class Store {
  db: Database.Database;
  orm: ReturnType<typeof drizzle>;
  bus = new EventEmitter();
  bootstrapToken: string;
  constructor(public dir: string) {
    ensureDirectory(dir);
    ensureDirectory(join(dir, 'artifacts'));
    ensureDirectory(join(dir, 'work'));
    const databasePath = join(dir, 'workspace.db');
    const key = join(dir, 'bootstrap.key');
    if (!existsSync(databasePath) && existsSync(key))
      throw new Error(
        `Workspace data is incomplete: ${databasePath} is missing while its device key remains. Refusing to create an empty workspace over the expected data. Restore a verified backup or choose an intentional new data directory.`,
      );
    this.db = new Database(databasePath);
    this.db.pragma('journal_mode = WAL');
    // NORMAL is SQLite's WAL default: a power loss can discard a transaction
    // that was already acknowledged to the user. FULL syncs the WAL before
    // each commit is reported as durable.
    this.db.pragma('synchronous = FULL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.orm = drizzle(this.db, { schema });
    this.bus.setMaxListeners(0);
    this.migrate();
    archiveLegacyPlans(this);
    attachArchivedPlanDocuments(this);
    if (!this.setting('migration.room-name-capitalization')) {
      for (const room of this.all("SELECT id,name FROM conversations WHERE kind='channel'")) {
        const name = capitalizeInitial(room.name);
        if (name !== room.name)
          this.run('UPDATE conversations SET name=? WHERE id=?', name, room.id);
      }
      this.set('migration.room-name-capitalization', true);
    }
    if (this.one('SELECT 1 FROM humans LIMIT 1')) this.ensureTeam();
    // Older delegation could accidentally grant employees access to someone else's DM.
    this.run(
      "DELETE FROM employee_conversations WHERE conversation_id IN (SELECT id FROM conversations WHERE kind<>'channel' AND (employee_id IS NULL OR employee_id<>employee_conversations.employee_id))",
    );
    if (!existsSync(key)) writeFileSync(key, randomBytes(32).toString('hex'), { mode: 0o600 });
    this.bootstrapToken = readFileSync(key, 'utf8').trim();
  }
  migrate() {
    this.db.exec(`
 CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS humans(id TEXT PRIMARY KEY,name TEXT NOT NULL,role TEXT NOT NULL,password TEXT,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES humans(id),expires_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS employees(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES humans(id),data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS employee_grants(employee_id TEXT NOT NULL REFERENCES employees(id),user_id TEXT NOT NULL REFERENCES humans(id),PRIMARY KEY(employee_id,user_id));
 CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL,employee_id TEXT,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS members(conversation_id TEXT NOT NULL REFERENCES conversations(id),user_id TEXT NOT NULL REFERENCES humans(id),last_read INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(conversation_id,user_id));
 CREATE TABLE IF NOT EXISTS employee_conversations(employee_id TEXT NOT NULL,conversation_id TEXT NOT NULL,PRIMARY KEY(employee_id,conversation_id));
 CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,conversation_id TEXT NOT NULL REFERENCES conversations(id),thread_id TEXT,author_id TEXT NOT NULL,author_name TEXT NOT NULL,kind TEXT NOT NULL,text TEXT NOT NULL,attachments TEXT NOT NULL DEFAULT '[]',created_at TEXT NOT NULL,run_id TEXT,edited_at TEXT,deleted_at TEXT,text_updated_at TEXT);
 CREATE INDEX IF NOT EXISTS message_conversation ON messages(conversation_id,seq);
 CREATE INDEX IF NOT EXISTS message_thread ON messages(conversation_id,thread_id,seq);
 CREATE TABLE IF NOT EXISTS plans(id TEXT PRIMARY KEY,message_id TEXT NOT NULL UNIQUE,conversation_id TEXT NOT NULL,employee_id TEXT NOT NULL,data TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS plans_conversation ON plans(conversation_id,updated_at);
 CREATE TABLE IF NOT EXISTS operations(user_id TEXT NOT NULL,key TEXT NOT NULL,fingerprint TEXT NOT NULL,message_id TEXT NOT NULL,PRIMARY KEY(user_id,key));
 CREATE INDEX IF NOT EXISTS operation_message ON operations(message_id);
 CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,message_id TEXT NOT NULL,employee_id TEXT NOT NULL,user_id TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(message_id,employee_id));
 CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,thread_id TEXT,user_id TEXT NOT NULL,employee_id TEXT NOT NULL,message_id TEXT NOT NULL,response_id TEXT NOT NULL,state TEXT NOT NULL,native_session TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,error TEXT,usage TEXT,context_key TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS native_sessions(context_key TEXT PRIMARY KEY,session_id TEXT NOT NULL,employee_id TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS activities(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS decisions(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,user_id TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,state TEXT NOT NULL,data TEXT NOT NULL,resolution TEXT);
 CREATE TABLE IF NOT EXISTS events(cursor INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,type TEXT NOT NULL,conversation_id TEXT,user_id TEXT,payload TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,conversation_id TEXT NOT NULL,name TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL,path TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS drafts(user_id TEXT NOT NULL,conversation_id TEXT NOT NULL,thread_id TEXT NOT NULL DEFAULT '',data TEXT NOT NULL,PRIMARY KEY(user_id,conversation_id,thread_id));
 CREATE TABLE IF NOT EXISTS invites(hash TEXT PRIMARY KEY,expires_at TEXT NOT NULL,created_by TEXT NOT NULL,used INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,author_id TEXT NOT NULL,content TEXT NOT NULL,source_id TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,deleted INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,scope TEXT NOT NULL DEFAULT 'conversation',owner_id TEXT);
 CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(id UNINDEXED,content);
 CREATE TABLE IF NOT EXISTS connections(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,service TEXT NOT NULL,label TEXT NOT NULL,state TEXT NOT NULL,data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS grants(connection_id TEXT NOT NULL,employee_id TEXT NOT NULL,capabilities TEXT NOT NULL,PRIMARY KEY(connection_id,employee_id));
 CREATE TABLE IF NOT EXISTS schedules(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,conversation_id TEXT NOT NULL,employee_id TEXT NOT NULL,prompt TEXT NOT NULL,next_at TEXT NOT NULL,interval_minutes INTEGER,enabled INTEGER NOT NULL DEFAULT 1);
 CREATE TABLE IF NOT EXISTS subscriptions(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS inbox(user_id TEXT NOT NULL,message_id TEXT NOT NULL,seen INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,PRIMARY KEY(user_id,message_id));
 CREATE INDEX IF NOT EXISTS inbox_user ON inbox(user_id,seen,created_at);
 INSERT OR IGNORE INTO migrations VALUES(1,datetime('now'));
 `);
    const messageColumns = new Set(this.all('PRAGMA table_info(messages)').map((row) => row.name));
    if (!messageColumns.has('edited_at'))
      this.db.exec('ALTER TABLE messages ADD COLUMN edited_at TEXT');
    if (!messageColumns.has('deleted_at'))
      this.db.exec('ALTER TABLE messages ADD COLUMN deleted_at TEXT');
    if (!messageColumns.has('text_updated_at'))
      this.db.exec('ALTER TABLE messages ADD COLUMN text_updated_at TEXT');
    const memoryColumns = new Set(this.all('PRAGMA table_info(memories)').map((row) => row.name));
    if (!memoryColumns.has('scope'))
      this.db.exec("ALTER TABLE memories ADD COLUMN scope TEXT NOT NULL DEFAULT 'conversation'");
    if (!memoryColumns.has('owner_id'))
      this.db.exec('ALTER TABLE memories ADD COLUMN owner_id TEXT');
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS memories_owner_scope ON memories(owner_id,scope,deleted,created_at)',
    );
  }
  all(sql: string, ...params: any[]): any[] {
    return this.db.prepare(sql).all(...params);
  }
  one(sql: string, ...params: any[]): any {
    return this.db.prepare(sql).get(...params);
  }
  run(sql: string, ...params: any[]) {
    return this.db.prepare(sql).run(...params);
  }
  setting(key: string, fallback: any = null) {
    const row = this.one('SELECT value FROM settings WHERE key=?', key);
    return row ? JSON.parse(row.value) : fallback;
  }
  set(key: string, value: any) {
    this.run(
      'INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      key,
      JSON.stringify(value),
    );
  }
  user(id: string) {
    return this.one('SELECT id,name,role FROM humans WHERE id=?', id);
  }
  authorize(userId: string, conversationId: string, allowArchived = false) {
    if (!allowArchived && this.setting('channel.archived.' + conversationId))
      throw new ApiError(410, 'This channel is archived. Restore it to continue the conversation.');
    if (
      !this.one(
        'SELECT 1 FROM members WHERE user_id=? AND conversation_id=?',
        userId,
        conversationId,
      )
    )
      throw new ApiError(403, 'This conversation is not available to you.');
  }
  session(token: string) {
    return this.one(
      'SELECT h.id,h.name,h.role FROM sessions s JOIN humans h ON h.id=s.user_id WHERE token_hash=? AND expires_at>?',
      hash(token),
      now(),
    );
  }
  newSession(userId: string) {
    const token = randomBytes(32).toString('base64url');
    this.run(
      'INSERT INTO sessions VALUES(?,?,?)',
      hash(token),
      userId,
      new Date(Date.now() + 30 * 86400000).toISOString(),
    );
    return token;
  }
  createOwner(name: string) {
    const id = uid();
    this.orm.insert(schema.humans).values({ id, name, role: 'owner', createdAt: now() }).run();
    this.ensureTeam();
    return this.user(id);
  }
  ensureTeam() {
    return this.db.transaction(() => {
      let id = this.setting('workspace.team');
      if (!id || !this.one("SELECT 1 FROM conversations WHERE id=? AND kind='channel'", id)) {
        id =
          this.one(
            "SELECT id FROM conversations WHERE kind='channel' AND lower(name)='team' ORDER BY created_at LIMIT 1",
          )?.id || uid();
        this.run(
          'INSERT OR IGNORE INTO conversations VALUES(?,?,?,?,?)',
          id,
          'Team',
          'channel',
          null,
          now(),
        );
        this.set('workspace.team', id);
      }
      this.run(
        'INSERT OR IGNORE INTO members(conversation_id,user_id) SELECT ?,id FROM humans',
        id,
      );
      for (const row of this.all('SELECT id,data FROM employees')) {
        const added = this.run(
          'INSERT OR IGNORE INTO employee_conversations VALUES(?,?)',
          row.id,
          id,
        );
        if (added.changes)
          this.addMessage(
            id,
            row.id,
            JSON.parse(row.data).name,
            'system',
            `${JSON.parse(row.data).name} joined #team.`,
          );
      }
      return id as string;
    })();
  }
  authorizeEmployee(employeeId: string, conversationId: string) {
    const c = this.one('SELECT * FROM conversations WHERE id=?', conversationId);
    if (
      !c ||
      this.setting('channel.archived.' + conversationId) ||
      (c.kind !== 'channel' && c.employee_id !== employeeId) ||
      !this.one(
        'SELECT 1 FROM employee_conversations WHERE employee_id=? AND conversation_id=?',
        employeeId,
        conversationId,
      )
    )
      throw new ApiError(
        403,
        'Private messages are only available to their participants. Coordinate with other employees in a shared channel.',
      );
  }
  recordNotifications(message: any, announce = true) {
    if (!message?.id || !message.text?.trim() || message.kind === 'system') return;
    const c = this.one('SELECT kind FROM conversations WHERE id=?', message.conversationId);
    for (const human of this.all(
      'SELECT h.id,h.name FROM humans h JOIN members m ON m.user_id=h.id WHERE m.conversation_id=? AND h.id<>?',
      message.conversationId,
      message.authorId,
    )) {
      const tagged = mentionsAtName(message.text, human.name);
      const follows =
        message.threadId &&
        this.one(
          'SELECT 1 FROM messages WHERE conversation_id=? AND (id=? OR thread_id=?) AND author_id=?',
          message.conversationId,
          message.threadId,
          message.threadId,
          human.id,
        );
      if (c?.kind !== 'channel' || tagged || follows) {
        const added = this.run(
          'INSERT OR IGNORE INTO inbox VALUES(?,?,0,?)',
          human.id,
          message.id,
          now(),
        );
        if (added.changes && announce)
          this.emit(
            'notification.message',
            message.conversationId,
            { ...message, tagged },
            human.id,
          );
      }
    }
  }
  emit(type: string, conversationId: string | null, payload: any, userId: string | null = null) {
    if (type === 'message.finished') {
      const row = this.one('SELECT * FROM messages WHERE id=?', payload.id);
      if (row) this.recordNotifications({ ...this.message(row), text: payload.text ?? row.text });
    }
    const id = uid();
    const createdAt = now();
    const result = this.run(
      'INSERT INTO events(id,type,conversation_id,user_id,payload,created_at) VALUES(?,?,?,?,?,?)',
      id,
      type,
      conversationId,
      userId,
      JSON.stringify(payload),
      createdAt,
    );
    const event: WorkspaceEvent = {
      id,
      type,
      conversationId,
      userId,
      payload,
      createdAt,
      cursor: Number(result.lastInsertRowid),
      version: 1,
    };
    queueMicrotask(() => {
      // A surrounding transaction can roll back after emit was called.
      if (this.db.open && this.one('SELECT 1 FROM events WHERE id=?', id))
        this.bus.emit('event', event);
    });
    return event;
  }
  allowedEvent(userId: string, e: WorkspaceEvent) {
    if (e.userId && e.userId !== userId) return false;
    return e.conversationId
      ? !!this.one(
          'SELECT 1 FROM members WHERE user_id=? AND conversation_id=?',
          userId,
          e.conversationId,
        )
      : e.userId === userId;
  }
  eventsAfter(userId: string, cursor: number) {
    return this.all(
      `SELECT e.* FROM events e WHERE e.cursor>? AND (e.user_id IS NULL OR e.user_id=?) AND ((e.conversation_id IS NULL AND e.user_id IS NOT NULL) OR EXISTS(SELECT 1 FROM members m WHERE m.conversation_id=e.conversation_id AND m.user_id=?)) ORDER BY cursor LIMIT 500`,
      cursor,
      userId,
      userId,
    ).map((e) => ({
      id: e.id,
      type: e.type,
      conversationId: e.conversation_id,
      userId: e.user_id,
      payload: JSON.parse(e.payload),
      createdAt: e.created_at,
      cursor: e.cursor,
      version: 1,
    }));
  }
  employee(id: string): Employee | undefined {
    const e = this.one('SELECT data FROM employees WHERE id=?', id);
    return e ? JSON.parse(e.data) : undefined;
  }
  canUseEmployee(userId: string, id: string) {
    return (
      (!this.employee(id)?.deactivatedAt && this.employee(id)?.ownerId === userId) ||
      (!this.employee(id)?.deactivatedAt &&
        !!this.one('SELECT 1 FROM employee_grants WHERE employee_id=? AND user_id=?', id, userId))
    );
  }
  createEmployee(ownerId: string, input: any) {
    const id = uid(),
      dmId = uid();
    const e: Employee = { ...input, id, kind: 'agent', ownerId, dmId, createdAt: now() };
    this.db.transaction(() => {
      this.run('INSERT INTO employees VALUES(?,?,?)', id, ownerId, JSON.stringify(e));
      this.run('INSERT INTO conversations VALUES(?,?,?,?,?)', dmId, e.name, 'dm', id, now());
      this.run('INSERT INTO members(conversation_id,user_id) VALUES(?,?)', dmId, ownerId);
      this.run('INSERT INTO employee_conversations VALUES(?,?)', id, dmId);
      this.ensureTeam();
      this.emit('workspace.changed', null, { employeeId: id }, ownerId);
    })();
    return e;
  }
  message(row: any, compactActivity = false): Message {
    return {
      id: row.id,
      seq: row.seq,
      clientKey:
        row.kind === 'human'
          ? this.one('SELECT key FROM operations WHERE message_id=?', row.id)?.key
          : undefined,
      conversationId: row.conversation_id,
      threadId: row.thread_id,
      authorId: row.author_id,
      authorName: row.author_name,
      kind: row.kind,
      text: row.text,
      attachments: JSON.parse(row.attachments),
      createdAt: row.created_at,
      textUpdatedAt: row.text_updated_at || undefined,
      editedAt: row.edited_at || undefined,
      deletedAt: row.deleted_at || undefined,
      runId: row.run_id,
      replyCount: this.one(
        `SELECT COUNT(*) n FROM messages msg WHERE conversation_id=? AND thread_id=? AND ${sharedMessageSql}`,
        row.conversation_id,
        row.id,
      ).n,
      activity: row.run_id
        ? this.all(
            compactActivity
              ? `SELECT json_object('id',id,'type',json_extract(data,'$.type'),
              'title',json_extract(data,'$.title'),'state',json_extract(data,'$.state'),
              'time',json_extract(data,'$.time'),'updatedAt',json_extract(data,'$.updatedAt'),
              'url',json_extract(data,'$.url'),
              'hasDetail',json(CASE WHEN COALESCE(json_extract(data,'$.detail'),'') != '' THEN 'true' ELSE 'false' END)) data
             FROM activities WHERE run_id=?`
              : 'SELECT data FROM activities WHERE run_id=?',
            row.run_id,
          ).map((a) => JSON.parse(a.data))
        : [],
    };
  }
  messages(
    conversationId: string,
    before = Number.MAX_SAFE_INTEGER,
    threadId?: string | null,
    compactActivity = false,
  ) {
    const isRoom =
      this.one('SELECT kind FROM conversations WHERE id=?', conversationId)?.kind === 'channel';
    const rows = this.all(
      `SELECT msg.* FROM messages msg WHERE conversation_id=? AND seq<? ${threadId ? 'AND thread_id=?' : 'AND thread_id IS NULL'} ${isRoom ? 'AND ' + sharedMessageSql : ''} ORDER BY seq DESC LIMIT 80`,
      ...[conversationId, before, ...(threadId ? [threadId] : [])],
    );
    return rows.reverse().flatMap((r) => {
      const message = this.message(r, compactActivity);
      if (!isRoom) return [message];
      if (r.run_id && this.setting('run.quiet.' + r.run_id, false)) {
        const shared = this.setting('run.sharedText.' + r.run_id);
        if (!shared) return [];
        message.text = shared;
      }
      return [{ ...message, activity: [] }];
    });
  }
  addMessage(
    conversationId: string,
    authorId: string,
    authorName: string,
    kind: string,
    text: string,
    threadId: string | null = null,
    attachments: string[] = [],
    runId: string | null = null,
  ) {
    const id = uid();
    this.run(
      'INSERT INTO messages(id,conversation_id,thread_id,author_id,author_name,kind,text,attachments,created_at,run_id) VALUES(?,?,?,?,?,?,?,?,?,?)',
      id,
      conversationId,
      threadId,
      authorId,
      authorName,
      kind,
      text,
      JSON.stringify(attachments),
      now(),
      runId,
    );
    const m = this.message(this.one('SELECT * FROM messages WHERE id=?', id));
    this.emit('message.created', conversationId, m);
    if (!runId) this.recordNotifications(m);
    return m;
  }
  accept(user: any, conversationId: string, input: any) {
    this.authorize(user.id, conversationId);
    const selectedFolder = this.setting('conversation.workingFolder.' + conversationId);
    const workingDirectory =
      input.workingDirectory === undefined ? selectedFolder : input.workingDirectory;
    if (workingDirectory && workingDirectory !== selectedFolder)
      throw new ApiError(400, 'Choose the working folder from the composer before sending.');
    const fingerprint = hash(
      JSON.stringify({ conversationId, ...input, workingDirectory, key: undefined }),
    );
    return this.db.transaction(() => {
      const previous = this.one(
        'SELECT * FROM operations WHERE user_id=? AND key=?',
        user.id,
        input.key,
      );
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new ApiError(409, 'This send key already belongs to different content.');
        return this.message(this.one('SELECT * FROM messages WHERE id=?', previous.message_id));
      }
      if (
        input.threadId &&
        !this.one(
          'SELECT id FROM messages WHERE id=? AND conversation_id=? AND thread_id IS NULL',
          input.threadId,
          conversationId,
        )
      )
        throw new ApiError(400, 'Thread is unavailable.');
      for (const a of input.attachments) {
        if (
          !this.one(
            'SELECT id FROM attachments WHERE id=? AND user_id=? AND conversation_id=?',
            a,
            user.id,
            conversationId,
          )
        )
          throw new ApiError(400, 'An attachment is not ready for this conversation.');
      }
      const conv = this.one('SELECT * FROM conversations WHERE id=?', conversationId);
      if (this.setting('channel.archived.' + conversationId))
        throw new ApiError(409, 'Restore this room before posting.');
      const channelTargets =
        conv.kind === 'channel' && mentionsAtName(input.text, conv.name)
          ? this.all(
              'SELECT employee_id FROM employee_conversations WHERE conversation_id=?',
              conversationId,
            ).map((row) => row.employee_id)
          : [];
      const employeeMentions =
        conv.kind === 'channel'
          ? this.all(
              'SELECT id,data FROM employees WHERE owner_id=? OR id IN (SELECT employee_id FROM employee_grants WHERE user_id=?)',
              user.id,
              user.id,
            )
              .map((row: any) => ({ id: row.id, ...JSON.parse(row.data) }))
              .filter((e: any) => !e.deactivatedAt && mentionsAtName(input.text, e.name))
          : [];
      // A #room call wakes one room lead; @room remains the explicit broadcast.
      // Keep room routing in shared conversations so a private DM never invites outsiders.
      const roomTargets =
        conv.kind === 'channel'
          ? this.all(
              `SELECT c.id,c.name FROM conversations c
               JOIN members m ON m.conversation_id=c.id
               WHERE c.kind='channel' AND m.user_id=?`,
              user.id,
            )
              .filter((room) => mentionsRoom(input.text, room.name))
              .flatMap((room) => {
                const lead = this.all(
                  `SELECT e.data,e.rowid AS employeeOrder FROM employee_conversations ec
                   JOIN employees e ON e.id=ec.employee_id WHERE ec.conversation_id=?`,
                  room.id,
                )
                  .map((row) => ({ ...JSON.parse(row.data), employeeOrder: row.employeeOrder }))
                  .filter((e) => !e.deactivatedAt && this.canUseEmployee(user.id, e.id))
                  .sort(
                    (a, b) =>
                      a.createdAt.localeCompare(b.createdAt) || a.employeeOrder - b.employeeOrder,
                  )[0];
                return lead ? [lead.id] : [];
              })
          : [];
      const targets = Array.from(
        new Set<string>([
          ...(input.recipients.length
            ? input.recipients
            : conv.employee_id
              ? [conv.employee_id]
              : []),
          ...channelTargets,
          ...roomTargets,
          ...employeeMentions.map((e: any) => e.id),
        ]),
      );
      if (!targets.length && input.threadId && conv.kind === 'channel') {
        const root = this.one('SELECT author_id,kind FROM messages WHERE id=?', input.threadId);
        const owners =
          root?.kind === 'agent'
            ? [{ employee_id: root.author_id }]
            : this.all(
                'SELECT DISTINCT employee_id FROM outbox WHERE message_id=?',
                input.threadId,
              );
        if (owners.length === 1) targets.push(owners[0].employee_id);
      }
      for (const target of targets) {
        if (conv.kind !== 'channel' && conv.employee_id !== target)
          throw new ApiError(
            403,
            'Other employees cannot join a private direct message. Use a shared channel.',
          );
        const e = this.employee(target);
        if (!e || !this.canUseEmployee(user.id, e.id))
          throw new ApiError(403, 'The account owner must grant access to this employee.');
        this.run(
          'INSERT OR IGNORE INTO employee_conversations VALUES(?,?)',
          target,
          conversationId,
        );
      }
      const message = this.addMessage(
        conversationId,
        user.id,
        user.name,
        'human',
        input.text,
        input.threadId || null,
        input.attachments,
      );
      if (workingDirectory) this.set('message.workingDirectory.' + message.id, workingDirectory);
      if (input.modelOverride) this.set('message.modelOverride.' + message.id, input.modelOverride);
      this.run(
        'INSERT INTO operations VALUES(?,?,?,?)',
        user.id,
        input.key,
        fingerprint,
        message.id,
      );
      for (const target of targets) {
        const outboxId = uid();
        this.run(
          'INSERT INTO outbox VALUES(?,?,?,?,?,?)',
          outboxId,
          message.id,
          target,
          user.id,
          input.newTask ? 'new' : 'pending',
          now(),
        );
        if (employeeMentions.some((employee: any) => employee.id === target))
          this.set('outbox.mention.' + outboxId, true);
      }
      this.run(
        'DELETE FROM drafts WHERE user_id=? AND conversation_id=? AND thread_id=?',
        user.id,
        conversationId,
        input.threadId || '',
      );
      return { ...message, clientKey: input.key };
    })();
  }
  transition(id: string, state: RunState, error: string | null = null) {
    const r = this.one('SELECT * FROM runs WHERE id=?', id);
    if (!r || !validTransition(r.state, state))
      throw new Error(`Invalid run transition ${r?.state} -> ${state}`);
    this.run(
      'UPDATE runs SET state=?,error=COALESCE(?,error),updated_at=? WHERE id=?',
      state,
      error,
      now(),
      id,
    );
    this.emit('run.changed', r.conversation_id, {
      ...r,
      state,
      error,
      limit: this.setting('run.limit.' + id),
      autoResume: this.setting('run.autoResume.' + id, false),
    });
  }
  close() {
    this.db.close();
  }
}
