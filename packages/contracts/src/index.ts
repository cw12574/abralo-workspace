import { z } from 'zod';
export const Harness = z.enum(['codex', 'claude', 'opencode']);
export type Harness = z.infer<typeof Harness>;
export const SendMessage = z.object({
  text: z.string().max(100000),
  key: z.string().min(8).max(100),
  threadId: z.string().nullable().optional(),
  attachments: z.array(z.string()).max(30).default([]),
  recipients: z.array(z.string()).max(100).default([]),
  workingDirectory: z.string().max(2000).nullable().optional(),
  modelOverride: z
    .object({ harness: Harness, model: z.string().min(1).max(160) })
    .nullable()
    .optional(),
  newTask: z.boolean().default(false),
});
export const EmployeeInput = z.object({
  name: z.string().trim().min(1).max(80),
  role: z.string().max(4000).default(''),
  harness: Harness,
  model: z.string().max(160).default(''),
  cwd: z.string().max(2000).default(''),
  instructions: z.string().max(16000).default(''),
  permissionMode: z.enum(['auto', 'ask', 'bypass']).default('auto'),
  canDelegate: z.boolean().default(false),
});
export type RunState =
  | 'accepted'
  | 'dispatching'
  | 'running'
  | 'waiting_input'
  | 'waiting_permission'
  | 'provider_limited'
  | 'cancelling'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'interrupted';
export const terminal = new Set<RunState>(['completed', 'cancelled', 'failed', 'interrupted']);
const transitions: Record<RunState, RunState[]> = {
  accepted: ['dispatching', 'cancelled', 'failed', 'interrupted'],
  dispatching: ['running', 'cancelling', 'failed', 'interrupted', 'provider_limited'],
  running: [
    'waiting_input',
    'waiting_permission',
    'provider_limited',
    'cancelling',
    'completed',
    'failed',
    'interrupted',
  ],
  waiting_input: ['running', 'cancelling', 'completed', 'failed', 'interrupted'],
  waiting_permission: ['running', 'cancelling', 'completed', 'failed', 'interrupted'],
  provider_limited: ['running', 'failed', 'cancelling', 'interrupted'],
  cancelling: ['cancelled', 'completed', 'failed', 'interrupted'],
  completed: [],
  cancelled: [],
  failed: [],
  interrupted: [],
};
export function validTransition(from: RunState, to: RunState) {
  return from === to || transitions[from]?.includes(to);
}
export interface Employee {
  id: string;
  name: string;
  kind: 'agent' | 'human';
  role: string;
  harness: Harness;
  model: string;
  cwd: string;
  instructions: string;
  permissionMode?: 'auto' | 'ask' | 'bypass';
  canDelegate?: boolean;
  latestWork?: { conversationId: string; threadId: string | null; state: string; name: string };
  working?: boolean;
  attentionUnread?: number;
  nextScheduledAt?: string | null;
  ownerId: string;
  dmId: string;
  createdAt: string;
  deactivatedAt?: string | null;
  deactivatedScheduleIds?: string[];
}
export interface Conversation {
  id: string;
  name: string;
  kind: 'dm' | 'human_dm';
  employeeId: string | null;
  createdAt: string;
  unread?: number;
}
export interface Message {
  id: string;
  clientKey?: string;
  conversationId: string;
  threadId: string | null;
  authorId: string;
  authorName: string;
  kind: 'human' | 'agent' | 'system';
  text: string;
  attachments: string[];
  createdAt: string;
  textUpdatedAt?: string;
  editedAt?: string;
  deletedAt?: string;
  seq: number;
  runId: string | null;
  replyCount?: number;
  activity?: Activity[];
  /** Shown version of a message that was edited and resent, starting at 1. */
  version?: number;
  versionCount?: number;
  /** The message went to an agent, so editing can resend it. */
  resendable?: boolean;
}
export interface Activity {
  id: string;
  type: string;
  title: string;
  /** A short description of what the step did, derived from its input. */
  label?: string;
  detail?: string;
  hasDetail?: boolean;
  state?: string;
  time: string;
  updatedAt?: string;
  url?: string;
  /** Length of the reply text when this step began; places the step within the text. */
  textOffset?: number;
}
export interface WorkspaceEvent {
  cursor: number;
  id: string;
  type: string;
  conversationId: string | null;
  userId: string | null;
  payload: any;
  createdAt: string;
  version: 1;
}
export interface ProviderInfo {
  harness: Harness;
  installed: boolean;
  authenticated: boolean | null;
  version: string;
  detail: string;
  models?: { id: string; name: string; isDefault?: boolean; upgrade?: string; aliases?: string[] }[];
  /** Hashed native account identity; never a credential. */
  accountKey?: string;
  catalogueError?: string;
  checkedAt?: number;
  limits?: unknown;
}
export interface AdapterEvent {
  type:
    | 'text'
    | 'final'
    | 'activity'
    | 'session'
    | 'decision'
    | 'usage'
    | 'diff'
    | 'error'
    | 'complete';
  id?: string;
  text?: string;
  data?: any;
}
export interface RunInput {
  /** Explicitly delegated review/research tasks only; never inferred from conversation text. */
  readOnly?: boolean;
  /** Human opt-in to Claude Code's user and project MCP configurations. */
  nativeMcp?: boolean;
  id: string;
  employee: Employee;
  prompt: string;
  sessionId?: string;
  resumeContext?: string;
  attachments: { path: string; mime: string; name: string }[];
  signal: AbortSignal;
  emit: (event: AdapterEvent) => void;
  decide: (request: any) => Promise<any>;
  tools?: Record<string, any>;
}
export interface Adapter {
  info(): Promise<ProviderInfo>;
  run(input: RunInput): Promise<void>;
  /** Add a message to an active turn when the provider supports live steering. */
  steer?(runId: string, message: string): Promise<boolean>;
  dispose(): Promise<void>;
}
