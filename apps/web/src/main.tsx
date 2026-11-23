import { ModelNotice, ModelSettings, ModelChoice } from './model-updates';
import { providerFailureKind } from './provider-failure';
import React, {
  lazy,
  Suspense,
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  useCallback,
  useMemo,
  useId,
} from 'react';
import { createRoot } from 'react-dom/client';
import {
  Plus,
  Search,
  Paperclip,
  ArrowUp,
  Square,
  X,
  ChevronDown,
  MessageSquare,
  Plug,
  Users,
  Menu,
  Check,
  ArrowLeft,
  Sun,
  Moon,
  ExternalLink,
  RefreshCw,
  Bell,
  FileText,
  ChevronRight,
  ArrowUpRight,
  Copy,
  Activity,
  Bookmark,
  LogOut,
  Archive,
  RotateCcw,
  Trash2,
  Pencil,
  FolderOpen,
  Target,
  Mic,
} from 'lucide-react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useVirtualizer } from '@tanstack/react-virtual';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import './style.css';
import { WorkspaceMark, NavigationMark, AgentNavigationRow } from './employee-navigation';
import { EmployeeList } from './employee-list';
import { SidePanel } from './side-panel';
import { PreviewContext, usePreview, type PreviewItem } from './preview-model';
import './preview.css';
const PreviewViewer = lazy(() => import('./preview-viewer'));
import { api } from './api';
import { ActivityStep } from './activity-step';
import { CodeBlock } from './code-block';
import { unlockSound, messageSound } from './sounds';
import { rehypeTextReveal, useStreamingText } from './streaming-text';
import { buildReplyTimeline } from './reply-timeline';
import { actionTitle } from './action-title';
import { useFollowConversation } from './follow-conversation';
import {
  conversationCache,
  useConversationPage,
  useConversationComposer,
  type OutgoingMessage,
  type ConversationView,
} from './conversation-cache';
import { useConversationViewport } from './conversation-viewport';
import { GoalsView, ConversationGoals } from './goals-view';
import {
  List,
  Menu as RowMenu,
  Meter,
  Page,
  Row,
  Section,
  Segmented,
  ServiceMark,
  Status,
  Switch,
  namesList,
  type Tone,
} from './surface';
import { BriefingsView } from './chief-briefing-view';
import { VoiceSettings } from './voice-settings';
import { BriefingHistory } from './briefing-history';
import { WorkCards, useConversationWork } from './work-cards';
import type { Employee, Message, ProviderInfo } from '../../../packages/contracts/src/index';
import { activityLabel, isQuietStep } from '../../../packages/contracts/src/activity-label';
const EMPTY_MESSAGES: Message[] = [];
const EMPTY_ITEMS: any[] = [];
async function ensureBrowserNotificationSubscription(publicKey: string) {
  const registration = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  const padding = '='.repeat((4 - (publicKey.length % 4)) % 4);
  const expectedKey = Uint8Array.from(
    atob((publicKey + padding).replace(/-/g, '+').replace(/_/g, '/')),
    (character) => character.charCodeAt(0),
  );
  let subscription = await registration.pushManager.getSubscription();
  if (subscription) {
    const currentKey = subscription.options.applicationServerKey;
    const bytes = currentKey ? new Uint8Array(currentKey as ArrayBuffer) : null;
    const sameKey =
      bytes?.length === expectedKey.length &&
      bytes.every((byte, index) => byte === expectedKey[index]);
    if (!sameKey) {
      await api('/notifications/subscribe', { endpoint: subscription.endpoint }, 'DELETE');
      if (!(await subscription.unsubscribe()))
        throw new Error('Could not replace the browser notification subscription.');
      subscription = null;
    }
  }
  subscription ??= await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: expectedKey,
  });
  await api('/notifications/subscribe', subscription.toJSON());
  window.dispatchEvent(new Event('workspace-notification-channel'));
}
const names: Record<string, string> = {
  codex: 'Codex',
  claude: 'Claude Code',
  opencode: 'OpenCode',
};
const serviceNames: Record<string, string> = {
  railway: 'Railway',
  stripe: 'Stripe',
  gmail: 'Gmail',
};
function activityTitle(value: string) {
  const titles: Record<string, string> = {
    workspace_read: 'Read conversation',
    workspace_team: 'Check team',
    workspace_propose_team: 'Propose employees',
    workspace_delegate: 'Brief employee',
    workspace_find_memory: 'Search memory',
    workspace_remember: 'Save memory',
    workspace_request_connection: 'Connect account',
  };
  return (
    titles[value] ||
    value
      .replace(/^mcp__workspace__/, '')
      .replace(/^workspace_/, '')
      .replaceAll('_', ' ')
      .replace(/^./, (c) => c.toUpperCase())
  );
}
/** What a step did, in words: its derived label, else its tool name tidied up. */
function stepTitle(step: { type: string; title: string; label?: string; detail?: string }) {
  return step.label || activityLabel(step) || activityTitle(step.title);
}
function activityTimeLabel(value?: string) {
  if (!value) return '';
  const time = new Date(value);
  return Number.isNaN(time.getTime())
    ? ''
    : time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function Avatar({
  id,
  name,
  human = false,
  size = 30,
}: {
  id: string;
  name: string;
  human?: boolean;
  size?: number;
}) {
  let seed = 0;
  for (const char of id) seed = (seed * 31 + char.charCodeAt(0)) >>> 0;
  return human ? (
    <span className="avatar human" style={{ width: size, height: size }}>
      {name.slice(0, 1)}
    </span>
  ) : (
    <svg
      className="avatar agent"
      width={size}
      height={size}
      viewBox="0 0 7 7"
      aria-label={`${name}, agent`}
    >
      <rect width="7" height="7" rx="1" fill="var(--tint)" />
      {Array.from({ length: 25 }, (_, i) =>
        (seed >> (Math.floor(i / 5) * 3 + Math.min(i % 5, 4 - (i % 5))) % 24) & 1 || i === 12 ? (
          <rect
            key={i}
            x={1 + (i % 5)}
            y={1 + Math.floor(i / 5)}
            width=".8"
            height=".8"
            rx=".1"
            fill="var(--accent)"
          />
        ) : null,
      )}
    </svg>
  );
}
function Modal({
  title,
  onClose,
  children,
  className,
  busy = false,
}: {
  className?: string;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const backdropPress = useRef(false);
  const outside = (
    e: React.MouseEvent<HTMLDialogElement> | React.PointerEvent<HTMLDialogElement>,
  ) => {
    const r = e.currentTarget.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className={className}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      onPointerDown={(e) => {
        backdropPress.current = outside(e);
      }}
      onClick={(e) => {
        if (!busy && backdropPress.current && outside(e)) onClose();
        backdropPress.current = false;
      }}
    >
      <header>
        <h2>{title}</h2>
        <button className="icon" aria-label="Close" disabled={busy} onClick={onClose}>
          <X size={18} />
        </button>
      </header>
      {children}
    </dialog>
  );
}
function NavigationActions({
  label,
  actions,
  onAction,
}: {
  label: string;
  actions: { id: string; label: string; danger?: boolean }[];
  onAction: (id: string) => void;
}) {
  if (!actions.length) return null;
  const icons: Record<string, typeof Archive> = {
    'delete-agent': Trash2,
    'reactivate-agent': RotateCcw,
  };
  const buttons = actions.map((action) => {
    const Icon = icons[action.id];
    return (
      <button
        key={action.id}
        type="button"
        className={`nav-action-button${action.danger ? ' danger-action' : ''}`}
        aria-label={`${action.label} ${label}`}
        title={`${action.label} ${label}`}
        onClick={(event) => {
          event.stopPropagation();
          onAction(action.id);
        }}
      >
        <Icon size={14} strokeWidth={1.8} />
      </button>
    );
  });
  return (
    <div className="nav-actions" role="group" aria-label={`${label} actions`}>
      {buttons}
    </div>
  );
}
function ConfirmWorkspaceAction({ action, onClose, onConfirm }: any) {
  const pending = useRef(false);
  const cancelButton = useRef<HTMLButtonElement>(null);
  useEffect(() => cancelButton.current?.focus(), []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const copy: Record<
    string,
    { title: string; description: string; button: string; permanent?: boolean }
  > = {
    'deactivate-agent': {
      title: `Deactivate ${action.name}?`,
      description:
        'The agent will stop working, and its scheduled runs will pause. Its conversation will remain. You can reactivate it later.',
      button: 'Deactivate agent',
    },
    'delete-agent': {
      title: `Delete ${action.name}?`,
      description:
        'This stops active work, removes scheduled runs, and permanently deletes the agent and its private conversation.',
      button: 'Delete agent',
      permanent: true,
    },
  };
  const content = copy[action.kind];
  return (
    <Modal
      title={content.title}
      onClose={busy ? () => {} : onClose}
      className="confirm-workspace-action"
      busy={busy}
    >
      <div className="confirm-action-body ui-stack">
        <p>{content.description}</p>
        {content.permanent && <p className="confirm-action-warning">This cannot be undone.</p>}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </div>
      <footer className="confirm-action-footer">
        <button
          ref={cancelButton}
          className="secondary"
          autoFocus
          disabled={busy}
          onClick={onClose}
        >
          Cancel
        </button>
        <button
          className={content.permanent ? 'danger-button' : 'primary'}
          disabled={busy}
          onClick={async () => {
            if (pending.current) return;
            pending.current = true;
            setBusy(true);
            setError('');
            try {
              await onConfirm();
            } catch (failure: any) {
              setError(failure.message);
            } finally {
              pending.current = false;
              setBusy(false);
            }
          }}
        >
          {busy ? 'Working…' : content.button}
        </button>
      </footer>
    </Modal>
  );
}
function ConfirmMessageDelete({ message, onClose, onConfirm }: any) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <Modal
      title="Delete this message?"
      onClose={busy ? () => {} : onClose}
      className="confirm-workspace-action"
    >
      <div className="confirm-action-body ui-stack">
        <p>
          It will be removed from the conversation. In-progress agent work started from it will be
          cancelled.
          {message.replyCount > 0 && ' Replies already posted will stay in the thread.'}
        </p>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </div>
      <footer className="confirm-action-footer">
        <button className="secondary" autoFocus disabled={busy} onClick={onClose}>
          Keep message
        </button>
        <button
          className="danger-button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              await onConfirm();
            } catch (failure: any) {
              setError(failure.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Deleting…' : 'Delete message'}
        </button>
      </footer>
    </Modal>
  );
}
function App() {
  const [desktopControl, setDesktopControl] = useState<any>({ active: false });
  const [threadWidth, setThreadWidth] = useState(() =>
    Math.max(300, Math.min(760, Number(localStorage.getItem('thread-width')) || 390)),
  );
  const [preview, setPreview] = useState<PreviewItem | null>(null);
  const [previewVisit, setPreviewVisit] = useState(0);
  const [panelExpanded, setPanelExpanded] = useState(false);
  const [resumeThread, setResumeThread] = useState(false);
  const previewTrigger = useRef<{ element: HTMLElement; key?: string; inThread: boolean } | null>(
    null,
  );
  const toastTimer = useRef<number | null>(null);
  const searchAnchor = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const [briefingId, setBriefingId] = useState<string>();
  const [jump, setJump] = useState<Message | null>(null);
  const [conversationVisit, setConversationVisit] = useState(0);
  useEffect(() => {
    localStorage.setItem('thread-width', String(threadWidth));
  }, [threadWidth]);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = Number(localStorage.getItem('sidebar-width'));
    return saved >= 200 && saved <= 420 ? saved : 248;
  });
  const [resizing, setResizing] = useState(false);
  const sidebarDrag = useRef({ x: 0, width: 248 });
  const resizeSidebar = (width: number) =>
    setSidebarWidth(Math.round(Math.max(200, Math.min(420, window.innerWidth - 360, width))));
  useEffect(() => {
    localStorage.setItem('sidebar-width', String(sidebarWidth));
  }, [sidebarWidth]);
  const notificationPrefs = useRef<any>({ enabled: true, sound: true });
  useEffect(() => {
    window.addEventListener('pointerdown', unlockSound, { once: true });
    return () => window.removeEventListener('pointerdown', unlockSound);
  }, []);
  const [workspace, setWorkspace] = useState<any>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [selected, setSelected] = useState(
      new URLSearchParams(location.search).get('conversation') ||
        localStorage.getItem('active-conversation') ||
        '',
    ),
    [view, setView] = useState(
      ['connections', 'usage', 'goals', 'briefings'].includes(localStorage.getItem('active-view') || '')
        ? localStorage.getItem('active-view')!
        : 'chat',
    ),
    [thread, setThread] = useState<Message | null>(null),
    [modal, setModal] = useState(''),
    [confirmAction, setConfirmAction] = useState<any>(null),
    [mobile, setMobile] = useState(false),
    [theme, setTheme] = useState(localStorage.getItem('theme') || 'light'),
    [revision, setRevision] = useState(0),
    [toast, setToast] = useState<any>(null),
    [providers, setProviders] = useState<ProviderInfo[]>([]),
    [search, setSearch] = useState(''),
    [results, setResults] = useState<Message[]>([]);
  useEffect(() => {
    if (selected) localStorage.setItem('active-conversation', selected);
  }, [selected]);
  useEffect(() => {
    localStorage.setItem('active-view', view);
  }, [view]);
  useEffect(() => {
    if (modal !== 'search') return;
    searchInput.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setModal('');
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!searchAnchor.current?.contains(event.target as Node)) setModal('');
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [modal]);
  const dismissToast = useCallback(() => {
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = null;
    setToast(null);
  }, []);
  useEffect(
    () => () => {
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    },
    [],
  );
  const refresh = useCallback(async () => {
    const w = await api('/workspace');
    conversationCache.setScope(
      location.origin + ':' + w.user.id,
      w.conversations.map((item: any) => item.id),
      [...w.employees, ...(w.inactiveEmployees || [])].map((item: any) => item.id),
    );
    await conversationCache.ready();
    setWorkspace(w);
    setSelected((v: string) =>
      w.conversations.some((conversation: any) => conversation.id === v)
        ? v
        : w.conversations.find((conversation: any) => !conversation.agentDeactivated)?.id || '',
    );
    return w;
  }, []);
  useEffect(() => {
    (async () => {
      try {
        const token = new URLSearchParams(location.hash.slice(1)).get('setup');
        if (token) {
          await api('/bootstrap', { token });
          history.replaceState(null, '', location.pathname);
        }
        try {
          await refresh();
        } catch (authError: any) {
          const invite = new URLSearchParams(location.hash.slice(1)).get('invite');
          const localHost = ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname);
          if (authError.status !== 401 || !localHost || invite) throw authError;
          await api('/local-session', {});
          await refresh();
        }
        const query = new URLSearchParams(location.search);
        if (query.get('message')) {
          const message = await api(
            '/messages/' + encodeURIComponent(query.get('message')!) + '?activity=summary',
          );
          const root = message.threadId
            ? await api('/messages/' + encodeURIComponent(message.threadId) + '?activity=summary')
            : null;
          setSelected(message.conversationId);
          setThread(root);
          setJump(message);
        } else if (query.get('thread') && query.get('conversation')) {
          const root = await api(
            '/messages/' + encodeURIComponent(query.get('thread')!) + '?activity=summary',
          );
          setThread(root);
        }
      } catch (e: any) {
        if (e.status !== 401) setError(e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [refresh]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('theme', theme);
  }, [theme]);
  useEffect(() => {
    if (!workspace) {
      document.title = 'Abralo';
      return;
    }
    const conversation = workspace.conversations.find((item: any) => item.id === selected);
    const employee = workspace.employees.find(
      (item: Employee) => item.id === conversation?.employeeId,
    );
    const location =
      view === 'connections'
        ? 'Connections'
        : view === 'usage'
          ? 'Usage'
        : view === 'briefings'
          ? 'Morning briefing'
        : view === 'goals'
          ? 'Goals'
          : employee?.name || conversation?.name || 'Workspace';
    const unread = workspace.conversations.reduce(
      (total: number, conversation: { unread: number }) => total + conversation.unread,
      0,
    );
    document.title = `${unread > 0 ? `(${unread}) ` : ''}${location} · ${workspace.name || 'Abralo'}`;
  }, [workspace, selected, view]);
  const notificationView = useRef({ selected, thread });
  notificationView.current = { selected, thread };
  useEffect(() => {
    const listener = (event: Event) => conversationCache.event((event as CustomEvent).detail);
    const flush = () => { if (document.visibilityState === 'hidden') conversationCache.flush(); };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', flush);
    window.addEventListener('workspace-event', listener);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', flush);
      window.removeEventListener('workspace-event', listener);
    };
  }, []);
  useEffect(() => {
    if (!workspace) return;
    if (workspace.user?.role === 'owner') {
      void api('/desktop-control')
        .then(setDesktopControl)
        .catch(() => {});
      const timer = window.setInterval(
        () =>
          void api('/desktop-control')
            .then(setDesktopControl)
            .catch(() => {}),
        5000,
      );
      return () => window.clearInterval(timer);
    }
  }, [workspace?.user?.id]);
  useEffect(() => {
    if (!workspace) return;
    void api('/notifications')
      .then((v) => {
        notificationPrefs.current = v.preferences;
        if (
          v.preferences.enabled &&
          'Notification' in window &&
          Notification.permission === 'granted' &&
          'serviceWorker' in navigator
        )
          void ensureBrowserNotificationSubscription(v.publicKey).catch((error) =>
            console.warn('Could not repair browser notifications:', error),
          );
      })
      .catch(() => {});
    const es = new EventSource('/api/events?activity=summary&after=' + workspace.cursor);
    let resyncTimer: ReturnType<typeof setTimeout> | undefined;
    es.onopen = () => {
      void refresh().catch(() => {});
      conversationCache.reconnect(false);
    };
    es.onmessage = (e) => {
      const event = JSON.parse(e.data);
      if (event.type === 'workspace.resync') {
        conversationCache.reconnect();
        if (!resyncTimer) resyncTimer = setTimeout(() => {
          resyncTimer = undefined;
          void refresh().catch(() => {});
          setRevision((v) => v + 1);
          void api('/providers').then(setProviders).catch(() => {});
          window.dispatchEvent(new CustomEvent('workspace-event', { detail: { type: 'workspace.resync' } }));
          void api('/notifications').then((v) => { notificationPrefs.current = v.preferences; }).catch(() => {});
          const id = notificationView.current.thread?.id;
          if (id) void api('/messages/' + encodeURIComponent(id) + '?activity=summary')
            .then((message) => setThread((current: any) => current?.id === id ? message : current))
            .catch(() => {});
        }, 100);
        return;
      }
      if (event.type === 'desktop.control') setDesktopControl(event.payload);
      const { selected, thread } = notificationView.current;
      if (['message.edited', 'message.deleted'].includes(event.type)) {
        if (thread?.id === event.payload.id) setThread(event.payload);
      }
      if (event.type === 'models.changed') void api('/providers').then(setProviders).catch(() => {});
      if (event.type === 'notifications.preferences') notificationPrefs.current = event.payload;
      if (
        event.type === 'notification.message' &&
        notificationPrefs.current.enabled &&
        !document.hidden &&
        document.hasFocus()
      )
        void api('/notifications/ack', { messageId: event.payload.id }).catch(() => {});
      window.dispatchEvent(new CustomEvent('workspace-event', { detail: event }));
      if (
        [
          'workspace.changed',
          'message.created',
          'message.finished',
          'message.edited',
          'message.deleted',
          'run.changed',
          'inbox.changed',
          'notification.message',
        ].includes(event.type)
      )
        void refresh().catch(() => {});
      if (
        event.type === 'notification.message' &&
        notificationPrefs.current.enabled &&
        (event.conversationId !== selected ||
          (event.payload.threadId || null) !== (thread?.id || null) ||
          document.hidden ||
          !document.hasFocus())
      ) {
        if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
        setToast({ ...event.payload, conversationId: event.conversationId });
        if (
          !document.hidden &&
          notificationPrefs.current.enabled &&
          notificationPrefs.current.sound
        )
          messageSound(!!event.payload.tagged);
        toastTimer.current = window.setTimeout(() => {
          toastTimer.current = null;
          setToast(null);
        }, 7000);
        // A hidden or unfocused tab never acknowledges delivery to the service.
      }
      if (
        [
          'proposal.created',
          'connection.requested',
          'connection.ready',
          'connection.action',
          'connection.action.dismissed',
          'goal.changed',
          'work.changed',
          'decision.created',
          'decision.resolved',
        ].includes(event.type)
      )
        setRevision((v) => v + 1);
    };
    return () => { clearTimeout(resyncTimer); es.close(); };
  }, [workspace?.user?.id]);
  useEffect(() => {
    if (workspace?.user.role === 'owner')
      api('/providers')
        .then(setProviders)
        .catch((e) => setError(e.message));
  }, [workspace?.user?.id]);
  useEffect(() => {
    if (!search.trim()) {
      setResults([]);
      return;
    }
    const timer = setTimeout(
      () =>
        api('/search?q=' + encodeURIComponent(search))
          .then(setResults)
          .catch((e) => setError(e.message)),
      250,
    );
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    const shortcut = (e: KeyboardEvent) => {
      if (
        workspace &&
        !modal &&
        (e.ctrlKey || e.metaKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === 'f'
      ) {
        e.preventDefault();
        setModal('search');
      }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [workspace, modal]);
  const prefetchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancelPrefetch = () => clearTimeout(prefetchTimer.current);
  useEffect(() => cancelPrefetch, []);
  const prefetchConversation = (id: string) => {
    cancelPrefetch();
    const item = workspace?.conversations.find((conversation: any) => conversation.id === id);
    if (!item) return;
    const view = {
      id,
      employeeId: workspace.employees.find((employee: Employee) => employee.id === item.employeeId)
        ?.id,
    };
    prefetchTimer.current = setTimeout(
      () => void conversationCache.load(view).catch(() => {}),
      120,
    );
  };
  const choose = (id: string, threadId?: string) => {
    setPreview(null);
    setPanelExpanded(false);
    setResumeThread(false);
    setConversationVisit((visit) => visit + 1);
    setJump(null);
    setSelected(id);
    setView('chat');
    setThread(null);
    if (typeof threadId === 'string')
      void api('/messages/' + encodeURIComponent(threadId) + '?activity=summary')
        .then(setThread)
        .catch((e) => setError(e.message));
    setMobile(false);
  };
  async function openMessage(messageId: string) {
    try {
      const message = await api('/messages/' + encodeURIComponent(messageId) + '?activity=summary');
      const root = message.threadId
        ? await api('/messages/' + encodeURIComponent(message.threadId) + '?activity=summary')
        : null;
      choose(message.conversationId);
      setThread(root);
      setJump(message);
    } catch (e: any) {
      setError(e.message);
    }
  }
  const updateMessage = (message: Message) => {
    setThread((current) => (current?.id === message.id ? message : current));
    setResults((current) => current.map((item) => (item.id === message.id ? message : item)));
  };
  const openPreview = useCallback(
    (item: PreviewItem) => {
      const element = document.activeElement as HTMLElement;
      previewTrigger.current = {
        element,
        key: element?.dataset.previewId,
        inThread: !!element.closest('.side-panel'),
      };
      setResumeThread(!!thread);
      setPreview({
        ...item,
        onDiscuss:
          item.onDiscuss ||
          (thread
            ? () => {
                setPreview(null);
                setPanelExpanded(false);
              }
            : undefined),
      });
      setPreviewVisit((visit) => visit + 1);
      setPanelExpanded(true);
    },
    [thread],
  );
  const closePreview = () => {
    setPreview(null);
    setPanelExpanded(false);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const trigger = previewTrigger.current;
        const element = trigger?.element.isConnected
          ? trigger.element
          : trigger?.key
            ? document.querySelector<HTMLElement>(
                `${trigger.inThread ? '.side-panel ' : '.conversation-columns > .chat '}[data-preview-id="${CSS.escape(trigger.key)}"]`,
              )
            : null;
        element?.focus({ preventScroll: true });
      }),
    );
  };
  const openThread = (message: Message) => {
    setPreview(null);
    setPanelExpanded(false);
    setResumeThread(false);
    setThread(message);
  };
  const requestNavigationAction = (kind: string, item: { id: string; name: string }) => {
    if (kind === 'reactivate-agent') {
      const endpoint = `/employees/${encodeURIComponent(item.id)}/reactivate`;
      void api(endpoint, {}, 'POST')
        .then(() => refresh())
        .catch((e: any) => setError(e.message));
      return;
    }
    setConfirmAction({ kind, ...item });
  };
  const confirmNavigationAction = async () => {
    const { kind, id } = confirmAction;
    if (kind === 'deactivate-agent')
      await api(`/employees/${encodeURIComponent(id)}/deactivate`, {}, 'POST');
    else if (kind === 'delete-agent')
      await api(`/employees/${encodeURIComponent(id)}`, {}, 'DELETE');
    await refresh();
    setConfirmAction(null);
  };
  async function openNotification(item: any) {
    try {
      const message = await api('/messages/' + encodeURIComponent(item.id) + '?activity=summary');
      const root = message.threadId
        ? await api('/messages/' + encodeURIComponent(message.threadId) + '?activity=summary')
        : null;
      choose(message.conversationId);
      setThread(root);
      setJump(message);
      setModal('');
      dismissToast();
    } catch (e: any) {
      setError(e.message);
    }
  }
  if (loading)
    return (
      <main className="launch">
        <div className="brand-mark">▦</div>
        <p>Opening your workspace…</p>
      </main>
    );
  if (!workspace) return <Login onDone={refresh} error={error} />;
  if (!workspace.onboarded && workspace.user.role === 'owner')
    return (
      <Onboarding
        providers={providers}
        userName={workspace.user.name === 'You' ? '' : workspace.user.name}
        refreshProviders={(harness?: string) =>
          api('/providers' + (harness ? '?check=' + harness : '')).then(setProviders)
        }
        onDone={async (id: string) => {
          await refresh();
          choose(id);
        }}
        fail={setError}
        error={error}
      />
    );
  const conversation = workspace.conversations.find((c: any) => c.id === selected),
    employee = workspace.employees.find((e: Employee) => e.id === conversation?.employeeId),
    inactiveEmployee = (workspace.inactiveEmployees ?? []).find(
      (e: Employee) => e.id === conversation?.employeeId,
    );
  const conversationIdentity = (
    <>
      {employee || inactiveEmployee ? (
        <Avatar
          id={(employee || inactiveEmployee).id}
          name={(employee || inactiveEmployee).name}
          size={34}
        />
      ) : (
        <WorkspaceMark size={24} />
      )}
      <div>
        <h1>{conversation?.name}</h1>
        <p>
          {employee || inactiveEmployee
            ? `${names[(employee || inactiveEmployee).harness]} · ${(employee || inactiveEmployee).role || 'Agent'}${inactiveEmployee ? ' · Deactivated' : ''}`
            : 'Shared conversation'}
        </p>
      </div>
    </>
  );
  return (
    <div
      className={`workspace${resizing ? ' resizing' : ''}`}
      style={{ '--sidebar-width': `${sidebarWidth}px` } as React.CSSProperties}
    >
      <aside className={mobile ? 'sidebar open' : 'sidebar'}>
        <button
          className="workspace-name"
          aria-label="Workspace settings"
          title="Workspace settings"
          onClick={() => setModal('settings')}
        >
          <span className="brand-mark">▦</span>
          <strong>{workspace.name}</strong>
          <ChevronDown size={15} />
        </button>
        <nav>
          <div className="workspace-destinations">
            <button
              aria-current={view === 'goals' ? 'page' : undefined}
              className={`nav-row goals-nav${view === 'goals' ? ' selected' : ''}`}
              onClick={() => {
                setView('goals');
                setMobile(false);
              }}
            >
              <NavigationMark kind="goals" />
              <span>Goals</span>
            </button>
            {workspace.user.role === 'owner' && (
              <button className={`nav-row${view === 'briefings' ? ' selected' : ''}`}
                aria-current={view === 'briefings' ? 'page' : undefined}
                onClick={() => { setBriefingId(undefined); setView('briefings'); setMobile(false); }}>
                <NavigationMark kind="briefing" /><span>Morning briefing</span>
              </button>
            )}
          </div>
          <div className="nav-title">
            <span>Employees</span>
            <button className="icon" aria-label="Add employee" onClick={() => setModal('employee')}>
              <Plus size={15} />
            </button>
          </div>
          <EmployeeList key={workspace.user.id} employees={workspace.employees} userId={workspace.user.id}>
          {(e, reorderDescriptionId) => (
            <AgentNavigationRow
              key={e.id}
              employee={e}
              reorderDescriptionId={reorderDescriptionId}
              selected={selected === e.dmId && view === 'chat'}
              unread={Boolean(
                e.attentionUnread ||
                  workspace.conversations.find((c: any) => c.id === e.dmId)?.unread > 0,
              )}
              onClick={() => choose(e.dmId)}
              onIntent={() => prefetchConversation(e.dmId)}
              onIntentEnd={cancelPrefetch}
              avatar={<Avatar id={e.id} name={e.name} size={26} />}
            />
          )}
          </EmployeeList>
          {(workspace.inactiveEmployees?.length ?? 0) > 0 && (
            <>
              <div className="nav-title inactive-nav-title">
                <span>Inactive</span>
              </div>
              {(workspace.inactiveEmployees ?? []).map((e: Employee) => (
                <div className="nav-item inactive-nav-item employee-row" key={e.id}>
                  <Avatar id={e.id} name={e.name} size={26} />
                  <span className="employee-name" title={e.name}>
                    {e.name}
                  </span>
                  {workspace.user.role === 'owner' && (
                    <NavigationActions
                      label={e.name}
                      actions={[
                        { id: 'reactivate-agent', label: 'Reactivate agent' },
                        { id: 'delete-agent', label: 'Delete agent…', danger: true },
                      ]}
                      onAction={(id) => requestNavigationAction(id, { id: e.id, name: e.name })}
                    />
                  )}
                </div>
              ))}
            </>
          )}
          {workspace.humans
            .filter((h: any) => h.id !== workspace.user.id)
            .map((h: any) => (
              <button
                className="nav-row employee-row"
                key={h.id}
                disabled={h.id === workspace.user.id}
                onClick={async () => {
                  try {
                    const c = await api('/humans/' + h.id + '/conversation', {});
                    await refresh();
                    choose(c.id);
                  } catch (e: any) {
                    setError(e.message);
                  }
                }}
              >
                <Avatar id={h.id} name={h.name} human size={26} />
                <span className="employee-name" title={h.name}>
                  {h.name}
                  {h.id === workspace.user.id ? ' (you)' : ''}
                </span>
                <span className="member-kind">Person</span>
              </button>
            ))}
        </nav>
        {workspace.user.role === 'owner' && <ModelNotice onOpen={() => { setModal('model-settings'); setMobile(false); }} />}
        <footer>
          <button
            className={`icon${view === 'connections' ? ' selected' : ''}`}
            aria-label="Connections"
            title="Connections"
            onClick={() => {
              setView('connections');
              setMobile(false);
            }}
          >
            <Plug size={17} />
          </button>
          <button
            className={`icon${view === 'usage' ? ' selected' : ''}`}
            aria-label="Usage"
            title="Usage"
            onClick={() => {
              setView('usage');
              setMobile(false);
            }}
          >
            <Activity size={16} />
          </button>
          <button
            className="icon"
            aria-label="Toggle theme"
            title="Toggle theme"
            onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
          >
            {theme === 'light' ? <Moon size={16} /> : <Sun size={16} />}
          </button>
        </footer>
        <div
          className="sidebar-resizer"
          role="separator"
          aria-label="Resize sidebar"
          aria-orientation="vertical"
          aria-valuemin={200}
          aria-valuemax={420}
          aria-valuenow={sidebarWidth}
          tabIndex={0}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            sidebarDrag.current = {
              x: e.clientX,
              width: e.currentTarget.parentElement!.getBoundingClientRect().width,
            };
            e.currentTarget.setPointerCapture(e.pointerId);
            setResizing(true);
          }}
          onPointerMove={(e) => {
            if (e.currentTarget.hasPointerCapture(e.pointerId))
              resizeSidebar(sidebarDrag.current.width + e.clientX - sidebarDrag.current.x);
          }}
          onPointerUp={(e) => {
            if (e.currentTarget.hasPointerCapture(e.pointerId))
              e.currentTarget.releasePointerCapture(e.pointerId);
            setResizing(false);
          }}
          onLostPointerCapture={() => setResizing(false)}
          onDoubleClick={() => setSidebarWidth(248)}
          onKeyDown={(e) => {
            if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
              e.preventDefault();
              resizeSidebar(
                e.key === 'Home'
                  ? 200
                  : e.key === 'End'
                    ? 420
                    : sidebarWidth + (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 40 : 10),
              );
            }
          }}
          title="Drag to resize · double-click to reset"
        />
      </aside>
      {mobile && (
        <button className="scrim" aria-label="Close navigation" onClick={() => setMobile(false)} />
      )}
      <main className="main">
        {desktopControl.active && (
          <div className="desktop-control-banner" role="status">
            <span>
              <strong>Desktop control active</strong> · {desktopControl.employeeName} · until{' '}
              {new Date(desktopControl.expiresAt).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
            <button
              className="secondary"
              onClick={() =>
                void api('/desktop-control/revoke', {}, 'POST')
                  .then(setDesktopControl)
                  .catch((e) => setError(e.message))
              }
            >
              Stop control
            </button>
          </div>
        )}
        {view === 'briefings' && <button className="icon chief-mobile-navigation" aria-label="Open workspace navigation" onClick={() => setMobile(true)}><Menu size={18} /></button>}
        {view !== 'briefings' && <header className="conversation-header">
          <button
            className="icon mobile-menu"
            aria-label="Open navigation"
            onClick={() => setMobile(true)}
          >
            <Menu size={20} />
          </button>
          {view === 'connections' ? (
            <>
              <Plug size={20} />
              <div>
                <h1>Connections</h1>
                <p>Accounts your team can use.</p>
              </div>
            </>
          ) : view === 'usage' ? (
            <>
              <Activity size={20} />
              <div>
                <h1>Usage</h1>
                <p>How much room your team has.</p>
              </div>
            </>
          ) : view === 'briefings' ? (
            <><Mic size={20} /><div><h1>Morning briefing</h1><p>A conversation with your Chief of Staff.</p></div></>
          ) : view === 'goals' ? (
            <>
              <Target size={20} />
              <div>
                <h1>Goals</h1>
                <p>What you want to achieve.</p>
              </div>
            </>
          ) : conversation ? (
            employee ? (
              <button
                className="conversation-identity"
                aria-label={`${employee?.name || conversation.name} settings`}
                title="Open employee settings"
                onClick={() => setModal('edit-employee')}
              >
                {conversationIdentity}
              </button>
            ) : (
              <div className="conversation-identity">{conversationIdentity}</div>
            )
          ) : (
            <h1>Workspace</h1>
          )}
          {workspace.user.role === 'owner' && view === 'chat' && employee && (workspace.chiefOfStaffId === employee.id || /\bchief of staff\b/i.test(employee.name + ' ' + employee.role)) &&
            <button className="quiet-button" onClick={() => setModal('briefing-history')}>Morning briefings</button>}
          <div className={`search-anchor${modal === 'search' ? ' open' : ''}`} ref={searchAnchor}>
            <button
              className="icon workspace-search-icon"
              aria-label="Search workspace"
              aria-haspopup="dialog"
              aria-expanded={modal === 'search'}
              aria-controls="workspace-search-popover"
              title="Search workspace (Ctrl+Shift+F / ⌘+Shift+F)"
              onClick={() => setModal(modal === 'search' ? '' : 'search')}
            >
              <Search size={19} />
            </button>
            {modal === 'search' && (
              <section
                id="workspace-search-popover"
                className="search-popover"
                role="dialog"
                aria-label="Search workspace"
              >
                <div className="search-field">
                  <Search size={18} />
                  <input
                    ref={searchInput}
                    aria-label="Search messages and decisions"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search messages and decisions"
                  />
                  {search && (
                    <button
                      className="icon"
                      aria-label="Clear search"
                      onClick={() => setSearch('')}
                    >
                      <X size={16} />
                    </button>
                  )}
                </div>
                <div className="search-results">
                  {results.map((m) => (
                    <button
                      className="search-result"
                      key={m.id}
                      onClick={async () => {
                        try {
                          const root = m.threadId
                            ? await api(
                                '/messages/' + encodeURIComponent(m.threadId) + '?activity=summary',
                              )
                            : null;
                          choose(m.conversationId);
                          setThread(root);
                          setJump(m);
                          setModal('');
                        } catch (e: any) {
                          setError(e.message);
                        }
                      }}
                    >
                      <strong>{m.authorName}</strong>
                      <small>
                        {workspace.conversations.find((c: any) => c.id === m.conversationId)?.name}
                      </small>
                      <p>{m.text.slice(0, 240)}</p>
                    </button>
                  ))}
                  {!!search.trim() && !results.length && <p className="search-empty">No matches</p>}
                </div>
              </section>
            )}
          </div>
        </header>}
        {error && (
          <div className="error-bar" role="alert" title={readableError(error) === error ? undefined : error}>
            {readableError(error)}
            <button className="icon" aria-label="Dismiss error" onClick={() => setError('')}>
              <X size={16} />
            </button>
          </div>
        )}
        {view === 'connections' ? (
          <ConnectionsView revision={revision} fail={setError} employees={workspace.employees} />
        ) : view === 'usage' ? (
          <UsageView
            employees={workspace.employees}
            avatar={(id: string, name: string) => <Avatar id={id} name={name} size={24} />}
            onOpenConnections={() => setView('connections')}
          />
        ) : view === 'briefings' ? (
          <BriefingsView conversationId={selected || undefined} initialBriefingId={briefingId} onOpenVoiceSettings={() => setModal('voice-settings')} />
        ) : view === 'goals' ? (
          <GoalsView
            conversationId={selected}
            conversations={workspace.conversations}
            employees={workspace.employees}
            revision={revision}
            onOpenConversation={choose}
            avatar={(id, name) => <Avatar id={id} name={name} size={20} />}
            fail={setError}
          />
        ) : conversation ? (
          <PreviewContext.Provider value={openPreview}>
            <div className="conversation-columns">
              <Chat
                key={`${selected}:${conversationVisit}`}
                focusMessage={!jump?.threadId ? jump : null}
                restoreViewport={!jump}
                id={selected}
                employee={employee}
                employees={workspace.employees}
                conversations={workspace.conversations}
                providers={providers}
                user={workspace.user}
                onOpenConversation={choose}
                onOpenMessage={openMessage}
                onThread={openThread}
                onMessageChange={updateMessage}
                fail={setError}
                onRead={refresh}
                onOpenGoals={() => setView('goals')}
                revision={revision}
                readOnly={!!conversation.agentDeactivated}
              />
              {(thread || preview) && (
                <SidePanel
                  width={threadWidth}
                  onWidth={setThreadWidth}
                  onResize={setResizing}
                  preview={!!preview}
                  expanded={panelExpanded}
                >
                  {preview ? (
                    <Suspense
                      fallback={
                        <div className="preview-state" role="status">
                          Opening preview…
                          <button className="quiet-button" onClick={closePreview}>
                            Close preview
                          </button>
                        </div>
                      }
                    >
                      <PreviewViewer
                        key={previewVisit}
                        item={preview}
                        expanded={panelExpanded}
                        onExpand={() => setPanelExpanded(!panelExpanded)}
                        onClose={closePreview}
                      />
                    </Suspense>
                  ) : (
                    thread && (
                      <>
                        <header className="thread-header">
                          <div className="thread-heading">
                            <h2>Thread</h2>
                            <span>{thread.replyCount || 0} replies</span>
                          </div>
                          <button
                            className="icon"
                            onClick={() => setThread(null)}
                            aria-label="Close thread"
                          >
                            <X size={18} />
                          </button>
                          <div className="thread-parent">
                            <Avatar
                              id={thread.authorId}
                              name={thread.authorName}
                              human={thread.kind === 'human'}
                              size={26}
                            />
                            <div className="thread-parent-content">
                              <div className="thread-parent-meta">
                                <strong>{thread.authorName}</strong>
                                {thread.kind === 'agent' && (
                                  <span className="agent-label">Agent</span>
                                )}
                                <time>
                                  {new Date(thread.createdAt).toLocaleTimeString([], {
                                    hour: '2-digit',
                                    minute: '2-digit',
                                  })}
                                </time>
                              </div>
                              <p>
                                {thread.deletedAt ? 'Message deleted' : thread.text.slice(0, 600)}
                              </p>
                            </div>
                          </div>
                        </header>
                        <Chat
                          key={`${thread.id}:${conversationVisit}`}
                          focusMessage={jump?.threadId === thread.id ? jump : null}
                          restoreViewport={resumeThread}
                          id={selected}
                          threadId={thread.id}
                          employee={employee}
                          employees={workspace.employees}
                          conversations={workspace.conversations}
                          providers={providers}
                          user={workspace.user}
                          onOpenConversation={choose}
                          onOpenMessage={openMessage}
                          onMessageChange={updateMessage}
                          fail={setError}
                          revision={revision}
                          readOnly={!!conversation?.agentDeactivated}
                        />
                      </>
                    )
                  )}
                </SidePanel>
              )}
            </div>
          </PreviewContext.Provider>
        ) : (
          <div className="empty">
            <Users size={32} />
            <h2>Your workspace is ready</h2>
            <p>Add an employee to begin.</p>
            <button className="primary" onClick={() => setModal('employee')}>
              Add employee
            </button>
          </div>
        )}
      </main>
      {toast && (
        <div className="toast" role="status">
          <button className="toast-open" onClick={() => void openNotification(toast)}>
            <Avatar id={toast.authorName} name={toast.authorName} />
            <span>
              <strong>{toast.authorName}</strong>
              <small>{toast.text.slice(0, 110)}</small>
            </span>
          </button>
          <button
            className="toast-dismiss icon"
            aria-label={`Dismiss notification from ${toast.authorName}`}
            title="Dismiss notification"
            onClick={dismissToast}
          >
            <X size={16} />
          </button>
        </div>
      )}
      {modal === 'employee' && (
        <AddEmployee
          providers={providers}
          onClose={() => setModal('')}
          onCreated={async (id: string) => {
            await refresh();
            setModal('');
            if (id) choose(id);
          }}
          fail={setError}
        />
      )}
      {modal === 'edit-employee' && employee && (
        <EditEmployee
          humans={workspace.humans}
          providers={providers}
          employee={employee}
          onClose={() => setModal('')}
          done={refresh}
          onManage={
            workspace.user.role === 'owner'
              ? (kind: string) => {
                  setModal('');
                  requestNavigationAction(kind, { id: employee.id, name: employee.name });
                }
              : undefined
          }
        />
      )}
      {modal === 'briefing-history' && <Modal title="Morning briefings" onClose={() => setModal('')}><BriefingHistory onOpen={(id) => { setBriefingId(id); setView('briefings'); setModal(''); }} /></Modal>}
      {['settings', 'voice-settings', 'model-settings'].includes(modal) && (
        <SettingsPanel
          workspace={workspace}
          initialTab={modal === 'voice-settings' ? 'voice' : modal === 'model-settings' ? 'accounts' : 'general'}
          onClose={() => setModal('')}
          refresh={refresh}
          onMemorySource={async (sourceId: string) => {
            try {
              const message = await api(
                '/messages/' + encodeURIComponent(sourceId) + '?activity=summary',
              );
              const root = message.threadId
                ? await api(
                    '/messages/' + encodeURIComponent(message.threadId) + '?activity=summary',
                  )
                : null;
              choose(message.conversationId);
              setThread(root);
              setJump(message);
              setModal('');
            } catch (e: any) {
              setError(e.message);
            }
          }}
          fail={setError}
        />
      )}
      {confirmAction && (
        <ConfirmWorkspaceAction
          action={confirmAction}
          onClose={() => setConfirmAction(null)}
          onConfirm={confirmNavigationAction}
        />
      )}
    </div>
  );
}
function Login({ onDone, error }: { onDone: () => Promise<any>; error: string }) {
  const [failure, setFailure] = useState(error);
  const invite = new URLSearchParams(location.hash.slice(1)).get('invite');
  return (
    <main className="launch login-page">
      <div className="login-card">
        <div className="login-signature" aria-hidden="true">
          <WorkspaceMark size={42} name={invite ? 'Join' : 'Welcome'} />
          <span />
          <span className="brand-mark">▦</span>
        </div>
        <div className="eyebrow">{invite ? 'A PLACE AT THE TABLE' : 'YOUR WORKSPACE'}</div>
        <h1>{invite ? 'Join the workspace' : 'Welcome back'}</h1>
        <p>
          {invite
            ? 'Choose the name your team will know you by.'
            : 'Sign in to continue to your workspace.'}
        </p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            try {
              await api(invite ? '/invite/accept' : '/login', {
                name: f.get('name'),
                password: f.get('password'),
                ...(invite ? { token: invite } : {}),
              });
              history.replaceState(null, '', location.pathname);
              await onDone();
            } catch (e: any) {
              setFailure(e.message);
            }
          }}
        >
          <label>
            Name
            <input name="name" required autoComplete="username" />
          </label>
          <label>
            Password
            <input
              name="password"
              type="password"
              minLength={invite ? 12 : undefined}
              required
              autoComplete={invite ? 'new-password' : 'current-password'}
            />
          </label>
          {failure && <p className="error">{failure}</p>}
          <button className="primary">{invite ? 'Join' : 'Sign in'}</button>
        </form>
        <span className="login-footnote">A small space for ambitious work.</span>
      </div>
    </main>
  );
}
const ONBOARDING_DRAFT = 'abralo.onboarding.draft';
function Onboarding({
  providers,
  refreshProviders,
  onDone,
  fail,
  error,
  userName: initialUserName,
}: any) {
  const [checking, setChecking] = useState(false),
    [checked, setChecked] = useState(false);
  // Keep the setup draft in this tab, so a reload (often while signing in) resumes it.
  const [draft] = useState<any>(() => {
    try {
      return JSON.parse(sessionStorage.getItem(ONBOARDING_DRAFT) || '{}') || {};
    } catch {
      return {};
    }
  });
  const [step, setStep] = useState<number>(draft.step ?? 0),
    [name] = useState('Chief of Staff'),
    [harness, setHarness] = useState<string>(draft.harness ?? 'codex'),
    [model, setModel] = useState<string>(draft.model ?? ''),
    [objectives, setObjectives] = useState<string[]>(draft.objectives ?? ['']),
    [objectiveError, setObjectiveError] = useState(''),
    [userName, setUserName] = useState<string>(
      draft.userName ?? (initialUserName && initialUserName !== 'You' ? initialUserName : ''),
    ),
    [busy, setBusy] = useState(false),
    [login, setLogin] = useState<any>(null);
  useEffect(() => {
    try {
      sessionStorage.setItem(
        ONBOARDING_DRAFT,
        JSON.stringify({ step, harness, model, objectives, userName }),
      );
    } catch {
      /* storage unavailable: setup still works, it just won't survive a reload */
    }
  }, [step, harness, model, objectives, userName]);
  const provider = providers.find((p: ProviderInfo) => p.harness === harness);
  return (
    <main className={`onboarding step-${step}`}>
      <header>
        <span className="brand-mark">▦</span>
        <span>Workspace</span>
        <span className="quiet">{step + 1} / 3</span>
      </header>
      <div className="onboarding-body">
        <div className="setup-copy">
          <div className="eyebrow">{step === 0 ? 'A PLACE TO BEGIN' : 'YOUR FIRST EMPLOYEE'}</div>
          <div className="onboarding-signature" aria-hidden="true">
            <WorkspaceMark size={40} name="Welcome" />
            <span />
            <Avatar id={name} name={name} size={40} />
          </div>
          <h1>
            {step === 0
              ? 'What should I call you?'
              : step === 1
                ? `Connect ${name}.`
                : 'What would you like to achieve?'}
          </h1>
          <p>
            {step === 0
              ? 'Your Chief of Staff is your first employee. Share what matters, and build the right workforce as you go.'
              : step === 1
                ? 'Use your existing agent account. Your provider’s usage limits apply.'
                : 'Give your team a few outcomes to work towards. Clear targets help the Chief of Staff spot useful next steps.'}
          </p>
          {error && <p className="error">{error}</p>}
          {step === 0 ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!userName.trim()) return;
                setUserName(userName.trim());
                setStep(1);
              }}
            >
              <label>
                Your name
                <input
                  autoFocus
                  autoComplete="given-name"
                  placeholder="The name you go by"
                  value={userName}
                  onChange={(e) => setUserName(e.target.value)}
                  required
                  pattern=".*\S.*"
                  maxLength={80}
                />
              </label>
              <button className="primary">
                Continue <ArrowUp size={16} className="right-arrow" />
              </button>
              <p className="aside-note">Your team will use this name when they talk to you.</p>
            </form>
          ) : step === 1 ? (
            <>
              <div className="provider-options">
                {['codex', 'claude', 'opencode'].map((p) => (
                  <button
                    key={p}
                    className={`provider-option ${harness === p ? 'active' : ''}`}
                    onClick={() => {
                      setHarness(p);
                      void refreshProviders(p);
                      setModel('');
                      setLogin(null);
                    }}
                  >
                    <span className="provider-monogram">
                      {p === 'codex' ? 'O' : p === 'claude' ? 'C' : 'o'}
                    </span>
                    <span>
                      <strong>{names[p]}</strong>
                      <small>
                        {p === 'opencode' ? 'Choose provider' : 'Native account sign-in'}
                      </small>
                    </span>
                    {harness === p && <Check size={17} />}
                  </button>
                ))}
              </div>
              <p className="connection-status">
                <span className={provider?.authenticated ? 'status-dot' : 'status-dot neutral'} />
                {provider?.detail || 'Checking this host…'}
              </p>
              {(!provider?.authenticated || harness === 'opencode') && (
                // Share onboarding's provider status, so finishing sign-in unlocks Continue.
                <ProviderLogin
                  harness={harness}
                  fail={fail}
                  provider={provider}
                  checking={checking}
                  refresh={refreshProviders}
                  onConnected={() => {
                    fail('');
                    setChecked(false);
                  }}
                />
              )}
              <button
                className="quiet-button"
                disabled={checking}
                onClick={async () => {
                  setChecking(true);
                  setChecked(false);
                  try {
                    await refreshProviders(harness);
                    // The check reached Abralo, so an earlier "cannot reach" error no longer applies.
                    fail('');
                    setChecked(true);
                  } catch (e: any) {
                    fail(e.message);
                  } finally {
                    setChecking(false);
                  }
                }}
              >
                <RefreshCw size={14} />
                {checking ? 'Checking…' : 'Check connection'}
              </button>
              {checked && (
                <p role="status" className="check-result">
                  {provider?.authenticated
                    ? 'Connected. You’re ready to continue.'
                    : 'Not connected yet. Complete sign-in, then check again.'}
                </p>
              )}
              <div className="form-actions">
                <button className="quiet-button" onClick={() => setStep(0)}>
                  Back
                </button>
                <button
                  className="primary"
                  disabled={!provider?.authenticated}
                  onClick={() => setStep(2)}
                >
                  Continue
                </button>
              </div>
            </>
          ) : (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const goals = objectives.map((objective) => objective.trim()).filter(Boolean);
                if (!goals.length) {
                  setObjectiveError('Add at least one objective to get started.');
                  return;
                }
                setObjectiveError('');
                setBusy(true);
                try {
                  const employee = await api('/onboarding', {
                    objectives: goals,
                    userName,
                    employee: {
                      name,
                      harness,
                      model,
                      role: 'Organizes the team and keeps work moving',
                    },
                  });
                  sessionStorage.removeItem(ONBOARDING_DRAFT);
                  await onDone(employee.dmId);
                } catch (e: any) {
                  fail(e.message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <fieldset className="objective-entry">
                <legend>Objectives</legend>
                <p className="objective-hint">
                  Add as many outcomes as you like. Clear targets help the team recognize progress.
                </p>
                <div className="objective-list">
                  {objectives.map((objective, index) => (
                    <div className="objective-row" key={index}>
                      <span className="objective-index" aria-hidden="true">
                        {String(index + 1).padStart(2, '0')}
                      </span>
                      <textarea
                        autoFocus={index === 0}
                        rows={2}
                        aria-label={`Objective ${index + 1}`}
                        placeholder={
                          index === 0
                            ? 'e.g. Ship a public beta by June; reach 1,000 weekly users; cut setup time from 20 minutes to 5.'
                            : 'Another outcome, target or milestone…'
                        }
                        value={objective}
                        onChange={(event) =>
                          setObjectives((current) =>
                            current.map((item, itemIndex) =>
                              itemIndex === index ? event.target.value : item,
                            ),
                          )
                        }
                      />
                      {objectives.length > 1 && (
                        <button
                          type="button"
                          className="icon objective-remove"
                          aria-label={`Remove objective ${index + 1}`}
                          title="Remove objective"
                          onClick={() =>
                            setObjectives((current) => current.filter((_, i) => i !== index))
                          }
                        >
                          <X size={14} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  className="quiet-button objective-add"
                  onClick={() => {
                    setObjectives((current) => [...current, '']);
                    setObjectiveError('');
                  }}
                >
                  <Plus size={15} /> Add another objective
                </button>
                {objectiveError && (
                  <p className="objective-error" role="alert">
                    {objectiveError}
                  </p>
                )}
              </fieldset>
              <div className="form-actions">
                <button type="button" className="quiet-button" onClick={() => setStep(1)}>
                  Back
                </button>
                <button className="primary" disabled={busy}>
                  {busy ? 'Starting…' : 'Start the conversation'}
                </button>
              </div>
            </form>
          )}
        </div>
        <div className="onboarding-art" aria-hidden="true">
          <div className="onboarding-workspace-sketch">
            <WorkspaceMark size={144} name="Welcome" />
          </div>
          <div className="pixel-field">
            {Array.from({ length: 49 }, (_, i) => (
              <span
                key={i}
                className={
                  [2, 3, 4, 8, 12, 14, 16, 18, 20, 21, 23, 25, 27, 30, 31, 32, 38, 44, 46].includes(
                    i,
                  )
                    ? 'filled'
                    : ''
                }
              />
            ))}
          </div>
          <span className="caption">Start with a little ambition.</span>
        </div>
      </div>
    </main>
  );
}
function Chat({
  id,
  threadId,
  employee,
  employees,
  conversations,
  providers,
  user,
  onOpenConversation,
  onOpenMessage,
  onMessageChange,
  onThread,
  fail,
  onRead,
  onOpenGoals,
  revision,
  focusMessage,
  restoreViewport = false,
  readOnly = false,
}: any) {
  const openPreview = usePreview();
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const messagePeople = useMemo(
    () => [...employees.map((e: any) => e.name), user.name],
    [employees, user.name],
  );
  const baseView: ConversationView = {
    id,
    threadId,
    employeeId: !threadId ? employee?.id : undefined,
  };
  const [historyBefore, updateHistoryBefore] = useState<number | null>(() =>
    focusMessage && !restoreViewport
      ? focusMessage.seq + 1
      : restoreViewport
        ? conversationCache.historyBefore(baseView)
        : null,
  );
  const setHistoryBefore = (before: number | null) => {
    conversationCache.clearViewport({ ...baseView, before });
    conversationCache.setHistoryBefore(baseView, before);
    updateHistoryBefore(before);
  };
  const pageView = useMemo(
    () => ({ ...baseView, before: historyBefore }),
    [id, threadId, employee?.id, historyBefore],
  );
  const history = useConversationPage(pageView);
  const { value: composer, set: setComposer } = useConversationComposer(baseView);
  const { draft, files, draftWork, uploading, sending, outgoing } = composer;
  useEffect(() => {
    if (composer.saveError) fail(composer.saveError);
  }, [composer.saveError]);
  const setDraft = (value: string | ((text: string) => string)) => setComposer('draft', value);
  const setFiles = (value: any[] | ((files: any[]) => any[])) => setComposer('files', value);
  const setDraftWork = (value: any) => setComposer('draftWork', value);
  const setUploading = (value: boolean) => setComposer('uploading', value);
  const setSending = (value: boolean) => setComposer('sending', value);
  const setOutgoing = (
    value: OutgoingMessage[] | ((items: OutgoingMessage[]) => OutgoingMessage[]),
  ) => setComposer('outgoing', value);
  const messages = history.data?.messages || EMPTY_MESSAGES;
  const runs = history.data?.runs || EMPTY_ITEMS;
  const decisions = history.data?.decisions || EMPTY_ITEMS;
  const attachments = history.data?.attachments || EMPTY_ITEMS;
  const historyStatus = history.status;
  const historyError = history.error;
  const [showLoading, setShowLoading] = useState(false);
  const [modelOptionIndex, setModelOptionIndex] = useState(0);
  const [proposals, setProposals] = useState<any[]>([]);
  const [connections, setConnections] = useState<any[]>([]);
  const [connectionActions, setConnectionActions] = useState<any[]>([]);
  // Dismissed cards fold to a one-line note where they were; each can be reopened in place.
  const [shownDismissed, setShownDismissed] = useState<Set<string>>(() => new Set());
  useEffect(() => setShownDismissed(new Set()), [id]);
  const [workingFolder, setWorkingFolder] = useState<{ path: string; name: string } | null>(null);
  const [choosingFolder, setChoosingFolder] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelQuery, setModelQuery] = useState<{
    start: number;
    end: number;
    query: string;
  } | null>(null);
  const [modelOverride, setModelOverride] = useState<{ harness: string; model: string } | null>(
    () => {
      try {
        return JSON.parse(localStorage.getItem('composer-model:' + id) || 'null');
      } catch {
        return null;
      }
    },
  );
  const modelGroups = (providers || []).filter(
    (provider: ProviderInfo) =>
      provider.installed &&
      (!employee || provider.harness === employee.harness) &&
      provider.models?.some((model: { id: string; name: string }) => model.id),
  );
  const chosenModel = modelGroups
    .find((provider: ProviderInfo) => provider.harness === modelOverride?.harness)
    ?.models?.find((model: { id: string; name: string }) => model.id === modelOverride?.model);
  const modelChoices: { provider: ProviderInfo; model: { id: string; name: string } }[] =
    modelGroups.flatMap((provider: ProviderInfo) =>
      (provider.models || []).filter((model) => model.id).map((model) => ({ provider, model })),
    );
  const matchingModelChoices = modelQuery
    ? modelChoices.filter(({ provider, model }) =>
        `${model.name} ${model.id} ${names[provider.harness] || provider.harness}`
          .toLocaleLowerCase()
          .includes(modelQuery.query),
      )
    : modelChoices;
  const scroll = useRef<HTMLDivElement>(null),
    picker = useRef<HTMLInputElement>(null),
    modelMenu = useRef<HTMLDivElement>(null),
    end = useRef<HTMLDivElement>(null),
    following = useRef(
      (!focusMessage || restoreViewport) &&
        (!restoreViewport || (conversationCache.viewport(pageView)?.following ?? true)),
    );
  useLayoutEffect(() => {
    const input = composerInput.current;
    const viewport = scroll.current;
    if (!input || !viewport) return;
    const offset = viewport.scrollTop;
    // Measuring a shorter textarea temporarily grows the message viewport and
    // clamps scrollTop. Restore it before paint so typing cannot move history.
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 180) + 'px';
    viewport.scrollTop = offset;
  }, [draft, id, threadId]);
  const load = useCallback(
    (before = historyBefore) => conversationCache.load({ ...pageView, before }, true),
    [pageView, historyBefore],
  );
  useEffect(() => {
    void conversationCache.load(pageView).catch(() => {});
    setShowLoading(false);
    const timer = setTimeout(() => setShowLoading(true), 250);
    return () => clearTimeout(timer);
  }, [pageView]);
  useEffect(() => {
    if (!readOnly) void conversationCache.loadDraft(baseView).catch((error) => fail(error.message));
  }, [id, threadId, readOnly]);
  useEffect(() => {
    setWorkingFolder(null);
    if (user.role !== 'owner' || readOnly) return;
    let current = true;
    api(`/conversations/${id}/working-folder`)
      .then((folder) => {
        if (current && folder.path) setWorkingFolder(folder);
      })
      .catch((e) => fail(e.message));
    return () => {
      current = false;
    };
  }, [id, readOnly, user.role]);
  useEffect(() => {
    if (modelOverride) localStorage.setItem('composer-model:' + id, JSON.stringify(modelOverride));
    else localStorage.removeItem('composer-model:' + id);
    window.dispatchEvent(
      new CustomEvent('composer-model-change', { detail: { id, modelOverride } }),
    );
  }, [id, modelOverride]);
  useEffect(() => {
    const syncModel = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.id === id) setModelOverride(detail.modelOverride || null);
    };
    window.addEventListener('composer-model-change', syncModel);
    return () => window.removeEventListener('composer-model-change', syncModel);
  }, [id]);
  useEffect(() => {
    if (!modelMenuOpen) return;
    const closeOnPointer = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (
        !modelMenu.current?.contains(event.target as Node) &&
        !target?.closest('.composer-model-typeahead')
      )
        setModelMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setModelMenuOpen(false);
    };
    document.addEventListener('pointerdown', closeOnPointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnPointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [modelMenuOpen]);
  useEffect(() => {
    api('/proposals')
      .then((p) =>
        setProposals(p.filter((p: any) => p.conversationId === id && !p.approved && !p.superseded)),
      )
      .catch(() => {});
    api('/connections')
      .then((c) =>
        setConnections(
          c.filter(
            (c: any) => c.data.conversationId === id && !['ready', 'granted'].includes(c.state),
          ),
        ),
      )
      .catch(() => {});
    api('/connection-actions?conversationId=' + encodeURIComponent(id))
      .then(setConnectionActions)
      .catch(() => {});
  }, [id, revision]);
  const confirmedKeys = new Set(messages.map((m) => m.clientKey));
  const pending = outgoing.filter((item) => !confirmedKeys.has(item.message.clientKey));
  const visibleMessages = [...messages, ...pending.map((item) => item.message)];
  const workItems = useConversationWork(id, messages.map((m) => m.id), revision, fail);
  const { inlineActions, pinnedActions } = useMemo(
    () => placeConnectionActions(connectionActions, messages),
    [connectionActions, messages],
  );
  const updateAction = (actionId: string, change: any) =>
    setConnectionActions((items) =>
      items.map((item) => (item.actionId === actionId ? { ...item, ...change } : item)),
    );
  const renderAction = (action: any) => (
    <ConnectionAction key={action.actionId} action={action}
      onDismiss={(dismissed: boolean) => {
        updateAction(action.actionId, { dismissed });
      }}
      onReceipt={(receipt: any) => updateAction(action.actionId, receipt)} />
  );
  // Dismissed cards in one place fold into a single quiet note that reopens them together.
  const renderPlacedActions = (actions: any[], slot: string) => {
    const dismissed = actions.filter((action) => action.dismissed);
    const shown = shownDismissed.has(slot);
    const services = [...new Set(dismissed.map((a) => serviceNames[a.service] || a.service))];
    const noun = `${dismissed.length > 1 ? dismissed.length + ' ' : ''}dismissed ${
      services.length === 1 ? services[0] + ' ' : ''
    }action${dismissed.length > 1 ? 's' : ''}`;
    return (
      <>
        {actions.filter((action) => !action.dismissed).map(renderAction)}
        {dismissed.length > 0 && (
          <button
            className="quiet-button dismissed-action-note"
            aria-expanded={shown}
            onClick={() =>
              setShownDismissed((current) => {
                const next = new Set(current);
                if (shown) next.delete(slot);
                else next.add(slot);
                return next;
              })
            }
          >
            {shown ? 'Hide' : 'Show'} {noun}
          </button>
        )}
        {shown && dismissed.map(renderAction)}
      </>
    );
  };
  const visibleAttachments = [...attachments, ...pending.flatMap((item) => item.files)];
  const savedViewport = useMemo(() => conversationCache.viewport(pageView), [pageView]);
  const virtual = useVirtualizer({
    count: visibleMessages.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => 140,
    getItemKey: (index) => visibleMessages[index].clientKey || visibleMessages[index].id,
    initialOffset: restoreViewport ? savedViewport?.offset || 0 : 0,
    initialMeasurementsCache: savedViewport?.measurements,
    initialRect: savedViewport
      ? { width: savedViewport.width, height: savedViewport.height }
      : undefined,
    overscan: 5,
  });
  useConversationViewport(
    pageView,
    visibleMessages,
    virtual,
    scroll,
    following,
    !!history.data,
    restoreViewport,
  );
  useEffect(() => {
    if (!focusMessage || restoreViewport) return;
    following.current = false;
    setHistoryBefore(focusMessage.seq + 1);
  }, [focusMessage?.id]);
  const focusedMessage = useRef<string | null>(null);
  useEffect(() => {
    if (!focusMessage || restoreViewport || focusedMessage.current === focusMessage.id) return;
    const index = messages.findIndex((m) => m.id === focusMessage.id);
    if (index < 0) return;
    const frame = requestAnimationFrame(() => {
      virtual.scrollToIndex(index, { align: 'center' });
      focusedMessage.current = focusMessage.id;
    });
    return () => cancelAnimationFrame(frame);
  }, [focusMessage?.id, messages]);
  const {
    handleScroll: handleConversationScroll,
    atLatest,
    jumpToLatest,
  } = useFollowConversation(scroll, following, id);
  const showLatest = () => {
    setHistoryBefore(null);
    jumpToLatest();
  };
  const latestReadSequence = messages.at(-1)?.seq;
  useEffect(() => {
    const markVisibleRead = () => {
      if (
        latestReadSequence === undefined ||
        document.hidden ||
        !document.hasFocus() ||
        !following.current ||
        historyBefore !== null
      )
        return;
      void api(`/conversations/${id}/read`, { seq: latestReadSequence })
        .then(() => onRead?.())
        .catch(() => {});
    };
    markVisibleRead();
    window.addEventListener('focus', markVisibleRead);
    document.addEventListener('visibilitychange', markVisibleRead);
    return () => {
      window.removeEventListener('focus', markVisibleRead);
      document.removeEventListener('visibilitychange', markVisibleRead);
    };
  }, [latestReadSequence, id, atLatest, historyBefore, onRead]);
  const latestRun = runs.reduce<any>(
    (latest, run) =>
      !latest ||
      String(run.created_at || run.createdAt || '') >=
        String(latest.created_at || latest.createdAt || '')
        ? run
        : latest,
    null,
  );
  const providerFailure = latestRun?.state === 'failed' ? providerFailureKind(latestRun.error) : null;
  async function resumeAfterProvider(text: string) {
    try {
      await api(`/conversations/${id}/messages`, {
        text,
        key: crypto.randomUUID(),
        threadId: threadId || null,
        attachments: [],
        recipients: [],
      });
      void load(null).catch((e) => fail(e.message));
    } catch (e: any) {
      fail(e.message);
    }
  }
  const active = runs.filter(
    (r) => !['completed', 'failed', 'cancelled', 'interrupted'].includes(r.state),
  );
  const activeWork =
    employee && active.find((r) => r.user_id === user.id && r.conversation_id !== id);
  const replyWork = draftWork || (!draft && !files.length ? activeWork : null);
  function chooseModel(harness: string | null, model: string | null) {
    if (harness && model) setModelOverride({ harness, model });
    else setModelOverride(null);
    if (modelQuery) {
      const input = composerInput.current;
      const next = draft.slice(0, modelQuery.start) + draft.slice(modelQuery.end);
      const caret = modelQuery.start;
      setDraft(next);
      requestAnimationFrame(() => {
        input?.focus();
        input?.setSelectionRange(caret, caret);
      });
    }
    setModelQuery(null);
    setModelMenuOpen(false);
  }
  async function upload(list: File[]) {
    if (readOnly) return;
    setUploading(true);
    const work = replyWork;
    setDraftWork(work);
    try {
      for (const file of list) {
        const form = new FormData();
        form.append('file', file);
        const result = await api(`/conversations/${work?.conversation_id || id}/attachments`, form);
        setFiles((fs) => [...fs, result]);
      }
    } catch (e: any) {
      fail(e.message);
    } finally {
      setUploading(false);
    }
  }
  async function submitOutgoing(item: OutgoingMessage) {
    if (readOnly || conversationCache.composer(baseView).sending) return;
    setSending(true);
    const key = item.message.clientKey;
    setOutgoing((items) =>
      items.map((entry) =>
        entry.message.clientKey === key ? { ...entry, state: 'sending' } : entry,
      ),
    );
    try {
      const confirmed: Message = await api(
        `/conversations/${item.message.conversationId}/messages`,
        item.body,
      );
      setOutgoing((items) =>
        items.map((entry) =>
          entry.message.clientKey === key ? { ...entry, message: confirmed, state: 'sent' } : entry,
        ),
      );
      // A history refresh failure must not turn a successful send into a failed one.
      void load(null).catch((e) => fail(e.message));
    } catch (e: any) {
      setOutgoing((items) =>
        items.map((entry) =>
          entry.message.clientKey === key ? { ...entry, state: 'failed' } : entry,
        ),
      );
      fail(e.message);
    } finally {
      setSending(false);
    }
  }
  function send() {
    if (
      readOnly ||
      conversationCache.composer(baseView).sending ||
      uploading ||
      (!draft.trim() && !files.length)
    )
      return;
    const work = draftWork;
    const key = crypto.randomUUID();
    const body = {
      text: draft,
      key,
      threadId: work?.thread_id || threadId,
      attachments: files.map((f) => (typeof f === 'string' ? f : f.id)),
      recipients: work
        ? [employee.id]
        : employee
          ? []
          : employees
              .filter((e: Employee) => draft.toLowerCase().includes('@' + e.name.toLowerCase()))
              .map((e: Employee) => e.id),
      modelOverride,
    };
    const item: OutgoingMessage = {
      message: {
        id: key,
        clientKey: key,
        conversationId: work?.conversation_id || id,
        threadId: body.threadId || null,
        authorId: user.id,
        authorName: user.name,
        kind: 'human',
        text: draft,
        attachments: body.attachments,
        createdAt: new Date().toISOString(),
        seq: 0,
        runId: null,
      },
      body,
      files: files.filter((f) => typeof f !== 'string'),
      state: 'sending',
    };
    following.current = true;
    setHistoryBefore(null);
    setOutgoing((items) => [...items, item]);
    setDraftWork(null);
    setDraft('');

    setFiles([]);
    void submitOutgoing(item);
  }
  async function chooseWorkingFolder() {
    if (choosingFolder || readOnly) return;
    setChoosingFolder(true);
    try {
      const picked = await api('/folders/pick', {});
      if (picked.cancelled) return;
      const folder = await api(`/conversations/${id}/working-folder`, { path: picked.path }, 'PUT');
      setWorkingFolder(folder);
    } catch (e: any) {
      fail(e.message);
    } finally {
      setChoosingFolder(false);
    }
  }
  async function clearWorkingFolder() {
    try {
      await api(`/conversations/${id}/working-folder`, { path: null }, 'PUT');
      setWorkingFolder(null);
    } catch (e: any) {
      fail(e.message);
    }
  }
  return (
    <section className="chat">
      {!threadId && (
        <ConversationGoals
          conversationId={id}
          revision={revision}
          onOpen={onOpenGoals}
          fail={fail}
        />
      )}
      <div className="message-scroll" ref={scroll} onScroll={handleConversationScroll}>
        {readOnly && (
          <div className="conversation-inactive-notice">
            This agent is deactivated. Reactivate it from the sidebar to continue.
          </div>
        )}
        <div className="history-controls">
          {messages.length === 80 && (
            <button
              className="quiet-button"
              onClick={() => {
                following.current = false;
                setHistoryBefore(messages[0].seq);
              }}
            >
              Earlier messages
            </button>
          )}
          {historyBefore && (
            <button className="quiet-button" onClick={showLatest}>
              Back to latest
            </button>
          )}
          {historyStatus === 'error' && !!history.data && (
            <button
              className="quiet-button history-retry-inline"
              onClick={() => {
                void load().catch((e) => fail(e.message));
              }}
            >
              History didn’t refresh · Retry
            </button>
          )}
        </div>
        {!history.data && historyStatus === 'loading' && showLoading && (
          <div className="history-load-state" role="status" aria-live="polite">
            <span className="toolchain-mark" aria-hidden="true" />
            <p>Restoring your conversation…</p>
          </div>
        )}
        {!history.data && historyStatus === 'error' && (
          <div className="history-load-state is-error" role="alert">
            <p>Your conversation couldn’t be restored.</p>
            <span>Your saved history hasn’t been changed.</span>
            {historyError && <small>{historyError}</small>}
            <button
              className="quiet-button"
              onClick={() => {
                void load().catch((e) => fail(e.message));
              }}
            >
              Try again
            </button>
          </div>
        )}
        {!visibleMessages.length && !!history.data && (
          <div className="conversation-start ui-stack">
            {employee && <Avatar id={employee.id} name={employee.name} size={48} />}
            <h2>{employee ? employee.name : 'Start a conversation'}</h2>
            <p>
              {employee
                ? 'Ask a question or give them something to work on.'
                : 'Send a message to start the conversation.'}
            </p>
          </div>
        )}
        <div style={{ height: virtual.getTotalSize(), position: 'relative', width: '100%' }}>
          {virtual.getVirtualItems().map((item) => {
            const m = visibleMessages[item.index],
              run = runs.find((r) => r.id === m.runId);
            const originLabel = undefined;
            const local = pending.find((entry) => entry.message.id === m.id);
            return (
              <div
                key={m.clientKey || m.id}
                data-index={item.index}
                data-message-id={m.id}
                className={focusMessage?.id === m.id ? 'message-highlight' : undefined}
                ref={virtual.measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${item.start}px)`,
                }}
              >
                <MemoMessageView
                  message={m}
                  originLabel={originLabel}
                  onOpenOrigin={originLabel ? () => onOpenMessage?.(m.id) : undefined}
                  run={run}
                  attachments={visibleAttachments}
                  delivery={local?.state}
                  onRetry={local ? () => void submitOutgoing(local) : undefined}
                  retryDisabled={sending || readOnly}
                  canManage={!local && m.kind === 'human' && m.authorId === user.id && !readOnly}
                  onMutated={async (updated: Message) => {
                    await load();
                    onMessageChange?.(updated);
                  }}
                  onThread={
                    local
                      ? undefined
                      : employee && m.conversationId !== id
                        ? () => onOpenConversation?.(m.conversationId, m.threadId || m.id)
                        : onThread
                  }
                  people={messagePeople}
                  onOpenConversation={onOpenConversation}
                />
                <WorkCards items={workItems.filter((work) => work.requestMessageId === m.id)} />
                {inlineActions.has(m.id) && (
                  <div className="conversation-actions inline-actions">
                    {renderPlacedActions(inlineActions.get(m.id)!, m.id)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="conversation-actions">
          {employee && !!providerFailure && (
            <ProviderRecoveryCard
              key={employee.harness + ':' + latestRun?.id}
              harness={employee.harness}
              failure={providerFailure}
              fail={fail}
              onResume={resumeAfterProvider}
            />
          )}
          {proposals.map((p) => (
            <div className="proposal inline-card" key={p.id}>
              <div className="proposal-heading">
                <div>
                  <div className="eyebrow">{p.employees.length === 1 ? 'PROPOSED EMPLOYEE' : 'PROPOSED EMPLOYEES'}</div>
                  <p>Suggested for the work you described.</p>
                </div>
                <span className="proposal-count">
                  {p.employees.length} {p.employees.length === 1 ? 'employee' : 'employees'}
                </span>
              </div>
              {p.employees.map((e: any, i: number) => (
                <div className="proposed-person" key={i}>
                  <Avatar id={e.name} name={e.name} />
                  <span>
                    <strong>{e.name}</strong>
                    <small>{e.role}</small>
                  </span>
                </div>
              ))}
              <button
                className="primary"
                onClick={async () => {
                  try {
                    await api(`/proposals/${p.id}/approve`, { version: p.version });
                    setProposals((ps) => ps.filter((x) => x.id !== p.id));
                  } catch (e: any) {
                    fail(e.message);
                  }
                }}
              >
                {p.employees.length === 1 ? 'Create this employee' : 'Create these employees'}
              </button>
              <small>Want to make changes? Reply in this conversation.</small>
            </div>
          ))}
          {decisions.map((d) => (
            <Decision key={d.id} decision={d} fail={fail} />
          ))}
          {renderPlacedActions(pinnedActions, 'pinned')}
          {connections.map((c) => (
            <ConnectionRow key={c.id} connection={c} fail={fail} />
          ))}
        </div>
        <div ref={end} />
      </div>
      {(historyBefore !== null || !atLatest) && (
        <div className="jump-to-latest">
          <button className="quiet-button" onClick={showLatest}>
            <ChevronDown size={16} aria-hidden="true" />
            Jump to latest
          </button>
        </div>
      )}
      <div className="composer-wrap">
        <div className="composer-stage">
          {modelMenuOpen && modelQuery && (
            <div
              className="composer-model-menu composer-model-typeahead"
              role="listbox"
              aria-label="Choose a model"
              onPointerDown={(event) => event.stopPropagation()}
            >
              <div className="composer-model-menu-heading">
                {employee ? `${names[employee.harness]} models` : 'Models by harness'}
              </div>
              {!modelQuery.query && (
                <button
                  type="button"
                  role="option"
                  aria-selected={modelOptionIndex === 0}
                  className="composer-model-option"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => chooseModel(null, null)}
                >
                  <span className="composer-model-option-copy">
                    <strong>{employee ? 'Agent default' : 'Each agent’s default'}</strong>
                    <small>Keep the configured model</small>
                  </span>
                  {!modelOverride && <Check size={14} aria-hidden="true" />}
                </button>
              )}
              {matchingModelChoices.map(({ provider, model }, index) => {
                const optionIndex = index + (modelQuery.query ? 0 : 1);
                const selected =
                  modelOverride?.harness === provider.harness && modelOverride?.model === model.id;
                return (
                  <button
                    key={`${provider.harness}:${model.id}`}
                    type="button"
                    role="option"
                    aria-selected={optionIndex === modelOptionIndex}
                    className="composer-model-option"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => chooseModel(provider.harness, model.id)}
                  >
                    <span className="composer-model-option-copy">
                      <strong>{model.name}</strong>
                      <small>
                        {employee ? model.id : `${names[provider.harness]} · ${model.id}`}
                      </small>
                    </span>
                    {selected && <Check size={14} aria-hidden="true" />}
                  </button>
                );
              })}
              {matchingModelChoices.length === 0 && modelQuery.query && (
                <p className="composer-model-empty">No matching models.</p>
              )}
            </div>
          )}
          <div
            className="composer"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              void upload(Array.from(e.dataTransfer.files));
            }}
          >
            {files.length > 0 && (
              <div className="attachments">
                {files.map((raw) => {
                  const file =
                    typeof raw === 'string'
                      ? attachments.find((a) => a.id === raw) || { id: raw, name: 'Attachment' }
                      : raw;
                  return (
                    <div className="attachment-chip" key={file.id}>
                      {file.mime?.startsWith('image/') ? (
                        <a
                          href={'/api/attachments/' + file.id}
                          target="_blank"
                          rel="noreferrer"
                          data-preview-id={file.id}
                          onClick={(event) => {
                            if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
                              return;
                            event.preventDefault();
                            openPreview({ kind: 'files', files: [file], index: 0 });
                          }}
                        >
                          <img src={'/api/attachments/' + file.id} alt={file.name} />
                        </a>
                      ) : (
                        <FileText size={22} />
                      )}
                      <button
                        className="quiet-button"
                        data-preview-id={file.id}
                        onClick={() => openPreview({ kind: 'files', files: [file], index: 0 })}
                      >
                        {file.name}
                      </button>
                      <button
                        className="icon"
                        aria-label={`Remove ${file.name}`}
                        onClick={() =>
                          setFiles((fs) =>
                            fs.filter((f) => (typeof f === 'string' ? f : f.id) !== file.id),
                          )
                        }
                      >
                        <X size={13} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            <textarea
              ref={composerInput}
              rows={1}
              aria-label="Message"
              value={draft}
              disabled={readOnly}
              placeholder={
                readOnly
                  ? 'This conversation is read-only'
                  : employee
                    ? `Message ${employee.name}…`
                    : 'Write a message…'
              }
              onChange={(e) => {
                const value = e.target.value;
                const beforeCaret = value.slice(0, e.target.selectionStart);
                const slashMatch = beforeCaret.match(/(?:^|\s)\/([^\s/]*)$/);
                if (!draft && !files.length) setDraftWork(activeWork || null);
                setDraft(value);
                setModelQuery(
                  slashMatch
                    ? {
                        start: e.target.selectionStart - slashMatch[1].length - 1,
                        end: e.target.selectionStart,
                        query: slashMatch[1].toLocaleLowerCase(),
                      }
                    : null,
                );
                setModelMenuOpen(!!slashMatch);
                setModelOptionIndex(0);
              }}
              onKeyDown={(e) => {
                if (modelMenuOpen && modelQuery) {
                  const optionCount = matchingModelChoices.length + (modelQuery.query ? 0 : 1);
                  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && optionCount > 0) {
                    e.preventDefault();
                    setModelOptionIndex(
                      (i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + optionCount) % optionCount,
                    );
                    return;
                  }
                  if (
                    ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') &&
                    optionCount > 0 &&
                    !e.nativeEvent.isComposing
                  ) {
                    e.preventDefault();
                    const defaultCount = modelQuery.query ? 0 : 1;
                    if (!defaultCount && modelOptionIndex === 0) {
                      const first = matchingModelChoices[0];
                      chooseModel(first.provider.harness, first.model.id);
                    } else if (defaultCount && modelOptionIndex === 0) chooseModel(null, null);
                    else {
                      const choice =
                        matchingModelChoices[modelOptionIndex - defaultCount] ||
                        matchingModelChoices[0];
                      chooseModel(choice.provider.harness, choice.model.id);
                    }
                    return;
                  }
                  if (
                    ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') &&
                    optionCount === 0
                  ) {
                    e.preventDefault();
                    return;
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    const input = composerInput.current;
                    const next = draft.slice(0, modelQuery.start) + draft.slice(modelQuery.end);
                    const caret = modelQuery.start;
                    setDraft(next);
                    setModelQuery(null);
                    setModelMenuOpen(false);
                    requestAnimationFrame(() => {
                      input?.focus();
                      input?.setSelectionRange(caret, caret);
                    });
                    return;
                  }
                }
                if (
                  e.key === 'Enter' &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing &&
                  matchMedia('(pointer:fine)').matches
                ) {
                  e.preventDefault();
                  void send();
                }
              }}
              onPaste={(e) => {
                const images = Array.from(e.clipboardData.files).filter((f) =>
                  f.type.startsWith('image/'),
                );
                if (images.length) {
                  e.preventDefault();
                  const text = e.clipboardData.getData('text/plain');
                  if (text) setDraft((d) => d + text);
                  void upload(images);
                }
              }}
            />
            <div className="composer-controls">
              {replyWork && (
                <span className="composer-destination">
                  Replying in{' '}
                  {conversations.find((c: any) => c.id === replyWork.conversation_id)?.name ||
                    'the active conversation'}
                </span>
              )}

              <input
                type="file"
                multiple
                ref={picker}
                hidden
                onChange={(e) => {
                  void upload(Array.from(e.target.files || []));
                  e.target.value = '';
                }}
              />
              <div className="composer-tools">
                <button
                  className="icon"
                  aria-label="Attach files"
                  disabled={readOnly}
                  onClick={() => picker.current?.click()}
                >
                  <Plus size={19} />
                </button>
                <div className="composer-model-picker" ref={modelMenu}>
                  <button
                    type="button"
                    className="icon composer-model-trigger"
                    aria-label="Choose model"
                    aria-haspopup="menu"
                    aria-expanded={modelMenuOpen}
                    title={chosenModel ? `Model: ${chosenModel.name}` : 'Default model'}
                    disabled={readOnly}
                    onClick={() => {
                      setModelQuery(null);
                      setModelMenuOpen((open) => !open);
                    }}
                  >
                    <span className="composer-model-slash">/</span>
                  </button>
                  {modelMenuOpen && !modelQuery && (
                    <div className="composer-model-menu" role="menu" aria-label="Choose a model">
                      <div className="composer-model-menu-heading">
                        {employee ? `${names[employee.harness]} models` : 'Models by harness'}
                      </div>
                      <button
                        type="button"
                        className="composer-model-option"
                        role="menuitemradio"
                        aria-checked={!modelOverride}
                        onClick={() => {
                          setModelOverride(null);
                          setModelMenuOpen(false);
                        }}
                      >
                        <span className="composer-model-option-copy">
                          <strong>{employee ? 'Agent default' : 'Each agent’s default'}</strong>
                          <small>
                            {employee
                              ? employee.model === '@recommended' ? 'Follow provider recommendation' : employee.model || 'Use the configured provider default'
                              : 'Keep each harness on its configured model'}
                          </small>
                        </span>
                        {!modelOverride && <Check size={14} aria-hidden="true" />}
                      </button>
                      {modelGroups.map((provider: ProviderInfo) => (
                        <div className="composer-model-group" key={provider.harness}>
                          {!employee && (
                            <div className="composer-model-group-label">
                              {names[provider.harness]}
                            </div>
                          )}
                          {provider.models
                            ?.filter((model) => model.id)
                            .map((model) => {
                              const selectedModel =
                                modelOverride?.harness === provider.harness &&
                                modelOverride.model === model.id;
                              return (
                                <button
                                  type="button"
                                  className="composer-model-option"
                                  role="menuitemradio"
                                  aria-checked={selectedModel}
                                  key={provider.harness + ':' + model.id}
                                  onClick={() => {
                                    setModelOverride({
                                      harness: provider.harness,
                                      model: model.id,
                                    });
                                    setModelMenuOpen(false);
                                  }}
                                >
                                  <span className="composer-model-option-copy">
                                    <strong>{model.name}</strong>
                                    <small>{model.id}</small>
                                  </span>
                                  {selectedModel && <Check size={14} aria-hidden="true" />}
                                </button>
                              );
                            })}
                        </div>
                      ))}
                      {!modelGroups.length && (
                        <p className="composer-model-empty">
                          No models are available for this harness.
                        </p>
                      )}
                      {!employee && modelGroups.length > 1 && (
                        <p className="composer-model-note">
                          A choice applies to matching agents; others keep their defaults.
                        </p>
                      )}
                    </div>
                  )}
                </div>
                {user.role === 'owner' && (
                  <div className="composer-folder">
                    {workingFolder ? (
                      <span
                        className="composer-folder-chip"
                        title={`Working in ${workingFolder.path}`}
                      >
                        <FolderOpen size={14} aria-hidden="true" />
                        <button
                          type="button"
                          className="composer-folder-change"
                          aria-label={`Change working folder · ${workingFolder.name}`}
                          onClick={() => void chooseWorkingFolder()}
                        >
                          <span>{workingFolder.name}</span>
                        </button>
                        <button
                          type="button"
                          className="composer-folder-clear"
                          aria-label="Clear working folder"
                          onClick={() => void clearWorkingFolder()}
                        >
                          <X size={13} />
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="composer-folder-picker"
                        aria-label="Choose working folder"
                        title="Choose a working folder for this conversation"
                        disabled={readOnly || choosingFolder}
                        onClick={() => void chooseWorkingFolder()}
                      >
                        <FolderOpen size={14} />
                        <span>{choosingFolder ? 'Opening…' : 'Folder'}</span>
                      </button>
                    )}
                  </div>
                )}
              </div>
              <span className="composer-spacer" />
              {uploading && <span className="composer-hint">Adding attachment…</span>}
              <div className="composer-runtime">
                {employee && employee.ownerId === user.id && (
                  <PermissionMenu employee={employee} fail={fail} />
                )}
                {employee && <span className="composer-provider">{names[employee.harness]}</span>}
              </div>
              <div className="composer-actions">
                {active.length > 0 ? (
                  <button
                    className="stop"
                    title="Stop active runs"
                    onClick={() => {
                      for (const run of active)
                        void api(`/runs/${run.id}/cancel`, {}).catch((e) => fail(e.message));
                    }}
                  >
                    <Square size={13} fill="currentColor" />
                    Stop {active.length > 1 ? active.length : ''}
                  </button>
                ) : null}
                <button
                  className="send"
                  aria-label="Send message"
                  disabled={readOnly || sending || uploading || (!draft.trim() && !files.length)}
                  onClick={() => void send()}
                >
                  <ArrowUp size={18} />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
function remarkWorkspaceEntities(options: { people: string[] }) {
  type Entity = { label: string; type: 'person' };
  const entities: Entity[] = [
    ...options.people
      .filter(Boolean)
      .map((name): Entity => ({ label: '@' + name, type: 'person' })),
  ].sort((a, b) => b.label.length - a.label.length);
  if (!entities.length) return () => {};
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const byLabel = new Map(entities.map((entity) => [entity.label.toLowerCase(), entity]));
  const matcher = new RegExp(
    `(^|[^\\p{L}\\p{N}_@])(${entities.map((entity) => escape(entity.label)).join('|')})(?=$|[^\\p{L}\\p{N}_-])`,
    'giu',
  );
  return (tree: any) => {
    const visit = (node: any): void => {
      if (
        !node.children ||
        ['link', 'linkReference', 'inlineCode', 'code', 'html'].includes(node.type)
      )
        return;
      const children: any[] = [];
      for (const child of node.children) {
        if (child.type !== 'text') {
          visit(child);
          children.push(child);
          continue;
        }
        matcher.lastIndex = 0;
        // Retain source offsets for the streaming reveal after entity parsing.
        const sliceText = (start: number, end: number) => {
          const value = child.value.slice(start, end);
          if (child.position?.end.offset - child.position?.start.offset !== child.value.length)
            return { type: 'text', value };
          const point = (offset: number) => {
            const lines = child.value.slice(0, offset).split('\n');
            return {
              offset: child.position.start.offset + offset,
              line: child.position.start.line + lines.length - 1,
              column:
                lines.length === 1 ? child.position.start.column + offset : lines.at(-1).length + 1,
            };
          };
          return { type: 'text', value, position: { start: point(start), end: point(end) } };
        };
        let last = 0;
        let match: RegExpExecArray | null;
        while ((match = matcher.exec(child.value))) {
          const start = match.index + match[1].length;
          if (start > last) children.push(sliceText(last, start));
          const label = match[2];
          const entity = byLabel.get(label.toLowerCase())!;
          children.push({
            type: 'link',
            url: 'workspace-person:' + encodeURIComponent(label),
            children: [sliceText(start, start + label.length)],
          });
          last = start + label.length;
        }
        if (last === 0) children.push(child);
        else if (last < child.value.length) children.push(sliceText(last, child.value.length));
      }
      node.children = children;
    };
    visit(tree);
  };
}

const runStatusLabels: Record<string, string> = {
  accepted: 'Starting',
  dispatching: 'Starting',
  running: 'Working',
  waiting_input: 'Waiting for your reply',
  waiting_permission: 'Needs permission',
  provider_limited: 'Waiting for provider',
  cancelling: 'Stopping',
  cancelled: 'Stopped',
  interrupted: 'Interrupted',
  failed: 'Stopped with an error',
};

const NO_TEXT_REVEALS: { start: number; end: number; at: number }[] = [];
// One stretch of reply text. Memoised so earlier stretches do not reparse while the
// latest one streams in.
const MarkdownSegment = React.memo(function MarkdownSegment({
  source,
  reveals,
  plugins,
  attachments,
  openPreview,
}: any) {
  return (
    <ReactMarkdown
      remarkPlugins={plugins}
      rehypePlugins={[[rehypeTextReveal, { source, reveals }]]}
      urlTransform={(url) => (url.startsWith('workspace-person:') ? url : defaultUrlTransform(url))}
      components={{
        pre: ({ node }) => <CodeBlock node={node} />,
        a: ({ children, href, ...p }) => {
          if (href?.startsWith('workspace-person:'))
            return <span className="entity-mention">{children}</span>;
          return (
            <a
              href={href}
              {...p}
              target="_blank"
              rel="noreferrer"
              onClick={(event) => {
                const id = href?.match(/^\/api\/attachments\/([^/?#]+)(?:\?.*)?$/)?.[1];
                const file = attachments.find((entry: any) => entry.id === id);
                if (!file || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
                  return;
                event.preventDefault();
                openPreview({ kind: 'files', files: [file], index: 0 });
              }}
            >
              {children}
            </a>
          );
        },
      }}
    >
      {source}
    </ReactMarkdown>
  );
});

function MessageView({
  message: m,
  originLabel,
  onOpenOrigin,
  delivery,
  onRetry,
  retryDisabled,
  run,
  attachments,
  canManage = false,
  onMutated,
  onThread,
  people = [],
  onOpenConversation,
}: any) {
  const openPreview = usePreview();
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [resumeBusy, setResumeBusy] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (editing)
      requestAnimationFrame(() => editorRef.current?.scrollIntoView({ block: 'nearest' }));
  }, [editing]);
  const markdownPlugins = useMemo(
    () => [remarkGfm, [remarkWorkspaceEntities, { people }]],
    [people],
  );
  const activities = m.activity || [];
  const working =
    m.kind === 'agent' && run && ['accepted', 'dispatching', 'running'].includes(run.state);
  const streaming = m.kind === 'agent' && run && ['dispatching', 'running'].includes(run.state);
  const revealed = useStreamingText(m.text || '', !!streaming);
  const timeline = useMemo(
    () => buildReplyTimeline(revealed.text, activities),
    [revealed.text, activities],
  );
  const renderLinkedMarkdown = (start: number, end: number) => {
    const source = revealed.text.slice(start, end);
    const reveals = revealed.reveals
      .filter((reveal) => reveal.end > start && reveal.start < end)
      .map((reveal) => ({
        ...reveal,
        start: Math.max(0, reveal.start - start),
        end: Math.min(source.length, reveal.end - start),
      }));
    return (
      <MarkdownSegment
        source={source}
        reveals={reveals.length ? reveals : NO_TEXT_REVEALS}
        plugins={markdownPlugins}
        attachments={attachments}
        openPreview={openPreview}
      />
    );
  };
  const showRunStatus =
    run &&
    run.state !== 'completed' &&
    (!activities.length || !['accepted', 'dispatching', 'running'].includes(run.state));
  const saveEdit = async () => {
    setEditBusy(true);
    setEditError('');
    try {
      const updated = await api(
        `/messages/${encodeURIComponent(m.id)}`,
        { text: editText },
        'PATCH',
      );
      await onMutated?.(updated);
      setEditing(false);
    } catch (e: any) {
      setEditError(e.message);
    } finally {
      setEditBusy(false);
    }
  };
  const deleteMessage = async () => {
    const updated = await api(`/messages/${encodeURIComponent(m.id)}`, {}, 'DELETE');
    await onMutated?.(updated);
    setConfirmDelete(false);
  };
  const renderStepGroup = (steps: any[], live: boolean) => {
    const key = steps[0].id;
    const open = expandedGroups.has(key);
    const list = (
      <ol className="toolchain-list">
        {steps.map((a: any) => (
          <ActivityStep
            key={a.id}
            activity={a}
            messageId={m.id}
            title={stepTitle(a)}
            time={activityTimeLabel(a.updatedAt || a.time)}
          />
        ))}
      </ol>
    );
    // A single step needs no summary row; it is its own row.
    if (steps.length === 1)
      return (
        <section className="tool-group" aria-label="Agent step" key={key}>
          {list}
        </section>
      );
    // Name the group by the latest step that did something, not by "Thinking".
    const latest = steps.findLast((s: any) => !isQuietStep(s)) || steps.at(-1);
    return (
      <section className="tool-group" aria-label="Agent steps" key={key}>
        <button
          className="tool-summary"
          aria-expanded={open}
          aria-label={`${open ? 'Hide' : 'Show'} ${steps.length} steps${live ? ', agent is working' : ''}`}
          onClick={() =>
            setExpandedGroups((groups) => {
              const next = new Set(groups);
              if (!next.delete(key)) next.add(key);
              return next;
            })
          }
        >
          <span className={`toolchain-mark ${live ? 'is-live' : ''}`} aria-hidden="true" />
          <span className={`tool-summary-state ${live ? 'is-live' : ''}`}>
            {live ? 'Working' : `${steps.length} steps`}
          </span>
          <span className="tool-summary-latest">{stepTitle(latest)}</span>
          <time>{activityTimeLabel(latest.updatedAt || latest.time)}</time>
          <ChevronRight size={13} className={open ? 'rotated' : ''} aria-hidden="true" />
        </button>
        {open && list}
      </section>
    );
  };
  return (
    <article className={`message ${m.kind === 'system' ? 'system-message' : ''}`}>
      <Avatar id={m.authorId} name={m.authorName} human={m.kind === 'human'} size={30} />
      <div className="message-content">
        <div className="message-meta">
          <strong>{m.authorName}</strong>
          {m.kind === 'agent' && <span className="agent-label">Agent</span>}
          {originLabel && (
            <button
              type="button"
              className="message-origin"
              aria-label={`${m.authorName} posted in ${originLabel}. Open message.`}
              title={`Open this message in ${originLabel}`}
              onClick={() => void onOpenOrigin?.()}
            >
              <ArrowUpRight size={12} aria-hidden="true" />
              <span>
                posted in <strong>{originLabel}</strong>
              </span>
            </button>
          )}
          {m.editedAt && !m.deletedAt && <span className="message-edited">edited</span>}
          {(onThread || (canManage && !m.deletedAt)) && (
            <div className="message-actions" role="group" aria-label="Message actions">
              {onThread && (
                <button
                  className="icon message-action"
                  aria-label="Reply in thread"
                  title="Reply in thread"
                  onClick={() => onThread(m)}
                >
                  <MessageSquare size={15} />
                </button>
              )}
              {canManage && !m.deletedAt && !editing && (
                <>
                  <button
                    className="icon message-action"
                    aria-label="Edit message"
                    title="Edit message"
                    onClick={() => {
                      setEditText(m.text);
                      setEditError('');
                      setEditing(true);
                    }}
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    className="icon message-action message-action-danger"
                    aria-label="Delete message"
                    title="Delete message"
                    onClick={() => setConfirmDelete(true)}
                  >
                    <Trash2 size={14} />
                  </button>
                </>
              )}
            </div>
          )}
          <time>
            {new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </time>
          {delivery === 'sending' && <span role="status">Sending…</span>}
          {delivery === 'failed' && (
            <span className="ui-actions" role="status">
              <span>Not sent</span>
              <button className="quiet-button" disabled={retryDisabled} onClick={onRetry}>
                Retry
              </button>
            </span>
          )}
        </div>
        {m.deletedAt ? (
          <div className="message-deleted">Message deleted</div>
        ) : editing ? (
          <div className="message-editor" ref={editorRef}>
            <textarea
              aria-label="Edit message"
              autoFocus
              value={editText}
              onChange={(event) => setEditText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  setEditing(false);
                } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void saveEdit();
                }
              }}
            />
            {editError && (
              <div className="message-edit-error" role="alert">
                {editError}
              </div>
            )}
            <div className="message-editor-footer">
              <span className="quiet">Esc to cancel · Ctrl/⌘+Enter to save</span>
              <div className="message-editor-actions">
                <button className="secondary" disabled={editBusy} onClick={() => setEditing(false)}>
                  Cancel
                </button>
                <button
                  className="primary"
                  disabled={
                    editBusy || editText === m.text || (!editText.trim() && !m.attachments?.length)
                  }
                  onClick={() => void saveEdit()}
                >
                  {editBusy ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <>
            {timeline.map((item, index) =>
              item.kind === 'steps' ? (
                renderStepGroup(item.steps, !!working && index === timeline.length - 1)
              ) : (
                <div
                  key={`text-${item.start}`}
                  className={'prose' + (streaming && index === timeline.length - 1 ? ' prose-streaming' : '')}
                >
                  {renderLinkedMarkdown(item.start, item.end)}
                </div>
              ),
            )}
            {m.attachments?.map((id: string) => {
              const a = attachments.find((a: any) => a.id === id);
              return (
                <a
                  className="file-output"
                  href={'/api/attachments/' + id}
                  target="_blank"
                  rel="noreferrer"
                  key={id}
                  data-preview-id={id}
                  onClick={(event) => {
                    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
                    event.preventDefault();
                    openPreview({
                      kind: 'files',
                      onDiscuss: onThread ? () => onThread(m) : undefined,
                      files: m.attachments.map(
                        (fileId: string) =>
                          attachments.find((entry: any) => entry.id === fileId) || {
                            id: fileId,
                            name: 'Attachment',
                          },
                      ),
                      index: m.attachments.indexOf(id),
                    });
                  }}
                >
                  {a?.mime?.startsWith('image/') ? (
                    <img src={'/api/attachments/' + id} alt={a?.name || 'Attachment'} />
                  ) : (
                    <FileText size={18} />
                  )}
                  <span>{a?.name || 'Attachment'}</span>
                </a>
              );
            })}
            {showRunStatus && (
              <div
                className={`run-status state-${run.state} ${run.error && run.state !== 'provider_limited' ? 'error' : ''}`}
                role="status"
              >
                {run.state === 'provider_limited' && run.limit ? (
                  <div className="limit-wait-card">
                    <div className="limit-wait-heading">
                      <span className="run-status-mark" aria-hidden="true" />
                      <span>
                        {run.limit.provider} {run.limit.window} limit reached
                      </span>
                    </div>
                    <div className="limit-wait-detail">
                      {Date.parse(run.limit.retryAt) > Date.now()
                        ? `Expected to be available ${new Date(run.limit.retryAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
                        : 'Waiting for the provider to make this available again'}
                    </div>
                    <label className="limit-resume-toggle">
                      <input
                        type="checkbox"
                        checked={!!run.autoResume}
                        disabled={resumeBusy}
                        onChange={async (event) => {
                          const enabled = event.currentTarget.checked;
                          setResumeBusy(true);
                          try {
                            await api(
                              `/runs/${encodeURIComponent(run.id)}/auto-resume`,
                              { enabled },
                              'PATCH',
                            );
                          } catch (error) {
                            console.error('Could not update automatic resume preference', error);
                          } finally {
                            setResumeBusy(false);
                          }
                        }}
                      />
                      <span>Resume automatically when available</span>
                    </label>
                  </div>
                ) : (
                  <>
                    <span className="run-status-mark" aria-hidden="true" />
                    <span className="run-status-label">
                      {runStatusLabels[run.state] || run.state.replaceAll('_', ' ')}
                    </span>
                    {run.error && <span className="run-status-error">{run.error}</span>}
                  </>
                )}
              </div>
            )}
          </>
        )}
        {m.replyCount > 0 && onThread && (
          <button className="thread-link quiet-button" onClick={() => onThread(m)}>
            <MessageSquare size={14} />
            {m.replyCount} {m.replyCount === 1 ? 'reply' : 'replies'}
          </button>
        )}
      </div>
      {confirmDelete && (
        <ConfirmMessageDelete
          message={m}
          onClose={() => setConfirmDelete(false)}
          onConfirm={deleteMessage}
        />
      )}
    </article>
  );
}
const MemoMessageView = React.memo(MessageView);
function Decision({ decision: d, fail }: any) {
  const [answer, setAnswer] = useState(''),
    [busy, setBusy] = useState(false);
  const [projectPath, setProjectPath] = useState(d.detail?.suggestedPath || '');
  const [projectRepo, setProjectRepo] = useState(d.detail?.suggestedRepo || '');
  async function resolve(allow: boolean) {
    setBusy(true);
    try {
      const answers: Record<string, any> = {};
      for (const q of d.questions || []) answers[q.id || q.question] = { answers: [answer] };
      await api('/decisions/' + d.id, {
        version: d.version,
        allow,
        ...(allow && d.kind === 'workspace_access'
          ? d.detail.type === 'directory'
            ? { path: projectPath }
            : { repo: projectRepo }
          : {}),
        ...(d.kind === 'question' ? { answers } : {}),
      });
    } catch (e: any) {
      fail(e.message);
      setBusy(false);
    }
  }
  return (
    <div className="inline-card decision">
      <strong>{d.title}</strong>
      {d.questions?.map((q: any, i: number) => (
        <p key={i}>{q.question || q.header}</p>
      ))}
      {d.kind === 'question' ? (
        <textarea aria-label="Answer" value={answer} onChange={(e) => setAnswer(e.target.value)} />
      ) : d.kind === 'desktop_control' ? (
        <div className="ui-stack">
          <p>{d.detail?.reason}</p>
          <p className="caption">
            The agent can see the Windows desktop and use the mouse and keyboard for five minutes.
            Stop control at any time from the visible banner.
          </p>
        </div>
      ) : d.kind === 'workspace_access' ? (
        <div className="workspace-access-fields">
          <p>{d.detail.reason}</p>
          {d.detail.type === 'directory' ? (
            <label className="ui-field">
              Local folder path
              <input
                aria-label="Approved folder path"
                value={projectPath}
                onChange={(e) => setProjectPath(e.target.value)}
                placeholder={
                  navigator.platform.startsWith('Win')
                    ? 'C:\\Users\\you\\project'
                    : '/home/you/project'
                }
              />
            </label>
          ) : (
            <label className="ui-field">
              GitHub repository
              <input
                aria-label="Approved GitHub repository"
                value={projectRepo}
                onChange={(e) => setProjectRepo(e.target.value)}
                placeholder="https://github.com/owner/repo"
              />
            </label>
          )}
          <p className="caption">
            Granting access sets this agent’s working folder. Its next run will use the folder.
            GitHub uses Git credentials already configured on this machine.
          </p>
        </div>
      ) : (
        <details>
          <summary>Details</summary>
          <pre>{JSON.stringify(d.detail, null, 2)}</pre>
        </details>
      )}
      <div className="form-actions">
        <button className="secondary" disabled={busy} onClick={() => void resolve(false)}>
          Decline
        </button>
        <button
          className="primary"
          disabled={
            busy ||
            (d.kind === 'workspace_access' &&
              !(d.detail.type === 'directory' ? projectPath.trim() : projectRepo.trim()))
          }
          onClick={() => void resolve(true)}
        >
          {d.kind === 'question'
            ? 'Reply'
            : d.kind === 'workspace_access'
              ? d.detail.type === 'directory'
                ? 'Grant folder access'
                : 'Clone and grant access'
              : d.kind === 'desktop_control'
                ? 'Allow for 5 minutes'
                : 'Allow this action'}
        </button>
      </div>
    </div>
  );
}
function DelegationField({ enabled = false }: { enabled?: boolean }) {
  const hintId = useId();
  return (
    <div className="ui-field">
      <label className="check-label">
        <input type="checkbox" name="canDelegate" defaultChecked={enabled} aria-describedby={hintId} />
        Delegate work and create employees
      </label>
      <p className="caption" id={hintId}>Allow this agent to assign work to other employees and request new employees. Creating employees from a proposal still needs your approval.</p>
    </div>
  );
}
function AddEmployee({ providers, onClose, onCreated }: any) {
  const pending = useRef(false);
  const created = useRef<{ id: string; dmId: string } | null>(null);
  const [creationStage, setCreationStage] = useState<'idle' | 'creating' | 'opening'>('idle');
  const [creationName, setCreationName] = useState('');
  const [creationError, setCreationError] = useState('');
  const [takingLonger, setTakingLonger] = useState(false);
  const creating = creationStage !== 'idle';
  useEffect(() => {
    if (!creating) return;
    const timer = setTimeout(() => setTakingLonger(true), 8000);
    return () => clearTimeout(timer);
  }, [creating]);
  const [inviteStatus, setInviteStatus] = useState('');
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteError, setInviteError] = useState('');
  const [kind, setKind] = useState('agent'),
    [harness, setHarness] = useState(
      providers?.find((p: ProviderInfo & { isDefault?: boolean }) => p.isDefault)?.harness || 'codex',
    ),
    [invite, setInvite] = useState('');
  return (
    <Modal title="Add employee" onClose={onClose} busy={creating} className="add-employee-dialog">
      <div className="add-employee-body">
        {creationError && (
          <p role="alert" className="error creation-error">
            {creationError}
          </p>
        )}
        <div className="segmented" hidden={creating || !!created.current}>
          <button className={kind === 'agent' ? 'active' : ''} onClick={() => setKind('agent')}>
            Agent
          </button>
          <button className={kind === 'human' ? 'active' : ''} onClick={() => setKind('human')}>
            Human
          </button>
        </div>
        {kind === 'human' ? (
          <div className="ui-stack invite-content">
            <p>
              Invite a trusted colleague. They’ll have their own identity and private conversations.
            </p>
            {invite ? (
              <div className="ui-stack">
                <label className="ui-field">
                  Invitation link
                  <input readOnly value={invite} onFocus={(e) => e.target.select()} />
                </label>
                <div className="ui-actions">
                  <button
                    className="secondary"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(invite);
                        setInviteStatus('Copied');
                        setInviteError('');
                      } catch {
                        setInviteError('Could not copy. Select the link and copy it manually.');
                      }
                    }}
                  >
                    <Copy size={14} />
                    Copy invitation
                  </button>
                  <span role="status" className="caption">
                    {inviteStatus}
                  </span>
                </div>
                <p className="caption">
                  Expires in 24 hours. Use your configured HTTPS address for another device.
                </p>
              </div>
            ) : (
              <button
                className="primary"
                disabled={inviteBusy}
                onClick={async () => {
                  setInviteBusy(true);
                  setInviteError('');
                  try {
                    const r = await api('/invites', {});
                    setInvite(location.origin + '/#invite=' + r.token);
                  } catch (e: any) {
                    setInviteError(e.message);
                  } finally {
                    setInviteBusy(false);
                  }
                }}
              >
                {inviteBusy ? 'Creating…' : 'Create invitation'}
              </button>
            )}
            {inviteError && (
              <p role="alert" className="settings-error">
                {inviteError}
              </p>
            )}
          </div>
        ) : (
          <form
            id="create-agent-form"
            className="ui-stack"
            hidden={creating || !!created.current}
            onSubmit={async (e) => {
              e.preventDefault();
              if (pending.current) return;
              pending.current = true;
              const f = new FormData(e.currentTarget);
              setCreationName(String(f.get('name') || 'your agent'));
              setCreationError('');
              setTakingLonger(false);
              setCreationStage(created.current ? 'opening' : 'creating');
              try {
                if (!created.current)
                  created.current = await api('/employees', {
                    name: f.get('name'),
                    role: f.get('role'),
                    harness,
                    model: f.get('model'),
                    instructions: f.get('instructions'),
                    canDelegate: f.has('canDelegate'),
                  });
                setCreationStage('opening');
                await onCreated(created.current!.dmId);
              } catch (e: any) {
                setCreationError(
                  created.current
                    ? 'Your agent was created, but its conversation could not be opened. Try opening it again.'
                    : e.message || 'Could not create your agent. Please try again.',
                );
              } finally {
                pending.current = false;
                setCreationStage('idle');
              }
            }}
          >
            <label>
              Name
              <input name="name" required autoFocus placeholder="Ada" />
            </label>
            <label>
              Role
              <input name="role" placeholder="What will they help with?" />
            </label>
            <label>
              Harness
              <select value={harness} onChange={(e) => setHarness(e.target.value)}>
                {Object.entries(names).map(([id, label]) => {
                  const info = providers?.find((p: ProviderInfo) => p.harness === id);
                  return (
                    <option key={id} value={id}>
                      {label}
                      {(info as any)?.isDefault ? ' (default)' : ''}
                      {info?.authenticated === false ? ' — not connected' : ''}
                    </option>
                  );
                })}
              </select>
            </label>
            <label>
              Model
              <ModelChoice key={harness} provider={providers.find((p: ProviderInfo) => p.harness === harness)} />
            </label>
            <label>
              Instructions
              <textarea name="instructions" rows={3} placeholder="How should this employee work?" />
            </label>
            <DelegationField />
          </form>
        )}
        {(creating || created.current) && (
          <div
            className="agent-creation ui-stack"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            <div
              className={`agent-creation-mark${creating ? ' is-working' : ''}`}
              aria-hidden="true"
            >
              <Avatar id={created.current?.id || creationName} name={creationName} size={56} />
            </div>
            <div className="ui-stack agent-creation-copy">
              <h3>
                {creationStage === 'creating'
                  ? `Creating ${creationName}…`
                  : `Meet ${creationName}`}
              </h3>
              <p>
                {creationStage === 'creating'
                  ? 'Setting up your agent and its private conversation.'
                  : creating
                    ? 'Opening your conversation…'
                    : 'Your agent is saved in the workspace.'}
              </p>
            </div>
            {creating && (
              <div className="agent-creation-track" aria-hidden="true">
                <span />
              </div>
            )}
            <p className="caption">
              {takingLonger && creating
                ? 'Taking a little longer. We’re still working on it — no need to submit again.'
                : creating
                  ? 'You’ll go straight to the conversation when it’s ready.'
                  : 'Open the conversation below to get started.'}
            </p>
          </div>
        )}
      </div>
      {kind === 'agent' && (
        <footer className="add-employee-footer ui-actions">
          <button type="button" className="secondary" disabled={creating} onClick={onClose}>
            {created.current && !creating ? 'Done' : 'Cancel'}
          </button>
          <button type="submit" form="create-agent-form" className="primary" disabled={creating}>
            {creationStage === 'creating'
              ? 'Creating agent…'
              : creationStage === 'opening'
                ? 'Opening conversation…'
                : created.current
                  ? 'Open conversation'
                  : 'Create agent'}
          </button>
        </footer>
      )}
    </Modal>
  );
}
function EditEmployee({ employee: e, providers, humans, onClose, done, onManage }: any) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [grants, setGrants] = useState<string[]>([]);
  const [harness, setHarness] = useState<string>(e.harness);
  useEffect(() => {
    api('/employees/' + e.id + '/grants')
      .then(setGrants)
      .catch((e) => setError(e.message));
  }, [e.id]);
  return (
    <Modal title={e.name} onClose={onClose} className="employee-settings-dialog">
      <form
        id="employee-preferences"
        className="employee-settings-scroll"
        onSubmit={async (event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const data = { ...Object.fromEntries(form), canDelegate: form.has('canDelegate') };
          setSaving(true);
          setError('');
          try {
            await api('/employees/' + e.id, data, 'PATCH');
            await api('/employees/' + e.id + '/grants', { users: grants }, 'PUT');
            await done();
            onClose();
          } catch (e: any) {
            setError(e.message);
          } finally {
            setSaving(false);
          }
        }}
      >
        <label>
          Name
          <input name="name" defaultValue={e.name} required />
        </label>
        <label>
          Role
          <input name="role" defaultValue={e.role} />
        </label>
        <label>
          Provider
          <select name="harness" value={harness} onChange={(event) => setHarness(event.target.value)}>
            {Object.entries(names)
              .filter(
                ([id]) =>
                  id === e.harness ||
                  providers?.find((p: ProviderInfo) => p.harness === id)?.authenticated === true,
              )
              .map(([id, label]) => {
                const info = providers?.find((p: ProviderInfo) => p.harness === id);
                return (
                  <option key={id} value={id}>
                    {label}
                    {info?.authenticated !== true ? ' — not connected' : ''}
                  </option>
                );
              })}
          </select>
        </label>
        {harness !== e.harness && (
          <p className="caption">
            Changing provider starts a fresh session. Earlier conversation carries over as a brief,
            and the model resets to the new provider’s default.
          </p>
        )}
        <label>
          Model
          <ModelChoice
            key={harness}
            initialValue={harness === e.harness ? e.model : ''}
            provider={providers?.find((p: ProviderInfo) => p.harness === harness)}
          />
        </label>
        <label>
          Instructions
          <textarea name="instructions" defaultValue={e.instructions} rows={5} />
        </label>
        <DelegationField enabled={e.canDelegate} />
        <fieldset>
          <legend>Who can work with this employee</legend>
          <p className="caption">
            Their conversations stay private. Runs use your connected provider account and its
            allowance.
          </p>
          {humans.filter((h: any) => h.id !== e.ownerId).length === 0 && (
            <p className="caption">Add a human to your workspace to share access.</p>
          )}
          {humans
            .filter((h: any) => h.id !== e.ownerId)
            .map((h: any) => (
              <label className="check-label" key={h.id}>
                <input
                  type="checkbox"
                  checked={grants.includes(h.id)}
                  onChange={(event) =>
                    setGrants((g) =>
                      event.target.checked ? [...g, h.id] : g.filter((id) => id !== h.id),
                    )
                  }
                />
                {h.name}
              </label>
            ))}
        </fieldset>
        {onManage && (
          <fieldset>
            <legend>Manage agent</legend>
            <div className="ui-actions">
              <button
                type="button"
                className="secondary"
                disabled={saving}
                onClick={() => onManage('deactivate-agent')}
              >
                Deactivate agent
              </button>
              <button
                type="button"
                className="secondary danger-action"
                disabled={saving}
                onClick={() => onManage('delete-agent')}
              >
                Delete agent…
              </button>
            </div>
          </fieldset>
        )}
      </form>
      <footer className="employee-settings-footer">
        <span role={error ? 'alert' : undefined} className="settings-error">
          {error}
        </span>
        <button type="button" className="secondary" disabled={saving} onClick={onClose}>
          Cancel
        </button>
        <button type="submit" form="employee-preferences" className="primary" disabled={saving}>
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </footer>
    </Modal>
  );
}
function ProviderRecoveryCard({ harness, failure, fail, onResume }: any) {
  const [provider, setProvider] = useState<any>(null);
  const [checking, setChecking] = useState(false);
  const [resumed, setResumed] = useState(false);
  const [denied, setDenied] = useState(false);
  async function load(check?: string) {
    setChecking(true);
    try {
      const list = await api('/providers' + (check ? '?check=' + check : ''));
      setProvider(list.find((p: any) => p.harness === harness) || null);
      return list;
    } catch (e: any) {
      setDenied(true);
      throw e;
    } finally {
      setChecking(false);
    }
  }
  useEffect(() => {
    void load(harness).catch(() => {});
  }, [harness]);
  const label = names[harness] || 'The provider';
  const resume = (text: string) => {
    if (resumed) return;
    setResumed(true);
    onResume(text);
  };
  if (resumed)
    return (
      <div className="inline-card account-card" role="status">
        <strong>{label} is ready.</strong>
        <p className="quiet account-detail">Picking up where you left off…</p>
      </div>
    );
  const signedIn = provider?.authenticated === true;
  // Signed in, yet the last request failed: nothing to fix on the account.
  if (signedIn || failure === 'blocked')
    return (
      <div className="inline-card ui-stack account-card" role="status">
        <strong>
          {failure === 'blocked'
            ? `${label} couldn’t be reached`
            : `${label} is signed in, but the last request didn’t go through`}
        </strong>
        <p className="quiet account-detail">
          {failure === 'blocked'
            ? 'The request was blocked on the way (for example by Cloudflare or your network). Your account is fine, so there is nothing to sign in to.'
            : 'Your account is connected. This is usually temporary.'}
        </p>
        <div className="account-card-actions">
          <button className="secondary" onClick={() => resume('Please try that again.')}>
            Try again
          </button>
        </div>
      </div>
    );
  if (denied)
    return (
      <div className="inline-card account-card" role="status">
        <strong>{label} needs to be signed in again</strong>
        <p className="quiet account-detail">Ask the workspace owner to reconnect it.</p>
      </div>
    );
  return (
    <ProviderLogin
      harness={harness}
      provider={provider}
      checking={checking}
      refresh={load}
      fail={fail}
      onConnected={() => resume('You’re signed in again. Please continue.')}
    />
  );
}
function ProviderSection({ fail }: any) {
  const [providers, setProviders] = useState<any[]>([]);
  const [checking, setChecking] = useState(false);
  async function load(check?: string) {
    setChecking(true);
    try {
      const result = await api('/providers' + (check ? '?check=' + check : ''));
      setProviders(result);
      return result;
    } finally {
      setChecking(false);
    }
  }
  useEffect(() => {
    load().catch((e: any) => fail(e.message));
    const changed = (event: Event) => {
      if ((event as CustomEvent).detail?.type === 'models.changed')
        void api('/providers').then(setProviders).catch(() => {});
    };
    window.addEventListener('workspace-event', changed);
    return () => window.removeEventListener('workspace-event', changed);
  }, []);
  async function makeDefault(harness: string) {
    try {
      await api('/providers/default', { harness }, 'PUT');
      setProviders(await api('/providers'));
    } catch (e: any) {
      fail(e.message);
    }
  }
  return (
    <div className="ui-stack provider-section">
      {['codex', 'claude', 'opencode'].map((h) => (
        <ProviderLogin
          key={h}
          harness={h}
          provider={providers.find((p) => p.harness === h)}
          isDefault={providers.find((p) => p.harness === h)?.isDefault === true}
          onMakeDefault={makeDefault}
          checking={checking}
          refresh={load}
          fail={fail}
        />
      ))}
    </div>
  );
}
function ProviderLogin({
  harness,
  fail,
  provider: suppliedProvider,
  checking: suppliedChecking,
  refresh: suppliedRefresh,
  isDefault,
  onMakeDefault,
  onConnected,
  bare = false,
}: any) {
  // Some screens show this card without managing provider status. Keep it
  // self-sufficient so Check status and sign-in polling always work.
  const [ownProvider, setOwnProvider] = useState<any>(null),
    [ownChecking, setOwnChecking] = useState(false);
  const managed = typeof suppliedRefresh === 'function';
  const provider = managed ? suppliedProvider : suppliedProvider || ownProvider;
  const checking = managed ? suppliedChecking : ownChecking;
  async function ownRefresh(check?: string) {
    setOwnChecking(true);
    try {
      const list = await api('/providers' + (check ? '?check=' + check : ''));
      setOwnProvider(list.find((p: any) => p.harness === harness) || null);
      return list;
    } finally {
      setOwnChecking(false);
    }
  }
  const refresh = managed ? suppliedRefresh : ownRefresh;
  useEffect(() => {
    if (!managed && !suppliedProvider) void ownRefresh().catch(() => {});
  }, [harness, managed]);
  const [info, setInfo] = useState<any>(null),
    [method, setMethod] = useState<any>(null),
    [authorization, setAuthorization] = useState<any>(null),
    [waiting, setWaiting] = useState(false),
    [showCode, setShowCode] = useState(false),
    [stalled, setStalled] = useState(false);
  const connected = provider?.authenticated === true;
  const unknown = provider?.authenticated == null;
  const unavailable = provider?.installed === false;
  async function refreshStatus() {
    try {
      await refresh(harness);
    } catch (e: any) {
      fail(e.message);
    }
  }
  async function startSignIn() {
    setShowCode(false);
    setStalled(false);
    try {
      const result = await api(`/providers/${harness}/login`, {});
      setInfo(result);
      if (harness !== 'opencode') setWaiting(true);
      const url = result?.authUrl || result?.verificationUrl;
      if (url) window.open(url, '_blank', 'noopener');
    } catch (e: any) {
      fail(e.message);
    }
  }
  // While a sign-in is in progress, notice completion without a manual check.
  useEffect(() => {
    if (!waiting || connected) return;
    const startedAt = Date.now();
    const poll = setInterval(() => {
      if (Date.now() - startedAt > 5 * 60 * 1000) {
        clearInterval(poll);
        setWaiting(false);
        setStalled(true);
        return;
      }
      void refresh(harness).catch(() => {});
    }, 3000);
    const reveal = setTimeout(() => setShowCode(true), 20000);
    return () => {
      clearInterval(poll);
      clearTimeout(reveal);
    };
  }, [waiting, connected, harness]);
  useEffect(() => {
    if (!connected || !waiting) return;
    setWaiting(false);
    setShowCode(false);
    setInfo(null);
    onConnected?.();
  }, [connected, waiting]);
  return (
    <div className={bare ? 'provider-login-bare ui-stack' : 'inline-card ui-stack account-card'}>
      {/* Bare: the surrounding row already names the account and its state. */}
      {!bare && (
      <div className="account-card-heading">
        <strong>
          {names[harness]} account
          {isDefault && <span className="account-default"> · Default for new employees</span>}
        </strong>
        <span className={'account-state' + (connected ? ' connected' : '')}>
          <span aria-hidden="true" />
          {checking
            ? 'Checking…'
            : connected
              ? 'Connected'
              : unavailable
                ? 'Not installed'
                : unknown
                  ? 'Not checked'
                  : 'Not signed in'}
        </span>
      </div>
      )}
      {!bare && (
      <p className="quiet account-detail">
        {provider?.detail ||
          (unknown
            ? 'Check this account to see whether it is signed in.'
            : 'Sign in with the provider on this host. Credentials stay out of the conversation.')}
      </p>
      )}
      <div className="account-card-actions">
        {!connected && !unavailable && (
          <button className={bare ? 'primary' : 'secondary'} onClick={startSignIn}>
            {waiting || stalled ? 'Start again' : 'Sign in'}
          </button>
        )}
        {connected && !isDefault && onMakeDefault && (
          <button className="secondary" disabled={checking} onClick={() => onMakeDefault(harness)}>
            Make default
          </button>
        )}
        <button className="quiet-button" disabled={checking} onClick={refreshStatus}>
          {checking ? 'Checking…' : unknown ? 'Check status' : 'Refresh'}
        </button>
      </div>
      {info?.message && <p>{info.message}</p>}
      {info?.userCode && <code>{info.userCode}</code>}
      {(info?.authUrl || info?.verificationUrl) && (
        <a
          className="primary account-sign-in-link"
          target="_blank"
          rel="noreferrer"
          href={info.authUrl || info.verificationUrl}
        >
          Open {names[harness]} sign-in
        </a>
      )}
      {waiting && (
        <p role="status" className="quiet account-waiting">
          Waiting for you to finish in the browser. This updates by itself.
          {!showCode && harness === 'claude' && (
            <>
              {' '}
              <button type="button" className="quiet-button" onClick={() => setShowCode(true)}>
                Page showing a code?
              </button>
            </>
          )}
        </p>
      )}
      {stalled && (
        <p role="status" className="quiet">
          Sign-in didn’t finish. Choose Start again for a fresh link.
        </p>
      )}
      {harness === 'claude' && info && showCode && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const form = e.currentTarget;
            try {
              await api('/providers/claude/code', { code: new FormData(form).get('code') });
              form.reset();
              setInfo({
                message: 'Code submitted. Check the connection, then send your message again.',
              });
              await refreshStatus();
            } catch (e: any) {
              fail(e.message);
            }
          }}
        >
          <label>
            Paste the code from the Claude page
            <input name="code" type="password" autoComplete="off" required />
          </label>
          <button className="secondary">Submit code securely</button>
        </form>
      )}
      {info?.providers && (
        <label>
          OpenCode provider
          <select
            defaultValue=""
            onChange={(e) => {
              const [provider, index] = e.target.value.split(':');
              setMethod({
                provider,
                index: Number(index),
                ...info.providers[provider][Number(index)],
              });
              setAuthorization(null);
            }}
          >
            <option value="" disabled>
              Select sign-in method
            </option>
            {Object.entries(info.providers).flatMap(([provider, methods]: any) =>
              methods.map((m: any, i: number) => (
                <option value={provider + ':' + i} key={provider + ':' + i}>
                  {provider} · {m.label}
                </option>
              )),
            )}
          </select>
        </label>
      )}
      {method?.type === 'oauth' && (
        <>
          <button
            className="secondary"
            onClick={async () => {
              try {
                setAuthorization(
                  await api('/providers/opencode/authorize', {
                    provider: method.provider,
                    method: method.index,
                  }),
                );
              } catch (e: any) {
                fail(e.message);
              }
            }}
          >
            Continue with {method.provider}
          </button>
          {authorization && (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                try {
                  await api('/providers/opencode/callback', {
                    provider: method.provider,
                    method: method.index,
                    ...(authorization.method === 'code'
                      ? { code: new FormData(e.currentTarget).get('code') }
                      : {}),
                  });
                  setAuthorization(null);
                  setInfo({ message: 'Connected. Choose your model in employee settings.' });
                  await refreshStatus();
                } catch (e: any) {
                  fail(e.message);
                }
              }}
            >
              <p>{authorization.instructions}</p>
              <a href={authorization.url} target="_blank" rel="noreferrer">
                Open sign-in
              </a>
              {authorization.method === 'code' && (
                <label>
                  Authorization code
                  <input name="code" type="password" autoComplete="off" />
                </label>
              )}
              <button className="primary">Finish sign-in</button>
            </form>
          )}
        </>
      )}
      {method?.type === 'api' && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            try {
              await api('/providers/opencode/key', {
                provider: method.provider,
                key: f.get('key'),
                billingConsent: true,
              });
              e.currentTarget.reset();
              setInfo({ message: 'API account connected.' });
              await refreshStatus();
            } catch (e: any) {
              fail(e.message);
            }
          }}
        >
          <label>
            API key
            <input name="key" type="password" autoComplete="off" required />
          </label>
          <label className="check-label">
            <input type="checkbox" required /> I understand this uses API billing from this
            provider.
          </label>
          <button className="primary">Connect API account</button>
        </form>
      )}
    </div>
  );
}
// Actions that still need attention stay pinned above the composer. Finished actions
// settle into the timeline after the last message sent before they started, so they
// scroll away with the conversation instead of following it.
const pinnedActionStates = new Set(['awaiting_approval', 'running', 'unknown']);
function placeConnectionActions(actions: any[], messages: Message[]) {
  const inlineActions = new Map<string, any[]>();
  const pinnedActions: any[] = [];
  for (const action of actions) {
    // A dismissed card no longer needs attention, even while it awaits approval.
    const pinned = pinnedActionStates.has(action.status) && !action.dismissed;
    let anchor: Message | undefined;
    if (!pinned && action.createdAt)
      for (const m of messages) {
        if (m.createdAt > action.createdAt) break;
        anchor = m;
      }
    if (anchor) inlineActions.set(anchor.id, [...(inlineActions.get(anchor.id) || []), action]);
    // Settled actions older than the loaded history belong to an earlier page.
    else if (pinned || !action.createdAt || !messages.length) pinnedActions.push(action);
  }
  return { inlineActions, pinnedActions };
}
function ConnectionAction({ action, onDismiss, onReceipt }: any) {
  const [receipt, setReceipt] = useState(action);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => setReceipt(action), [action]);
  const labels: Record<string, string> = {
    awaiting_approval: 'Needs your approval',
    running: 'Working on it',
    succeeded: 'Completed',
    declined: 'Declined',
    failed: 'Could not complete',
    unknown: 'Needs a check',
  };
  async function decide(allow: boolean) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const next = await api(`/connection-actions/${action.actionId}/decision`, { allow });
      setReceipt(next);
      onReceipt?.(next);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function dismiss() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await api(`/connection-actions/${action.actionId}/dismissal`,
        { dismissed: !action.dismissed }, 'PUT');
      onDismiss(result.dismissed);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const service = serviceNames[action.service] || action.service;
  const title = actionTitle(action.tool);
  const details = (
    <details className="connection-action-details">
      <summary>Details</summary>
      {action.account && <p className="quiet connection-account">Account: {action.account}</p>}
      <pre>{JSON.stringify(action.arguments, null, 2)}</pre>
    </details>
  );
  // Once settled, the card has done its job: it becomes a one-line receipt.
  if (['succeeded', 'declined', 'failed'].includes(receipt.status))
    return (
      <div className={`connection-receipt is-${receipt.status}`}>
        {receipt.status === 'succeeded' ? (
          <Check size={14} aria-hidden="true" />
        ) : (
          <X size={14} aria-hidden="true" />
        )}
        <span>
          <strong>{title}</strong> · {service}
        </span>
        <span className="quiet" role="status">
          {receiptLabels[receipt.status]}
        </span>
        {details}
      </div>
    );
  return (
    <div className="inline-card connection-action ui-stack" aria-busy={busy}>
      <div className="connection-heading">
        <Plug size={18} aria-hidden="true" />
        <strong>{title}</strong>
        <span className="connection-service">{service}</span>
        <span className="quiet" role="status">
          {labels[receipt.status] || receipt.status}
        </span>
        <button className="icon connection-dismiss" disabled={busy}
          aria-label={`${action.dismissed ? 'Restore' : 'Dismiss'} ${service} action`}
          title={action.dismissed ? 'Restore this card' : 'Dismiss this card. This does not cancel the action.'}
          onClick={() => void dismiss()}>
          {action.dismissed ? <RotateCcw size={16} aria-hidden="true" /> : <X size={16} aria-hidden="true" />}
        </button>
      </div>
      {receipt.status === 'unknown' && (
        <p role="status">
          The connection stopped before the result was confirmed. Your agent needs to check what
          happened before trying again.
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {details}
      {receipt.status === 'awaiting_approval' && (
        <div className="form-actions">
          <button className="secondary" disabled={busy} onClick={() => void decide(false)}>
            Decline
          </button>
          <button className="primary" disabled={busy} onClick={() => void decide(true)}>
            {busy ? 'Saving…' : 'Approve'}
          </button>
        </div>
      )}
    </div>
  );
}
const receiptLabels: Record<string, string> = {
  succeeded: 'Done',
  declined: 'Declined',
  failed: 'Couldn’t complete',
};
/** Who runs a server matters more than its name: a relay sees everything sent through it. */
function ServerOrigin({ server }: { server: any }) {
  return (
    <p className={`server-origin ${server.official ? 'is-official' : 'is-third-party'}`}>
      {server.official
        ? `Official server, run by ${server.publisher}`
        : `Third-party server, run by ${server.publisher}. It can see what agents send through it.`}
    </p>
  );
}
function ConnectionRow({ connection: c, fail, variant }: any) {
  const page = variant === 'page';
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [detail, setDetail] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  // idle → open (provider window showing) → settled by the callback; or blocked/closed.
  const [signIn, setSignIn] = useState<'idle' | 'open' | 'blocked' | 'closed'>('idle');
  const popup = useRef<Window | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const name = c.label && c.label !== c.service ? c.label : serviceNames[c.service] || c.service;
  // A request card names the service; a connected account names itself.
  const serviceName = c.data?.anotherAccount ? serviceNames[c.service] || c.data?.server?.label || name : name;
  const accountName = c.state === 'ready' ? c.account || name : serviceName;
  const choosing = !!c.data?.anotherAccount && c.state !== 'ready';
  const otherAccounts: any[] = choosing ? c.accounts || [] : [];
  const [renaming, setRenaming] = useState(false);
  const server = c.data?.server;
  const [keyForm, setKeyForm] = useState(false);
  const needsKey =
    c.state !== 'ready' && !c.data?.reuseId && (detail?.requiresApiKey || keyForm || server?.auth === 'api_key');
  useEffect(() => {
    if (detail) card.current?.scrollIntoView({ block: 'nearest' });
  }, [detail]);
  // The provider redirects to Abralo, which updates this connection durably and
  // notifies the page. No "check" step: the card settles on its own.
  useEffect(() => {
    if (!['ready', 'granted', 'failed'].includes(c.state) || signIn === 'idle') return;
    popup.current = null;
    setSignIn('idle');
    setDetail(
      c.state === 'failed'
        ? { error: c.data?.lastError || `Sign-in to ${serviceName} was cancelled. Connect again when you’re ready.` }
        : { message: `${c.account || name} is connected.` },
    );
  }, [c.state]);
  // Notice a sign-in window closed before finishing, after giving the callback time to land.
  useEffect(() => {
    if (signIn !== 'open') return;
    let settle: ReturnType<typeof setTimeout> | undefined;
    const timer = setInterval(() => {
      if (!popup.current?.closed) return;
      clearInterval(timer);
      settle = setTimeout(() => setSignIn((s) => (s === 'open' ? 'closed' : s)), 2500);
    }, 500);
    return () => {
      clearInterval(timer);
      clearTimeout(settle);
    };
  }, [signIn]);
  /**
   * Opens the sign-in window inside the click, so the browser allows it, then
   * points it at the provider once Abralo has prepared the request.
   */
  async function startSignIn(request: () => Promise<any>, needsWindow: boolean) {
    let win: Window | null = null;
    if (needsWindow) {
      win = window.open('', 'abralo-signin-' + c.id, 'popup,width=520,height=720');
      try {
        if (win) {
          win.opener = null; // The provider page gets no handle on Abralo.
          win.document.title = `Signing in to ${name}`;
          win.document.body.style.cssText =
            'font:16px system-ui;padding:48px;background:#fcfbf8;color:#252a30';
          win.document.body.textContent = `Opening ${name} sign-in…`;
        }
      } catch {
        // A reused window may already be on the provider's page.
      }
    }
    setBusy(true);
    setDetail(null);
    try {
      const result = await request();
      if (result?.url) {
        if (win && !win.closed) {
          win.location.href = result.url;
          win.focus();
          popup.current = win;
          setSignIn('open');
        } else {
          setSignIn('blocked');
          setDetail(result);
        }
      } else {
        win?.close();
        setSignIn('idle');
        setDetail(result);
      }
    } catch (e: any) {
      win?.close();
      setSignIn('idle');
      setDetail({ error: e.message });
    } finally {
      setBusy(false);
    }
  }
  async function disconnect() {
    try {
      const result = await api(`/connections/${c.id}`, undefined, 'DELETE');
      setConfirmDisconnect(false);
      setDetail({ message: result?.message || 'Disconnected. Employee grants have been removed.' });
    } catch (e: any) {
      fail(e.message);
    }
  }
  const usedBy: string[] = (c.usedBy || []).map((e: any) => e.name);
  const pageStatus: [Tone, string] =
    c.state === 'ready'
      ? ['ok', 'Connected']
      : c.state === 'failed'
        ? ['problem', 'Sign-in failed']
        : c.state === 'disconnected'
          ? ['idle', 'Disconnected']
          : c.data?.reuseId
            ? ['attention', 'Needs your OK']
            : ['attention', 'Needs sign-in'];
  const pageSubtitle =
    c.state === 'ready'
      ? [
          c.account && c.account.toLowerCase() !== name.toLowerCase() ? c.account : '',
          usedBy.length ? 'Used by ' + namesList(usedBy) : 'Not used by an employee yet',
        ]
          .filter(Boolean)
          .join(' · ')
      : c.data?.reuseId
        ? `${c.data.employeeName || 'An employee'} would like to use your ${c.data.accountLabel || name} account.`
        : choosing
          ? `${c.data.employeeName || 'Your employee'} needs a different ${serviceName} account${c.data?.reason ? ' to ' + c.data.reason.replace(/\.$/, '') : ''}.`
          : c.data?.reason
            ? `${c.data.employeeName || 'Your employee'} needs ${name} to ${c.data.reason.replace(/\.$/, '')}.`
            : c.data?.employeeName
              ? `${c.data.employeeName} is waiting for ${name}.`
              : `Sign in to finish connecting ${name}.`;
  const Wrapper: any = page ? 'li' : 'div';
  return (
    <Wrapper
      ref={card}
      data-connection-id={c.id}
      className={
        page
          ? 'surface-row connection-page-row' +
            (pageStatus[0] === 'attention' ? ' attention' : pageStatus[0] === 'problem' ? ' problem' : '')
          : 'inline-card connection-row'
      }
    >
      {page ? (
        <div className="surface-row-head">
          <span className="surface-row-mark">
            <ServiceMark service={c.service} name={serviceName} />
          </span>
          <div className="surface-row-text">
            <div className="surface-row-title">
              <strong>{serviceName}</strong>
              {c.state === 'ready' && c.isDefault && c.accountCount > 1 && (
                <span className="surface-tag">Default</span>
              )}
            </div>
            <div className="surface-row-subtitle">{pageSubtitle}</div>
          </div>
          <Status tone={pageStatus[0]}>{pageStatus[1]}</Status>
          {c.state === 'ready' && (
            <RowMenu label={`Manage ${accountName}`}>
              <button
                disabled={busy}
                onClick={() => void startSignIn(() => api(`/connections/${c.id}/connect`, {}), false)}
              >
                Check connection
              </button>
              {c.accountCount > 1 && !c.isDefault && (
                <button
                  disabled={busy}
                  onClick={async () => {
                    try {
                      await api(`/connections/${c.id}`, { isDefault: true }, 'PATCH');
                      setDetail({ message: `Agents now use ${accountName} unless a task names another account.` });
                    } catch (e: any) {
                      setDetail({ error: e.message });
                    }
                  }}
                >
                  Make default
                </button>
              )}
              <button disabled={busy} onClick={() => setRenaming(true)}>
                Rename
              </button>
              <button
                disabled={busy}
                onClick={() => void startSignIn(() => api(`/connections/${c.id}/reconnect`, {}), true)}
              >
                Reconnect
              </button>
              <button className="danger" onClick={() => setConfirmDisconnect(true)}>
                Disconnect…
              </button>
            </RowMenu>
          )}
        </div>
      ) : (
      <div className="connection-heading">
        {c.service === 'railway' ? (
          <img className="service-logo" src="/brands/railway.svg" alt="" />
        ) : (
          <Plug size={18} />
        )}
        <strong>{accountName}</strong>
        {c.state === 'ready' && c.isDefault && c.accountCount > 1 && (
          <span className="badge connection-default">Default</span>
        )}
        <span className="quiet">
          {c.state === 'ready'
            ? 'Connected'
            : c.state === 'awaiting_authorization'
              ? 'Needs sign-in'
              : choosing && c.data?.lastError
                ? 'Same account'
                : c.state.replaceAll('_', ' ').replace(/^./, (v: string) => v.toUpperCase())}
        </span>
      </div>
      )}
      <div className={page ? 'surface-row-body' : 'connection-row-body'}>
      {page && confirmDisconnect && (
        <div className="surface-confirm" role="alertdialog" aria-label={`Disconnect ${accountName}?`}>
          <p>
            <strong>Disconnect {accountName}?</strong> Employees lose access until you connect it
            again.
          </p>
          <div className="ui-actions">
            <button className="danger-button" autoFocus onClick={() => void disconnect()}>
              Disconnect
            </button>
            <button type="button" onClick={() => setConfirmDisconnect(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {!page && c.state !== 'ready' && (c.data?.reason || choosing) && (
        <p className="connection-reason">
          {c.data.employeeName || 'Your employee'} needs{' '}
          {choosing ? `a different ${serviceName} account` : name}
          {c.data?.reason ? ` to ${c.data.reason.replace(/\.$/, '')}` : ''}.
        </p>
      )}
      {choosing && c.state === 'failed' && c.data?.lastError && !detail && signIn === 'idle' && (
        <p role="status">{c.data.lastError}</p>
      )}
      {/* On the page, a connected official server needs no explanation. */}
      {server && (!page || c.state !== 'ready' || !server.official) && <ServerOrigin server={server} />}
      {signIn === 'open' ? (
        <p role="status">
          Finish signing in to {name} in the window that opened. This updates on its own.
        </p>
      ) : signIn === 'closed' ? (
        <p role="status">The sign-in window closed before {name} was connected.</p>
      ) : (
        detail && <p role="status">{detail.message || detail.error}</p>
      )}
      {c.data?.reuseId && c.state !== 'granted' && detail?.state !== 'granted' && (
        <button
          className="primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              setDetail(
                await api(`/connections/${c.id}/reuse`, { write: !!c.data.requestedWrite }),
              );
            } catch (e: any) {
              setDetail({ error: e.message });
            } finally {
              setBusy(false);
            }
          }}
        >
          Share your {c.data.accountLabel || name} account with {c.data.employeeName || 'this employee'}
        </button>
      )}
      {c.data?.reuseId && c.state !== 'granted' && detail?.state !== 'granted' && (
        <button
          className="quiet-button"
          disabled={busy}
          onClick={() => void startSignIn(() => api(`/connections/${c.id}/use-another`, {}), true)}
        >
          Use another account
        </button>
      )}
      {choosing && detail?.state !== 'granted' && !['open', 'blocked'].includes(signIn) && (
        <>
          {otherAccounts.map((a) => (
            <button
              key={a.connectionId}
              className="secondary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  setDetail(
                    await api(`/connections/${c.id}/reuse`, {
                      write: !!c.data.requestedWrite,
                      accountId: a.connectionId,
                    }),
                  );
                } catch (e: any) {
                  setDetail({ error: e.message });
                } finally {
                  setBusy(false);
                }
              }}
            >
              Use {a.account}
            </button>
          ))}
          {/* After a same-account sign-in, the error above already says what to do. */}
          {!(c.state === 'failed' && c.data?.lastError) && (
            <p className="quiet">
              {serviceName} will ask which account to use. If it signs you straight in, sign out of{' '}
              {serviceName} in that window, then sign in with the other account.
            </p>
          )}
        </>
      )}
      {detail?.requiresConfiguration === 'google-oauth' && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            void startSignIn(
              () =>
                api(`/connections/${c.id}/google-client`, {
                  id: f.get('client'),
                  secret: f.get('secret'),
                  write: f.get('write') === 'on',
                }),
              true,
            );
          }}
        >
          <a href="https://console.cloud.google.com/auth/clients" target="_blank" rel="noreferrer">
            Open Google OAuth clients
          </a>
          <label>
            Redirect URI
            <input readOnly value={detail.redirect} />
          </label>
          <label>
            Client ID
            <input name="client" autoComplete="off" required />
          </label>
          <label>
            Client secret
            <input name="secret" type="password" autoComplete="off" required />
          </label>
          <label className="check-label">
            <input type="checkbox" name="write" /> Also request permission to send mail (each send
            still needs approval)
          </label>
          <button className="primary">Continue with Google</button>
        </form>
      )}
      {signIn === 'open' && (
        <button className="quiet-button" onClick={() => popup.current?.focus()}>
          Show sign-in window
        </button>
      )}
      {signIn === 'blocked' && detail?.url && (
        // Only when the browser blocked the window: one link, which opens it directly.
        <a
          className="connection-signin"
          href={detail.url}
          target={'abralo-signin-' + c.id}
          rel="noreferrer"
          onClick={() => setSignIn('open')}
        >
          Sign in to {name} <ExternalLink size={14} />
        </a>
      )}
      {needsKey && (
        <form
          className="connection-key ui-stack"
          onSubmit={async (e) => {
            e.preventDefault();
            const input = e.currentTarget.elements.namedItem('key') as HTMLInputElement;
            setBusy(true);
            try {
              setDetail(await api(`/connections/${c.id}/api-key`, { key: input.value }));
              input.value = '';
            } catch (error: any) {
              setDetail({ error: error.message, requiresApiKey: true });
            } finally {
              setBusy(false);
            }
          }}
        >
          <label className="ui-field">
            {name} API key
            <input name="key" type="password" autoComplete="off" required minLength={8} />
          </label>
          <small className="quiet">
            {detail?.apiKeyHelp || server?.apiKeyHelp || `Create a key in your ${name} account settings.`}{' '}
            It goes straight to Abralo’s encrypted store and is never shown to agents.
          </small>
          <button className="primary" disabled={busy}>
            {busy ? 'Connecting…' : `Connect ${name}`}
          </button>
        </form>
      )}
      {/* A fallback only once sign-in has not worked: one choice at a time. */}
      {!c.data?.reuseId &&
        !needsKey &&
        server?.apiKeyHelp &&
        c.state !== 'ready' &&
        // Sign-in worked but chose the same account: a key would not help.
        !(choosing && c.data?.lastError) &&
        (signIn === 'closed' || detail?.error || c.state === 'failed') && (
        <button className="quiet-button" onClick={() => setKeyForm(true)}>
          Use an API key instead
        </button>
      )}
      {!c.data?.reuseId && !needsKey && !['open', 'blocked'].includes(signIn) && detail?.state !== 'granted' && !(page && c.state === 'ready') && (
        <button
          className={c.state === 'ready' ? 'secondary' : 'primary'}
          disabled={busy}
          onClick={() =>
            void startSignIn(
              () =>
                api(`/connections/${c.id}/connect`, {}),
              c.state !== 'ready',
            )
          }
        >
          {busy
            ? 'Connecting…'
            : c.state === 'ready'
              ? 'Check connection'
              : signIn === 'closed'
                ? 'Try again'
                : choosing
                  ? `Sign in to another ${serviceName} account`
                  : `Sign in to ${name}`}
        </button>
      )}
      {c.state === 'ready' && renaming && (
        <form
          className="connection-rename ui-stack"
          onSubmit={async (e) => {
            e.preventDefault();
            const input = e.currentTarget.elements.namedItem('name') as HTMLInputElement;
            setBusy(true);
            try {
              const saved = await api(`/connections/${c.id}`, { name: input.value }, 'PATCH');
              setRenaming(false);
              setDetail({ message: `Renamed to ${saved.account}.` });
            } catch (error: any) {
              setDetail({ error: error.message });
            } finally {
              setBusy(false);
            }
          }}
        >
          <label className="ui-field">
            Account name
            <input name="name" defaultValue={c.data?.customName || ''} placeholder={accountName} maxLength={80} autoFocus />
          </label>
          <small className="quiet">Agents can ask for this account by this name. Leave it empty to use the provider’s name.</small>
          <div className="form-actions">
            <button type="button" className="secondary" onClick={() => setRenaming(false)}>
              Cancel
            </button>
            <button className="primary" disabled={busy}>
              Save name
            </button>
          </div>
        </form>
      )}
      {!page && c.state === 'ready' && !renaming && (
        <>
          {c.accountCount > 1 && !c.isDefault && (
            <button
              className="quiet-button"
              disabled={busy}
              onClick={async () => {
                try {
                  await api(`/connections/${c.id}`, { isDefault: true }, 'PATCH');
                  setDetail({ message: `Agents now use ${accountName} unless a task names another account.` });
                } catch (e: any) {
                  setDetail({ error: e.message });
                }
              }}
            >
              Make default
            </button>
          )}
          <button className="quiet-button" disabled={busy} onClick={() => setRenaming(true)}>
            Rename
          </button>
          <button
            className="quiet-button"
            disabled={busy}
            onClick={() => void startSignIn(() => api(`/connections/${c.id}/reconnect`, {}), true)}
          >
            Reconnect
          </button>
          <button
            className="quiet-button"
            disabled={busy}
            onClick={() => void disconnect()}
          >
            Disconnect
          </button>
        </>
      )}
      </div>
    </Wrapper>
  );
}
/** "chatgpt · plus" → "ChatGPT Plus"; "claude.ai · max" → "Claude Max". */
function providerPlan(provider: any) {
  const detail = String(provider?.detail || '');
  if (provider?.authenticated !== true) return '';
  const [kind = '', plan = ''] = detail.split(' · ').map((part) => part.trim());
  const brand =
    ({ chatgpt: 'ChatGPT', 'claude.ai': 'Claude', apikey: 'API key', console: 'Anthropic Console' } as Record<string, string>)[
      kind.toLowerCase()
    ] || kind;
  const tier = plan && /^[a-z0-9_-]+$/i.test(plan) ? plan.replace(/[_-]/g, ' ').replace(/^./, (c) => c.toUpperCase()) : plan;
  return [brand, tier].filter(Boolean).join(' ');
}
const providerMarks: Record<string, string> = { codex: 'codex', claude: 'claude', opencode: 'opencode' };
function ProviderAccountRow({
  harness,
  provider,
  checking,
  refresh,
  makeDefault,
  fail,
  tone,
}: any) {
  const connected = provider?.authenticated === true;
  const missing = provider?.installed === false;
  const unknown = !provider || provider.authenticated == null;
  const status: [Tone, string] = connected
    ? ['ok', 'Connected']
    : checking
      ? ['idle', 'Checking…']
      : missing
        ? ['idle', 'Not installed']
        : unknown
          ? ['idle', 'Not checked']
          : ['attention', 'Not signed in'];
  const subtitle = connected
    ? providerPlan(provider) || 'Connected on this computer'
    : missing
      ? `Install ${names[harness]} on this computer to use it.`
      : unknown
        ? 'Checking this account in the background.'
        : tone === 'attention'
          ? `Employees using ${names[harness]} are waiting for you to sign in.`
          : 'Sign in with your existing account. Credentials stay on this computer.';
  return (
    <Row
      className="provider-account-row"
      tone={tone}
      mark={<ServiceMark service={providerMarks[harness]} name={names[harness]} />}
      title={names[harness]}
      tag={provider?.isDefault ? 'Default' : undefined}
      subtitle={subtitle}
      status={<Status tone={status[0]}>{status[1]}</Status>}
      menu={
        <RowMenu label={`Manage ${names[harness]}`}>
          {connected && !provider?.isDefault && (
            <button onClick={() => makeDefault(harness)}>Use for new employees</button>
          )}
          <button disabled={checking} onClick={() => void refresh(harness).catch((e: any) => fail(e.message))}>
            Check now
          </button>
        </RowMenu>
      }
    >
      {provider?.authenticated === false && !missing && (
        <ProviderLogin
          bare
          harness={harness}
          provider={provider}
          checking={checking}
          refresh={refresh}
          fail={fail}
        />
      )}
    </Row>
  );
}
const suggestedServices = ['Stripe', 'Railway', 'Resend', 'Gmail', 'GitHub', 'Linear', 'Notion'];
function ConnectionsView({ revision, fail, employees = [] }: any) {
  const [items, setItems] = useState<any[]>([]);
  const [providers, setProviders] = useState<any[]>([]);
  const [checking, setChecking] = useState('');
  const [askBeforeSharing, setAskBeforeSharing] = useState<boolean | null>(null);
  const [nativeMcp, setNativeMcp] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addName, setAddName] = useState('');
  const [addBusy, setAddBusy] = useState(false);
  const [addNote, setAddNote] = useState<{ error?: string; message?: string } | null>(null);
  const loadItems = () => api('/connections').then(setItems);
  async function loadProviders(check?: string) {
    setChecking(check || 'all');
    try {
      const result = await api('/providers' + (check ? '?check=' + check : ''));
      setProviders(result);
      return result;
    } finally {
      setChecking('');
    }
  }
  useEffect(() => {
    void loadItems().catch((e: any) => fail(e.message));
    api('/connections/native-mcp')
      .then((value) => setNativeMcp(value.enabled))
      .catch((e: any) => fail(e.message));
    api('/connections/sharing')
      .then((value) => setAskBeforeSharing(value.askBeforeSharing))
      .catch((e: any) => fail(e.message));
  }, [revision]);
  useEffect(() => {
    void loadProviders().catch((e: any) => fail(e.message));
    const changed = (event: Event) => {
      if ((event as CustomEvent).detail?.type === 'models.changed')
        void api('/providers').then(setProviders).catch(() => {});
    };
    window.addEventListener('workspace-event', changed);
    return () => window.removeEventListener('workspace-event', changed);
  }, []);
  async function makeDefault(harness: string) {
    try {
      await api('/providers/default', { harness }, 'PUT');
      setProviders(await api('/providers'));
    } catch (e: any) {
      fail(e.message);
    }
  }
  async function addService(event: React.FormEvent) {
    event.preventDefault();
    const name = addName.trim();
    if (!name) return;
    setAddBusy(true);
    setAddNote(null);
    try {
      const result = await api('/connections', { service: name });
      await loadItems();
      if (result.status === 'already_connected') {
        setAddNote({ message: `${name.replace(/^./, (c) => c.toUpperCase())} is already connected.` });
        return;
      }
      setAdding(false);
      setAddName('');
      // Take the person straight to the one thing left to do: sign in.
      requestAnimationFrame(() => {
        const row = document.querySelector(`[data-connection-id="${result.id}"]`);
        row?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        (row?.querySelector('button.primary') as HTMLButtonElement | null)?.focus();
      });
    } catch (e: any) {
      setAddNote({ error: e.message });
    } finally {
      setAddBusy(false);
    }
  }
  async function saveSetting(path: string, body: object, apply: (value: any) => void) {
    setSaving(true);
    try {
      apply(await api(path, body, 'PUT'));
    } catch (e: any) {
      fail(e.message);
    } finally {
      setSaving(false);
    }
  }
  const visible = items.filter((c) => c.state !== 'granted');
  const waitingServices = visible.filter((c) => c.state !== 'ready');
  const services = visible
    .filter((c) => c.state === 'ready')
    .sort((a, b) =>
      String(serviceNames[a.service] || a.label || a.service).localeCompare(
        String(serviceNames[b.service] || b.label || b.service),
      ),
    );
  const harnesses = ['codex', 'claude', 'opencode'];
  const info = (h: string) => providers.find((p) => p.harness === h);
  const inUse = (h: string) => employees.some((e: any) => e.harness === h);
  const providerWaiting = harnesses.filter(
    (h) => info(h) && info(h).installed !== false && info(h).authenticated === false && inUse(h),
  );
  // OpenCode stays out of the way until it is installed or someone uses it.
  const accountRows = harnesses.filter(
    (h) =>
      !providerWaiting.includes(h) &&
      (h !== 'opencode' || inUse(h) || (info(h) && info(h).installed !== false)),
  );
  const providerRow = (h: string, tone?: 'attention') => (
    <ProviderAccountRow
      key={h}
      harness={h}
      tone={tone}
      provider={info(h)}
      checking={checking === h || (checking === 'all' && !info(h))}
      refresh={loadProviders}
      makeDefault={makeDefault}
      fail={fail}
    />
  );
  const attentionCount = providerWaiting.length + waitingServices.length;
  return (
    <Page
      label="Connections"
      actions={
        !adding && (
          <button
            className="primary"
            onClick={() => {
              setAdding(true);
              setAddNote(null);
            }}
          >
            <Plus size={16} /> Add service
          </button>
        )
      }
    >
      {adding && (
        <form className="surface-add" onSubmit={addService} aria-label="Add a service">
          <div className="surface-add-row">
            <input
              autoFocus
              list="connection-suggestions"
              aria-label="Which service?"
              placeholder="Which service? For example Stripe, Gmail or Linear"
              value={addName}
              maxLength={120}
              disabled={addBusy}
              onChange={(event) => setAddName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && !addBusy) setAdding(false);
              }}
            />
            <datalist id="connection-suggestions">
              {suggestedServices.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
            <button className="primary" disabled={addBusy || addName.trim().length < 2}>
              {addBusy ? 'Finding…' : 'Continue'}
            </button>
            <button type="button" disabled={addBusy} onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
          {addNote && (
            <p role={addNote.error ? 'alert' : 'status'} className="surface-add-note">
              {addNote.error || addNote.message}
            </p>
          )}
        </form>
      )}
      {attentionCount > 0 && (
        <Section id="connections-attention" label="Needs attention" count={attentionCount} tone="attention">
          <List label="Needs attention">
            {providerWaiting.map((h) => providerRow(h, 'attention'))}
            {waitingServices.map((c) => (
              <ConnectionRow key={c.id} connection={c} fail={fail} variant="page" />
            ))}
          </List>
        </Section>
      )}
      <Section id="connections-ai" label="AI accounts">
        <List label="AI accounts">{accountRows.map((h) => providerRow(h))}</List>
      </Section>
      <Section
        id="connections-services"
        label="Services"
        count={services.length || undefined}
        footnote="Reading happens automatically. Changes always ask you first. Employees can also use command-line tools in their working folder, within their permissions."
      >
        {services.length ? (
          <List label="Services">
            {services.map((c) => (
              <ConnectionRow key={c.id} connection={c} fail={fail} variant="page" />
            ))}
          </List>
        ) : (
          <p className="surface-empty">
            No services yet. Add one now, or an employee will ask when a task needs it.
          </p>
        )}
      </Section>
      <Section id="connections-permissions" label="Permissions">
        <List label="Permissions">
          <Switch
            label="Ask before another employee uses an account"
            hint="Changes always ask for your approval, whichever employee makes them."
            checked={!!askBeforeSharing}
            disabled={askBeforeSharing === null || saving}
            onChange={(value) =>
              void saveSetting('/connections/sharing', { askBeforeSharing: value }, (saved) =>
                setAskBeforeSharing(saved.askBeforeSharing),
              )
            }
          />
          <Switch
            label="Let Claude Code use its own configured tools"
            hint="Uses the MCP servers in your Claude Code settings. Project servers can start when an agent opens that project, so turn this on only for projects you trust."
            checked={!!nativeMcp}
            disabled={nativeMcp === null || saving}
            onChange={(value) =>
              void saveSetting('/connections/native-mcp', { enabled: value }, (saved) =>
                setNativeMcp(saved.enabled),
              )
            }
          />
        </List>
      </Section>
    </Page>
  );
}
function readableError(message: string) {
  if (/(?:is not a function|is not defined|is not iterable|Cannot read propert(?:y|ies) of|Cannot set propert(?:y|ies) of|undefined is not an object|null is not an object)/i.test(message)) {
    return 'Something went wrong on this screen. Please try again, or reload Abralo if it keeps happening.';
  }
  return message;
}

type UsageWindow = {
  key: string;
  label: string;
  used: number;
  resetsAt: number;
  minutes: number;
};
function usageWindowLabel(w: { label?: string; windowDurationMins?: number | null }) {
  if (w.label) return w.label;
  const minutes = Number(w.windowDurationMins) || 0;
  if (minutes && minutes <= 360) return 'This session';
  if (minutes === 10080) return 'This week';
  if (minutes >= 1440 && minutes % 1440 === 0) return `${minutes / 1440}-day window`;
  return minutes ? `${Math.round(minutes / 60)}-hour window` : 'Usage';
}
/** Today → "18:00"; later → "Thu 04:00". */
function usageTime(ms: number) {
  const date = new Date(ms);
  const sameDay = date.toDateString() === new Date().toDateString();
  return date.toLocaleString([], {
    ...(sameDay ? {} : { weekday: 'short' }),
    hour: '2-digit',
    minute: '2-digit',
  });
}
function usageWindows(provider: any) {
  const limits = provider?.limits;
  const buckets: [string, any][] = Object.entries(
    limits?.rateLimitsByLimitId || (limits?.rateLimits ? { default: limits.rateLimits } : {}),
  ).filter(([, bucket]) => Boolean(bucket));
  const mainKey =
    buckets.find(([key]) => ['plan', 'default', 'codex'].includes(key))?.[0] || buckets[0]?.[0];
  const main: UsageWindow[] = [];
  const models: UsageWindow[] = [];
  for (const [bucketKey, bucket] of buckets)
    for (const slot of ['primary', 'secondary'] as const) {
      const w = bucket[slot];
      if (!w || typeof w.usedPercent !== 'number' || typeof w.resetsAt !== 'number') continue;
      const base = usageWindowLabel(w);
      const label =
        bucketKey === mainKey || w.label
          ? base
          : `${bucket.limitName || bucketKey.replace(/[_-]/g, ' ')} · ${base.toLowerCase()}`;
      (bucketKey === mainKey ? main : models).push({
        key: `${provider.harness}.${bucketKey}.${slot}`,
        label,
        used: Math.max(0, Math.min(100, w.usedPercent)),
        resetsAt: w.resetsAt * 1000,
        minutes: Number(w.windowDurationMins) || 0,
      });
    }
  main.sort((x, y) => x.minutes - y.minutes);
  return { main, models };
}
function UsageWindowRow({ w, forecast }: { w: UsageWindow; forecast?: { earliest: number } }) {
  const left = Math.round(100 - w.used);
  const runsOut = forecast && forecast.earliest < w.resetsAt ? forecast.earliest : 0;
  return (
    <li className="usage-window-row">
      <span className="usage-window-label">{w.label}</span>
      <Meter used={w.used} label={`${w.label}: ${left}% left`} />
      <span className="usage-window-value">
        <b>{left}% left</b> · resets {usageTime(w.resetsAt)}
      </span>
      {runsOut > 0 && (
        <span className="usage-window-forecast">
          At this pace this could run out around {usageTime(runsOut)}, before it resets.
        </span>
      )}
    </li>
  );
}
function UsageView({ employees = [], onOpenConnections, avatar }: any) {
  const [accounts, setAccounts] = useState<any>(null);
  const [data, setData] = useState<any>({ runs: [] });
  const [period, setPeriod] = useState<'today' | 'week'>('week');
  useEffect(() => {
    let live = true;
    api('/usage')
      .then((value) => live && setData(value))
      .catch(() => {});
    const refresh = () =>
      void api('/usage/accounts')
        .then((value) => live && setAccounts(value))
        .catch(() => live && setAccounts((current: any) => current || { providers: [], forecasts: {}, limited: [] }));
    refresh();
    const timer = setInterval(refresh, 60000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  const providers: any[] = (accounts?.providers || []).filter(
    (p: any) => p.authenticated === true || p.limits,
  );
  const limited: any[] = accounts?.limited || [];
  const attention: { key: string; harness: string; title: string; subtitle: string }[] = [];
  for (const p of providers) {
    const { main } = usageWindows(p);
    const tight = [...main].sort((x, y) => y.used - x.used)[0];
    if (tight && tight.used >= 85)
      attention.push({
        key: 'low.' + p.harness,
        harness: p.harness,
        title:
          tight.used >= 100
            ? `${names[p.harness]} has reached its limit`
            : `${names[p.harness]} is nearly used up`,
        subtitle: `${Math.round(100 - tight.used)}% left ${tight.label.toLowerCase()} · resets ${usageTime(tight.resetsAt)}`,
      });
  }
  const pausedGroups = new Map<string, any[]>();
  for (const run of limited) {
    const key = run.harness + '|' + (run.retryAt || '');
    pausedGroups.set(key, [...(pausedGroups.get(key) || []), run]);
  }
  for (const [key, runs] of pausedGroups) {
    const people = [...new Set(runs.map((r) => r.employeeName))];
    const retry = runs[0].retryAt ? Date.parse(runs[0].retryAt) : 0;
    const automatic = runs.every((r) => r.autoResume);
    attention.push({
      key: 'paused.' + key,
      harness: runs[0].harness,
      title: retry ? `Paused until ${usageTime(retry)}` : 'Paused by a usage limit',
      subtitle: `${namesList(people)} ${automatic ? (people.length > 1 ? 'continue' : 'continues') + ' automatically' : (people.length > 1 ? 'are' : 'is') + ' waiting for you to resume'}.`,
    });
  }
  const cutoff =
    period === 'today'
      ? new Date(new Date().setHours(0, 0, 0, 0)).getTime()
      : Date.now() - 7 * 24 * 60 * 60 * 1000;
  const totals = new Map<string, { id: string; name: string; tokens: number }>();
  for (const r of data.runs || []) {
    if (Date.parse(r.createdAt) < cutoff) continue;
    const u = r.usage?.usage || r.usage?.last || r.usage?.tokens || {};
    const tokens =
      (u.input_tokens || u.inputTokens || u.input || 0) + (u.output_tokens || u.outputTokens || u.output || 0);
    if (!tokens) continue;
    const key = r.employeeId || r.name;
    const entry = totals.get(key) || { id: r.employeeId || key, name: r.name, tokens: 0 };
    entry.tokens += tokens;
    totals.set(key, entry);
  }
  const ranked = [...totals.values()].sort((x, y) => y.tokens - x.tokens);
  const total = ranked.reduce((sum, e) => sum + e.tokens, 0);
  const known = new Set(employees.map((e: any) => e.id));
  return (
    <Page label="Usage">
      {attention.length > 0 && (
        <Section id="usage-attention" label="Needs attention" count={attention.length} tone="attention">
          <List label="Usage that needs attention">
            {attention.map((item) => (
              <Row
                key={item.key}
                tone="attention"
                mark={<ServiceMark service={item.harness} name={names[item.harness] || item.harness} />}
                title={item.title}
                subtitle={item.subtitle}
              />
            ))}
          </List>
        </Section>
      )}
      <Section id="usage-accounts" label="AI accounts">
        {!accounts ? (
          <p className="surface-empty">Checking your accounts…</p>
        ) : !providers.length ? (
          <div className="surface-empty">
            <p>Connect an AI account to see how much room your team has.</p>
            <button className="secondary" onClick={onOpenConnections}>
              Open Connections
            </button>
          </div>
        ) : (
          <div className="usage-providers">
            {providers.map((p) => {
              const { main, models } = usageWindows(p);
              const tight = [...main].sort((x, y) => y.used - x.used)[0];
              return (
                <article className="usage-provider" key={p.harness} aria-label={`${names[p.harness]} usage`}>
                  <header className="usage-provider-head">
                    <ServiceMark service={p.harness} name={names[p.harness]} size={22} />
                    <div className="usage-provider-name">
                      <strong>{names[p.harness]}</strong>
                      <span>{providerPlan(p) || p.detail}</span>
                    </div>
                    {tight && (
                      <div className="usage-headline">
                        <b>{Math.round(100 - tight.used)}%</b>
                        <span>
                          left {tight.label.toLowerCase()}
                        </span>
                      </div>
                    )}
                  </header>
                  {main.length ? (
                    <ul className="usage-windows" aria-label={`${names[p.harness]} limits`}>
                      {main.map((w) => (
                        <UsageWindowRow key={w.key} w={w} forecast={accounts.forecasts?.[w.key]} />
                      ))}
                    </ul>
                  ) : (
                    <p className="usage-unreported">
                      {names[p.harness]} doesn’t report its remaining allowance.
                    </p>
                  )}
                  {models.length > 0 && (
                    <details className="usage-models">
                      <summary>Model limits</summary>
                      <ul className="usage-windows">
                        {models.map((w) => (
                          <UsageWindowRow key={w.key} w={w} forecast={accounts.forecasts?.[w.key]} />
                        ))}
                      </ul>
                    </details>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </Section>
      <Section
        id="usage-people"
        label="Who’s using it"
        footnote="Limits are shared with your other apps on the same account. This list counts work in this workspace only."
        aside={
          <Segmented
            label="Period"
            value={period}
            onChange={setPeriod}
            options={[
              { value: 'today', label: 'Today' },
              { value: 'week', label: '7 days' },
            ]}
          />
        }
      >
        {ranked.length ? (
          <List label="Usage by employee">
            {ranked.map((e) => {
              const share = total ? (e.tokens / total) * 100 : 0;
              return (
                <li className="surface-row usage-person" key={e.id} title={`${e.tokens.toLocaleString()} tokens`}>
                  <div className="surface-row-head">
                    <span className="surface-row-mark">
                      {avatar && known.has(e.id) ? avatar(e.id, e.name) : <ServiceMark service="" name={e.name} />}
                    </span>
                    <span className="usage-person-name">{e.name}</span>
                    <span className="usage-person-bar" aria-hidden="true">
                      <span style={{ width: Math.max(2, (e.tokens / ranked[0].tokens) * 100) + '%' }} />
                    </span>
                    <span className="usage-person-share">{share < 1 ? '<1' : Math.round(share)}%</span>
                  </div>
                </li>
              );
            })}
          </List>
        ) : (
          <p className="surface-empty">No work recorded {period === 'today' ? 'today' : 'in the last 7 days'}.</p>
        )}
      </Section>
    </Page>
  );
}
function Schedules({ workspace: w, fail }: any) {
  const [items, setItems] = useState<any[]>([]);
  const load = () => api('/schedules').then(setItems);
  useEffect(() => {
    void load();
  }, []);
  return (
    <>
      <p className="quiet">
        Work runs while this host is awake, even with the browser closed. A missed repeat runs once
        when the host returns.
      </p>
      {items.map((s) => (
        <div className="inline-card" key={s.id}>
          <p>{s.prompt}</p>
          <small>
            {new Date(s.next_at).toLocaleString()} ·{' '}
            {s.interval_minutes ? 'every ' + s.interval_minutes + ' minutes' : 'once'}
          </small>
          <button
            className="secondary"
            onClick={async () => {
              await api('/schedules/' + s.id, { enabled: !s.enabled }, 'PATCH');
              await load();
            }}
          >
            {s.enabled ? 'Pause' : 'Enable'}
          </button>
          <button
            className="quiet-button"
            onClick={async () => {
              await api('/schedules/' + s.id, undefined, 'DELETE');
              await load();
            }}
          >
            Remove
          </button>
        </div>
      ))}
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const form = e.currentTarget,
            f = new FormData(form),
            employee = w.employees.find((a: any) => a.id === f.get('employee'));
          try {
            await api('/schedules', {
              employeeId: employee.id,
              conversationId: employee.dmId,
              prompt: f.get('prompt'),
              nextAt: new Date(String(f.get('next'))).toISOString(),
              intervalMinutes: f.get('repeat') ? Number(f.get('repeat')) : null,
            });
            form.reset();
            await load();
          } catch (e: any) {
            fail(e.message);
          }
        }}
      >
        <label>
          Employee
          <select name="employee" required>
            {w.employees.map((e: any) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Task
          <textarea name="prompt" required />
        </label>
        <label>
          First run
          <input type="datetime-local" name="next" required />
        </label>
        <label>
          Repeat every (minutes, empty for once)
          <input name="repeat" type="number" min="1" />
        </label>
        <button className="primary">Schedule work</button>
      </form>
    </>
  );
}
function PermissionMenu({ employee, fail }: any) {
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const mode = employee.permissionMode || 'auto';
  const choices = [
    { id: 'auto', label: 'Auto', detail: 'Use the provider’s built-in safeguards.' },
    { id: 'ask', label: 'Ask', detail: 'Request approval for restricted actions.' },
    {
      id: 'bypass',
      label: employee.harness === 'codex' ? 'Full access' : 'Bypass permissions',
      detail: 'Run native tools without approval prompts.',
    },
  ];
  const close = () => {
    menu.current?.hidePopover();
    trigger.current?.focus();
  };
  const show = () => {
    if (open) {
      close();
      return;
    }
    const r = trigger.current!.getBoundingClientRect();
    menu.current!.style.right = Math.max(12, innerWidth - r.right) + 'px';
    menu.current!.style.bottom = innerHeight - r.top + 8 + 'px';
    menu.current!.showPopover();
    menu.current?.querySelector<HTMLButtonElement>(`[data-mode="${mode}"]`)?.focus();
  };
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="permission-trigger"
        aria-label="Permission mode"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={show}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            show();
          }
        }}
      >
        {choices.find((c) => c.id === mode)?.label}
        <ChevronDown size={14} />
      </button>
      <div
        ref={menu}
        popover="auto"
        role="menu"
        aria-label="Permission mode"
        className="permission-menu"
        onToggle={(e) => setOpen((e as any).newState === 'open')}
        onKeyDown={(e) => {
          const buttons = [
            ...menu.current!.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
          ];
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
            e.preventDefault();
            buttons[
              e.key === 'Home'
                ? 0
                : e.key === 'End'
                  ? buttons.length - 1
                  : (index + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
            ]?.focus();
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            close();
          }
          if (e.key === 'Tab') menu.current?.hidePopover();
        }}
      >
        <div className="permission-menu-heading">
          Permissions <small>Applies to the next run</small>
        </div>
        {choices.map((c) => (
          <button
            type="button"
            key={c.id}
            data-mode={c.id}
            role="menuitemradio"
            aria-checked={c.id === mode}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api('/employees/' + employee.id, { permissionMode: c.id }, 'PATCH');
                close();
              } catch (e: any) {
                fail(e.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <span>
              <strong>{c.label}</strong>
              <small>{c.detail}</small>
            </span>
            {c.id === mode && <Check size={16} />}
          </button>
        ))}
      </div>
    </>
  );
}
function UpdatePreparationStatus() {
  const [update, setUpdate] = useState<any>(null);
  useEffect(() => {
    let disposed = false;
    const refresh = () => void api('/maintenance').then(value => { if (!disposed) setUpdate(value); }).catch(() => {});
    refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, []);
  const job = update?.job;
  if (!update?.supported || !job) return null;
  const message = job.waitingForSpace ? 'Update queued: waiting for free disk space. Agents can keep working.'
    : job.phase === 'stopping' || job.phase === 'starting' ? 'Installing update and checking your saved workspace. Please wait a moment.'
    : job.phase === 'succeeded' ? 'Update installed.'
    : job.phase === 'rolled-back' ? 'The update could not start. Your previous version is running.'
    : job.phase === 'failed' || job.phase === 'recovery-required' ? 'Update needs attention.'
    : job.message || 'Update queued.';
  return <section className="settings-section" aria-label="Update status">
    <h3>Updates</h3>
    <p role="status">{message}</p>
    {job.error && <p className="caption">{job.error}</p>}
    {job.compaction?.state === 'switched' && <p className="caption">Workspace storage compacted and verified. Recovery copy retained.</p>}
  </section>;
}

function SettingsPanel({ workspace: w, onClose, refresh, onMemorySource, fail, initialTab = 'general' }: any) {
  const [notificationStatus, setNotificationStatus] = useState('');
  const [notificationInfo, setNotificationInfo] = useState<any>(null);
  const [startup, setStartup] = useState<any>(null);
  const [tab, setTab] = useState(initialTab),
    [prefs, setPrefs] = useState<any>({ enabled: true, sound: true, privatePreview: false }),
    [memories, setMemories] = useState<any[]>([]);
  useEffect(() => {
    const loadNotifications = () =>
      void api('/notifications')
        .then((r) => {
          setPrefs(r.preferences);
          setNotificationInfo(r);
        })
        .catch((e) => setSettingsError(e.message));
    loadNotifications();
    window.addEventListener('workspace-notification-channel', loadNotifications);
    api('/memories')
      .then(setMemories)
      .catch((e) => setSettingsError(e.message));
    api('/startup')
      .then(setStartup)
      .catch(() => {});
    return () => window.removeEventListener('workspace-notification-channel', loadNotifications);
  }, []);
  const [draft, setDraft] = useState({ workspace: w.name, name: w.user.name, password: '' });
  const [saved, setSaved] = useState({ workspace: w.name, name: w.user.name });
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  const [settingsError, setSettingsError] = useState('');
  const [closing, setClosing] = useState(false);
  const [backup, setBackup] = useState('');
  const [backingUp, setBackingUp] = useState(false);
  const dirty =
    draft.workspace !== saved.workspace || draft.name !== saved.name || !!draft.password;
  const close = () => {
    if (saving) return;
    if (dirty) setClosing(true);
    else onClose();
  };
  async function save() {
    setSettingsError('');
    setStatus('');
    if (!draft.name.trim() || (w.user.role === 'owner' && !draft.workspace.trim())) {
      setSettingsError('Names cannot be empty.');
      return;
    }
    if (draft.password && draft.password.length < 12) {
      setSettingsError('Use at least 12 characters for your password.');
      return;
    }
    setSaving(true);
    try {
      if (w.user.role === 'owner')
        await api('/workspace', { name: draft.workspace.trim() }, 'PATCH');
      await api(
        '/profile',
        { name: draft.name.trim(), ...(draft.password ? { password: draft.password } : {}) },
        'PATCH',
      );
      const next = { workspace: draft.workspace.trim(), name: draft.name.trim() };
      setSaved(next);
      setDraft({ ...next, password: '' });
      await refresh();
      setStatus('Changes saved.');
      if (closing) onClose();
    } catch (e: any) {
      setSettingsError(e.message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal title="Workspace settings" onClose={close} className="workspace-settings-dialog">
      <div className="workspace-settings-layout">
        <nav className="settings-navigation" aria-label="Settings sections">
          {['general', ...(w.user.role === 'owner' ? ['voice'] : []), 'notifications', 'memory', 'accounts', 'schedules'].map((t) => (
            <button
              type="button"
              aria-current={tab === t ? 'page' : undefined}
              className={tab === t ? 'active' : ''}
              key={t}
              onClick={() => setTab(t)}
            >
              {t === 'accounts' ? 'providers' : t}
            </button>
          ))}
        </nav>
        <div className="settings-scroll">
          {tab === 'voice' ? <VoiceSettings onSaved={() => void refresh().catch(fail)} /> : tab === 'general' ? (
            <form
              id="workspace-preferences"
              className="settings-general"
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              <section className="settings-section">
                <h3>Workspace</h3>
                {w.user.role === 'owner' && (
                  <label>
                    Workspace name
                    <input
                      name="workspace"
                      required
                      value={draft.workspace}
                      onChange={(e) => {
                        setDraft((d) => ({ ...d, workspace: e.target.value }));
                        setStatus('');
                      }}
                    />
                  </label>
                )}
                <p className="caption">The name everyone sees in the sidebar.</p>
              </section>
              <section className="settings-section">
                <h3>Your profile</h3>
                <label>
                  Your name
                  <input
                    name="name"
                    required
                    value={draft.name}
                    onChange={(e) => {
                      setDraft((d) => ({ ...d, name: e.target.value }));
                      setStatus('');
                    }}
                  />
                </label>
                <label>
                  New password <span className="optional-label">Optional</span>
                  <input
                    type="password"
                    name="password"
                    autoComplete="new-password"
                    minLength={12}
                    value={draft.password}
                    onChange={(e) => setDraft((d) => ({ ...d, password: e.target.value }))}
                    placeholder="At least 12 characters"
                  />
                </label>
                <p className="caption">Leave blank to keep your current password.</p>
              </section>
              <section className="settings-section">
                <h3>On this device</h3>
                <p className="caption">Agents keep working when you close the browser.</p>
                {startup?.supported && (
                  <label className="check-label settings-toggle">
                    <input
                      type="checkbox"
                      checked={startup.enabled}
                      onChange={async (e) => {
                        try {
                          setStartup(await api('/startup', { enabled: e.target.checked }, 'PUT'));
                        } catch (e: any) {
                          setSettingsError(e.message);
                        }
                      }}
                    />
                    <span>
                      Start when I sign in to Windows<small>This setting saves immediately.</small>
                    </span>
                  </label>
                )}
                {w.user.role === 'owner' && (
                  <div className="settings-backup">
                    <div>
                      <h4>Workspace backup</h4>
                      <p className="caption">
                        Create a local recovery copy of your workspace data.
                      </p>
                    </div>
                    <button
                      type="button"
                      className="secondary"
                      disabled={backingUp}
                      onClick={async () => {
                        setBackingUp(true);
                        try {
                          const b = await api('/backups', {});
                          setBackup(b.message + ' ' + b.path);
                        } catch (e: any) {
                          setSettingsError(e.message);
                        } finally {
                          setBackingUp(false);
                        }
                      }}
                    >
                      {backingUp ? 'Creating…' : 'Create a backup'}
                    </button>
                  </div>
                )}
                {backup && (
                  <p role="status" className="settings-result">
                    {backup}
                  </p>
                )}
              </section>
              {w.user.role === 'owner' && <UpdatePreparationStatus />}
              <button
                type="button"
                className="quiet-button settings-signout"
                onClick={() => {
                  if (dirty) {
                    setSettingsError('Save or discard your changes before signing out.');
                    return;
                  }
                  void api('/logout', {}).then(() => {
                    conversationCache.clear();
                    location.reload();
                  });
                }}
              >
                <LogOut size={14} />
                Sign out
              </button>
            </form>
          ) : tab === 'accounts' ? (
            <>
              <section className="settings-section provider-settings-intro">
                <h3>Connect AI providers</h3>
                <p>Connect Codex, Claude and OpenCode separately. You can keep more than one connected and choose which provider each employee uses when you add or edit them.</p>
              </section>
              {w.user.role === 'owner' && <ModelSettings />}
              <ProviderSection fail={setSettingsError} />
            </>
          ) : tab === 'schedules' ? (
            <Schedules workspace={w} fail={setSettingsError} />
          ) : tab === 'notifications' ? (
            <div className="ui-stack notification-settings">
              <p>Get an alert when someone replies or mentions you.</p>
              {notificationInfo && (
                <p className="quiet">
                  {notificationInfo.nativeAvailable
                    ? prefs.enabled
                      ? 'Delivery: Windows desktop, independent of your browser.'
                      : 'Windows desktop delivery is available.'
                    : notificationInfo.browserSubscriptions
                      ? `${prefs.enabled ? 'Delivery' : 'Available'}: ${notificationInfo.browserSubscriptions} browser subscription${notificationInfo.browserSubscriptions === 1 ? '' : 's'}.`
                      : prefs.enabled
                        ? 'In-app alerts are on. Desktop alerts need browser permission on this device.'
                        : 'Alerts are off.'}
                  {notificationInfo.lastDelivery?.error &&
                    !(
                      notificationInfo.nativeAvailable &&
                      notificationInfo.lastDelivery.channel === 'none'
                    ) &&
                    ` Last attempt failed: ${notificationInfo.lastDelivery.error}`}
                </p>
              )}
              <button
                className={prefs.enabled ? 'secondary' : 'primary'}
                onClick={async () => {
                  try {
                    const next = { ...prefs, enabled: !prefs.enabled };
                    await api('/notifications', next, 'PUT');
                    setPrefs(next);
                    setNotificationStatus('');
                  } catch (e: any) {
                    setSettingsError(e.message);
                  }
                }}
              >
                <Bell size={15} />
                {prefs.enabled ? 'Turn off notifications' : 'Turn on notifications'}
              </button>
              {prefs.enabled &&
                notificationInfo &&
                !notificationInfo.nativeAvailable &&
                !notificationInfo.browserSubscriptions && (
                  <button
                    className="secondary"
                    onClick={async () => {
                      try {
                        if (!('Notification' in window) || !('serviceWorker' in navigator))
                          throw new Error('This browser does not support desktop alerts.');
                        const permission = await Notification.requestPermission();
                        if (permission !== 'granted')
                          throw new Error('Desktop alerts are blocked in this browser.');
                        await ensureBrowserNotificationSubscription(notificationInfo.publicKey);
                        setNotificationStatus('Browser desktop alerts connected.');
                      } catch (e: any) {
                        setNotificationStatus(e.message);
                      }
                    }}
                  >
                    Allow browser desktop alerts
                  </button>
                )}
              {['sound', 'privatePreview'].map((key) => (
                <label className="check-label" key={key}>
                  <input
                    type="checkbox"
                    checked={prefs[key]}
                    onChange={async (e) => {
                      const next = { ...prefs, [key]: e.target.checked };
                      try {
                        await api('/notifications', next, 'PUT');
                        setPrefs(next);
                      } catch (e: any) {
                        setSettingsError(e.message);
                      }
                    }}
                  />
                  {key === 'sound' ? 'Play sounds where supported' : 'Hide message previews'}
                </label>
              ))}
              {prefs.enabled &&
                !!(notificationInfo?.nativeAvailable || notificationInfo?.browserSubscriptions) && (
                  <button
                    className="secondary"
                    onClick={async () => {
                      setNotificationStatus('Sending…');
                      try {
                        if (notificationInfo?.nativeAvailable) {
                          const result = await api('/notifications/test', {}, 'POST');
                          setNotificationStatus(result.message);
                          return;
                        }
                        if (!('Notification' in window) || Notification.permission !== 'granted')
                          throw new Error(
                            'Notifications are blocked for this browser. Enable them in site settings.',
                          );
                        const registration = await navigator.serviceWorker.getRegistration('/');
                        if (!registration?.active)
                          throw new Error(
                            'The notification worker is not ready. Enable notifications again.',
                          );
                        await registration.showNotification('Chief of Staff', {
                          body: 'A small ping. A working notification.',
                          tag: 'workspace-test-' + Date.now(),
                          icon: '/icon.svg',
                          silent: !prefs.sound,
                          data: {},
                        });
                        if (prefs.sound) messageSound();
                        setNotificationStatus(
                          'Sent to your browser. If no banner appears, check Windows notification settings and Do not disturb.',
                        );
                      } catch (e: any) {
                        setNotificationStatus(e.message);
                      }
                    }}
                  >
                    Send a test
                  </button>
                )}
              {notificationStatus && (
                <p role="status" className="notification-result">
                  {notificationStatus}
                </p>
              )}
            </div>
          ) : (
            <>
              <p className="quiet">
                Agents carry workspace facts across conversations and use conversation notes only
                here. Forget a note to remove it from future context.
              </p>
              {memories.map((m) => (
                <div className="inline-card" key={m.id}>
                  <textarea
                    defaultValue={m.content}
                    rows={4}
                    onBlur={(e) => {
                      if (e.target.value !== m.content)
                        void api('/memories/' + m.id, { content: e.target.value }, 'PATCH').catch(
                          (e) => fail(e.message),
                        );
                    }}
                  />
                  <div className="memory-meta">
                    {m.scope === 'workspace' && <span className="memory-scope">WORKSPACE</span>}
                    {m.source_author ? (
                      <button
                        type="button"
                        className="memory-source"
                        title={`From #${m.source_conversation_name} · ${m.source_author} · ${new Date(m.source_created_at).toLocaleDateString()}`}
                        onClick={() => void onMemorySource(m.source_id)}
                      >
                        From #{m.source_conversation_name} · {m.source_author} ·{' '}
                        {new Date(m.source_created_at).toLocaleDateString()}
                      </button>
                    ) : (
                      <small>Original message unavailable</small>
                    )}
                    <button
                      className="quiet-button"
                      onClick={async () => {
                        try {
                          await api('/memories/' + m.id, { deleted: true }, 'PATCH');
                          setMemories((ms) => ms.filter((x) => x.id !== m.id));
                        } catch (e: any) {
                          setSettingsError(e.message);
                        }
                      }}
                    >
                      Forget
                    </button>
                  </div>
                </div>
              ))}
              {!memories.length && <p>No saved notes yet.</p>}
            </>
          )}
        </div>
      </div>
      {(tab !== 'voice' || dirty || closing) && <footer className="settings-footer">
        <div aria-live="polite">
          {settingsError ? (
            <span className="settings-error" role="alert">
              {settingsError}
            </span>
          ) : closing ? (
            'Save your changes before closing?'
          ) : dirty ? (
            'Unsaved changes'
          ) : (
            status || 'All changes saved'
          )}
          {tab !== 'general' && tab !== 'voice' && !dirty && (
            <small>Preferences in this section save as you go.</small>
          )}
        </div>
        {closing && (
          <button
            type="button"
            className="quiet-button"
            onClick={() => setClosing(false)}
            disabled={saving}
          >
            Keep editing
          </button>
        )}
        {closing && (
          <button type="button" className="secondary" onClick={onClose} disabled={saving}>
            Discard
          </button>
        )}
        <button
          type="button"
          className="primary"
          disabled={!dirty || saving}
          onClick={() => void save()}
        >
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </footer>}
    </Modal>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
