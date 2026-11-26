import type { Question, QuestionOption } from '@mcc-agents/protocol';

type Json = Record<string, unknown>;

const RECOMMENDED_PREFIX = /^\s*\(Recommended\)\s*/i;
const RECOMMENDED_SUFFIX = /\s*\(Recommended\)\s*$/i;

/** Strip leading/trailing «(Recommended)» tag and report whether it was present. */
export function stripRecommended(raw: string): { label: string; recommended: boolean } {
  const s = raw.trim();
  if (RECOMMENDED_PREFIX.test(s)) return { label: s.replace(RECOMMENDED_PREFIX, '').trim(), recommended: true };
  if (RECOMMENDED_SUFFIX.test(s)) return { label: s.replace(RECOMMENDED_SUFFIX, '').trim(), recommended: true };
  return { label: s, recommended: false };
}

/** True when an ACP tool_call represents Antigravity's ask_question tool. */
export function isAskQuestionTool(tc: { name?: unknown; title?: unknown }): boolean {
  const name = String(tc.name ?? '').trim();
  if (name === 'ask_question' || name === 'AskUserQuestion') return true;
  const title = String(tc.title ?? '').trim();
  return /^(run\s+)?ask_question$/i.test(title);
}

function parseOption(raw: unknown): QuestionOption | null {
  if (typeof raw === 'string') {
    const { label, recommended } = stripRecommended(raw);
    if (!label) return null;
    return recommended ? { label, recommended: true } : { label };
  }
  if (raw && typeof raw === 'object') {
    const o = raw as Json;
    const rawLabel = typeof o.label === 'string' ? o.label : typeof o.text === 'string' ? o.text : '';
    const { label, recommended } = stripRecommended(rawLabel);
    if (!label) return null;
    const opt: QuestionOption = { label };
    if (typeof o.description === 'string' && o.description.trim()) opt.description = o.description.trim();
    if (o.recommended === true || recommended) opt.recommended = true;
    return opt;
  }
  return null;
}

/** Normalize Antigravity ask_question rawInput into protocol Question[]. */
export function parseAskQuestions(rawInput: unknown): Question[] {
  if (!rawInput || typeof rawInput !== 'object') return [];
  const list = (rawInput as Json).questions;
  if (!Array.isArray(list)) return [];
  const out: Question[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const q = item as Json;
    const question = typeof q.question === 'string' ? q.question.trim() : '';
    if (!question) continue;
    const rawOpts = Array.isArray(q.options) ? q.options : [];
    const options = rawOpts.map(parseOption).filter((o): o is QuestionOption => o !== null);
    const entry: Question = {
      question,
      options,
    };
    if (typeof q.header === 'string' && q.header.trim()) entry.header = q.header.trim();
    if (q.is_multi_select === true || q.multiSelect === true) entry.multiSelect = true;
    out.push(entry);
  }
  return out;
}

function pluralQuestions(n: number): string {
  const d = n % 10;
  const h = n % 100;
  const word = d === 1 && h !== 11 ? 'вопрос' : d >= 2 && d <= 4 && (h < 12 || h > 14) ? 'вопроса' : 'вопросов';
  return `${n} ${word}`;
}

/** Compact one-line title for a collapsed ask_question ToolCard. */
export function questionToolTitle(questions: Question[]): string {
  if (!questions.length) return 'Вопрос';
  const first = questions[0].question.replace(/\s+/g, ' ').trim();
  if (questions.length === 1) return first;
  return `${pluralQuestions(questions.length)} · ${first}`;
}

function formatPart(q: Question, part: string): string {
  const clean = stripRecommended(part).label;
  const idx = q.options.findIndex((o) => o.label === part || o.label === clean);
  if (idx >= 0) return `[${idx + 1}] ${q.options[idx].label}`;
  return part.trim();
}

/**
 * Format structured answers into a clear user message for `agy acp` `session/prompt`.
 * Keeps `[N]` indices alongside option labels so both the model and a human reading history see the exact choices.
 */
export function formatAskQuestionAnswers(
  questions: Question[],
  answers?: Record<string, string>,
  answerLists?: Record<string, string[]>,
): string {
  const rows: { question: string; formatted: string }[] = [];
  for (const q of questions) {
    const rawList = answerLists?.[q.question];
    const parts = rawList?.length
      ? rawList.map((s) => s.trim()).filter(Boolean)
      : answers?.[q.question]?.trim()
        ? [answers[q.question].trim()]
        : [];
    if (!parts.length) continue;
    const formatted = parts.map((p) => formatPart(q, p)).join('; ');
    rows.push({ question: q.question, formatted });
  }
  if (!rows.length) return '';
  if (questions.length === 1 && rows.length === 1) return rows[0].formatted;
  return rows.map((r, i) => `${i + 1}. ${r.question}\n→ ${r.formatted}`).join('\n\n');
}
