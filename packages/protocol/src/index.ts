/**
 * Shared types for agentd ⇄ web. Everything the UI renders is a normalized ChatItem,
 * independent of which CLI (claude / codex) produced it.
 */

export type AgentKind = 'claude' | 'codex';

/** `${agent}:${nativeId}` — nativeId is the Claude session UUID or the Codex thread id. */
export type ChatId = string;

export type ChatStatus = 'idle' | 'starting' | 'running' | 'waiting' | 'error';

export interface ChatSummary {
  id: ChatId;
  agent: AgentKind;
  nativeId: string;
  cwd: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  status: ChatStatus;
  /** Created from this web UI (otherwise: terminal, CloudCLI, …). */
  origin: 'web' | 'terminal' | 'other';
  pinned?: boolean;
  unread?: boolean;
  model?: string;
  /** 'chat' — a conversation outside projects (folder ~/chat/<date-id>), 'code' — work in a project. */
  mode?: ChatMode;
}

export type ChatMode = 'chat' | 'code';

export interface ProjectInfo {
  path: string;
  name: string;
  /** Most recent chat activity in this folder (ms). */
  lastActivity: number;
  chatCount: number;
  isGit: boolean;
}

// ---------------------------------------------------------------- items

export interface BaseItem {
  id: string;
  ts?: number;
  /** Tool-use id of the subagent (Task) this item belongs to. */
  parentId?: string | null;
}

export interface ImageRef {
  mediaType: string;
  /** data: URL for previews (only for small images / just-sent ones). */
  dataUrl?: string;
  name?: string;
}

/** A file the user attached: stored on the server, the agent gets its path. */
export interface AttachedFile {
  path: string;
  name: string;
  size: number;
  mediaType?: string;
}

export interface UserItem extends BaseItem {
  kind: 'user';
  text: string;
  images?: ImageRef[];
  files?: AttachedFile[];
  /** Sent while the agent was busy; waits in the CLI queue. */
  queued?: boolean;
}

export interface AssistantItem extends BaseItem {
  kind: 'assistant';
  text: string;
  streaming?: boolean;
  model?: string;
}

export interface ThinkingItem extends BaseItem {
  kind: 'thinking';
  text: string;
  tokens?: number;
  streaming?: boolean;
}

export type ToolStatus = 'pending' | 'running' | 'done' | 'error' | 'denied' | 'interrupted';

export type ToolCategory =
  | 'bash'
  | 'edit'
  | 'write'
  | 'read'
  | 'search'
  | 'web'
  | 'task'
  | 'todo'
  | 'plan'
  | 'question'
  | 'mcp'
  | 'skill'
  | 'other';

export interface FileDiff {
  path: string;
  kind: 'add' | 'delete' | 'update';
  /** Unified diff text (hunks). */
  unified?: string;
  oldText?: string;
  newText?: string;
}

export interface ToolItem extends BaseItem {
  kind: 'tool';
  /** Raw tool name from the CLI (Bash, Edit, commandExecution, …). */
  tool: string;
  category: ToolCategory;
  /** One-line human description: the command, the file path, the query… */
  title: string;
  subtitle?: string;
  input: unknown;
  output?: string;
  outputTruncated?: boolean;
  status: ToolStatus;
  exitCode?: number | null;
  diffs?: FileDiff[];
  durationMs?: number | null;
  /** Bash started with run_in_background. */
  backgroundTaskId?: string;
}

export interface NoticeItem extends BaseItem {
  kind: 'notice';
  level: 'info' | 'warn' | 'error';
  text: string;
}

export type ChatItem = UserItem | AssistantItem | ThinkingItem | ToolItem | NoticeItem;

// ---------------------------------------------------------------- live state

export interface ApprovalOption {
  id: string;
  label: string;
}

export interface Question {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
}

export interface Approval {
  id: string;
  kind: 'tool' | 'command' | 'fileChange' | 'question' | 'plan';
  tool: string;
  title: string;
  /** Extra line under the title (reason, cwd). */
  detail?: string;
  input?: unknown;
  command?: string;
  diffs?: FileDiff[];
  /** "Allow for this session" / "always allow X" style shortcuts offered by the CLI. */
  options?: ApprovalOption[];
  questions?: Question[];
  plan?: string;
  toolItemId?: string;
  createdAt: number;
}

export interface ApprovalDecision {
  approvalId: string;
  decision: 'allow' | 'deny';
  /** One of Approval.options (e.g. allow for session). */
  optionId?: string;
  message?: string;
  /** AskUserQuestion: question text → chosen label(s), comma-joined. */
  answers?: Record<string, string>;
}

export interface Usage {
  contextTokens: number;
  contextWindow: number;
  /** 0..100 */
  percent: number;
}

export interface LimitWindow {
  id: string;
  label: string;
  /** 0..100 */
  usedPercent: number;
  /** unix seconds */
  resetsAt?: number;
  status?: string;
}

export interface AgentLimits {
  agent: AgentKind;
  plan?: string;
  windows: LimitWindow[];
  updatedAt: number;
}

export interface BgTask {
  id: string;
  description: string;
  type: string;
  status: 'running' | 'completed' | 'failed' | 'stopped' | 'killed';
  toolItemId?: string;
  outputFile?: string;
  startedAt: number;
  endedAt?: number;
  summary?: string;
}

export interface TodoEntry {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface ChatSettings {
  model?: string;
  effort?: string;
  permissionMode?: string;
}

export interface ChatState {
  summary: ChatSummary;
  items: ChatItem[];
  approvals: Approval[];
  usage?: Usage;
  tasks: BgTask[];
  todos: TodoEntry[];
  settings: ChatSettings;
  /** A CLI process / thread subscription is attached right now. */
  live: boolean;
  /** Another process (terminal) is using this session. */
  busyElsewhere?: string;
  /** Last error from the CLI (shown as a banner). */
  error?: string;
}

// ---------------------------------------------------------------- capabilities

export interface ModelInfo {
  id: string;
  label: string;
  description?: string;
  efforts: string[];
  defaultEffort?: string;
  isDefault?: boolean;
}

export interface PermissionModeInfo {
  id: string;
  label: string;
  description: string;
}

export interface SlashCommand {
  name: string;
  description?: string;
  argumentHint?: string;
}

export interface AgentCapabilities {
  agent: AgentKind;
  available: boolean;
  error?: string;
  plan?: string;
  models: ModelInfo[];
  permissionModes: PermissionModeInfo[];
  defaults: ChatSettings;
  commands: SlashCommand[];
}

// ---------------------------------------------------------------- user preferences (server-side)

export interface Prefs {
  /** Send an unanswered approval / question to Telegram after this many seconds (0 = off). */
  telegramDelaySec: number;
}

export interface PrefsState extends Prefs {
  /** The agents' Telegram bot is configured (~/secrets/agents-telegram.env). */
  telegramReady: boolean;
}

// ---------------------------------------------------------------- websocket

export interface SendPayload {
  text: string;
  images?: { mediaType: string; data: string; name?: string }[];
  /** Uploaded beforehand via POST /api/upload. */
  files?: AttachedFile[];
}

export type ClientMessage =
  | { t: 'subscribe'; chatId: ChatId }
  | { t: 'unsubscribe'; chatId: ChatId }
  | { t: 'visible'; chatId: ChatId | null }
  | {
      t: 'create';
      reqId: string;
      agent: AgentKind;
      /** Ignored for mode 'chat': the server makes a fresh folder under ~/chat. */
      cwd: string;
      mode?: ChatMode;
      settings: ChatSettings;
      message: SendPayload;
    }
  | { t: 'send'; chatId: ChatId; message: SendPayload }
  | { t: 'interrupt'; chatId: ChatId }
  | { t: 'decide'; chatId: ChatId; decision: ApprovalDecision }
  | { t: 'settings'; chatId: ChatId; settings: ChatSettings }
  | { t: 'stopTask'; chatId: ChatId; taskId: string }
  | { t: 'meta'; chatId: ChatId; pinned?: boolean; title?: string }
  | { t: 'seen'; chatId: ChatId }
  | { t: 'release'; chatId: ChatId }
  | { t: 'prefs'; prefs: Partial<Prefs> }
  | { t: 'ping' };

export type ServerMessage =
  | { t: 'hello'; version: string; host: string }
  | { t: 'chats'; chats: ChatSummary[] }
  | { t: 'chat'; chat: ChatSummary }
  | { t: 'chatRemoved'; chatId: ChatId }
  | { t: 'limits'; limits: AgentLimits[] }
  | { t: 'snapshot'; chatId: ChatId; state: ChatState }
  | { t: 'item'; chatId: ChatId; item: ChatItem }
  | { t: 'delta'; chatId: ChatId; itemId: string; text: string }
  | { t: 'state'; chatId: ChatId; patch: Partial<Omit<ChatState, 'items' | 'summary'>> }
  | { t: 'created'; reqId: string; chatId: ChatId }
  | { t: 'error'; message: string; chatId?: ChatId; reqId?: string }
  | { t: 'prefs'; prefs: PrefsState }
  | { t: 'pong' };

// ---------------------------------------------------------------- http api

export interface GitStatus {
  isRepo: boolean;
  branch?: string;
  ahead?: number;
  behind?: number;
  files: { path: string; status: string; staged: boolean }[];
  diff: string;
  truncated?: boolean;
}

export interface DirEntry {
  name: string;
  path: string;
  dir: boolean;
  size?: number;
}

export function chatId(agent: AgentKind, nativeId: string): ChatId {
  return `${agent}:${nativeId}`;
}

export function parseChatId(id: ChatId): { agent: AgentKind; nativeId: string } {
  const i = id.indexOf(':');
  return { agent: id.slice(0, i) as AgentKind, nativeId: id.slice(i + 1) };
}
