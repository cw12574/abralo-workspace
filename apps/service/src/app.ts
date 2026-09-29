import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import staticFiles from '@fastify/static';
import {
  createReadStream,
  existsSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { platform } from 'node:os';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  Store,
  ApiError,
  uid,
  now,
  hash,
  passwordHash,
  verifyPassword,
  sharedMessageSql,
} from './store.js';
import { Supervisor } from './supervisor.js';
import { EmployeeInput, SendMessage } from '../../../packages/contracts/src/index.js';
import { summaryEvent } from '../../../packages/contracts/src/activity-summary.js';
import { ensureDirectory, execFileAsync, launch } from '../../../packages/host/src/index.js';
import { CodexAdapter } from './adapters/codex.js';
import { registerWorkspaceTools } from './workspace-tools.js';
import { registerNotifications } from './notifications.js';
import { ConnectionBroker, registerConnectionRoutes } from './connections.js';
import { registerOperations } from './operations.js';
import { quotaForecasts } from './usage.js';
import { handoffTeam } from './team-handoff.js';
import { createMaintenance, type MaintenanceConfig } from './maintenance.js';
export async function createApp(
  store: Store,
  options: { supervisor?: Supervisor; staticRoot?: string; maintenance?: MaintenanceConfig } = {},
) {
  const app = Fastify({ logger: false, bodyLimit: 200000, trustProxy: false });
  const canonicalDataDirectory = realpathSync(store.dir);
  const dataDirectoryId = createHash('sha256')
    .update(platform() === 'win32' ? canonicalDataDirectory.toLowerCase() : canonicalDataDirectory)
    .digest('hex');
  const buildId = process.env.WORKSPACE_BUILD_ID || 'unmanaged';
  const supervisor = options.supervisor || new Supervisor(store);
  const maintenance = createMaintenance(store, supervisor, options.maintenance);
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 1 } });
  const authAttempts = new Map<string, { count: number; until: number }>();
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (req, reply) => {
    const configured = process.env.WORKSPACE_PUBLIC_URL;
    const allowed = new Set([
      '127.0.0.1',
      'localhost',
      '[::1]',
      ...(configured ? [new URL(configured).hostname] : []),
    ]);
    const hostname = new URL(`http://${req.headers.host || 'invalid'}`).hostname;
    if (!allowed.has(hostname)) throw new ApiError(403, 'Host is not configured.');
    if (supervisor.maintenanceReadonly && !['GET', 'HEAD'].includes(req.method))
      throw new ApiError(503, 'Workspace restart is being verified. Please retry shortly.');
    const origin = req.headers.origin;
    if (origin) {
      const u = new URL(origin);
      if (
        !allowed.has(u.hostname) ||
        (u.host !== req.headers.host && origin !== configured && origin !== 'http://127.0.0.1:5178')
      )
        throw new ApiError(403, 'Origin is not allowed.');
    }
    if (
      req.method !== 'GET' &&
      req.method !== 'HEAD' &&
      req.url.startsWith('/api/') &&
      req.headers['x-workspace-request'] !== '1'
    )
      throw new ApiError(403, 'Missing request header.');
    const user = store.session(req.cookies.workspace || '');
    (req as any).user = user || null;
    if (
      req.url.startsWith('/api/') &&
      ![
        '/api/health',
        '/api/bootstrap',
        '/api/local-session',
        '/api/login',
        '/api/invite/accept',
      ].includes(req.url.split('?')[0]) &&
      !user
    )
      throw new ApiError(401, 'Open Workspace from its launcher or sign in.');
    if (
      ['/api/bootstrap', '/api/local-session', '/api/login', '/api/invite/accept'].includes(
        req.url.split('?')[0],
      )
    ) {
      const key = req.ip;
      const v = authAttempts.get(key);
      if (v && v.until > Date.now() && v.count >= 20)
        throw new ApiError(429, 'Too many attempts. Try again in a minute.');
      authAttempts.set(key, {
        count: v && v.until > Date.now() ? v.count + 1 : 1,
        until: Date.now() + 60000,
      });
    }
  });
  app.addHook('onSend', async (_req, reply) => {
    reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'no-referrer')
      .header('X-Frame-Options', 'DENY');
  });
  app.setErrorHandler((error: any, _req, reply) => {
    const status = error instanceof z.ZodError ? 400 : error.statusCode || 500;
    reply.code(status).send({
      error: status === 500 ? 'The operation failed. Check workspace diagnostics.' : error.message,
    });
    if (status === 500) console.error(error.stack || error);
  });
  const user = (req: any) => req.user as { id: string; name: string; role: string };
  const owner = (req: any) => {
    if (user(req).role !== 'owner')
      throw new ApiError(403, 'Only the workspace owner can do this.');
    return user(req);
  };
  const purgeConversation = (id: string) => {
    const paths = store
      .all('SELECT path FROM attachments WHERE conversation_id=?', id)
      .map((attachment: any) => attachment.path as string);
    store.run(
      "DELETE FROM settings WHERE key IN (SELECT 'delegation.lineage.' || id FROM messages WHERE conversation_id=?) OR key IN (SELECT 'run.lineage.' || id FROM runs WHERE conversation_id=?)",
      id,
      id,
    );
    store.run(
      'DELETE FROM inbox WHERE message_id IN (SELECT id FROM messages WHERE conversation_id=?)',
      id,
    );
    store.run(
      'DELETE FROM operations WHERE message_id IN (SELECT id FROM messages WHERE conversation_id=?)',
      id,
    );
    store.run(
      'DELETE FROM outbox WHERE message_id IN (SELECT id FROM messages WHERE conversation_id=?)',
      id,
    );
    store.run(
      'DELETE FROM activities WHERE run_id IN (SELECT id FROM runs WHERE conversation_id=?)',
      id,
    );
    store.run(
      'DELETE FROM decisions WHERE run_id IN (SELECT id FROM runs WHERE conversation_id=?)',
      id,
    );
    store.run(
      'DELETE FROM native_sessions WHERE context_key IN (SELECT context_key FROM runs WHERE conversation_id=?)',
      id,
    );
    store.run('DELETE FROM runs WHERE conversation_id=?', id);
    store.run('DELETE FROM schedules WHERE conversation_id=?', id);
    store.run('DELETE FROM drafts WHERE conversation_id=?', id);
    store.run(
      "DELETE FROM memory_fts WHERE id IN (SELECT id FROM memories WHERE conversation_id=? AND scope='conversation')",
      id,
    );
    store.run("DELETE FROM memories WHERE conversation_id=? AND scope='conversation'", id);
    store.run('DELETE FROM plans WHERE conversation_id=?', id);
    store.run('DELETE FROM messages WHERE conversation_id=?', id);
    store.run('DELETE FROM attachments WHERE conversation_id=?', id);
    store.run('DELETE FROM events WHERE conversation_id=?', id);
    store.run('DELETE FROM members WHERE conversation_id=?', id);
    store.run('DELETE FROM employee_conversations WHERE conversation_id=?', id);
    store.run('DELETE FROM conversations WHERE id=?', id);
    store.run('DELETE FROM settings WHERE key LIKE ?', `channel.${id}.%`);
    store.run('DELETE FROM settings WHERE key=?', 'archive.schedules.' + id);
    return { paths };
  };
  const canonicalFolder = (path: string) => {
    try {
      const canonical = realpathSync(path);
      if (!statSync(canonical).isDirectory()) throw new Error();
      return canonical;
    } catch {
      throw new ApiError(400, 'Choose an existing folder on this computer.');
    }
  };
  app.post('/api/folders/pick', async (req) => {
    owner(req);
    let path = '';
    try {
      if (platform() === 'win32') {
        const script = String.raw`
$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.Runtime.InteropServices;

[Flags]
public enum FolderDialogOptions : uint {
  PickFolders = 0x00000020, ForceFileSystem = 0x00000040, PathMustExist = 0x00000800
}

[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct FolderFilterSpec { public string Name; public string Spec; }

[ComImport, Guid("D57C7288-D4AD-4768-BE02-9D969532D960"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IFolderOpenDialog {
  [PreserveSig] int Show(IntPtr owner);
  [PreserveSig] int SetFileTypes(uint count, [MarshalAs(UnmanagedType.LPArray)] FolderFilterSpec[] types);
  [PreserveSig] int SetFileTypeIndex(uint index);
  [PreserveSig] int GetFileTypeIndex(out uint index);
  [PreserveSig] int Advise(IntPtr events, out uint cookie);
  [PreserveSig] int Unadvise(uint cookie);
  [PreserveSig] int SetOptions(FolderDialogOptions options);
  [PreserveSig] int GetOptions(out FolderDialogOptions options);
  [PreserveSig] int SetDefaultFolder(IShellFolderItem item);
  [PreserveSig] int SetFolder(IShellFolderItem item);
  [PreserveSig] int GetFolder(out IShellFolderItem item);
  [PreserveSig] int GetCurrentSelection(out IShellFolderItem item);
  [PreserveSig] int SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
  [PreserveSig] int GetFileName(out IntPtr name);
  [PreserveSig] int SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
  [PreserveSig] int SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
  [PreserveSig] int SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
  [PreserveSig] int GetResult(out IShellFolderItem item);
  [PreserveSig] int AddPlace(IShellFolderItem item, uint alignment);
  [PreserveSig] int SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string extension);
  [PreserveSig] int Close(int result);
  [PreserveSig] int SetClientGuid(ref Guid guid);
  [PreserveSig] int ClearClientData();
  [PreserveSig] int SetFilter(IntPtr filter);
  [PreserveSig] int GetResults(out IntPtr results);
  [PreserveSig] int GetSelectedItems(out IntPtr items);
}

[ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IShellFolderItem {
  [PreserveSig] int BindToHandler(IntPtr bindContext, ref Guid handler, ref Guid iid, out IntPtr result);
  [PreserveSig] int GetParent(out IShellFolderItem parent);
  [PreserveSig] int GetDisplayName(uint nameType, out IntPtr name);
  [PreserveSig] int GetAttributes(uint mask, out uint attributes);
  [PreserveSig] int Compare(IShellFolderItem item, uint hint, out int order);
}

public static class NativeFolderPicker {
  private delegate bool WindowVisitor(IntPtr window, IntPtr state);
  [DllImport("user32.dll")] private static extern bool EnumWindows(WindowVisitor visitor, IntPtr state);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, System.Text.StringBuilder text, int maxCount);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr window, IntPtr insertAfter, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("ole32.dll")] public static extern int CoInitializeEx(IntPtr reserved, uint flags);
  [DllImport("ole32.dll")] public static extern void CoUninitialize();
  private static readonly IntPtr TopMost = new IntPtr(-1);
  private static readonly IntPtr NotTopMost = new IntPtr(-2);
  private const uint PositionFlags = 0x0002 | 0x0001 | 0x0040;
  private static System.Threading.Timer monitor;
  private static void RaisePicker() {
    EnumWindows((window, state) => {
      if (!IsWindowVisible(window)) return true;
      var title = new System.Text.StringBuilder(256);
      GetWindowText(window, title, title.Capacity);
      if (title.ToString() == "Choose a working folder") {
        SetWindowPos(window, TopMost, 0, 0, 0, 0, PositionFlags);
        SetForegroundWindow(window);
        return false;
      }
      return true;
    }, IntPtr.Zero);
  }
  public static string Pick() {
    int initialized = CoInitializeEx(IntPtr.Zero, 2);
    IFolderOpenDialog dialog = null;
    IShellFolderItem item = null;
    try {
      if (initialized < 0) Marshal.ThrowExceptionForHR(initialized);
      dialog = (IFolderOpenDialog)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")));
      FolderDialogOptions options = FolderDialogOptions.PickFolders | FolderDialogOptions.ForceFileSystem | FolderDialogOptions.PathMustExist;
      Marshal.ThrowExceptionForHR(dialog.SetOptions(options));
      Marshal.ThrowExceptionForHR(dialog.SetTitle("Choose a working folder"));
      monitor = new System.Threading.Timer(_ => RaisePicker(), null, 0, 100);
      int result = dialog.Show(GetForegroundWindow());
      monitor.Dispose();
      monitor = null;
      EnumWindows((window, state) => {
        var title = new System.Text.StringBuilder(256);
        GetWindowText(window, title, title.Capacity);
        if (title.ToString() == "Choose a working folder") SetWindowPos(window, NotTopMost, 0, 0, 0, 0, PositionFlags);
        return true;
      }, IntPtr.Zero);
      if (result == unchecked((int)0x800704C7)) return null;
      Marshal.ThrowExceptionForHR(result);
      Marshal.ThrowExceptionForHR(dialog.GetResult(out item));
      IntPtr name = IntPtr.Zero;
      Marshal.ThrowExceptionForHR(item.GetDisplayName(0x80058000, out name));
      try { return Marshal.PtrToStringUni(name); }
      finally { Marshal.FreeCoTaskMem(name); }
    } finally {
      if (monitor != null) { monitor.Dispose(); monitor = null; }
      if (item != null) Marshal.FinalReleaseComObject(item);
      if (dialog != null) Marshal.FinalReleaseComObject(dialog);
      if (initialized >= 0) CoUninitialize();
    }
  }
}
'@
Add-Type -TypeDefinition $source
$selected = [NativeFolderPicker]::Pick()
if ($selected) { [Console]::WriteLine($selected) }
`;
        const result = await execFileAsync(
          'powershell.exe',
          ['-NoProfile', '-STA', '-Command', script],
          { windowsHide: true, timeout: 300000, maxBuffer: 4096 },
        );
        path = result.stdout.trim();
      } else if (platform() === 'darwin') {
        const result = await execFileAsync(
          'osascript',
          ['-e', 'POSIX path of (choose folder with prompt "Choose a working folder")'],
          { timeout: 300000, maxBuffer: 4096 },
        );
        path = result.stdout.trim();
      } else {
        const result = await execFileAsync(
          'zenity',
          ['--file-selection', '--directory', '--title=Choose a working folder'],
          { timeout: 300000, maxBuffer: 4096 },
        );
        path = result.stdout.trim();
      }
    } catch (error: any) {
      if ((platform() !== 'win32' && error.code === 1) || error.code === 130)
        return { cancelled: true };
      const detail = String(error.stderr || error.message || '')
        .trim()
        .slice(0, 240);
      throw new ApiError(
        501,
        detail
          ? `The folder picker failed to open: ${detail}`
          : 'The folder picker is unavailable.',
      );
    }
    if (!path) return { cancelled: true };
    path = canonicalFolder(path);
    return { path, name: basename(path) || path };
  });
  app.get('/api/conversations/:id/working-folder', async (req) => {
    owner(req);
    const id = (req.params as any).id;
    store.authorize(user(req).id, id);
    const path = store.setting('conversation.workingFolder.' + id);
    return { path, name: path ? basename(path) || path : null };
  });
  app.put('/api/conversations/:id/working-folder', async (req) => {
    owner(req);
    const id = (req.params as any).id;
    store.authorize(user(req).id, id);
    const { path } = z.object({ path: z.string().max(2000).nullable() }).parse(req.body);
    const canonical = path ? canonicalFolder(path) : null;
    store.set('conversation.workingFolder.' + id, canonical);
    return { path: canonical, name: canonical ? basename(canonical) || canonical : null };
  });
  const setSession = (reply: any, id: string) =>
    reply.setCookie('workspace', store.newSession(id), {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      secure: !!process.env.WORKSPACE_PUBLIC_URL?.startsWith('https:'),
      maxAge: 30 * 86400,
    });
  app.get('/api/health', async () => ({
    ok: true,
    product: 'agent-workspace',
    version: '0.1.0',
    buildId,
    dataDirectoryId,
    maintenanceJob: process.env.WORKSPACE_MAINTENANCE_JOB || null,
    setup: !store.one('SELECT id FROM humans LIMIT 1'),
  }));
  app.post('/api/bootstrap', async (req, reply) => {
    const { token, name } = z
      .object({ token: z.string(), name: z.string().max(80).default('You') })
      .parse(req.body);
    if (hash(token) !== hash(store.bootstrapToken))
      throw new ApiError(403, 'Use the Workspace launcher to open this device.');
    let u = store.one("SELECT id,name,role FROM humans WHERE role='owner' LIMIT 1");
    if (!u) u = store.createOwner(name);
    setSession(reply, u.id);
    return u;
  });
  app.post('/api/local-session', async (req, reply) => {
    const host = new URL(`http://${req.headers.host || 'invalid'}`).hostname;
    if (
      process.env.WORKSPACE_PUBLIC_URL ||
      !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)
    )
      throw new ApiError(403, 'Use the workspace invitation or sign in.');
    let localOwner = store.one("SELECT id,name,role FROM humans WHERE role='owner' LIMIT 1");
    if (!localOwner) localOwner = store.createOwner('You');
    setSession(reply, localOwner.id);
    return localOwner;
  });
  app.post('/api/login', async (req, reply) => {
    const body = z.object({ name: z.string(), password: z.string() }).parse(req.body);
    const u = store.one('SELECT * FROM humans WHERE lower(name)=lower(?)', body.name);
    if (!u?.password || !verifyPassword(body.password, u.password))
      throw new ApiError(401, 'Name or password did not match.');
    setSession(reply, u.id);
    return store.user(u.id);
  });
  app.post('/api/logout', async (req, reply) => {
    store.run('DELETE FROM sessions WHERE token_hash=?', hash(req.cookies.workspace || ''));
    reply.clearCookie('workspace', { path: '/' });
    return { ok: true };
  });
  app.get('/api/workspace', async (req) => {
    const u = user(req);
    const conversations = store
      .all(
        `SELECT c.*,m.last_read,(SELECT COUNT(*) FROM messages msg WHERE msg.conversation_id=c.id AND msg.seq>m.last_read AND msg.author_id<>? AND msg.kind<>'system' AND msg.text<>'' AND ${sharedMessageSql}) unread FROM conversations c JOIN members m ON m.conversation_id=c.id WHERE m.user_id=? ORDER BY c.created_at`,
        u.id,
        u.id,
      )
      .map((c) => ({
        id: c.id,
        name: c.name,
        kind: c.kind,
        employeeId: c.employee_id,
        createdAt: c.created_at,
        unread: c.unread,
        archivedAt: store.setting('channel.archived.' + c.id),
      }));
    const availableEmployees = store
      .all(
        'SELECT data FROM employees WHERE owner_id=? OR id IN (SELECT employee_id FROM employee_grants WHERE user_id=?)',
        u.id,
        u.id,
      )
      .map((e) => {
        const value = JSON.parse(e.data);
        value.attentionUnread = store.one(
          'SELECT COUNT(*) n FROM inbox i JOIN messages msg ON msg.id=i.message_id JOIN members m ON m.conversation_id=msg.conversation_id AND m.user_id=i.user_id WHERE i.user_id=? AND i.seen=0 AND msg.author_id=?',
          u.id,
          value.id,
        ).n;
        value.working = !!store.one(
          "SELECT 1 FROM runs r JOIN members m ON m.conversation_id=r.conversation_id AND m.user_id=? WHERE r.employee_id=? AND r.state IN ('accepted','dispatching','running','cancelling')",
          u.id,
          value.id,
        );
        value.nextScheduledAt =
          store.one(
            'SELECT MIN(next_at) at FROM schedules WHERE employee_id=? AND user_id=? AND enabled=1',
            value.id,
            u.id,
          )?.at || null;
        const recent = store.one(
          'SELECT r.conversation_id,r.thread_id,r.state,c.name FROM runs r JOIN conversations c ON c.id=r.conversation_id JOIN members m ON m.conversation_id=c.id AND m.user_id=? WHERE r.employee_id=? ORDER BY r.created_at DESC LIMIT 1',
          u.id,
          value.id,
        );
        if (recent)
          value.latestWork = {
            conversationId: recent.conversation_id,
            threadId: recent.thread_id,
            state: recent.state,
            name: recent.name,
          };
        if (value.ownerId !== u.id)
          value.dmId = conversations.find((c) => c.employeeId === value.id)?.id;
        return value;
      });
    const ownedEmployees = store
      .all('SELECT data FROM employees WHERE owner_id=?', u.id)
      .map(({ data }) => JSON.parse(data));
    return {
      user: u,
      name: store.setting('workspace.name', 'Workspace'),
      purpose: store.setting('workspace.purpose', ''),
      objectives: store.setting(
        'workspace.objectives.' + u.id,
        store.setting('workspace.purpose', '') ? [store.setting('workspace.purpose', '')] : [],
      ),
      onboarded: store.setting('workspace.onboarded', false),
      employees: availableEmployees.filter((e) => !e.deactivatedAt),
      inactiveEmployees: ownedEmployees.filter((e) => !!e.deactivatedAt),
      conversations: conversations.map((conversation) => ({
        ...conversation,
        archivedAt: store.setting('channel.archived.' + conversation.id),
        isTeamChannel: conversation.id === store.setting('workspace.team'),
        agentDeactivated: !!ownedEmployees.find(
          (employee) => employee.id === conversation.employeeId && employee.deactivatedAt,
        ),
      })),
      archivedChannels: conversations.filter(
        (conversation) =>
          conversation.kind === 'channel' && store.setting('channel.archived.' + conversation.id),
      ),
      humans: store.all('SELECT id,name,role FROM humans'),
      cursor: store.one('SELECT COALESCE(MAX(cursor),0) cursor FROM events').cursor,
      capabilities: { remoteConfigured: !!process.env.WORKSPACE_PUBLIC_URL, version: '0.1.0' },
    };
  });
  app.patch('/api/profile', async (req) => {
    const b = z
      .object({ name: z.string().trim().min(1).max(80), password: z.string().min(12).optional() })
      .parse(req.body);
    store.run(
      'UPDATE humans SET name=?,password=COALESCE(?,password) WHERE id=?',
      b.name,
      b.password ? passwordHash(b.password) : null,
      user(req).id,
    );
    return store.user(user(req).id);
  });
  app.patch('/api/workspace', async (req) => {
    owner(req);
    const b = z
      .object({
        name: z.string().max(80).optional(),
        purpose: z.string().max(10000).optional(),
        objectives: z.array(z.string().trim().min(1).max(5000)).optional(),
        onboarded: z.boolean().optional(),
      })
      .parse(req.body);
    for (const [k, v] of Object.entries(b))
      if (k === 'objectives') {
        const ownerId = user(req).id;
        store.set('workspace.objectives.' + ownerId, v);
        const stateKey = 'proactive.state.' + ownerId;
        const state = store.setting(stateKey, {});
        store.set(stateKey, {
          ...state,
          nextAt: now(),
          idleSince: null,
          followup: false,
          chainDepth: 0,
        });
      } else store.set('workspace.' + k, v);
    return { ok: true };
  });
  app.get('/api/providers', async (req) => {
    owner(req);
    return supervisor.infos((req.query as any).check);
  });
  app.post('/api/providers/codex/login', async (req) => {
    owner(req);
    return (supervisor.adapters.codex as CodexAdapter).login();
  });
  let claudeLogin: any = null;
  app.post('/api/providers/claude/login', async (req) => {
    owner(req);
    if (claudeLogin) return claudeLogin.info;
    const process = launch('claude', ['auth', 'login', '--claudeai']);
    const info: any = {
      message:
        'Complete the native Claude Code sign-in in your browser, then check the connection.',
    };
    claudeLogin = { process, info };
    let output = '';
    const capture = (d: Buffer) => {
      output = (output + d.toString()).slice(-8000);
      const url = output.match(
        /https:\/\/(?:claude\.ai|claude\.com|platform\.claude\.com|console\.anthropic\.com)\/[^\s\x1b]+/,
      );
      if (url) info.authUrl = url[0];
    };
    process.stdout.on('data', capture);
    process.stderr.on('data', capture);
    process.on('error', () => {
      claudeLogin = null;
    });
    process.on('exit', () => {
      claudeLogin = null;
    });
    await new Promise((r) => setTimeout(r, 1000));
    return info;
  });
  app.post('/api/providers/claude/code', async (req) => {
    owner(req);
    const { code } = z
      .object({
        code: z
          .string()
          .min(1)
          .max(4000)
          .regex(/^[^\r\n]+$/),
      })
      .parse(req.body);
    if (!claudeLogin?.process?.stdin.writable) throw new ApiError(409, 'Start sign-in again.');
    claudeLogin.process.stdin.write(code + '\n');
    return { ok: true };
  });
  app.post('/api/providers/opencode/login', async (req) => {
    owner(req);
    return {
      message:
        'OpenCode is installed. Choose a provider below or sign in with its native CLI on this host.',
      providers: await (supervisor.adapters.opencode as any).api('/provider/auth'),
    };
  });
  app.post('/api/providers/opencode/authorize', async (req) => {
    owner(req);
    const b = z
      .object({
        provider: z.string().regex(/^[a-zA-Z0-9_-]+$/),
        method: z.number().int().min(0),
        inputs: z.record(z.string(), z.string()).optional(),
      })
      .parse(req.body);
    return (supervisor.adapters.opencode as any).api(
      `/provider/${b.provider}/oauth/authorize`,
      'POST',
      { method: b.method, inputs: b.inputs },
    );
  });
  app.post('/api/providers/opencode/callback', async (req) => {
    owner(req);
    const b = z
      .object({
        provider: z.string().regex(/^[a-zA-Z0-9_-]+$/),
        method: z.number().int().min(0),
        code: z.string().max(8000).optional(),
      })
      .parse(req.body);
    return (supervisor.adapters.opencode as any).api(
      `/provider/${b.provider}/oauth/callback`,
      'POST',
      { method: b.method, code: b.code },
    );
  });
  app.post('/api/providers/opencode/key', async (req) => {
    owner(req);
    const b = z
      .object({
        provider: z.string().regex(/^[a-zA-Z0-9_-]+$/),
        key: z.string().min(1).max(8000),
        billingConsent: z.literal(true),
      })
      .parse(req.body);
    await (supervisor.adapters.opencode as any).api(`/auth/${b.provider}`, 'PUT', {
      type: 'api',
      key: b.key,
    });
    return { ok: true };
  });
  app.post('/api/employees', async (req) => {
    owner(req);
    const b = EmployeeInput.parse(req.body);
    return store.createEmployee(user(req).id, b);
  });
  app.post('/api/employees/:id/deactivate', async (req) => {
    const actor = owner(req);
    const id = (req.params as any).id;
    const employee = store.employee(id);
    if (!employee || employee.ownerId !== actor.id) throw new ApiError(404, 'Agent not found.');
    if (employee.deactivatedAt) return { ok: true };
    for (const run of store.all(
      "SELECT id,user_id FROM runs WHERE employee_id=? AND state NOT IN ('completed','cancelled','failed','interrupted')",
      id,
    ))
      if (supervisor.active.has(run.id)) supervisor.cancel(run.user_id, run.id);
    const disabledSchedules = store
      .all('SELECT id FROM schedules WHERE employee_id=? AND enabled=1', id)
      .map((row: any) => row.id as string);
    store.db.transaction(() => {
      store.run('UPDATE schedules SET enabled=0 WHERE employee_id=?', id);
      store.run(
        "UPDATE outbox SET status='cancelled' WHERE employee_id=? AND status IN ('pending','new')",
        id,
      );
      store.run(
        'UPDATE employees SET data=? WHERE id=?',
        JSON.stringify({
          ...employee,
          deactivatedAt: now(),
          deactivatedScheduleIds: disabledSchedules,
        }),
        id,
      );
    })();
    for (const { user_id } of store.all(
      'SELECT user_id FROM employee_grants WHERE employee_id=?',
      id,
    ))
      store.emit('workspace.changed', null, { employeeId: id }, user_id);
    store.emit('workspace.changed', null, { employeeId: id }, actor.id);
    return { ok: true };
  });
  app.post('/api/employees/:id/reactivate', async (req) => {
    const actor = owner(req);
    const id = (req.params as any).id;
    const employee = store.employee(id);
    if (!employee || employee.ownerId !== actor.id) throw new ApiError(404, 'Agent not found.');
    if (!employee.deactivatedAt) return { ok: true };
    store.db.transaction(() => {
      for (const scheduleId of employee.deactivatedScheduleIds || [])
        store.run('UPDATE schedules SET enabled=1 WHERE id=? AND employee_id=?', scheduleId, id);
      const {
        deactivatedAt: _deactivatedAt,
        deactivatedScheduleIds: _scheduleIds,
        ...activeEmployee
      } = employee;
      store.run('UPDATE employees SET data=? WHERE id=?', JSON.stringify(activeEmployee), id);
    })();
    for (const { user_id } of store.all(
      'SELECT user_id FROM employee_grants WHERE employee_id=?',
      id,
    ))
      store.emit('workspace.changed', null, { employeeId: id }, user_id);
    store.emit('workspace.changed', null, { employeeId: id }, actor.id);
    return { ok: true };
  });
  app.delete('/api/employees/:id', async (req) => {
    const actor = owner(req);
    const id = (req.params as any).id;
    const employee = store.employee(id);
    if (!employee || employee.ownerId !== actor.id) throw new ApiError(404, 'Agent not found.');
    const activeRuns = store
      .all(
        "SELECT id,user_id FROM runs WHERE employee_id=? AND state NOT IN ('completed','cancelled','failed','interrupted')",
        id,
      )
      .filter((run: any) => supervisor.active.has(run.id));
    store.db.transaction(() => {
      store.run('UPDATE schedules SET enabled=0 WHERE employee_id=?', id);
      store.run(
        "UPDATE outbox SET status='cancelled' WHERE employee_id=? AND status IN ('pending','new')",
        id,
      );
      if (!employee.deactivatedAt)
        store.run(
          'UPDATE employees SET data=? WHERE id=?',
          JSON.stringify({ ...employee, deactivatedAt: now() }),
          id,
        );
    })();
    for (const run of activeRuns) supervisor.cancel(run.user_id, run.id);
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const stillActive = store
        .all(
          "SELECT id FROM runs WHERE employee_id=? AND state NOT IN ('completed','cancelled','failed','interrupted')",
          id,
        )
        .some((run: any) => supervisor.active.has(run.id));
      if (!stillActive) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (
      store
        .all(
          "SELECT id FROM runs WHERE employee_id=? AND state NOT IN ('completed','cancelled','failed','interrupted')",
          id,
        )
        .some((run: any) => supervisor.active.has(run.id))
    )
      throw new ApiError(
        409,
        'The agent has stopped accepting work, but its current run is still stopping. Retry deletion shortly.',
      );
    const viewers = new Set([
      actor.id,
      ...store
        .all('SELECT user_id FROM employee_grants WHERE employee_id=?', id)
        .map((row: any) => row.user_id),
    ]);
    const { paths } = store.db.transaction(() => {
      const purged = purgeConversation(employee.dmId);
      store.run('DELETE FROM employee_grants WHERE employee_id=?', id);
      store.run('DELETE FROM grants WHERE employee_id=?', id);
      store.run('DELETE FROM schedules WHERE employee_id=?', id);
      store.run('DELETE FROM outbox WHERE employee_id=?', id);
      store.run('DELETE FROM native_sessions WHERE employee_id=?', id);
      store.run('DELETE FROM employees WHERE id=?', id);
      return purged;
    })();
    for (const path of paths)
      if (existsSync(path))
        try {
          unlinkSync(path);
        } catch {
          /* already inaccessible */
        }
    for (const viewer of viewers) store.emit('workspace.changed', null, { employeeId: id }, viewer);
    return { ok: true };
  });
  app.post('/api/onboarding', async (req) => {
    const u = owner(req);
    const body = z
      .object({
        employee: EmployeeInput,
        purpose: z.string().trim().max(10000).optional(),
        objectives: z.array(z.string().trim().min(1).max(5000)).min(1).optional(),
        userName: z.string().trim().min(1).max(80),
      })
      .refine((body) => !!body.objectives?.length || !!body.purpose?.trim(), {
        message: 'Add at least one objective.',
        path: ['objectives'],
      })
      .parse(req.body);
    const result = store.db.transaction(() => {
      const prior = store.setting('onboarding.' + u.id);
      if (prior) return prior;
      store.run('UPDATE humans SET name=? WHERE id=?', body.userName, u.id);
      const employee = store.createEmployee(u.id, {
        ...body.employee,
        name: 'Chief of Staff',
        role: 'Organizes the team and keeps work moving',
        instructions:
          'You are the Chief of Staff, the first employee and owner of forward motion. The workspace has user-stated objectives available in your context. When you receive a proactive idle review, inspect relevant recent workspace activity and identify one high-value next action toward those objectives. Do useful, bounded work yourself or delegate to existing employees; do not merely suggest work that you could safely start. Ask the human a specific question only when a material decision or missing fact blocks progress. If no worthwhile action is justified, say so briefly and wait. Use a new employee or team proposal only when a recurring skill or capacity gap clearly warrants it; explain the evidence and expected benefit, and never claim new employees exist before approval. Limit autonomous follow-up chains, avoid parallel work without a concrete reason, and do not keep agents busy for its own sake. Respect existing workspace access, permissions, and approval boundaries.',
      });
      const objectives = body.objectives?.length ? body.objectives : [body.purpose!.trim()];
      const objectiveText = objectives.map((objective, i) => `${i + 1}. ${objective}`).join('\n');
      store.set('workspace.purpose', (body.purpose || objectiveText).slice(0, 10000));
      store.set('workspace.objectives.' + u.id, objectives);
      store.set('workspace.chiefOfStaff.' + u.id, employee.id);
      store.set('proactive.state.' + u.id, {
        nextAt: new Date(Date.now() + 2 * 60_000).toISOString(),
        idleSince: null,
        lastReviewAt: null,
        lastHumanAt: null,
        followup: false,
        chainDepth: 0,
      });
      store.set('workspace.onboarded', true);
      const opening = store.accept({ ...u, name: body.userName }, employee.dmId, {
        text: `Here are the outcomes I’d like the workspace to move towards:\n\n${objectiveText}`,
        key: 'onboarding.' + u.id,
        attachments: [],
        recipients: [],
        newTask: false,
      });
      const goalsMemoryId = uid();
      const goalsMemory = `${body.userName}'s workspace objectives, provided during onboarding:\n${objectiveText}`;
      store.run(
        'INSERT INTO memories(id,conversation_id,author_id,content,source_id,created_at,scope,owner_id) VALUES(?,?,?,?,?,?,?,?)',
        goalsMemoryId,
        employee.dmId,
        u.id,
        goalsMemory,
        opening.id,
        now(),
        'workspace',
        u.id,
      );
      store.run('INSERT INTO memory_fts VALUES(?,?)', goalsMemoryId, goalsMemory);
      store.set('onboarding.' + u.id, employee);
      return employee;
    })();
    queueMicrotask(() => void supervisor.dispatch());
    return result;
  });
  app.post('/api/humans/:id/conversation', async (req) => {
    const other = store.user((req.params as any).id),
      me = user(req);
    if (!other || other.id === me.id) throw new ApiError(400, 'Choose another human.');
    const prior = store.one(
      "SELECT c.id FROM conversations c JOIN members a ON a.conversation_id=c.id JOIN members b ON b.conversation_id=c.id WHERE c.kind='human_dm' AND a.user_id=? AND b.user_id=?",
      me.id,
      other.id,
    );
    if (prior) return prior;
    const id = uid();
    store.db.transaction(() => {
      store.run(
        'INSERT INTO conversations VALUES(?,?,?,?,?)',
        id,
        `${me.name}, ${other.name}`,
        'human_dm',
        null,
        now(),
      );
      for (const human of [me, other]) {
        store.run('INSERT INTO members(conversation_id,user_id) VALUES(?,?)', id, human.id);
        store.emit('workspace.changed', null, {}, human.id);
      }
    })();
    return { id };
  });
  app.get('/api/employees/:id/grants', async (req) => {
    const e = store.employee((req.params as any).id);
    if (e?.ownerId !== user(req).id) throw new ApiError(403, 'Owner access required');
    return store
      .all('SELECT user_id FROM employee_grants WHERE employee_id=?', e.id)
      .map((g) => g.user_id);
  });
  app.put('/api/employees/:id/grants', async (req) => {
    const e = store.employee((req.params as any).id);
    if (!e || e.ownerId !== user(req).id) throw new ApiError(403, 'Owner access required');
    const { users } = z.object({ users: z.array(z.string()) }).parse(req.body);
    store.db.transaction(() => {
      const previous = store
        .all('SELECT user_id FROM employee_grants WHERE employee_id=?', e.id)
        .map((g) => g.user_id);
      store.run('DELETE FROM employee_grants WHERE employee_id=?', e.id);
      for (const id of users) {
        if (!store.user(id)) throw new ApiError(400, 'Unknown human');
        store.run('INSERT OR IGNORE INTO employee_grants VALUES(?,?)', e.id, id);
        if (
          !store.one(
            'SELECT c.id FROM conversations c JOIN members m ON m.conversation_id=c.id WHERE c.employee_id=? AND m.user_id=?',
            e.id,
            id,
          )
        ) {
          const dm = uid();
          store.run('INSERT INTO conversations VALUES(?,?,?,?,?)', dm, e.name, 'dm', e.id, now());
          store.run('INSERT INTO members(conversation_id,user_id) VALUES(?,?)', dm, id);
        }
      }
      for (const id of new Set([...previous, ...users]))
        store.emit('workspace.changed', null, {}, id);
    })();
    for (const run of store.all('SELECT id,user_id FROM runs WHERE employee_id=?', e.id)) {
      if (!store.canUseEmployee(run.user_id, e.id) && supervisor.active.has(run.id))
        supervisor.cancel(run.user_id, run.id);
    }
    return { ok: true };
  });
  app.patch('/api/employees/:id', async (req) => {
    const id = (req.params as any).id;
    const e = store.employee(id);
    if (e?.ownerId !== user(req).id) throw new ApiError(403, 'Employee is unavailable.');
    const b = EmployeeInput.parse({ ...e, ...(req.body as any) });
    store.run('UPDATE employees SET data=? WHERE id=?', JSON.stringify({ ...e, ...b }), id);
    store.run('UPDATE conversations SET name=? WHERE id=?', b.name, e.dmId);
    store.emit('workspace.changed', null, {}, user(req).id);
    return { ...e, ...b };
  });
  app.post('/api/channels', async (req) => {
    const b = z
      .object({
        name: z.string().trim().min(1).max(80),
        members: z.array(z.string()).default([]),
        employees: z.array(z.string()).default([]),
      })
      .parse(req.body);
    const id = uid();
    store.db.transaction(() => {
      if (
        store.one(
          "SELECT 1 FROM conversations WHERE kind='channel' AND lower(name)=lower(?)",
          b.name,
        )
      )
        throw new ApiError(409, 'A channel with that name already exists.');
      for (const employeeId of b.employees)
        if (!store.canUseEmployee(user(req).id, employeeId))
          throw new ApiError(403, 'An employee is unavailable to you.');
      store.run('INSERT INTO conversations VALUES(?,?,?,?,?)', id, b.name, 'channel', null, now());
      for (const m of new Set([user(req).id, ...b.members])) {
        if (!store.user(m)) throw new ApiError(400, 'Unknown human');
        store.run('INSERT INTO members(conversation_id,user_id) VALUES(?,?)', id, m);
        store.emit('workspace.changed', null, {}, m);
      }
      for (const employeeId of new Set(b.employees))
        store.run('INSERT INTO employee_conversations VALUES(?,?)', employeeId, id);
    })();
    return { id };
  });
  app.get('/api/channels/:id', async (req) => {
    const id = (req.params as any).id;
    const channel = store.one(
      "SELECT id,name FROM conversations WHERE id=? AND kind='channel'",
      id,
    );
    if (!channel) throw new ApiError(404, 'Channel not found.');
    if (!store.one('SELECT 1 FROM members WHERE user_id=? AND conversation_id=?', user(req).id, id))
      throw new ApiError(403, 'This channel is not available to you.');
    return {
      ...channel,
      archivedAt: store.setting('channel.archived.' + id),
      purpose: store.setting('channel.' + id + '.purpose', ''),
      humans: store.all(
        'SELECT h.id,h.name,h.role FROM humans h JOIN members m ON m.user_id=h.id WHERE m.conversation_id=? ORDER BY h.name COLLATE NOCASE',
        id,
      ),
      employees: store
        .all(
          'SELECT e.data FROM employees e JOIN employee_conversations m ON m.employee_id=e.id WHERE m.conversation_id=?',
          id,
        )
        .map(({ data }: any) => {
          const employee = JSON.parse(data);
          return {
            id: employee.id,
            name: employee.name,
            role: employee.role,
            harness: employee.harness,
          };
        })
        .sort((a: any, b: any) => a.name.localeCompare(b.name)),
    };
  });
  app.patch('/api/channels/:id', async (req) => {
    const id = (req.params as any).id;
    const actor = user(req);
    const body = z
      .object({
        name: z.string().trim().min(1).max(80).optional(),
        purpose: z.string().trim().max(500).optional(),
        addHumans: z.array(z.string()).max(200).default([]),
        removeHumans: z.array(z.string()).max(200).default([]),
        addEmployees: z.array(z.string()).max(200).default([]),
        removeEmployees: z.array(z.string()).max(200).default([]),
      })
      .parse(req.body);
    const channel = store.one(
      "SELECT id,name FROM conversations WHERE id=? AND kind='channel'",
      id,
    );
    if (!channel) throw new ApiError(404, 'Channel not found.');
    store.authorize(actor.id, id);
    if (store.setting('channel.archived.' + id))
      throw new ApiError(409, 'Restore this channel before changing it.');
    const name = body.name?.replace(/^#/, '').trim();
    if (body.name !== undefined && !name) throw new ApiError(400, 'Enter a channel name.');
    const sets = [
      [new Set(body.addHumans), new Set(body.removeHumans)],
      [new Set(body.addEmployees), new Set(body.removeEmployees)],
    ];
    if (sets.some(([add, remove]) => [...add].some((member) => remove.has(member))))
      throw new ApiError(400, 'A member cannot be added and removed at the same time.');
    const affectedHumans = new Set<string>(
      store
        .all('SELECT user_id FROM members WHERE conversation_id=?', id)
        .map((row: any) => row.user_id),
    );
    store.db.transaction(() => {
      if (
        name &&
        store.one(
          "SELECT 1 FROM conversations WHERE kind='channel' AND lower(name)=lower(?) AND id<>?",
          name,
          id,
        )
      )
        throw new ApiError(409, 'A channel with that name already exists.');
      const remainingHumans =
        Number(store.one('SELECT COUNT(*) n FROM members WHERE conversation_id=?', id).n) -
        body.removeHumans.filter((member) =>
          store.one('SELECT 1 FROM members WHERE conversation_id=? AND user_id=?', id, member),
        ).length;
      if (remainingHumans + body.addHumans.length < 1)
        throw new ApiError(400, 'A channel needs at least one person in it.');
      for (const member of body.removeHumans) {
        store.run('DELETE FROM members WHERE conversation_id=? AND user_id=?', id, member);
        affectedHumans.add(member);
      }
      for (const member of body.addHumans) {
        if (!store.user(member)) throw new ApiError(400, 'Unknown person.');
        store.run('INSERT OR IGNORE INTO members(conversation_id,user_id) VALUES(?,?)', id, member);
        affectedHumans.add(member);
      }
      for (const employeeId of body.removeEmployees)
        store.run(
          'DELETE FROM employee_conversations WHERE conversation_id=? AND employee_id=?',
          id,
          employeeId,
        );
      for (const employeeId of body.addEmployees) {
        if (!store.canUseEmployee(actor.id, employeeId))
          throw new ApiError(403, 'You do not have access to that employee.');
        store.run('INSERT OR IGNORE INTO employee_conversations VALUES(?,?)', employeeId, id);
      }
      if (name) store.run('UPDATE conversations SET name=? WHERE id=?', name, id);
      if (body.purpose !== undefined) store.set('channel.' + id + '.purpose', body.purpose);
    })();
    for (const member of affectedHumans) store.emit('workspace.changed', null, {}, member);
    return { ok: true };
  });
  app.post('/api/channels/:id/archive', async (req) => {
    const actor = owner(req);
    const id = (req.params as any).id;
    const channel = store.one(
      "SELECT id,name FROM conversations WHERE id=? AND kind='channel'",
      id,
    );
    if (!channel) throw new ApiError(404, 'Channel not found.');
    if (id === store.setting('workspace.team'))
      throw new ApiError(400, 'The team channel cannot be archived.');
    if (store.setting('channel.archived.' + id)) return { ok: true };
    const users = store
      .all('SELECT user_id FROM members WHERE conversation_id=?', id)
      .map((row: any) => row.user_id as string);
    const activeRuns = store.all(
      "SELECT id,user_id FROM runs WHERE conversation_id=? AND state NOT IN ('completed','cancelled','failed','interrupted')",
      id,
    );
    for (const run of activeRuns)
      if (supervisor.active.has(run.id)) supervisor.cancel(run.user_id, run.id);
    const scheduleIds = store
      .all('SELECT id FROM schedules WHERE conversation_id=? AND enabled=1', id)
      .map((row: any) => row.id as string);
    store.db.transaction(() => {
      store.set('channel.archived.' + id, now());
      store.run('UPDATE schedules SET enabled=0 WHERE conversation_id=?', id);
      store.run(
        "UPDATE outbox SET status='cancelled' WHERE message_id IN (SELECT id FROM messages WHERE conversation_id=?) AND status IN ('pending','new')",
        id,
      );
      store.set('archive.schedules.' + id, scheduleIds);
    })();
    for (const member of users)
      store.emit('workspace.changed', null, { channelId: id, archived: true }, member);
    store.emit('workspace.changed', null, { channelId: id, archived: true }, actor.id);
    return { ok: true };
  });
  app.post('/api/channels/:id/restore', async (req) => {
    const actor = owner(req);
    const id = (req.params as any).id;
    const channel = store.one("SELECT id FROM conversations WHERE id=? AND kind='channel'", id);
    if (!channel) throw new ApiError(404, 'Channel not found.');
    store.db.transaction(() => {
      store.run('DELETE FROM settings WHERE key=?', 'channel.archived.' + id);
      for (const scheduleId of store.setting('archive.schedules.' + id, []))
        store.run(
          'UPDATE schedules SET enabled=1 WHERE id=? AND conversation_id=?',
          scheduleId,
          id,
        );
      store.run('DELETE FROM settings WHERE key=?', 'archive.schedules.' + id);
    })();
    for (const { user_id } of store.all('SELECT user_id FROM members WHERE conversation_id=?', id))
      store.emit('workspace.changed', null, { channelId: id, archived: false }, user_id);
    store.emit('workspace.changed', null, { channelId: id, archived: false }, actor.id);
    return { ok: true };
  });
  app.delete('/api/channels/:id', async (req) => {
    const actor = owner(req);
    const id = (req.params as any).id;
    const channel = store.one("SELECT id FROM conversations WHERE id=? AND kind='channel'", id);
    if (!channel) throw new ApiError(404, 'Channel not found.');
    if (id === store.setting('workspace.team'))
      throw new ApiError(400, 'The team channel cannot be permanently deleted.');
    const users = new Set([
      actor.id,
      ...store
        .all('SELECT user_id FROM members WHERE conversation_id=?', id)
        .map((row: any) => row.user_id as string),
    ]);
    const activeRuns = store.all(
      "SELECT id FROM runs WHERE conversation_id=? AND state NOT IN ('completed','cancelled','failed','interrupted')",
      id,
    );
    if (activeRuns.some((run: any) => supervisor.active.has(run.id)))
      throw new ApiError(
        409,
        'The channel still has active work. Archive it first and try again once work has stopped.',
      );
    const { paths } = store.db.transaction(() => purgeConversation(id))();
    for (const path of paths)
      if (existsSync(path))
        try {
          unlinkSync(path);
        } catch {
          /* already inaccessible */
        }
    for (const viewer of users)
      store.emit('workspace.changed', null, { channelId: id, deleted: true }, viewer);
    return { ok: true };
  });
  app.post('/api/invites', async (req) => {
    owner(req);
    const token = randomBytes(24).toString('base64url');
    store.run(
      'INSERT INTO invites VALUES(?,?,?,0)',
      hash(token),
      new Date(Date.now() + 86400000).toISOString(),
      user(req).id,
    );
    return { token, expiresInHours: 24 };
  });
  app.post('/api/invite/accept', async (req, reply) => {
    const b = z
      .object({ token: z.string(), name: z.string().min(1).max(80), password: z.string().min(12) })
      .parse(req.body);
    const id = uid();
    store.db.transaction(() => {
      const accepted = store.run(
        'UPDATE invites SET used=1 WHERE hash=? AND used=0 AND expires_at>?',
        hash(b.token),
        now(),
      );
      if (!accepted.changes) throw new ApiError(400, 'Invitation is expired or already used.');
      if (store.one('SELECT 1 FROM humans WHERE lower(name)=lower(?)', b.name))
        throw new ApiError(409, 'Choose a distinct display name.');
      store.run(
        'INSERT INTO humans VALUES(?,?,?,?,?)',
        id,
        b.name,
        'member',
        passwordHash(b.password),
        now(),
      );
    })();
    store.ensureTeam();
    setSession(reply, id);
    return store.user(id);
  });
  app.get('/api/conversations/:id/messages', async (req) => {
    const id = (req.params as any).id;
    store.authorize(user(req).id, id, true);
    const q = req.query as any;
    const threadId = q.threadId || null;
    const conversation = store.one('SELECT * FROM conversations WHERE id=?', id);
    if (q.agentView === '1' && conversation.employee_id && !threadId) {
      if (!store.canUseEmployee(user(req).id, conversation.employee_id))
        throw new ApiError(403, 'Agent unavailable');
      const runs = store.all(
        'SELECT r.* FROM runs r JOIN members m ON m.conversation_id=r.conversation_id AND m.user_id=? WHERE r.employee_id=? ORDER BY r.created_at DESC LIMIT 100',
        user(req).id,
        conversation.employee_id,
      );
      const messages = store
        .all(
          `SELECT msg.* FROM messages msg JOIN members m ON m.conversation_id=msg.conversation_id AND m.user_id=?
        WHERE msg.seq<? AND (msg.conversation_id=? OR msg.id IN (SELECT response_id FROM runs WHERE employee_id=?) OR msg.id IN (SELECT message_id FROM runs WHERE employee_id=?) OR (msg.author_id=? AND msg.conversation_id IN (SELECT id FROM conversations WHERE kind='channel')))
        ORDER BY msg.seq DESC LIMIT 80`,
          user(req).id,
          q.before ? Number(q.before) : Number.MAX_SAFE_INTEGER,
          id,
          conversation.employee_id,
          conversation.employee_id,
          conversation.employee_id,
        )
        .reverse()
        .map((row) => store.message(row, q.activity === 'summary'));
      return {
        messages,
        runs: runs.map((r: any) => ({
          ...r,
          limit: store.setting('run.limit.' + r.id),
          autoResume: store.setting('run.autoResume.' + r.id, false),
        })),
        decisions: store
          .all(
            "SELECT d.* FROM decisions d JOIN runs r ON r.id=d.run_id JOIN members m ON m.conversation_id=r.conversation_id AND m.user_id=? WHERE r.employee_id=? AND d.user_id=? AND d.state='pending'",
            user(req).id,
            conversation.employee_id,
            user(req).id,
          )
          .map((d) => ({ ...d, ...JSON.parse(d.data) })),
        attachments: store.all(
          'SELECT a.id,a.name,a.mime,a.size FROM attachments a JOIN members m ON m.conversation_id=a.conversation_id AND m.user_id=? WHERE a.id IN (SELECT value FROM messages msg,json_each(msg.attachments) WHERE msg.id IN (SELECT response_id FROM runs WHERE employee_id=?) OR msg.conversation_id=?)',
          user(req).id,
          conversation.employee_id,
          id,
        ),
      };
    }
    return {
      messages: store.messages(
        id,
        q.before ? Number(q.before) : undefined,
        threadId,
        q.activity === 'summary',
      ),
      runs: store
        .all(
          "SELECT * FROM runs WHERE conversation_id=? AND COALESCE(thread_id,'')=? ORDER BY created_at DESC LIMIT 100",
          id,
          threadId || '',
        )
        .map((r: any) => ({
          ...r,
          limit: store.setting('run.limit.' + r.id),
          autoResume: store.setting('run.autoResume.' + r.id, false),
        })),
      decisions: store
        .all(
          "SELECT d.* FROM decisions d JOIN runs r ON r.id=d.run_id WHERE r.conversation_id=? AND d.user_id=? AND d.state='pending'",
          id,
          user(req).id,
        )
        .map((d) => ({ ...d, ...JSON.parse(d.data) })),
      attachments: store.all(
        'SELECT id,name,mime,size FROM attachments WHERE conversation_id=?',
        id,
      ),
    };
  });
  app.get('/api/messages/:id', async (req) => {
    const row = store.one('SELECT * FROM messages WHERE id=?', (req.params as any).id);
    if (!row) throw new ApiError(404, 'Message unavailable');
    store.authorize(user(req).id, row.conversation_id, true);
    return store.message(row, (req.query as any).activity === 'summary');
  });
  app.get('/api/messages/:id/activities/:activityId', async (req, reply) => {
    const { id, activityId } = req.params as any;
    const row = store.one('SELECT * FROM messages WHERE id=?', id);
    if (!row || row.deleted_at) throw new ApiError(404, 'Message unavailable');
    store.authorize(user(req).id, row.conversation_id, true);
    const run = row.run_id && store.one('SELECT employee_id FROM runs WHERE id=?', row.run_id);
    if (!run || !store.canUseEmployee(user(req).id, run.employee_id))
      throw new ApiError(403, 'Agent unavailable');
    const activity = store.one(
      'SELECT data FROM activities WHERE id=? AND run_id=?',
      activityId,
      row.run_id,
    );
    if (!activity) throw new ApiError(404, 'Activity unavailable');
    reply.header('Cache-Control', 'no-store');
    return JSON.parse(activity.data);
  });
  app.patch('/api/messages/:id', async (req) => {
    const id = (req.params as any).id;
    const row = store.one('SELECT * FROM messages WHERE id=?', id);
    if (!row) throw new ApiError(404, 'Message unavailable');
    store.authorize(user(req).id, row.conversation_id);
    if (row.kind !== 'human' || row.author_id !== user(req).id)
      throw new ApiError(403, 'You can only edit your own messages.');
    if (row.deleted_at) throw new ApiError(409, 'This message has been deleted.');
    const { text } = z.object({ text: z.string().max(100000) }).parse(req.body);
    if (!text.trim() && JSON.parse(row.attachments).length === 0)
      throw new ApiError(400, 'A message cannot be empty.');
    const changed = store.run(
      'UPDATE messages SET text=?,edited_at=? WHERE id=? AND deleted_at IS NULL',
      text,
      now(),
      id,
    );
    if (!changed.changes)
      throw new ApiError(409, 'This message has changed. Reload and try again.');
    const message = store.message(store.one('SELECT * FROM messages WHERE id=?', id));
    store.emit('message.edited', row.conversation_id, message);
    return message;
  });
  app.delete('/api/messages/:id', async (req) => {
    const id = (req.params as any).id;
    const row = store.one('SELECT * FROM messages WHERE id=?', id);
    if (!row) throw new ApiError(404, 'Message unavailable');
    store.authorize(user(req).id, row.conversation_id);
    if (row.kind !== 'human' || row.author_id !== user(req).id)
      throw new ApiError(403, 'You can only delete your own messages.');
    if (row.deleted_at) throw new ApiError(409, 'This message has already been deleted.');
    const activeRuns = store.all(
      "SELECT id,user_id FROM runs WHERE message_id=? AND state IN ('accepted','dispatching','running','waiting_input','waiting_permission','provider_limited','cancelling')",
      id,
    );
    const inboxUsers = store.all('SELECT user_id FROM inbox WHERE message_id=?', id);
    const deletedAt = now();
    store.db.transaction(() => {
      const changed = store.run(
        'UPDATE messages SET text=?,attachments=?,deleted_at=?,edited_at=NULL WHERE id=? AND deleted_at IS NULL',
        '',
        '[]',
        deletedAt,
        id,
      );
      if (!changed.changes) throw new ApiError(409, 'This message has already been deleted.');
      store.run(
        "UPDATE outbox SET status='cancelled' WHERE message_id=? AND status IN ('pending','new','claimed')",
        id,
      );
      store.run('DELETE FROM inbox WHERE message_id=?', id);
    })();
    for (const run of activeRuns)
      if (supervisor.active.has(run.id)) {
        try {
          supervisor.cancel(run.user_id, run.id);
        } catch {
          // The run may have completed between the snapshot and cancellation.
        }
      }
    const message = store.message(store.one('SELECT * FROM messages WHERE id=?', id));
    store.emit('message.deleted', row.conversation_id, message);
    for (const inboxUser of inboxUsers) store.emit('inbox.changed', null, {}, inboxUser.user_id);
    return message;
  });
  app.post('/api/conversations/:id/messages', async (req) => {
    const id = (req.params as any).id,
      b = SendMessage.parse(req.body);
    if (!b.text.trim() && !b.attachments.length)
      throw new ApiError(400, 'Write a message or attach a file.');
    const m = store.accept(user(req), id, b);
    store.run(
      'DELETE FROM drafts WHERE user_id=? AND conversation_id=? AND thread_id=?',
      user(req).id,
      id,
      b.threadId || '',
    );
    // Human corrections stop this conversation's current turn. Dispatch is
    // serialized per agent, so the correction resumes after the old turn exits.
    for (const job of store.all('SELECT employee_id FROM outbox WHERE message_id=?', m.id))
      for (const run of store.all(
        "SELECT id FROM runs WHERE user_id=? AND employee_id=? AND conversation_id=? AND COALESCE(thread_id,'')=? AND state IN ('running','waiting_input','waiting_permission')",
        user(req).id,
        job.employee_id,
        id,
        b.threadId || '',
      ))
        if (
          supervisor.active.has(run.id) &&
          store.one('SELECT message_id FROM runs WHERE id=?', run.id)?.message_id !== m.id
        )
          supervisor.cancel(user(req).id, run.id);
    queueMicrotask(() => void supervisor.dispatch());
    return m;
  });
  app.post('/api/conversations/:id/read', async (req) => {
    const id = (req.params as any).id;
    store.authorize(user(req).id, id, true);
    const { seq, agentView } = z
      .object({ seq: z.number().int().nonnegative(), agentView: z.boolean().optional() })
      .parse(req.body);
    const employeeId = store.one(
      'SELECT employee_id FROM conversations WHERE id=?',
      id,
    )?.employee_id;
    if (agentView && employeeId && store.canUseEmployee(user(req).id, employeeId)) {
      store.run(
        'UPDATE inbox SET seen=1 WHERE user_id=? AND message_id IN (SELECT id FROM messages WHERE author_id=? AND seq<=?)',
        user(req).id,
        employeeId,
        seq,
      );
      store.emit('inbox.changed', null, {}, user(req).id);
    }
    const max = store.one(
      'SELECT COALESCE(MAX(seq),0) seq FROM messages WHERE conversation_id=?',
      id,
    ).seq;
    store.run(
      'UPDATE members SET last_read=MAX(last_read,?) WHERE user_id=? AND conversation_id=?',
      Math.min(seq, max),
      user(req).id,
      id,
    );
    return { ok: true };
  });
  app.get('/api/conversations/:id/draft', async (req) => {
    const id = (req.params as any).id;
    store.authorize(user(req).id, id);
    const row = store.one(
      'SELECT data FROM drafts WHERE user_id=? AND conversation_id=? AND thread_id=?',
      user(req).id,
      id,
      (req.query as any).threadId || '',
    );
    return row ? JSON.parse(row.data) : { text: '', attachments: [] };
  });
  app.put('/api/conversations/:id/draft', async (req) => {
    const id = (req.params as any).id;
    store.authorize(user(req).id, id);
    const b = z
      .object({
        text: z.string().max(100000),
        attachments: z.array(z.string()).max(30),
        threadId: z.string().default(''),
      })
      .parse(req.body);
    store.run(
      'INSERT INTO drafts VALUES(?,?,?,?) ON CONFLICT(user_id,conversation_id,thread_id) DO UPDATE SET data=excluded.data',
      user(req).id,
      id,
      b.threadId,
      JSON.stringify(b),
    );
    return { ok: true };
  });
  app.post('/api/conversations/:id/attachments', async (req) => {
    const id = (req.params as any).id;
    store.authorize(user(req).id, id);
    const part = await req.file();
    if (!part) throw new ApiError(400, 'Choose a file.');
    const bytes = await part.toBuffer();
    if (part.file.truncated) throw new ApiError(413, 'Files must be smaller than 25 MB.');
    let mime = 'application/octet-stream';
    if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
      mime = 'image/png';
    else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) mime = 'image/jpeg';
    else if (bytes.subarray(0, 6).toString().startsWith('GIF8')) mime = 'image/gif';
    else if (bytes.subarray(8, 12).toString() === 'WEBP') mime = 'image/webp';
    else if (bytes.subarray(0, 5).toString() === '%PDF-') mime = 'application/pdf';
    else if (/\.(txt|md|csv|json|log|ts|js|py)$/i.test(part.filename)) mime = 'text/plain';
    const attachmentId = uid(),
      path = join(store.dir, 'artifacts', attachmentId);
    writeFileSync(path, bytes, { mode: 0o600 });
    const name = part.filename.replace(/[\\/\x00-\x1f]/g, '_').slice(0, 200);
    store.run(
      'INSERT INTO attachments VALUES(?,?,?,?,?,?,?,?)',
      attachmentId,
      user(req).id,
      id,
      name,
      mime,
      bytes.length,
      path,
      now(),
    );
    return { id: attachmentId, name, mime, size: bytes.length };
  });
  app.get('/api/attachments/:id', async (req, reply) => {
    const a = store.one('SELECT * FROM attachments WHERE id=?', (req.params as any).id);
    if (!a) throw new ApiError(404, 'File unavailable');
    store.authorize(user(req).id, a.conversation_id, true);
    reply.type(a.mime).header('Content-Security-Policy', "default-src 'none'; sandbox");
    if (!a.mime.startsWith('image/') || (req.query as any).download === '1')
      reply.header(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(a.name)}`,
      );
    return reply.send(createReadStream(a.path));
  });
  app.post('/api/runs/:id/cancel', async (req) => {
    supervisor.cancel(user(req).id, (req.params as any).id);
    return { ok: true };
  });
  app.patch('/api/runs/:id/auto-resume', async (req) => {
    const id = (req.params as any).id;
    const run = store.one('SELECT * FROM runs WHERE id=?', id);
    if (!run || run.user_id !== user(req).id) throw new ApiError(404, 'Run unavailable');
    store.authorize(user(req).id, run.conversation_id);
    if (run.state !== 'provider_limited')
      throw new ApiError(409, 'This run is no longer waiting on a provider limit.');
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    store.set('run.autoResume.' + id, enabled);
    store.emit(
      'run.changed',
      run.conversation_id,
      {
        ...run,
        limit: store.setting('run.limit.' + id),
        autoResume: enabled,
      },
      user(req).id,
    );
    return { ok: true, enabled };
  });
  app.post('/api/decisions/:id', async (req) => {
    const b = z
      .object({
        version: z.number().int(),
        allow: z.boolean().optional(),
        answers: z.record(z.string(), z.any()).optional(),
      })
      .parse(req.body);
    supervisor.resolve(user(req).id, (req.params as any).id, b.version, b);
    return { ok: true };
  });
  app.get('/api/usage', async (req) => ({
    runs: store
      .all(
        'SELECT r.id,r.employee_id,r.created_at,r.usage,e.data FROM runs r JOIN employees e ON e.id=r.employee_id WHERE r.user_id=? AND r.usage IS NOT NULL ORDER BY r.created_at DESC LIMIT 500',
        user(req).id,
      )
      .map((r) => ({
        id: r.id,
        employeeId: r.employee_id,
        name: JSON.parse(r.data).name,
        harness: JSON.parse(r.data).harness,
        createdAt: r.created_at,
        usage: JSON.parse(r.usage),
      })),
  }));
  app.get('/api/usage/accounts', async (req) => {
    owner(req);
    const providers = await supervisor.infos();
    const quota = quotaForecasts(store, providers);
    return { providers, ...quota, sampledAt: now() };
  });
  app.get('/api/search', async (req) => {
    const q = z
      .string()
      .max(200)
      .parse((req.query as any).q || '');
    return store
      .all(
        `SELECT msg.* FROM messages msg JOIN members m ON m.conversation_id=msg.conversation_id WHERE m.user_id=? AND msg.text LIKE ? ESCAPE '\\' ORDER BY msg.seq DESC LIMIT 50`,
        user(req).id,
        '%' + q.replace(/[\\%_]/g, '\\$&') + '%',
      )
      .map((r) => store.message(r));
  });
  app.get('/api/memories', async (req) =>
    store.all(
      "SELECT n.*,c.name source_conversation_name,src.author_name source_author,src.created_at source_created_at FROM memories n LEFT JOIN conversations c ON c.id=n.conversation_id LEFT JOIN messages src ON src.id=n.source_id WHERE n.deleted=0 AND ((n.scope='workspace' AND n.owner_id=?) OR (n.scope='conversation' AND EXISTS (SELECT 1 FROM members m WHERE m.conversation_id=n.conversation_id AND m.user_id=?))) ORDER BY n.created_at DESC LIMIT 200",
      user(req).id,
      user(req).id,
    ),
  );
  app.patch('/api/memories/:id', async (req) => {
    const b = z
      .object({ content: z.string().max(8000).optional(), deleted: z.boolean().optional() })
      .parse(req.body);
    const m = store.one('SELECT * FROM memories WHERE id=?', (req.params as any).id);
    if (!m) throw new ApiError(404, 'Memory unavailable');
    if (m.scope === 'workspace') {
      if (m.owner_id !== user(req).id) throw new ApiError(403, 'Memory unavailable');
    } else store.authorize(user(req).id, m.conversation_id);
    store.db.transaction(() => {
      store.run(
        'UPDATE memories SET content=?,deleted=?,version=version+1 WHERE id=?',
        b.content ?? m.content,
        b.deleted ? 1 : 0,
        m.id,
      );
      store.run('DELETE FROM memory_fts WHERE id=?', m.id);
      if (!b.deleted) store.run('INSERT INTO memory_fts VALUES(?,?)', m.id, b.content ?? m.content);
      // Subsequent runs must not resume a native session carrying a forgotten note.
      if (m.scope === 'workspace')
        store.run(
          'DELETE FROM native_sessions WHERE context_key IN (SELECT context_key FROM runs WHERE user_id=?)',
          user(req).id,
        );
      else
        store.run(
          'DELETE FROM native_sessions WHERE context_key IN (SELECT context_key FROM runs WHERE conversation_id=?)',
          m.conversation_id,
        );
    })();
    return { ok: true };
  });
  app.get('/api/events', async (req, reply) => {
    const u = user(req);
    let cursor = Number(req.headers['last-event-id'] || (req.query as any).after || 0);
    if (!Number.isFinite(cursor)) cursor = 0;
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    let closed = false;
    let heartbeat: NodeJS.Timeout;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      store.bus.off('event', send);
    };
    const end = () => {
      if (closed) return;
      if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
      cleanup();
    };
    const write = (e: any) => {
      if (closed || reply.raw.destroyed || reply.raw.writableEnded) {
        cleanup();
        return;
      }
      if (e.cursor <= cursor) return;
      cursor = e.cursor;
      if (reply.raw.writableLength > 1024 * 1024) {
        end();
        return;
      }
      const payload = (req.query as any).activity === 'summary' ? summaryEvent(e) : e;
      reply.raw.write(`id: ${e.cursor}\ndata: ${JSON.stringify(payload)}\n\n`);
    };
    const send = (e: any) => {
      if (closed) return;
      if (!store.session(req.cookies.workspace || '')) {
        end();
        return;
      }
      if (store.allowedEvent(u.id, e)) write(e);
    };
    store.bus.on('event', send);
    let page;
    do {
      page = store.eventsAfter(u.id, cursor);
      for (const e of page) {
        write(e);
        if (closed) break;
      }
    } while (!closed && page.length === 500);
    heartbeat = setInterval(() => {
      if (closed || reply.raw.destroyed || reply.raw.writableEnded) {
        cleanup();
        return;
      }
      if (!store.session(req.cookies.workspace || '')) end();
      else reply.raw.write(': keepalive\n\n');
    }, 25000);
    reply.raw.on('close', cleanup);
    reply.raw.on('error', cleanup);
  });
  app.get('/api/proposals', async (req) => store.setting('proposals.' + user(req).id, []));
  app.post('/api/proposals/:id/approve', async (req) => {
    owner(req);
    const proposals = store.setting('proposals.' + user(req).id, []);
    const proposal = proposals.find((p: any) => p.id === (req.params as any).id);
    if (!proposal) throw new ApiError(404, 'Proposal unavailable');
    if (proposal.approved) return proposal;
    if (proposal.superseded) throw new ApiError(409, 'A newer proposal replaced this one.');
    const version = (req.body as any)?.version;
    if (version !== proposal.version) throw new ApiError(409, 'The proposal has changed.');
    store.db.transaction(() => {
      proposal.employees = proposal.employees.map((e: any) =>
        store.createEmployee(user(req).id, EmployeeInput.parse(e)),
      );
      proposal.approved = true;
      handoffTeam(store, user(req), proposal);
      store.set('proposals.' + user(req).id, proposals);
    })();
    void supervisor.dispatch();
    return proposal;
  });
  app.post('/api/proposals/:id/brief', async (req) => {
    owner(req);
    const proposals = store.setting('proposals.' + user(req).id, []);
    const proposal = proposals.find((p: any) => p.id === (req.params as any).id);
    if (!proposal?.approved) throw new ApiError(409, 'Approve the team first.');
    store.db.transaction(() => {
      handoffTeam(store, user(req), proposal);
      store.set('proposals.' + user(req).id, proposals);
    })();
    void supervisor.dispatch();
    return proposal;
  });
  const broker = new ConnectionBroker(
    store,
    () => process.env.WORKSPACE_PUBLIC_URL || supervisor.origin,
    supervisor,
  );
  registerConnectionRoutes(app, broker);
  await registerWorkspaceTools(app, store, supervisor, broker, maintenance);
  app.get('/api/maintenance', async (req) => {
    owner(req);
    return maintenance.status();
  });
  app.post('/api/maintenance/prepare', async (req) => {
    owner(req);
    return maintenance.prepare(
      z.object({ candidateRoot: z.string().optional() }).parse(req.body).candidateRoot,
    );
  });
  app.post('/api/maintenance/execute', async (req) => {
    owner(req);
    return maintenance.execute(z.object({ jobId: z.string().uuid() }).parse(req.body).jobId);
  });
  await registerNotifications(app, store);
  registerOperations(app, store, supervisor);
  const staticRoot = options.staticRoot || resolve('dist/web');
  if (existsSync(staticRoot)) {
    await app.register(staticFiles, { root: staticRoot });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/mcp'))
        return reply.code(404).send({ error: 'Not found' });
      return reply.sendFile('index.html');
    });
  }
  app.addHook('onClose', async () => {
    maintenance.close();
    await supervisor.dispose();
    store.close();
  });
  return { app, supervisor, maintenance };
}
