/**
 * Shared types for agentd ⇄ web. Everything the UI renders is a normalized ChatItem,
 * independent of which CLI (claude / codex / agy) produced it.
 */

export type AgentKind = 'claude' | 'codex' | 'antigravity';

export const AGENTS: AgentKind[] = ['claude', 'codex', 'antigravity'];

/** `${agent}:${nativeId}` — nativeId is the Claude session UUID, the Codex thread id or the Antigravity conversation id. */
export type ChatId = string;

export type TaskStage = 'in-progress' | 'done';

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
  deleted?: boolean;
  taskStage?: TaskStage;
  projectArchived?: boolean;
  projectDeleted?: boolean;
  unread?: boolean;
  model?: string;
  /** 'chat' — a conversation outside projects (folder ~/chat/<date-id>), 'code' — work in a project. */
  mode?: ChatMode;
  /** Branched off this chat (a fork). */
  forkOf?: ChatId;
  /** This chat is the original's dialogue rolled back to an earlier point; «Вернуть как было» shows `rewoundFrom` again. */
  rewoundFrom?: ChatId;
  /** Kept on disk but not listed (the original of a rollback, or a rollback that was undone). */
  hidden?: boolean;
  /** In the archive: out of the main list, nothing deleted. A new message brings it back. */
  archived?: boolean;
  /** «Сообщить в Telegram, когда закончит» is on: one message when the current/next turn ends, then it switches off. */
  notifyDone?: boolean;
  /** «Продолжить в другом агенте»: this chat continues that one (its history went in as a file). */
  handoffFrom?: ChatId;
  /** …and the other way round: the latest chat this one was continued in. */
  handoffTo?: ChatId;
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

export interface QuestionOption {
  label: string;
  description?: string;
  recommended?: boolean;
}

export interface Question {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: QuestionOption[];
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
  /** AskUserQuestion / ask_question: question text → chosen label(s), comma-joined. */
  answers?: Record<string, string>;
  /** Exact list of chosen labels / custom answer per question (safe when labels contain commas). */
  answerLists?: Record<string, string[]>;
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
  /**
   * Antigravity counts limits per group of models (Gemini / Claude и GPT / Argon), each with its own 5-hour and weekly
   * window: the group's id and name, and the base model ids in it (to show the group of the chat's model).
   */
  groupId?: string;
  group?: string;
  models?: string[];
}

export interface AgentLimits {
  agent: AgentKind;
  plan?: string;
  windows: LimitWindow[];
  updatedAt: number;
  /** Last error fetching limits (e.g. agy /usage failed). Cleared on success. */
  error?: string;
  /** When `error` occurred (unix ms). */
  errorAt?: number;
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
  /** Speech-to-text model on OpenRouter (one of VOICE_MODELS). */
  voiceModel: string;
  /** Send the message right after the dictation is transcribed (no keyboard at all). */
  voiceAutoSend: boolean;
  /** Tidy the transcript with an LLM: drop fillers and stutters, English terms in Latin script. */
  voiceCleanup: boolean;
  /** LLM for the cleanup / translation (one of CLEANUP_MODELS). */
  voiceCleanupModel: string;
  /** Also translate the dictation into English. */
  voiceTranslate: boolean;
}

export interface PrefsState extends Prefs {
  /** The agents' Telegram bot is configured (~/secrets/agents-telegram.env). */
  telegramReady: boolean;
  /** OpenRouter key is present (~/secrets/openrouter.env) — cloud voice models & cleanup work. */
  voiceReady: boolean;
  /** Local GigaAM-v4 speech-to-text service (mcc-voice-local) responds to /health. */
  localVoiceReady?: boolean;
}

/** Speech-to-text models for voice input: local on-server GigaAM-v4 + OpenRouter /audio/transcriptions (Nov 2026). */
/** `wav`: the provider rejects WebM/MP4 from MediaRecorder — the browser re-encodes the take to 16 kHz mono WAV (checked 2026-11-13). */
export const VOICE_MODELS: { id: string; label: string; description: string; wav?: boolean; local?: boolean }[] = [
  { id: 'local/gigaam-v4', label: 'GigaAM-v4 (локально)', description: 'На сервере · бесплатно · 0,3–4 с, ru + en', local: true },
  { id: 'microsoft/mai-transcribe-2', label: 'Microsoft MAI-Transcribe 2', description: 'Смешанная речь (ru + en) · ≈ $0,10 / час', wav: true },
  { id: 'openai/gpt-transcribe', label: 'OpenAI GPT Transcribe', description: 'Точный, быстрый · ≈ $0,27 / час' },
  { id: 'elevenlabs/scribe-v2', label: 'ElevenLabs Scribe v2', description: 'Сильный русский · ≈ $0,22 / час' },
  { id: 'openai/whisper-large-v3', label: 'OpenAI Whisper Large v3', description: 'Дешёвый · ≈ $0,03 / час' },
];
export const DEFAULT_VOICE_MODEL = VOICE_MODELS[0].id;
export const isLocalVoiceModel = (id: string) => !!VOICE_MODELS.find((m) => m.id === id)?.local;

/** LLMs for tidying / translating a dictation (OpenRouter chat). Checked 2026-11-13 on mixed ru/en dictation. */
export const CLEANUP_MODELS: { id: string; label: string; description: string }[] = [
  { id: 'google/gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash Lite', description: 'Точнее всех сохраняет формулировки · 0,5–1 с' },
  { id: 'openai/gpt-6-luna', label: 'GPT 6 Luna', description: 'Чуть сокращает · 1,5–2 с, перевод до 6 с' },
  { id: 'anthropic/claude-haiku-5.5', label: 'Claude Haiku 5.5', description: 'Иногда оставляет «Айфон» кириллицей · ~1 с' },
];
export const DEFAULT_CLEANUP_MODEL = CLEANUP_MODELS[0].id;

/** A dictation kept on the server (audio + transcript) — history in Settings → Голос, retry, delete. */
export interface VoiceRecord {
  id: string;
  createdAt: number;
  /** Absolute path of the audio (open with /api/raw). */
  file: string;
  mediaType: string;
  size: number;
  durationSec?: number;
  status: 'ok' | 'error';
  /** Speech-to-text output as is. */
  raw?: string;
  /** What goes into the message: cleaned / translated, or `raw` when the cleanup is off or failed. */
  text?: string;
  model?: string;
  cleanupModel?: string;
  translated?: boolean;
  /** Cleanup failed — `text` is the raw transcript. */
  cleanupError?: string;
  error?: string;
  ms?: number;
}

/** POST /api/transcribe, POST /api/voice/retry → VoiceRecord; an error response carries `{ error, id }`. */
export type TranscribeResult = VoiceRecord;

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
  /**
   * Branch the dialogue (files are not touched). `beforeItemId` — a user message: the branch keeps everything before it
   * (absent: the whole chat). `rewind` — the branch replaces the chat: the original is hidden and can be brought back.
   * Answered with `created` (reqId).
   */
  | { t: 'fork'; reqId: string; chatId: ChatId; title: string; beforeItemId?: string; rewind?: boolean }
  /**
   * Continue the dialogue in another agent: a new chat (same folder) whose first message carries the whole history as a
   * Markdown file; the new agent sums it up and waits. Answered with `created` (reqId).
   * `cwd` — «Перенести в проект»: a conversation goes on in this project folder (any agent, the same one too).
   */
  | { t: 'handoff'; reqId: string; chatId: ChatId; agent: AgentKind; settings: ChatSettings; note?: string; cwd?: string }
  /** Undo a rollback: show the original again, hide this branch. */
  | { t: 'unrewind'; chatId: ChatId }
  | { t: 'send'; chatId: ChatId; message: SendPayload }
  | { t: 'interrupt'; chatId: ChatId }
  | { t: 'decide'; chatId: ChatId; decision: ApprovalDecision }
  | { t: 'settings'; chatId: ChatId; settings: ChatSettings }
  | { t: 'stopTask'; chatId: ChatId; taskId: string }
  | { t: 'meta'; chatId: ChatId; pinned?: boolean; title?: string; archived?: boolean; taskStage?: TaskStage | null; notifyDone?: boolean }
  | { t: 'removeChat'; chatId: ChatId; confirm: string }
  | { t: 'projectMeta'; cwd: string; action: 'archive' | 'restore' | 'delete'; confirm: string }
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
