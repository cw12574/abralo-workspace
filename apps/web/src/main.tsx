import React, {
  lazy,
  Suspense,
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  useCallback,
  useMemo,
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
} from 'lucide-react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useVirtualizer } from '@tanstack/react-virtual';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import './style.css';
import { RoomMark, AgentNavigationRow } from './collaboration-ui';
import { SidePanel } from './side-panel';
import { PreviewContext, usePreview, type PreviewItem } from './preview-model';
import './preview.css';
const PreviewViewer = lazy(() => import('./preview-viewer'));
import { api } from './api';
import { ActivityStep } from './activity-step';
import { unlockSound, messageSound } from './sounds';
import { rehypeTextReveal, useStreamingText } from './streaming-text';
import { useFollowConversation } from './follow-conversation';
import {
  conversationCache,
  useConversationPage,
  useConversationComposer,
  type OutgoingMessage,
  type ConversationView,
} from './conversation-cache';
import { useConversationViewport } from './conversation-viewport';
import type { Employee, Message, ProviderInfo } from '../../../packages/contracts/src/index';
const EMPTY_MESSAGES: Message[] = [];
const EMPTY_ITEMS: any[] = [];
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
    workspace_propose_team: 'Propose team',
    workspace_delegate: 'Brief employee',
    workspace_find_memory: 'Search memory',
    workspace_remember: 'Save memory',
    workspace_create_channel: 'Create room',
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
    'archive-channel': Archive,
    'delete-channel': Trash2,
    'delete-agent': Trash2,
    'restore-channel': RotateCcw,
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
    'archive-channel': {
      title: `Archive #${action.name}?`,
      description:
        'The room will leave the active list. Its history stays available, and scheduled work in this room will pause.',
      button: 'Archive room',
    },
    'delete-channel': {
      title: `Delete #${action.name}?`,
      description:
        'This permanently deletes the room, its messages, files, and room history for everyone.',
      button: 'Delete room',
      permanent: true,
    },
    'deactivate-agent': {
      title: `Deactivate ${action.name}?`,
      description:
        'The agent will stop working, and its scheduled runs will pause. Its private conversation and shared room messages will remain. You can reactivate it later.',
      button: 'Deactivate agent',
    },
    'delete-agent': {
      title: `Delete ${action.name}?`,
      description:
        'This stops active work, removes scheduled runs, and permanently deletes the agent and its private conversation. Messages it sent in shared rooms will stay visible.',
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
  const notificationAnchor = useRef<HTMLDivElement>(null);
  const notificationTrigger = useRef<HTMLButtonElement>(null);
  const notificationPanel = useRef<HTMLElement>(null);
  const [inbox, setInbox] = useState<any>({ unread: 0, items: [] });
  const [jump, setJump] = useState<Message | null>(null);
  const [conversationVisit, setConversationVisit] = useState(0);
  const loadInbox = useCallback(() => api('/notifications/inbox').then(setInbox), []);
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
  const notificationPrefs = useRef<any>({ enabled: false, sound: false });
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
      localStorage.getItem('active-view') === 'connections' ? 'connections' : 'chat',
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
    if (modal !== 'inbox') return;
    notificationPanel.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setModal('');
        notificationTrigger.current?.focus();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!notificationAnchor.current?.contains(event.target as Node)) setModal('');
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [modal]);
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
    setWorkspace(w);
    void loadInbox().catch(() => {});
    setSelected((v: string) =>
      w.conversations.some((conversation: any) => conversation.id === v)
        ? v
        : w.conversations.find(
            (conversation: any) => !conversation.archivedAt && !conversation.agentDeactivated,
          )?.id || '',
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
      document.title = 'Agent Workspace';
      return;
    }
    const conversation = workspace.conversations.find((item: any) => item.id === selected);
    const employee = workspace.employees.find(
      (item: Employee) => item.id === conversation?.employeeId,
    );
    const location =
      view === 'connections'
        ? 'Connections'
        : conversation?.kind === 'channel'
          ? `#${conversation.name}`
          : employee?.name || conversation?.name || 'Workspace';
    document.title = `${location} · ${workspace.name || 'Workspace'}`;
  }, [workspace, selected, view]);
  const notificationView = useRef({ selected, thread });
  notificationView.current = { selected, thread };
  useEffect(() => {
    const listener = (event: Event) => conversationCache.event((event as CustomEvent).detail);
    const reconnect = () => conversationCache.reconnect();
    window.addEventListener('workspace-event', listener);
    window.addEventListener('workspace-reconnected', reconnect);
    return () => {
      window.removeEventListener('workspace-event', listener);
      window.removeEventListener('workspace-reconnected', reconnect);
    };
  }, []);
  useEffect(() => {
    if (!workspace) return;
    void api('/notifications')
      .then((v) => (notificationPrefs.current = v.preferences))
      .catch(() => {});
    const es = new EventSource('/api/events?activity=summary&after=' + workspace.cursor);
    es.onopen = () => {
      window.dispatchEvent(new Event('workspace-reconnected'));
    };
    es.onmessage = (e) => {
      const event = JSON.parse(e.data);
      const { selected, thread } = notificationView.current;
      if (['notification.message', 'inbox.changed'].includes(event.type))
        void loadInbox().catch(() => {});
      if (['message.edited', 'message.deleted'].includes(event.type)) {
        void loadInbox().catch(() => {});
        if (thread?.id === event.payload.id) setThread(event.payload);
      }
      if (event.type === 'notifications.preferences') notificationPrefs.current = event.payload;
      window.dispatchEvent(new CustomEvent('workspace-event', { detail: event }));
      if (
        ['workspace.changed', 'message.created', 'message.finished', 'run.changed'].includes(
          event.type,
        )
      )
        void refresh().catch(() => {});
      if (
        event.type === 'notification.message' &&
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
        // OS delivery is owned by server push, so a hidden tab cannot duplicate it.
      }
      if (
        [
          'proposal.created',
          'connection.requested',
          'connection.ready',
          'decision.created',
          'decision.resolved',
        ].includes(event.type)
      )
        setRevision((v) => v + 1);
    };
    return () => es.close();
  }, [workspace?.user?.id]);
  useEffect(() => {
    if (!workspace) return;
    const send = () =>
      void api('/notifications/presence', {
        visible: !document.hidden && document.hasFocus(),
      }).catch(() => {});
    send();
    const timer = setInterval(send, 30000);
    document.addEventListener('visibilitychange', send);
    window.addEventListener('focus', send);
    window.addEventListener('blur', send);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', send);
      window.removeEventListener('focus', send);
      window.removeEventListener('blur', send);
    };
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
      room: item.kind === 'channel',
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
    if (kind === 'restore-channel' || kind === 'reactivate-agent') {
      const endpoint =
        kind === 'restore-channel'
          ? `/channels/${encodeURIComponent(item.id)}/restore`
          : `/employees/${encodeURIComponent(item.id)}/reactivate`;
      void api(endpoint, {}, 'POST')
        .then(() => refresh())
        .catch((e: any) => setError(e.message));
      return;
    }
    setConfirmAction({ kind, ...item });
  };
  const confirmNavigationAction = async () => {
    const { kind, id } = confirmAction;
    if (kind === 'archive-channel')
      await api(`/channels/${encodeURIComponent(id)}/archive`, {}, 'POST');
    else if (kind === 'delete-channel')
      await api(`/channels/${encodeURIComponent(id)}`, {}, 'DELETE');
    else if (kind === 'deactivate-agent')
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
      await api('/notifications/inbox/read', { messageId: message.id });
      await loadInbox();
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
        <RoomMark size={24} />
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
          <div className="nav-title">
            <span>Rooms</span>
            <button className="icon" aria-label="Add room" onClick={() => setModal('channel')}>
              <Plus size={15} />
            </button>
          </div>
          {workspace.conversations
            .filter((c: any) => c.kind === 'channel' && !c.archivedAt)
            .map((c: any) => (
              <div className="nav-item" key={c.id}>
                <button
                  className={`nav-row ${selected === c.id && view === 'chat' ? 'selected' : ''}`}
                  onMouseEnter={() => prefetchConversation(c.id)}
                  onFocus={() => prefetchConversation(c.id)}
                  onMouseLeave={cancelPrefetch}
                  onBlur={cancelPrefetch}
                  onClick={() => choose(c.id)}
                >
                  <RoomMark size={18} name={c.name} />
                  <span>#{c.name}</span>
                  {c.unread > 0 && <b className="badge">{c.unread}</b>}
                </button>
                {workspace.user.role === 'owner' && (
                  <NavigationActions
                    label={`#${c.name}`}
                    actions={
                      c.isTeamChannel
                        ? []
                        : [
                            { id: 'archive-channel', label: 'Archive room' },
                            { id: 'delete-channel', label: 'Delete room…', danger: true },
                          ]
                    }
                    onAction={(id) => requestNavigationAction(id, { id: c.id, name: c.name })}
                  />
                )}
              </div>
            ))}
          <div className="nav-title">
            <span>Employees</span>
            <button className="icon" aria-label="Add employee" onClick={() => setModal('employee')}>
              <Plus size={15} />
            </button>
          </div>
          {workspace.employees.map((e: Employee) => (
            <AgentNavigationRow
              key={e.id}
              employee={e}
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
          ))}
          {((workspace.archivedChannels?.length ?? 0) > 0 ||
            (workspace.inactiveEmployees?.length ?? 0) > 0) && (
            <>
              <div className="nav-title archived-nav-title">
                <span>Archived</span>
              </div>
              {(workspace.archivedChannels ?? []).map((channel: any) => (
                <div className="nav-item archived-nav-item" key={channel.id}>
                  <button
                    className={`nav-row ${selected === channel.id && view === 'chat' ? 'selected' : ''}`}
                    onClick={() => choose(channel.id)}
                    title={`Archived room #${channel.name}`}
                  >
                    <RoomMark size={16} />
                    <span>#{channel.name}</span>
                  </button>
                  {workspace.user.role === 'owner' && (
                    <NavigationActions
                      label={`#${channel.name}`}
                      actions={[
                        { id: 'restore-channel', label: 'Restore room' },
                        { id: 'delete-channel', label: 'Delete room…', danger: true },
                      ]}
                      onAction={(id) =>
                        requestNavigationAction(id, { id: channel.id, name: channel.name })
                      }
                    />
                  )}
                </div>
              ))}
              {(workspace.inactiveEmployees ?? []).map((e: Employee) => (
                <div className="nav-item archived-nav-item employee-row" key={e.id}>
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
            className="icon"
            aria-label="Usage"
            title="Usage"
            onClick={() => setModal('usage')}
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
        <header className="conversation-header">
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
          ) : conversation ? (
            employee || conversation.kind === 'channel' ? (
              <button
                className="conversation-identity"
                aria-label={`${employee?.name || conversation.name} settings`}
                title={`Open ${employee ? 'employee' : 'room'} settings`}
                onClick={() => setModal(employee ? 'edit-employee' : 'channel-info')}
              >
                {conversationIdentity}
              </button>
            ) : (
              <div className="conversation-identity">{conversationIdentity}</div>
            )
          ) : (
            <h1>Workspace</h1>
          )}
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
                        {workspace.conversations.find((c: any) => c.id === m.conversationId)
                          ?.kind === 'channel'
                          ? '#'
                          : ''}
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
          <div className="notification-anchor" ref={notificationAnchor}>
            <button
              ref={notificationTrigger}
              className="icon notification-button"
              aria-label={`Notifications${inbox.unread ? `, ${inbox.unread} unread` : ''}`}
              aria-haspopup="dialog"
              aria-expanded={modal === 'inbox'}
              aria-controls="notification-popover"
              title="Notifications"
              onClick={() => {
                setModal(modal === 'inbox' ? '' : 'inbox');
                void loadInbox().catch((e) => setError(e.message));
              }}
            >
              <Bell size={19} />
              {inbox.unread > 0 && (
                <span className="notification-badge">
                  {inbox.unread > 99 ? '99+' : inbox.unread}
                </span>
              )}
            </button>
            {modal === 'inbox' && (
              <section
                id="notification-popover"
                ref={notificationPanel}
                className="notification-popover"
                role="dialog"
                aria-label="Notifications"
                aria-modal="false"
                tabIndex={-1}
              >
                <header>
                  <h2>Notifications</h2>
                  <button
                    className="icon"
                    aria-label="Close notifications"
                    onClick={() => {
                      setModal('');
                      notificationTrigger.current?.focus();
                    }}
                  >
                    <X size={18} />
                  </button>
                </header>
                <div className="inbox-toolbar">
                  <span>{inbox.unread ? `${inbox.unread} unread` : 'You’re caught up.'}</span>
                  {inbox.unread > 0 && (
                    <button
                      className="quiet-button"
                      onClick={async () => {
                        try {
                          await api('/notifications/inbox/read', { all: true });
                          await loadInbox();
                        } catch (e: any) {
                          setError(e.message);
                        }
                      }}
                    >
                      Mark all read
                    </button>
                  )}
                </div>
                {!inbox.items.length && (
                  <p className="muted">
                    Direct messages, mentions and replies to your threads will appear here.
                  </p>
                )}
                <div className="notification-list">
                  {inbox.items.map((item: any) => (
                    <button
                      key={item.id}
                      className={`notification-item ${item.seen ? '' : 'unread'}`}
                      onClick={() => void openNotification(item)}
                    >
                      <Avatar id={item.authorId} name={item.authorName} />
                      <span>
                        <strong>{item.authorName}</strong>
                        <small>
                          {item.conversationKind === 'channel' ? '#' : ''}
                          {item.conversationName}
                          {item.threadId ? ' · Thread reply' : ' · Message'} ·{' '}
                          {new Date(item.createdAt).toLocaleString()}
                        </small>
                        <span>{item.text.slice(0, 200)}</span>
                      </span>
                      {!item.seen && <i className="unread-dot" />}
                    </button>
                  ))}
                </div>
              </section>
            )}
          </div>
        </header>
        {error && (
          <div className="error-bar" role="alert">
            {error}
            <button className="icon" aria-label="Dismiss error" onClick={() => setError('')}>
              <X size={16} />
            </button>
          </div>
        )}
        {view === 'connections' ? (
          <Connections revision={revision} fail={setError} />
        ) : conversation ? (
          <PreviewContext.Provider value={openPreview}>
            <div className="conversation-columns">
              <Chat
                key={`${selected}:${conversationVisit}`}
                focusMessage={!jump?.threadId ? jump : null}
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
                revision={revision}
                readOnly={!!conversation.archivedAt || !!conversation.agentDeactivated}
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
                          readOnly={!!conversation?.archivedAt || !!conversation?.agentDeactivated}
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
            <p>Add an employee or create a room to begin.</p>
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
      {modal === 'channel' && (
        <CreateChannel
          workspace={workspace}
          onClose={() => setModal('')}
          onCreated={async (id: string) => {
            await refresh();
            choose(id);
            setModal('');
          }}
        />
      )}
      {modal === 'channel-info' && conversation?.kind === 'channel' && (
        <ChannelSettings
          conversation={conversation}
          workspace={workspace}
          onClose={() => setModal('')}
          refresh={refresh}
        />
      )}
      {modal === 'usage' && <Usage providers={providers} onClose={() => setModal('')} />}
      {modal === 'settings' && (
        <SettingsPanel
          workspace={workspace}
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
          <RoomMark size={42} name={invite ? 'Join' : 'Welcome'} />
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
  const [step, setStep] = useState(0),
    [name] = useState('Chief of Staff'),
    [harness, setHarness] = useState('codex'),
    [model, setModel] = useState(''),
    [objectives, setObjectives] = useState(['']),
    [objectiveError, setObjectiveError] = useState(''),
    [userName, setUserName] = useState(
      initialUserName && initialUserName !== 'You' ? initialUserName : '',
    ),
    [busy, setBusy] = useState(false),
    [login, setLogin] = useState<any>(null);
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
            <RoomMark size={40} name="Welcome" />
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
                <ProviderLogin harness={harness} fail={fail} />
              )}
              <button
                className="quiet-button"
                disabled={checking}
                onClick={async () => {
                  setChecking(true);
                  setChecked(false);
                  try {
                    await refreshProviders(harness);
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
          <div className="onboarding-room-sketch">
            <RoomMark size={144} name="Welcome" />
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
          <span className="caption">Room for a little ambition.</span>
        </div>
      </div>
    </main>
  );
}
function ChannelStart({ conversation }: { conversation: { id: string; name: string } }) {
  const [purpose, setPurpose] = useState('');
  useEffect(() => {
    let live = true;
    void api('/channels/' + encodeURIComponent(conversation.id))
      .then((channel) => {
        if (live) setPurpose(channel.purpose || '');
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [conversation]);
  return (
    <div className="conversation-start ui-stack">
      <span className="channel-start-icon" aria-hidden="true">
        <RoomMark size={28} />
      </span>
      <div className="ui-field">
        <h2>{conversation.name}</h2>
        <p>{purpose || 'A shared space for your team to plan, discuss and work together.'}</p>
      </div>
      <p className="channel-start-hint">
        Write the first message, or use <span className="entity-mention">@</span> to bring an agent
        into the conversation.
      </p>
    </div>
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
  revision,
  focusMessage,
  restoreViewport = false,
  readOnly = false,
}: any) {
  const openPreview = usePreview();
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const channel = !threadId && conversations.find((c: any) => c.id === id && c.kind === 'channel');
  const messagePeople = useMemo(
    () => [...employees.map((e: any) => e.name), user.name],
    [employees, user.name],
  );
  const messageChannels = useMemo(
    () => conversations.filter((c: any) => c.kind === 'channel'),
    [conversations],
  );
  const baseView: ConversationView = {
    id,
    threadId,
    employeeId: !threadId ? employee?.id : undefined,
    room: !!channel,
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
    [id, threadId, employee?.id, !!channel, historyBefore],
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
  const [mention, setMention] = useState<{
    start: number;
    end: number;
    query: string;
    kind: 'employee' | 'room';
  } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [proposals, setProposals] = useState<any[]>([]);
  const [connections, setConnections] = useState<any[]>([]);
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
  }, [id, revision]);
  const confirmedKeys = new Set(messages.map((m) => m.clientKey));
  const pending = outgoing.filter((item) => !confirmedKeys.has(item.message.clientKey));
  const visibleMessages = [...messages, ...pending.map((item) => item.message)];
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
  useEffect(() => {
    if (!messages.length || document.hidden || !following.current) return;
    const last = messages.at(-1)!;
    void api(`/conversations/${id}/read`, { seq: last.seq, agentView: !!employee })
      .then(() => onRead?.())
      .catch(() => {});
  }, [messages.length, id]);
  const active = runs.filter(
    (r) => !['completed', 'failed', 'cancelled', 'interrupted'].includes(r.state),
  );
  const activeWork =
    employee && active.find((r) => r.user_id === user.id && r.conversation_id !== id);
  const replyWork = draftWork || (!draft && !files.length ? activeWork : null);
  const mentionCandidates: { kind: 'employee' | 'room'; item: any }[] =
    mention?.kind === 'employee'
      ? employee
        ? []
        : employees.map((item: Employee) => ({ kind: 'employee', item }))
      : mention?.kind === 'room'
        ? conversations
            .filter((item: any) => item.kind === 'channel' && !item.archivedAt)
            .map((item: any) => ({ kind: 'room', item }))
        : [];
  const mentionMatches = mention
    ? mentionCandidates
        .filter(({ item }) => item.name.toLocaleLowerCase().includes(mention.query))
        .sort((a, b) => {
          const aStarts = a.item.name.toLocaleLowerCase().startsWith(mention.query);
          const bStarts = b.item.name.toLocaleLowerCase().startsWith(mention.query);
          return Number(bStarts) - Number(aStarts) || a.item.name.localeCompare(b.item.name);
        })
        .slice(0, 8)
    : [];
  function chooseMention(kind: 'employee' | 'room', name: string) {
    if (!mention) return;
    const input = composerInput.current;
    const inserted = `${kind === 'employee' ? '@' : '#'}${name} `;
    const next = draft.slice(0, mention.start) + inserted + draft.slice(mention.end);
    const caret = mention.start + inserted.length;
    setDraft(next);
    setMention(null);
    setMentionIndex(0);
    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(caret, caret);
    });
  }
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
    setMention(null);
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
      <div className="message-scroll" ref={scroll} onScroll={handleConversationScroll}>
        {readOnly && (
          <div className="conversation-archived-notice">
            {channel?.archivedAt
              ? 'Archived room · restore it from the sidebar to resume conversation.'
              : 'This agent is deactivated. Reactivate it from the sidebar to continue.'}
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
        {!visibleMessages.length &&
          !!history.data &&
          (channel ? (
            <ChannelStart conversation={channel} />
          ) : (
            <div className="conversation-start ui-stack">
              {employee && <Avatar id={employee.id} name={employee.name} size={48} />}
              <h2>{employee ? employee.name : 'Start a conversation'}</h2>
              <p>
                {employee
                  ? 'Ask a question or give them something to work on.'
                  : 'Mention an employee by name to bring them into the work.'}
              </p>
            </div>
          ))}
        <div style={{ height: virtual.getTotalSize(), position: 'relative', width: '100%' }}>
          {virtual.getVirtualItems().map((item) => {
            const m = visibleMessages[item.index],
              run = runs.find((r) => r.id === m.runId);
            const originConversation = conversations.find(
              (entry: any) => entry.id === m.conversationId,
            );
            const originLabel =
              employee &&
              m.kind === 'agent' &&
              m.conversationId !== id &&
              originConversation?.kind === 'channel'
                ? `#${originConversation.name}`
                : undefined;
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
                  channels={messageChannels}
                  onOpenConversation={onOpenConversation}
                />
              </div>
            );
          })}
        </div>
        <div className="conversation-actions">
          {employee &&
            runs.some((r) => r.error && /auth|sign.in|login|credential/i.test(r.error)) && (
              <ProviderLogin harness={employee.harness} fail={fail} />
            )}
          {proposals.map((p) => (
            <div className="proposal inline-card" key={p.id}>
              <div className="proposal-heading">
                <div>
                  <div className="eyebrow">TEAM & PROJECT ROOMS</div>
                  <p>
                    {p.rooms?.length
                      ? `Shared team room plus ${p.rooms.length} project ${p.rooms.length === 1 ? 'room' : 'rooms'}, with agents assigned to each.`
                      : 'A small team, shaped around the work you described.'}
                  </p>
                </div>
                <span className="proposal-count">
                  {p.employees.length} {p.employees.length === 1 ? 'agent' : 'agents'}
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
              {!!p.rooms?.length && (
                <section className="proposal-rooms" aria-label="Project rooms">
                  <span className="proposal-section-label">PROJECT ROOMS</span>
                  {p.rooms.map((room: any, roomIndex: number) => (
                    <div className="proposal-room" key={roomIndex}>
                      <RoomMark name={room.name} size={18} />
                      <span>
                        <strong>{room.name}</strong>
                        <small>
                          {room.employeeIndexes
                            .map((index: number) => p.employees[index]?.name)
                            .filter(Boolean)
                            .join(' · ')
                            ? [
                                employee?.name || 'Chief of Staff',
                                ...room.employeeIndexes
                                  .map((index: number) => p.employees[index]?.name)
                                  .filter(Boolean),
                              ].join(' · ')
                            : employee?.name || 'Chief of Staff'}
                        </small>
                      </span>
                    </div>
                  ))}
                </section>
              )}
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
                {p.rooms?.length
                  ? `Create team · ${p.rooms.length} project ${p.rooms.length === 1 ? 'room' : 'rooms'}`
                  : 'Create this team'}
              </button>
              <small>Want to adjust it? Reply to your Chief of Staff.</small>
            </div>
          ))}
          {decisions.map((d) => (
            <Decision key={d.id} decision={d} fail={fail} />
          ))}
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
                  aria-selected={mentionIndex === 0}
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
                    aria-selected={optionIndex === mentionIndex}
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
          {mentionMatches.length > 0 && (
            <div
              className="mention-menu"
              role="listbox"
              aria-label={mention?.kind === 'room' ? 'Choose a room' : 'Choose an agent'}
            >
              {mentionMatches.map(({ kind, item }, index) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={index === mentionIndex}
                  id={`mention-option-${index}`}
                  className="mention-option"
                  key={item.id}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => chooseMention(kind, item.name)}
                >
                  {kind === 'room' ? (
                    <RoomMark size={28} name={item.name} />
                  ) : (
                    <Avatar id={item.id} name={item.name} human={item.kind === 'human'} size={28} />
                  )}
                  <span className="mention-option-copy">
                    <strong>{kind === 'room' ? `#${item.name}` : item.name}</strong>
                    {kind === 'employee' && item.role && <small>{item.role}</small>}
                  </span>
                  <span className="mention-suggestion-kind">
                    {kind === 'room' ? 'Room' : 'Agent'}
                  </span>
                </button>
              ))}
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
                    : 'Message this room…'
              }
              onChange={(e) => {
                const value = e.target.value;
                const beforeCaret = value.slice(0, e.target.selectionStart);
                const slashMatch = beforeCaret.match(/(?:^|\s)\/([^\s/]*)$/);
                const match = value
                  .slice(0, e.target.selectionStart)
                  .match(/(?:^|\s)([@#])([^\s@#]*)$/);
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
                setMention(
                  match
                    ? {
                        start: e.target.selectionStart - match[2].length - 1,
                        end: e.target.selectionStart,
                        query: match[2].toLocaleLowerCase(),
                        kind: match[1] === '@' ? 'employee' : 'room',
                      }
                    : null,
                );
                setMentionIndex(0);
              }}
              onKeyDown={(e) => {
                if (modelMenuOpen && modelQuery) {
                  const optionCount = matchingModelChoices.length + (modelQuery.query ? 0 : 1);
                  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && optionCount > 0) {
                    e.preventDefault();
                    setMentionIndex(
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
                    if (!defaultCount && mentionIndex === 0) {
                      const first = matchingModelChoices[0];
                      chooseModel(first.provider.harness, first.model.id);
                    } else if (defaultCount && mentionIndex === 0) chooseModel(null, null);
                    else {
                      const choice =
                        matchingModelChoices[mentionIndex - defaultCount] ||
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
                if (mentionMatches.length > 0 && mention) {
                  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    setMentionIndex(
                      (i) =>
                        (i + (e.key === 'ArrowDown' ? 1 : -1) + mentionMatches.length) %
                        mentionMatches.length,
                    );
                    return;
                  }
                  if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
                    if (!e.nativeEvent.isComposing) {
                      e.preventDefault();
                      const selected = mentionMatches[mentionIndex] || mentionMatches[0];
                      chooseMention(selected.kind, selected.item.name);
                      return;
                    }
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    setMention(null);
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
                              ? employee.model || 'Use the provider default'
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
function remarkWorkspaceEntities(options: { people: string[]; channels: any[] }) {
  type Entity = { label: string; type: 'person' | 'channel'; id?: string };
  const entities: Entity[] = [
    ...options.people
      .filter(Boolean)
      .map((name): Entity => ({ label: '@' + name, type: 'person' })),
    ...options.channels.map(
      (channel): Entity => ({
        label: '#' + channel.name,
        type: 'channel',
        id: channel.id,
      }),
    ),
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
            url:
              entity.type === 'person'
                ? 'workspace-person:' + encodeURIComponent(label)
                : 'workspace-channel:' + entity.id,
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
  channels = [],
  onOpenConversation,
}: any) {
  const openPreview = usePreview();
  const [expanded, setExpanded] = useState(false);
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
    () => [remarkGfm, [remarkWorkspaceEntities, { people, channels }]],
    [people, channels],
  );
  const activities = m.activity || [];
  const orderedActivities = useMemo(
    () =>
      [...activities].sort(
        (a: any, b: any) => Date.parse(a.time) - Date.parse(b.time) || a.id.localeCompare(b.id),
      ),
    [activities],
  );
  const lastActivity = orderedActivities.at(-1);
  const textTime = Date.parse(m.textUpdatedAt || m.createdAt);
  const activitiesBeforeText = orderedActivities.filter((activity: any) => {
    const time = Date.parse(activity.time);
    return m.text && Number.isFinite(textTime) && Number.isFinite(time) && time < textTime;
  });
  const activitiesAfterText = orderedActivities.filter(
    (activity: any) => !activitiesBeforeText.includes(activity),
  );
  const working =
    m.kind === 'agent' && run && ['accepted', 'dispatching', 'running'].includes(run.state);
  const streaming = m.kind === 'agent' && run && ['dispatching', 'running'].includes(run.state);
  const revealed = useStreamingText(m.text || '', !!streaming);
  const showRunStatus =
    run &&
    run.state !== 'completed' &&
    (!orderedActivities.length || !['accepted', 'dispatching', 'running'].includes(run.state));
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
  const renderActivityTrail = (items: any[]) => {
    if (!items.length) return null;
    const latest = items.at(-1);
    return (
      <section className="tool-group" aria-label="Agent activity">
        <button
          className="tool-summary"
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Hide' : 'Show'} activity timeline${working ? ', agent is working' : ', latest update'}`}
          onClick={() => setExpanded(!expanded)}
        >
          <span className={`toolchain-mark ${working ? 'is-live' : ''}`} aria-hidden="true" />
          <span className={`tool-summary-state ${working ? 'is-live' : ''}`}>
            {working ? 'Working' : 'Done'}
          </span>
          <span className="tool-summary-latest">{activityTitle(latest.title)}</span>
          <time>{activityTimeLabel(latest.updatedAt || latest.time)}</time>
          <ChevronRight size={13} className={expanded ? 'rotated' : ''} aria-hidden="true" />
        </button>
        {expanded && (
          <ol className="toolchain-list">
            {items.map((a: any) => (
              <ActivityStep
                key={a.id}
                activity={a}
                messageId={m.id}
                title={activityTitle(a.title)}
                time={activityTimeLabel(a.updatedAt || a.time)}
              />
            ))}
          </ol>
        )}
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
            {renderActivityTrail(activitiesBeforeText)}
            {m.text && (
              <div className={'prose' + (streaming ? ' prose-streaming' : '')}>
                <ReactMarkdown
                  remarkPlugins={markdownPlugins as any}
                  rehypePlugins={[
                    [rehypeTextReveal, { source: revealed.text, reveals: revealed.reveals }],
                  ]}
                  urlTransform={(url) =>
                    url.startsWith('workspace-person:') || url.startsWith('workspace-channel:')
                      ? url
                      : defaultUrlTransform(url)
                  }
                  components={{
                    a: ({ children, href, ...p }) => {
                      if (href?.startsWith('workspace-person:'))
                        return <span className="entity-mention">{children}</span>;
                      if (href?.startsWith('workspace-channel:')) {
                        const channelId = href.slice('workspace-channel:'.length);
                        return (
                          <button
                            type="button"
                            className="entity-channel"
                            onClick={() => onOpenConversation?.(channelId)}
                          >
                            {children}
                          </button>
                        );
                      }
                      return (
                        <a
                          href={href}
                          {...p}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(event) => {
                            const id = href?.match(/^\/api\/attachments\/([^/?#]+)(?:\?.*)?$/)?.[1];
                            const file = attachments.find((entry: any) => entry.id === id);
                            if (
                              !file ||
                              event.ctrlKey ||
                              event.metaKey ||
                              event.shiftKey ||
                              event.altKey
                            )
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
                  {revealed.text}
                </ReactMarkdown>
              </div>
            )}
            {renderActivityTrail(activitiesAfterText)}
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
              : 'Allow this action'}
        </button>
      </div>
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
    [harness, setHarness] = useState('codex'),
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
                {Object.entries(names).map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Model
              <select name="model">
                <option value="">Provider default</option>
                {providers
                  .find((p: any) => p.harness === harness)
                  ?.models?.filter((m: any) => m.id)
                  .map((m: any) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Instructions
              <textarea name="instructions" rows={3} placeholder="How should this employee work?" />
            </label>
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
function ChannelSettings({ conversation, workspace: w, onClose, refresh }: any) {
  const [channel, setChannel] = useState<any>(null);
  const [name, setName] = useState(conversation.name);
  const [purpose, setPurpose] = useState('');
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [confirmClose, setConfirmClose] = useState(false);
  const loadChannel = async () => {
    const result = await api('/channels/' + encodeURIComponent(conversation.id));
    setChannel(result);
    setName(result.name);
    setPurpose(result.purpose || '');
  };
  useEffect(() => {
    void loadChannel().catch((e: any) => setError(e.message));
  }, [conversation.id]);
  const currentIds = new Set([
    ...(channel?.humans || []).map((h: any) => h.id),
    ...(channel?.employees || []).map((e: any) => e.id),
  ]);
  const candidates = [
    ...w.employees
      .filter((e: any) => !currentIds.has(e.id))
      .map((e: any) => ({ ...e, type: 'agent', detail: e.role || names[e.harness] })),
    ...w.humans
      .filter((h: any) => !currentIds.has(h.id))
      .map((h: any) => ({ ...h, type: 'human', detail: 'Person' })),
  ].filter((person: any) =>
    (person.name + ' ' + person.detail).toLowerCase().includes(query.trim().toLowerCase()),
  );
  const members = [
    ...(channel?.humans || []).map((h: any) => ({ ...h, type: 'human', detail: 'Person' })),
    ...(channel?.employees || []).map((e: any) => ({
      ...e,
      type: 'agent',
      detail: e.role || names[e.harness],
    })),
  ].sort((a: any, b: any) => a.name.localeCompare(b.name));
  const dirty =
    !!channel &&
    (name.trim().replace(/^#/, '') !== channel.name || purpose.trim() !== (channel.purpose || ''));
  const close = () => {
    if (busy) return;
    if (dirty) setConfirmClose(true);
    else onClose();
  };
  async function saveDetails() {
    setBusy(true);
    setError('');
    setStatus('');
    try {
      await api(
        '/channels/' + encodeURIComponent(conversation.id),
        {
          name: name.trim().replace(/^#/, ''),
          purpose: purpose.trim(),
        },
        'PATCH',
      );
      await Promise.all([loadChannel(), refresh()]);
      setConfirmClose(false);
      setStatus('Room details saved.');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function updateMembers(change: any) {
    setBusy(true);
    setError('');
    setStatus('');
    try {
      await api('/channels/' + encodeURIComponent(conversation.id), change, 'PATCH');
      setSelected([]);
      setQuery('');
      setAdding(false);
      await Promise.all([loadChannel(), refresh()]);
      setStatus('Room members updated.');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Room settings" onClose={close} className="channel-settings-dialog">
      <div className="channel-settings-body">
        {!channel ? (
          <p className="muted">Loading room…</p>
        ) : (
          <>
            <section className="channel-settings-section">
              <div className="channel-settings-heading member-settings-heading">
                <div>
                  <h3>People</h3>
                  <p>
                    {members.length} {members.length === 1 ? 'member' : 'members'} in #
                    {channel.name}
                  </p>
                </div>
                <button className="secondary" disabled={busy} onClick={() => setAdding(!adding)}>
                  <Plus size={15} />
                  {adding ? 'Done' : 'Add people'}
                </button>
              </div>
              {adding && (
                <div className="channel-add-members">
                  <input
                    type="search"
                    aria-label="Find people to add"
                    placeholder="Search people or agents…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  <div className="channel-member-list">
                    {candidates.map((person: any) => (
                      <label className="channel-member" key={person.id}>
                        <input
                          type="checkbox"
                          checked={selected.includes(person.id)}
                          onChange={(e) =>
                            setSelected((ids) =>
                              e.target.checked
                                ? [...ids, person.id]
                                : ids.filter((id) => id !== person.id),
                            )
                          }
                        />
                        <Avatar id={person.id} name={person.name} human={person.type === 'human'} />
                        <span>
                          <strong>{person.name}</strong>
                          <small>{person.detail}</small>
                        </span>
                        <span className="member-kind">
                          {person.type === 'agent' ? 'Agent' : 'Person'}
                        </span>
                      </label>
                    ))}
                    {!candidates.length && <p className="caption">No one else to add.</p>}
                  </div>
                  {selected.length > 0 && (
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={() =>
                        void updateMembers({
                          addHumans: selected.filter((id) =>
                            w.humans.some((h: any) => h.id === id),
                          ),
                          addEmployees: selected.filter((id) =>
                            w.employees.some((e: any) => e.id === id),
                          ),
                        })
                      }
                    >
                      Add {selected.length} {selected.length === 1 ? 'person' : 'people'}
                    </button>
                  )}
                </div>
              )}
              <div className="channel-roster">
                {members.map((member: any) => (
                  <div className="channel-roster-row" key={member.id}>
                    <Avatar
                      id={member.id}
                      name={member.name}
                      human={member.type === 'human'}
                      size={34}
                    />
                    <span className="channel-roster-name">
                      <strong>{member.name}</strong>
                      <small>{member.id === w.user.id ? 'You' : member.detail}</small>
                    </span>
                    <span className="member-kind">
                      {member.type === 'agent' ? 'Agent' : 'Person'}
                    </span>
                    {member.id !== w.user.id && (
                      <button
                        className="quiet-button channel-remove-member"
                        aria-label={`Remove ${member.name} from room`}
                        disabled={busy || (member.type === 'human' && channel.humans.length <= 1)}
                        onClick={() =>
                          void updateMembers(
                            member.type === 'human'
                              ? { removeHumans: [member.id] }
                              : { removeEmployees: [member.id] },
                          )
                        }
                      >
                        Remove
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </section>
            <section className="channel-settings-section channel-details-section">
              <div className="channel-settings-heading">
                <div className="channel-mark">
                  <RoomMark size={17} />
                </div>
                <div>
                  <h3>Room details</h3>
                </div>
              </div>
              <label>
                Room name
                <div className="channel-name-input">
                  <RoomMark size={17} />
                  <input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
                </div>
              </label>
              <label>
                Purpose <span className="optional-label">Optional</span>
                <textarea
                  rows={2}
                  maxLength={500}
                  placeholder="What belongs in this room?"
                  value={purpose}
                  onChange={(e) => setPurpose(e.target.value)}
                />
              </label>
              <div className="channel-detail-actions">
                <button
                  className="primary"
                  disabled={!dirty || busy}
                  onClick={() => void saveDetails()}
                >
                  {busy && dirty ? 'Saving…' : 'Save details'}
                </button>
              </div>
            </section>
          </>
        )}
      </div>
      <footer className="channel-settings-footer">
        <span className={error ? 'settings-error' : 'quiet'} role={error ? 'alert' : 'status'}>
          {error || (confirmClose ? 'Unsaved room details' : status)}
        </span>
        {confirmClose ? (
          <>
            <button className="quiet-button" onClick={() => setConfirmClose(false)}>
              Keep editing
            </button>
            <button className="secondary" onClick={onClose}>
              Discard
            </button>
          </>
        ) : (
          <button className="secondary" onClick={close}>
            Done
          </button>
        )}
      </footer>
    </Modal>
  );
}

function CreateChannel({ workspace: w, onClose, onCreated }: any) {
  const [name, setName] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const people = [
    ...w.employees.map((e: any) => ({ ...e, type: 'agent', detail: e.role || names[e.harness] })),
    ...w.humans
      .filter((h: any) => h.id !== w.user.id)
      .map((h: any) => ({ ...h, type: 'human', detail: 'Person' })),
  ];
  const filtered = people.filter((p: any) =>
    (p.name + ' ' + p.detail).toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <Modal
      title="Create a room"
      onClose={() => {
        if (!busy) onClose();
      }}
      className="create-channel-dialog"
    >
      <form
        id="create-channel"
        className="channel-create-body"
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy) return;
          setBusy(true);
          setError('');
          try {
            const result = await api('/channels', {
              name: name.trim().replace(/^#/, ''),
              members: selected.filter((id) => w.humans.some((h: any) => h.id === id)),
              employees: selected.filter((id) => w.employees.some((a: any) => a.id === id)),
            });
            await onCreated(result.id);
          } catch (e: any) {
            setError(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="channel-name-label">
          Room name
          <div className="channel-name-input">
            <RoomMark size={17} />
            <input
              autoFocus
              name="name"
              required
              maxLength={80}
              placeholder="project-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
        </label>
        <div className="channel-member-heading">
          <h3>Members</h3>
          <span>{selected.length + 1} selected</span>
        </div>
        <div className="channel-self">
          <Avatar id={w.user.id} name={w.user.name} />
          <span>
            {w.user.name}
            <small>You · included</small>
          </span>
          <Check size={16} />
        </div>
        {people.length > 0 && (
          <input
            type="search"
            aria-label="Find members"
            placeholder="Find agents or people…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        )}
        <div className="channel-member-list">
          {filtered.map((p: any) => (
            <label key={p.id} className="channel-member">
              <input
                type="checkbox"
                checked={selected.includes(p.id)}
                onChange={(e) =>
                  setSelected((ids) =>
                    e.target.checked ? [...ids, p.id] : ids.filter((id) => id !== p.id),
                  )
                }
              />
              <Avatar id={p.id} name={p.name} />
              <span>
                <strong>{p.name}</strong>
                <small>{p.detail}</small>
              </span>
              <span className="member-kind">{p.type === 'agent' ? 'Agent' : 'Person'}</span>
            </label>
          ))}
          {!filtered.length && (
            <p className="caption">
              {people.length
                ? 'No matching members.'
                : 'No other members yet. You can create the room now.'}
            </p>
          )}
        </div>
      </form>
      <footer className="channel-create-footer">
        <span role="alert" className="settings-error">
          {error}
        </span>
        <button type="button" className="secondary" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button
          type="submit"
          form="create-channel"
          className="primary"
          disabled={busy || !name.trim().replace(/^#/, '').trim()}
        >
          {busy ? 'Creating…' : 'Create room'}
        </button>
      </footer>
    </Modal>
  );
}
function EditEmployee({ employee: e, humans, onClose, done, onManage }: any) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [grants, setGrants] = useState<string[]>([]);
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
          const data = Object.fromEntries(new FormData(event.currentTarget));
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
          Model
          <input name="model" defaultValue={e.model} placeholder="Provider default" />
        </label>
        <label>
          Instructions
          <textarea name="instructions" defaultValue={e.instructions} rows={5} />
        </label>
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
function ProviderLogin({ harness, fail, provider, checking, refresh }: any) {
  const [info, setInfo] = useState<any>(null),
    [method, setMethod] = useState<any>(null),
    [authorization, setAuthorization] = useState<any>(null);
  const connected = provider?.authenticated === true;
  const unknown = provider?.authenticated == null;
  const unavailable = provider?.installed === false;
  async function refreshStatus() {
    try {
      await refresh(harness === 'opencode' ? harness : undefined);
    } catch (e: any) {
      fail(e.message);
    }
  }
  return (
    <div className="inline-card ui-stack account-card">
      <div className="account-card-heading">
        <strong>{names[harness]} account</strong>
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
      <p className="quiet account-detail">
        {provider?.detail ||
          (unknown
            ? 'Check this account to see whether it is signed in.'
            : 'Sign in with the provider on this host. Credentials stay out of the conversation.')}
      </p>
      <div className="account-card-actions">
        {!connected && !unavailable && (
          <button
            className="secondary"
            disabled={checking}
            onClick={async () => {
              try {
                setInfo(await api(`/providers/${harness}/login`, {}));
                await refreshStatus();
              } catch (e: any) {
                fail(e.message);
              }
            }}
          >
            {unknown ? 'Sign in' : 'Sign in'}
          </button>
        )}
        <button className="quiet-button" disabled={checking} onClick={refreshStatus}>
          {checking ? 'Checking…' : unknown ? 'Check status' : 'Refresh'}
        </button>
      </div>
      {info?.message && <p>{info.message}</p>}
      {info?.userCode && <code>{info.userCode}</code>}
      {(info?.authUrl || info?.verificationUrl) && (
        <a target="_blank" rel="noreferrer" href={info.authUrl || info.verificationUrl}>
          Open provider sign-in
        </a>
      )}
      {harness === 'claude' && info && (
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
            If the provider gives you a code
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
function ConnectionRow({ connection: c, fail }: any) {
  const [detail, setDetail] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (detail) card.current?.scrollIntoView({ block: 'nearest' });
  }, [detail]);
  return (
    <div ref={card} className="inline-card connection-row">
      <div className="connection-heading">
        {c.service === 'railway' ? (
          <img className="service-logo" src="/brands/railway.svg" alt="" />
        ) : (
          <Plug size={18} />
        )}
        <strong>
          {c.label && c.label !== c.service ? c.label : serviceNames[c.service] || c.service}
        </strong>
        <span className="quiet">
          {c.state === 'ready'
            ? 'Connected'
            : c.state.replaceAll('_', ' ').replace(/^./, (v: string) => v.toUpperCase())}
        </span>
      </div>
      {detail && <p>{detail.message || detail.error}</p>}
      {c.data?.reuseId && (
        <button
          className="primary"
          onClick={async () => {
            try {
              setDetail(await api(`/connections/${c.id}/reuse`, {}));
            } catch (e: any) {
              fail(e.message);
            }
          }}
        >
          Use existing connection · {c.data.accountLabel} ·{' '}
          {c.data.requestedWrite ? 'allow reads and writes' : 'read only'}
        </button>
      )}
      {detail?.requiresConfiguration === 'google-oauth' && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            try {
              setDetail(
                await api(`/connections/${c.id}/google-client`, {
                  id: f.get('client'),
                  secret: f.get('secret'),
                  write: f.get('write') === 'on',
                }),
              );
            } catch (e: any) {
              fail(e.message);
            }
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
      {detail?.url && (
        <a className="connection-signin" href={detail.url} target="_blank" rel="noreferrer">
          Continue sign-in <ExternalLink size={14} />
        </a>
      )}
      <button
        className="secondary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            setDetail(await api(`/connections/${c.id}/connect`, {}));
          } catch (e: any) {
            fail(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy
          ? 'Connecting…'
          : c.state === 'ready'
            ? 'Check connection'
            : detail?.url
              ? 'Check sign-in'
              : 'Connect'}
      </button>
      {c.state === 'ready' && (
        <button
          className="quiet-button"
          onClick={async () => {
            try {
              await api(`/connections/${c.id}`, undefined, 'DELETE');
              setDetail({ message: 'Disconnected. Employee grants have been removed.' });
            } catch (e: any) {
              fail(e.message);
            }
          }}
        >
          Disconnect
        </button>
      )}
    </div>
  );
}
function Connections({ revision, fail }: any) {
  const [items, setItems] = useState<any[]>([]);
  useEffect(() => {
    api('/connections')
      .then(setItems)
      .catch((e: any) => fail(e.message));
  }, [revision]);
  return (
    <section className="settings-content">
      <h2>Connected accounts</h2>
      <p className="quiet">
        Ask any employee to connect a service. Existing accounts can be shared with another employee
        when you choose.
      </p>
      {items.length ? (
        items.map((c) => <ConnectionRow key={c.id} connection={c} fail={fail} />)
      ) : (
        <div className="empty-card">
          <Plug size={24} />
          <p>“Connect Railway, Stripe and Gmail.”</p>
          <span className="quiet">Start with a message. Setup stays in the conversation.</span>
        </div>
      )}
    </section>
  );
}
const usageChartColors = [
  '#8c9eff',
  '#56b6a8',
  '#e6a45e',
  '#d9829a',
  '#b7a0e8',
  '#83b7dc',
  '#d2c66d',
  '#a5b887',
];

function UsageSparkline({ samples }: { samples: { at: number; used: number }[] }) {
  if (!samples || samples.length < 2) return null;
  const values = samples.slice(-60);
  const points = values
    .map((sample, i) => `${(i / (values.length - 1)) * 114 + 3},${3 + sample.used * 0.22}`)
    .join(' ');
  return (
    <div className="usage-trend">
      <svg viewBox="0 0 120 28" role="img" aria-label="Allowance remaining over the past hour">
        <line x1="3" y1="25" x2="117" y2="25" />
        <polyline points={points} />
      </svg>
      <span>Allowance · 1h</span>
    </div>
  );
}

function EmployeeUsageChart({ totals }: { totals: Record<string, number> }) {
  const employees = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  const total = employees.reduce((sum, [, count]) => sum + count, 0);
  const radius = 40;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  return (
    <div className="employee-usage-chart">
      <svg
        className="employee-usage-donut"
        viewBox="0 0 100 100"
        role="img"
        aria-label={`Employee token usage shares, ${total.toLocaleString()} tokens total`}
      >
        <circle className="employee-usage-track" cx="50" cy="50" r={radius} />
        {employees.map(([name, count], i) => {
          const length = total ? (count / total) * circumference : 0;
          const segment = (
            <circle
              key={name}
              className="employee-usage-segment"
              cx="50"
              cy="50"
              r={radius}
              stroke={usageChartColors[i % usageChartColors.length]}
              strokeDasharray={`${length} ${circumference - length}`}
              strokeDashoffset={-offset}
            />
          );
          offset += length;
          return segment;
        })}
        <text className="employee-usage-total" x="50" y="48">
          {total >= 1_000_000
            ? `${(total / 1_000_000).toFixed(1)}m`
            : `${Math.round(total / 1000)}k`}
        </text>
        <text className="employee-usage-unit" x="50" y="59">
          tokens
        </text>
      </svg>
      <div className="employee-usage-legend">
        {employees.map(([name, count], i) => (
          <div className="employee-usage-row" key={name}>
            <span
              className="employee-usage-swatch"
              style={{ backgroundColor: usageChartColors[i % usageChartColors.length] }}
              aria-hidden="true"
            />
            <span className="employee-usage-name" title={name}>
              {name}
            </span>
            <span className="employee-usage-share">
              {total && count > 0 && count / total < 0.005
                ? '<1%'
                : `${total ? Math.round((count / total) * 100) : 0}%`}
            </span>
            <code>{count.toLocaleString()}</code>
          </div>
        ))}
      </div>
    </div>
  );
}

function Usage({ providers, onClose }: any) {
  const [data, setData] = useState<any>({ runs: [] });
  const [accounts, setAccounts] = useState<any>({ providers, forecasts: {}, trends: {} });
  useEffect(() => {
    api('/usage').then(setData);
    const refresh = () => {
      void api('/usage/accounts')
        .then(setAccounts)
        .catch(() => {});
    };
    refresh();
    const timer = setInterval(refresh, 60000);
    return () => clearInterval(timer);
  }, []);
  const totals: Record<string, number> = {};
  for (const r of data.runs) {
    const u = r.usage?.usage || r.usage?.last || r.usage?.tokens || {};
    totals[r.name] =
      (totals[r.name] || 0) +
      (u.input_tokens || u.inputTokens || u.input || 0) +
      (u.output_tokens || u.outputTokens || u.output || 0);
  }
  return (
    <Modal title="Usage" onClose={onClose}>
      <div className="usage-content">
        <p className="quiet">
          Account limits are shared with your other apps. Employee figures show only activity
          observed in this workspace.
        </p>
        {accounts.providers.map((p: any) => (
          <div className="usage-account" key={p.harness}>
            <strong>{names[p.harness]}</strong>
            <small>{p.detail}</small>
            {p.limits ? (
              Object.entries(p.limits.rateLimitsByLimitId || { default: p.limits.rateLimits })
                .filter(([, bucket]) => Boolean(bucket))
                .map(([bucketKey, bucket]: any) => (
                  <div key={bucketKey}>
                    {(['primary', 'secondary'] as const).map((windowKey) => {
                      const w = bucket[windowKey];
                      if (!w) return null;
                      const trendKey = `${p.harness}.${bucketKey}.${windowKey}`;
                      const estimate = accounts.forecasts[trendKey];
                      return (
                        <div className="usage-window" key={windowKey}>
                          <div className="usage-label">
                            <span>{Math.round(w.windowDurationMins / 60)} hour window</span>
                            <b>{Math.max(0, 100 - w.usedPercent)}% remaining</b>
                          </div>
                          <progress max={100} value={w.usedPercent} />
                          <div className="usage-window-detail">
                            <small>Resets {new Date(w.resetsAt * 1000).toLocaleString()}</small>
                            <UsageSparkline samples={accounts.trends[trendKey]} />
                          </div>
                          {estimate && (
                            <p className="usage-estimate">
                              At this pace, could run out between{' '}
                              {new Date(estimate.earliest).toLocaleString([], {
                                weekday: 'short',
                                hour: '2-digit',
                                minute: '2-digit',
                              })}{' '}
                              and{' '}
                              {new Date(estimate.latest).toLocaleString([], {
                                weekday: 'short',
                                hour: '2-digit',
                                minute: '2-digit',
                              })}
                              .
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ))
            ) : (
              <p className="quiet">Remaining allowance unavailable</p>
            )}
          </div>
        ))}
        <h3>Observed by employee</h3>
        <p className="usage-section-note">
          Share across up to 500 recent runs with reported token usage.
        </p>
        {Object.keys(totals).length > 0 && <EmployeeUsageChart totals={totals} />}
        {!data.runs.length && (
          <p className="quiet">Usage appears after a provider reports a completed turn.</p>
        )}
        <p className="caption">
          Estimates use recent account-wide activity; other apps share the allowance. They appear
          only when enough fresh samples are available.
        </p>
      </div>
    </Modal>
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
function SettingsPanel({ workspace: w, onClose, refresh, onMemorySource, fail }: any) {
  const [notificationStatus, setNotificationStatus] = useState('');
  const [startup, setStartup] = useState<any>(null);
  const [tab, setTab] = useState('general'),
    [prefs, setPrefs] = useState<any>({ enabled: false, sound: true, privatePreview: false }),
    [memories, setMemories] = useState<any[]>([]),
    [accountProviders, setAccountProviders] = useState<any[]>([]),
    [checkingAccounts, setCheckingAccounts] = useState(false);
  async function refreshAccounts(check?: string) {
    setCheckingAccounts(true);
    try {
      const result = await api('/providers' + (check ? '?check=' + check : ''));
      setAccountProviders(result);
      return result;
    } finally {
      setCheckingAccounts(false);
    }
  }
  useEffect(() => {
    api('/notifications')
      .then((r) => setPrefs(r.preferences))
      .catch((e) => setSettingsError(e.message));
    api('/memories')
      .then(setMemories)
      .catch((e) => setSettingsError(e.message));
    api('/startup')
      .then(setStartup)
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (tab === 'accounts' && accountProviders.length === 0) {
      void refreshAccounts('opencode').catch((e: any) => setSettingsError(e.message));
    }
  }, [tab]);
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
          {['general', 'notifications', 'memory', 'accounts', 'schedules'].map((t) => (
            <button
              type="button"
              aria-current={tab === t ? 'page' : undefined}
              className={tab === t ? 'active' : ''}
              key={t}
              onClick={() => setTab(t)}
            >
              {t}
            </button>
          ))}
        </nav>
        <div className="settings-scroll">
          {tab === 'general' ? (
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
              {['codex', 'claude', 'opencode'].map((h) => (
                <ProviderLogin
                  key={h}
                  harness={h}
                  provider={accountProviders.find((p) => p.harness === h)}
                  checking={checkingAccounts}
                  refresh={refreshAccounts}
                  fail={setSettingsError}
                />
              ))}
            </>
          ) : tab === 'schedules' ? (
            <Schedules workspace={w} fail={setSettingsError} />
          ) : tab === 'notifications' ? (
            <div className="ui-stack notification-settings">
              <p>Get an alert when someone replies or mentions you.</p>
              <button
                className="primary"
                onClick={async () => {
                  try {
                    const permission = await Notification.requestPermission();
                    if (permission !== 'granted')
                      throw new Error(
                        'Notifications are blocked. Enable them in browser settings.',
                      );
                    const registration = await navigator.serviceWorker.register('/sw.js');
                    await navigator.serviceWorker.ready;
                    const { publicKey } = await api('/notifications');
                    const padding = '='.repeat((4 - (publicKey.length % 4)) % 4);
                    const expectedKey = Uint8Array.from(
                      atob((publicKey + padding).replace(/-/g, '+').replace(/_/g, '/')),
                      (character) => character.charCodeAt(0),
                    );
                    let sub = await registration.pushManager.getSubscription();
                    if (sub) {
                      const existingKey = sub.options.applicationServerKey;
                      const existingBytes = existingKey
                        ? new Uint8Array(existingKey as ArrayBuffer)
                        : null;
                      const sameKey =
                        existingBytes?.length === expectedKey.length &&
                        existingBytes.every((byte, index) => byte === expectedKey[index]);
                      if (!sameKey) {
                        await api('/notifications/subscribe', { endpoint: sub.endpoint }, 'DELETE');
                        if (!(await sub.unsubscribe()))
                          throw new Error(
                            'Could not replace the browser notification subscription.',
                          );
                        sub = null;
                      }
                    }
                    sub ??= await registration.pushManager.subscribe({
                      userVisibleOnly: true,
                      applicationServerKey: expectedKey,
                    });
                    await api('/notifications/subscribe', sub.toJSON());
                    const next = { ...prefs, enabled: true };
                    await api('/notifications', next, 'PUT');
                    setPrefs(next);
                  } catch (e: any) {
                    setSettingsError(e.message);
                  }
                }}
              >
                <Bell size={15} />
                {prefs.enabled ? 'Notifications enabled' : 'Enable notifications'}
              </button>
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
              {prefs.enabled && (
                <button
                  className="secondary"
                  onClick={async () => {
                    setNotificationStatus('Sending…');
                    try {
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
                Agents carry workspace facts across rooms and use conversation notes only here.
                Forget a note to remove it from future context.
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
      <footer className="settings-footer">
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
          {tab !== 'general' && !dirty && (
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
      </footer>
    </Modal>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
