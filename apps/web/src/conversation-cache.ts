import { useCallback, useSyncExternalStore } from 'react';
import { api } from './api';
import { IndexedConversationStorage, type ConversationStorage } from './conversation-storage';
import { messageSummary, summaryEvent } from '../../../packages/contracts/src/activity-summary';
import type { Message } from '../../../packages/contracts/src/index';

export type ConversationView = {
  id: string;
  threadId?: string;
  employeeId?: string;
  before?: number | null;
};
export type HistoryData = {
  cursor?: number;
  messages: Message[];
  runs: any[];
  decisions: any[];
  attachments: any[];
};
export type Viewport = {
  following: boolean;
  offset: number;
  anchor?: string;
  anchorOffset?: number;
  anchorStart?: number;
  width: number;
  height: number;
  measurements: any[];
};
export type OutgoingMessage = {
  message: Message;
  body: any;
  files: any[];
  state: 'sending' | 'failed' | 'sent';
};
type Composer = {
  draft: string;
  files: any[];
  draftWork: any;
  ready: boolean;
  uploading: boolean;
  sending: boolean;
  outgoing: OutgoingMessage[];
  saveError?: string;
};
type Snapshot = { data: HistoryData | null; status: 'loading' | 'ready' | 'error'; error: string };
type Listener = () => void;
type Entry = {
  view: ConversationView;
  snapshot: Snapshot;
  listeners: Set<Listener>;
  touched: number;
  fetched: number;
  stale: boolean;
  request?: Promise<void>;
  controller?: AbortController;
  journal?: any[];
  overflow?: boolean;
  viewport?: Viewport;
  positionAt?: number;
  bytes: number;
  refreshTimer?: ReturnType<typeof setTimeout>;
  persistTimer?: ReturnType<typeof setTimeout>;
  expanded: string[];
};
type Session = {
  value: Composer;
  listeners: Set<Listener>;
  before: number | null;
  revision: number;
  dirty: boolean;
  timer?: ReturnType<typeof setTimeout>;
  save?: Promise<void>;
  loading?: Promise<void>;
};
const EMPTY: Composer = {
  draft: '',
  files: [],
  draftWork: null,
  ready: false,
  uploading: false,
  sending: false,
  outgoing: [],
};
const baseKey = (view: ConversationView) => JSON.stringify([view.id, view.threadId || '']);
const pageKey = (view: ConversationView) => `${baseKey(view)}:${view.before || 'latest'}`;
// Reuse estimates for unchanged objects: streaming one word must not serialize
// every message and tool result in all eight views again.
const measured = new WeakMap<object, number>();
const sizeOf = (value: any): number => {
  if (typeof value === 'string') return value.length * 2;
  if (!value || typeof value !== 'object') return 8;
  const known = measured.get(value);
  if (known !== undefined) return known;
  const size =
    32 + Object.entries(value).reduce((sum, [key, item]) => sum + key.length * 2 + sizeOf(item), 0);
  measured.set(value, size);
  return size;
};

// Recent data lives independently of mounted chats; the optional disk cache is bounded.
export class ConversationCache {
  private entries = new Map<string, Entry>();
  private sessions = new Map<string, Session>();
  private scope = '';
  private access = new Set<string>();
  private tick = 0;
  private generation = 0;
  private accessSignature = '';
  private employees?: Set<string>;
  private restoring: Promise<void> = Promise.resolve();
  constructor(
    private fetcher = api,
    private maxViews = 8,
    private maxBytes = 16 * 1024 * 1024,
    private storage: ConversationStorage | undefined = typeof indexedDB === 'undefined'
      ? undefined
      : new IndexedConversationStorage(),
  ) {}

  setScope(scope: string, allowed?: string[], employees?: string[]) {
    const changed = scope !== this.scope;
    if (changed) {
      this.clear();
      this.scope = scope;
    }
    if (!allowed) return;
    const signature = JSON.stringify([allowed, employees]);
    const accessChanged = signature !== this.accessSignature;
    this.accessSignature = signature;
    this.employees = employees ? new Set(employees) : undefined;
    const next = new Set(allowed);
    const revoked = [...this.access].filter((id) => !next.has(id));
    this.access = next;
    for (const id of revoked) this.revoke(id);
    if (this.storage && scope && (changed || accessChanged)) {
      const generation = this.generation;
      this.restoring = this.storage
        .purge(scope, allowed, employees)
        .then(async () => {
          if (!changed || this.generation !== generation) return;
          const saved = await this.storage!.load(scope);
          if (this.generation !== generation) return;
          for (const row of saved.views.sort((a, b) => (a.positionAt || 0) - (b.positionAt || 0))) {
            if (
              !this.access.has(row.view.id) ||
              (row.view.employeeId && this.employees && !this.employees.has(row.view.employeeId))
            )
              continue;
            const entry = this.entry(row.view);
            if (entry.snapshot.data) continue; // A fresh network response always wins.
            entry.viewport = row.viewport;
            entry.positionAt = row.positionAt;
            if (row.viewport) this.session(row.view).before = row.view.before || null;
            entry.expanded = row.expanded || [];
            const data = { ...row.data, messages: row.data.messages.map(messageSummary) };
            this.publish(entry, { data, status: 'ready', error: '' });
            entry.stale = true;
          }
          for (const row of saved.drafts) {
            if (
              !this.access.has(row.view.id) ||
              (row.view.employeeId && this.employees && !this.employees.has(row.view.employeeId))
            )
              continue;
            const session = this.session(row.view);
            if (session.revision || session.value.ready) continue;
            session.value = { ...session.value, draft: row.draft, files: row.files, ready: true };
            session.dirty = true;
            session.revision++;
            session.listeners.forEach((notify) => notify());
          }
          this.trim();
        })
        .catch(() => {});
    }
    if (employees) {
      const available = new Set(employees);
      const lostAgents = [...this.entries.values()].filter(
        (entry) =>
          entry.view.employeeId &&
          !available.has(entry.view.employeeId) &&
          (entry.snapshot.data || entry.request),
      );
      for (const entry of lostAgents) this.revoke(entry.view.id);
    }
  }
  ready() {
    return this.restoring;
  }
  clear() {
    const oldScope = this.scope;
    this.scope = '';
    this.generation++;
    this.accessSignature = '';
    this.employees = undefined;
    if (oldScope) void this.storage?.purge(oldScope).catch(() => {});
    for (const entry of this.entries.values()) {
      entry.controller?.abort();
      clearTimeout(entry.refreshTimer);
      clearTimeout(entry.persistTimer);
      entry.snapshot = { data: null, status: 'loading', error: '' };
      entry.listeners.forEach((notify) => notify());
    }
    for (const session of this.sessions.values()) {
      clearTimeout(session.timer);
      session.value = { ...EMPTY };
      session.listeners.forEach((notify) => notify());
    }
    this.entries.clear();
    this.sessions.clear();
    this.access.clear();
  }
  private entry(view: ConversationView) {
    const key = pageKey(view);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        view: { ...view },
        snapshot: { data: null, status: 'loading', error: '' },
        listeners: new Set(),
        touched: ++this.tick,
        fetched: 0,
        stale: true,
        bytes: 0,
        expanded: [],
      };
      this.entries.set(key, entry);
    } else if (view.employeeId) entry.view.employeeId = view.employeeId;
    return entry;
  }
  read(view: ConversationView) {
    return this.entry(view).snapshot;
  }
  pageToken(view: ConversationView) {
    return this.entry(view);
  }
  subscribe(view: ConversationView, notify: Listener) {
    const entry = this.entry(view);
    entry.touched = ++this.tick;
    entry.listeners.add(notify);
    return () => {
      entry.listeners.delete(notify);
      this.trim();
    };
  }
  viewport(view: ConversationView) {
    return this.entries.get(pageKey(view))?.viewport;
  }
  saveViewport(view: ConversationView, viewport: Viewport) {
    const entry = this.entries.get(pageKey(view));
    if (entry) {
      entry.viewport = viewport;
      entry.positionAt = Date.now();
      this.persist(entry);
    }
  }
  clearViewport(view: ConversationView) {
    const entry = this.entries.get(pageKey(view));
    if (entry) {
      entry.viewport = undefined;
      this.persist(entry);
    }
  }
  private publish(entry: Entry, snapshot: Snapshot) {
    entry.snapshot = snapshot;
    entry.bytes = sizeOf(snapshot.data);
    entry.listeners.forEach((notify) => notify());
    this.persist(entry);
  }
  private persist(entry: Entry) {
    if (!this.storage || !this.scope || !entry.snapshot.data || entry.persistTimer) return;
    const scope = this.scope;
    entry.persistTimer = setTimeout(() => {
      entry.persistTimer = undefined;
      if (
        scope !== this.scope ||
        this.entries.get(pageKey(entry.view)) !== entry ||
        !this.access.has(entry.view.id) ||
        !entry.snapshot.data
      )
        return;
      void this.storage!.save(scope, {
        view: entry.view,
        data: entry.snapshot.data,
        viewport: entry.viewport,
        positionAt: entry.positionAt,
        expanded: entry.expanded,
        updatedAt: Date.now(),
      }).catch(() => {});
    }, 1000);
  }
  flush() {
    for (const entry of this.entries.values()) {
      clearTimeout(entry.persistTimer);
      entry.persistTimer = undefined;
      if (this.scope && this.access.has(entry.view.id) && entry.snapshot.data)
        void this.storage
          ?.save(this.scope, {
            view: entry.view,
            data: entry.snapshot.data,
            viewport: entry.viewport,
            positionAt: entry.positionAt,
            expanded: entry.expanded,
            updatedAt: Date.now(),
          })
          .catch(() => {});
    }
  }
  isExpanded(messageId: string, activityId: string) {
    const key = JSON.stringify([messageId, activityId]);
    return [...this.entries.values()].some((entry) => entry.expanded.includes(key));
  }
  setExpanded(messageId: string, activityId: string, open: boolean) {
    const key = JSON.stringify([messageId, activityId]);
    for (const entry of this.entries.values())
      if (entry.snapshot.data?.messages.some((m) => m.id === messageId)) {
        entry.expanded = entry.expanded.filter((item) => item !== key);
        if (open) entry.expanded.push(key);
        entry.expanded = entry.expanded.slice(-128);
        this.persist(entry);
      }
  }
  private trim() {
    let bytes = [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    for (const [key, entry] of [...this.entries].sort((a, b) => a[1].touched - b[1].touched)) {
      if (this.entries.size <= this.maxViews && bytes <= this.maxBytes) break;
      // Mounted views own their visible data; only unused snapshots are evicted.
      if (entry.listeners.size) continue;
      clearTimeout(entry.refreshTimer);
      clearTimeout(entry.persistTimer);
      bytes -= entry.bytes;
      this.entries.delete(key);
      entry.controller?.abort();
    }
    for (const [key, session] of this.sessions) {
      if (this.sessions.size <= this.maxViews) break;
      if (
        session.listeners.size ||
        session.dirty ||
        session.value.uploading ||
        session.value.sending ||
        session.value.outgoing.length ||
        session.value.draftWork
      )
        continue;
      this.sessions.delete(key);
    }
  }
  stats() {
    return {
      views: this.entries.size,
      bytes: [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0),
    };
  }
  load(view: ConversationView, force = false): Promise<void> {
    const entry = this.entry(view);
    entry.touched = ++this.tick;
    if (entry.request) return entry.request;
    if (!force && !entry.stale && entry.snapshot.data && Date.now() - entry.fetched < 30000)
      return Promise.resolve();
    entry.journal = [];
    entry.overflow = false;
    if (!entry.snapshot.data && entry.snapshot.status === 'error')
      this.publish(entry, { data: null, status: 'loading', error: '' });
    const key = pageKey(view);
    const query = new URLSearchParams({
      activity: 'summary',
      ...(view.threadId ? { threadId: view.threadId } : {}),
      ...(view.before ? { before: String(view.before) } : {}),
    });
    const current = () => this.entries.get(key) === entry;
    entry.controller = new AbortController();
    entry.request = this.fetcher(
      `/conversations/${encodeURIComponent(view.id)}/messages?${query}`,
      undefined,
      undefined,
      entry.controller.signal,
    )
      .then((data: HistoryData) => {
        if (!current()) return;
        data = { ...data, messages: data.messages.map(messageSummary) };
        if (entry.overflow) {
          entry.stale = true;
          return;
        }
        let dirty = false;
        // Replay events received during the request so late responses cannot rewind a stream.
        for (const event of entry.journal || []) {
          if (
            !belongs(event, view) ||
            (event.cursor && data.cursor !== undefined && event.cursor <= data.cursor)
          )
            continue;
          const result = reduceEvent(data, event, view);
          data = result.data;
          dirty ||= result.dirty;
        }
        entry.stale = dirty;
        entry.fetched = Date.now();
        this.publish(entry, { data, status: 'ready', error: '' });
        const session = this.session(view);
        const keys = new Set(data.messages.map((message) => message.clientKey).filter(Boolean));
        if (session.value.outgoing.some((item) => keys.has(item.message.clientKey)))
          this.updateComposer(view, 'outgoing', (items) =>
            items.filter((item) => !keys.has(item.message.clientKey)),
          );
      })
      .catch((error) => {
        if (!current()) return;
        entry.stale = true;
        if ([401, 403, 404].includes(error.status)) {
          this.revoke(view.id);
          this.publish(entry, { data: null, status: 'error', error: error.message });
        } else
          this.publish(entry, {
            ...entry.snapshot,
            status: 'error',
            error: error.message || 'The conversation could not be loaded.',
          });
        throw error;
      })
      .finally(() => {
        entry.request = undefined;
        entry.controller = undefined;
        entry.journal = undefined;
        if (current() && (entry.overflow || (entry.stale && entry.snapshot.status === 'ready')))
          this.scheduleRefresh(entry);
        this.trim();
      });
    const request = entry.request;
    this.trim();
    return request;
  }
  private scheduleRefresh(entry: Entry) {
    if (entry.refreshTimer) return;
    entry.refreshTimer = setTimeout(() => {
      entry.refreshTimer = undefined;
      if (this.entries.get(pageKey(entry.view)) === entry)
        void this.load(entry.view, true).catch(() => {});
    }, 80);
  }
  event(event: any) {
    event = summaryEvent(event);
    for (const entry of this.entries.values()) {
      const relevant = belongs(event, entry.view);
      if (entry.journal) {
        if (relevant) {
          if (entry.journal.length < 512) entry.journal.push(event);
          else entry.overflow = true;
        }
      }
      if (!relevant) continue;
      if (!entry.snapshot.data) {
        entry.stale = true;
        continue;
      }
      if (
        event.cursor &&
        entry.snapshot.data.cursor !== undefined &&
        event.cursor <= entry.snapshot.data.cursor
      )
        continue;
      const result = reduceEvent(entry.snapshot.data, event, entry.view);
      if (result.data !== entry.snapshot.data)
        this.publish(entry, { data: result.data, status: 'ready', error: '' });
      if (result.dirty) {
        entry.stale = true;
        this.scheduleRefresh(entry);
      }
    }
    this.trim();
  }
  reconnect(reconcile = true) {
    for (const entry of reconcile ? this.entries.values() : []) {
      entry.stale = true;
      if (entry.request) entry.overflow = true;
      if (entry.listeners.size) this.scheduleRefresh(entry);
    }
    for (const [key, session] of this.sessions) {
      if (!session.dirty) continue;
      const [id, threadId] = JSON.parse(key);
      void this.saveDraft({ id, threadId }).catch(() => {});
    }
  }
  revoke(id: string) {
    if (this.scope)
      void this.storage
        ?.purge(
          this.scope,
          [...this.access].filter((value) => value !== id),
        )
        .catch(() => {});
    for (const entry of this.entries.values()) {
      if (entry.view.id === id) {
        clearTimeout(entry.refreshTimer);
        clearTimeout(entry.persistTimer);
        entry.controller?.abort();
        // Replace identity to invalidate in-flight requests without reviving revoked data.
        const replacement = {
          ...entry,
          request: undefined,
          controller: undefined,
          journal: undefined,
          stale: true,
          bytes: 0,
          viewport: undefined,
          expanded: [],
          persistTimer: undefined,
          snapshot: {
            data: null,
            status: 'error' as const,
            error: 'Conversation access changed. Reload to continue.',
          },
        };
        this.entries.set(pageKey(entry.view), replacement);
        replacement.listeners.forEach((notify) => notify());
        if (entry.view.id !== id && replacement.listeners.size) this.scheduleRefresh(replacement);
      }
    }
    for (const [key, session] of this.sessions) {
      if (JSON.parse(key)[0] === id || session.value.draftWork?.conversation_id === id) {
        clearTimeout(session.timer);
        session.value = { ...EMPTY };
        session.listeners.forEach((notify) => notify());
        this.sessions.delete(key);
      }
    }
  }
  private session(view: ConversationView) {
    const key = baseKey(view);
    let session = this.sessions.get(key);
    if (!session) {
      session = {
        value: { ...EMPTY },
        listeners: new Set(),
        before: null,
        revision: 0,
        dirty: false,
      };
      this.sessions.set(key, session);
    }
    return session;
  }
  composer(view: ConversationView) {
    return this.session(view).value;
  }
  composerToken(view: ConversationView) {
    return this.session(view);
  }
  historyBefore(view: ConversationView) {
    return this.session(view).before;
  }
  setHistoryBefore(view: ConversationView, before: number | null) {
    this.session(view).before = before;
  }
  subscribeComposer(view: ConversationView, notify: Listener) {
    const session = this.session(view);
    session.listeners.add(notify);
    return () => {
      session.listeners.delete(notify);
      this.trim();
    };
  }
  updateComposer<K extends keyof Composer>(
    view: ConversationView,
    field: K,
    value: Composer[K] | ((previous: Composer[K]) => Composer[K]),
    expected?: Session,
  ) {
    if (expected && this.sessions.get(baseKey(view)) !== expected) return;
    const session = this.session(view);
    session.value = {
      ...session.value,
      [field]:
        typeof value === 'function'
          ? (value as (previous: Composer[K]) => Composer[K])(session.value[field])
          : value,
    };
    if (field === 'draft' || field === 'files') {
      session.revision++;
      session.dirty = true;
      session.value.ready = true;
      if (this.scope && this.access.has(view.id))
        void this.storage
          ?.draft(this.scope, view, {
            view,
            draft: session.value.draft,
            files: session.value.files.map((file) =>
              typeof file === 'string'
                ? file
                : { id: file.id, name: file.name, mime: file.mime, size: file.size },
            ),
          })
          .catch(() => {});
      clearTimeout(session.timer);
      session.timer = setTimeout(() => void this.saveDraft(view).catch(() => {}), 400);
    }
    session.listeners.forEach((notify) => notify());
  }
  loadDraft(view: ConversationView) {
    const session = this.session(view);
    if (session.value.ready) return Promise.resolve();
    if (session.loading) return session.loading;
    const revision = session.revision;
    session.loading = this.fetcher(
      `/conversations/${encodeURIComponent(view.id)}/draft${view.threadId ? '?threadId=' + encodeURIComponent(view.threadId) : ''}`,
    )
      .then((draft) => {
        if (this.sessions.get(baseKey(view)) !== session || session.revision !== revision) return;
        session.value = {
          ...session.value,
          draft: draft.text,
          files: draft.attachments || [],
          ready: true,
        };
        session.listeners.forEach((notify) => notify());
      })
      .finally(() => {
        session.loading = undefined;
      });
    return session.loading;
  }
  saveDraft(view: ConversationView): Promise<void> {
    const session = this.session(view);
    if (session.save) return session.save;
    if (!session.dirty) return Promise.resolve();
    const revision = session.revision;
    const scope = this.scope;
    session.save = this.fetcher(
      `/conversations/${encodeURIComponent(view.id)}/draft`,
      {
        text: session.value.draft,
        attachments: session.value.files.map((file) => (typeof file === 'string' ? file : file.id)),
        threadId: view.threadId || '',
      },
      'PUT',
    )
      .then(() => {
        if (session.revision === revision && this.sessions.get(baseKey(view)) === session) {
          session.dirty = false;
          if (scope) void this.storage?.draft(scope, view).catch(() => {});
        }
        session.value = { ...session.value, saveError: undefined };
        session.listeners.forEach((notify) => notify());
      })
      .catch((error) => {
        if (this.sessions.get(baseKey(view)) === session) {
          session.value = {
            ...session.value,
            saveError: error.message || 'The draft could not be saved.',
          };
          session.listeners.forEach((notify) => notify());
        }
        throw error;
      })
      .finally(() => {
        session.save = undefined;
        if (this.sessions.get(baseKey(view)) === session && session.revision !== revision)
          void this.saveDraft(view).catch(() => {});
        this.trim();
      });
    return session.save;
  }
}

function belongs(event: any, view: ConversationView) {
  return event.conversationId === view.id;
}
function reduceEvent(
  data: HistoryData,
  event: any,
  view: ConversationView,
): { data: HistoryData; dirty: boolean } {
  const p = event.payload || {};
  const index = data.messages.findIndex((message) => message.id === (p.messageId || p.id));
  const message = data.messages[index];
  const replace = (next: Message) => ({
    ...data,
    messages: data.messages.map((item, i) => (i === index ? next : item)),
  });
  if (event.type === 'run.changed') {
    if ((p.thread_id || '') !== (view.threadId || '')) return { data, dirty: false };
    return {
      data: { ...data, runs: [p, ...data.runs.filter((run) => run.id !== p.id)].slice(0, 100) },
      dirty: !data.runs.some((run) => run.id === p.id),
    };
  }
  if (event.type === 'message.updated') {
    if (!message) return { data, dirty: true };
    const stamp = p.textUpdatedAt || event.createdAt;
    if (message.textUpdatedAt && stamp && stamp < message.textUpdatedAt)
      return { data, dirty: false };
    if (p.text !== undefined)
      return { data: replace({ ...message, text: p.text, textUpdatedAt: stamp }), dirty: false };
    if (p.offset === message.text.length)
      return {
        data: replace({ ...message, text: message.text + (p.delta || ''), textUpdatedAt: stamp }),
        dirty: false,
      };
    return { data, dirty: p.offset > message.text.length };
  }
  if (event.type === 'activity.updated' && message) {
    const old = message.activity?.find((item) => item.id === p.activity.id);
    if (old?.updatedAt && p.activity.updatedAt && old.updatedAt > p.activity.updatedAt)
      return { data, dirty: false };
    return {
      data: replace({
        ...message,
        activity: [
          ...(message.activity || []).filter((item) => item.id !== p.activity.id),
          p.activity,
        ].sort((a, b) => Date.parse(a.time) - Date.parse(b.time) || a.id.localeCompare(b.id)),
      }),
      dirty: false,
    };
  }
  if (['message.edited', 'message.deleted'].includes(event.type) && message)
    return { data: replace(p), dirty: true };
  // Refresh membership and thread contents from the server before appending new messages.
  if (
    [
      'message.created',
      'message.finished',
      'decision.created',
      'decision.resolved',
      'artifact.created',
    ].includes(event.type)
  )
    return { data, dirty: true };
  return { data, dirty: false };
}

export const conversationCache = new ConversationCache();
export function useConversationPage(view: ConversationView) {
  const key = pageKey(view);
  const token = conversationCache.pageToken(view);
  const subscribe = useCallback(
    (notify: Listener) => conversationCache.subscribe(view, notify),
    [key, token],
  );
  const read = useCallback(() => conversationCache.read(view), [key, token]);
  return useSyncExternalStore(subscribe, read);
}
export function useConversationComposer(view: ConversationView) {
  const key = baseKey(view);
  const token = conversationCache.composerToken(view);
  const subscribe = useCallback(
    (notify: Listener) => conversationCache.subscribeComposer(view, notify),
    [key, token],
  );
  const read = useCallback(() => conversationCache.composer(view), [key, token]);
  const value = useSyncExternalStore(subscribe, read);
  const set = useCallback(
    <K extends keyof Composer>(
      field: K,
      value: Composer[K] | ((previous: Composer[K]) => Composer[K]),
    ) => conversationCache.updateComposer(view, field, value, token),
    [key, token],
  );
  return { value, set };
}
