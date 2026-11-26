import type { Question, QuestionOption } from '@mcc-agents/protocol';

const RECOMMENDED_PREFIX = /^\s*\(Recommended\)\s*/i;
const RECOMMENDED_SUFFIX = /\s*\(Recommended\)\s*$/i;

export interface DisplayOption {
  rawLabel: string;
  label: string;
  description?: string;
  recommended: boolean;
}

/** Visually strip «(Recommended)» while keeping `rawLabel` intact for Claude/Codex protocol answers. */
export function displayOption(opt: QuestionOption | string): DisplayOption {
  const rawLabel = typeof opt === 'string' ? opt : String(opt.label ?? '');
  const trimmed = rawLabel.trim();
  let label = trimmed;
  let recommended = typeof opt === 'object' && opt !== null ? Boolean(opt.recommended) : false;
  if (RECOMMENDED_PREFIX.test(label)) {
    label = label.replace(RECOMMENDED_PREFIX, '').trim();
    recommended = true;
  } else if (RECOMMENDED_SUFFIX.test(label)) {
    label = label.replace(RECOMMENDED_SUFFIX, '').trim();
    recommended = true;
  }
  const description = typeof opt === 'object' && opt !== null && typeof opt.description === 'string' ? opt.description.trim() || undefined : undefined;
  return { rawLabel, label: label || trimmed, description, recommended };
}

/** Extract normalized questions from ToolItem.input (works for Antigravity ask_question and Claude/Codex AskUserQuestion). */
export function extractQuestionsFromInput(input: unknown): Question[] {
  if (!input || typeof input !== 'object') return [];
  const raw = (input as { questions?: unknown }).questions;
  if (!Array.isArray(raw)) return [];
  const out: Question[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const q = item as Record<string, unknown>;
    const question = typeof q.question === 'string' ? q.question.trim() : '';
    if (!question) continue;
    const opts = Array.isArray(q.options) ? q.options : [];
    const options: QuestionOption[] = [];
    for (const o of opts) {
      if (typeof o === 'string') {
        const d = displayOption(o);
        if (d.label) options.push({ label: d.label, recommended: d.recommended || undefined });
      } else if (o && typeof o === 'object') {
        const rec = o as Record<string, unknown>;
        const rawLabel = typeof rec.label === 'string' ? rec.label : typeof rec.text === 'string' ? rec.text : '';
        const d = displayOption({
          label: rawLabel,
          description: typeof rec.description === 'string' ? rec.description : undefined,
          recommended: rec.recommended === true,
        });
        if (d.label) options.push({ label: d.label, description: d.description, recommended: d.recommended || undefined });
      }
    }
    out.push({
      question,
      header: typeof q.header === 'string' && q.header.trim() ? q.header.trim() : undefined,
      multiSelect: q.is_multi_select === true || q.multiSelect === true ? true : undefined,
      options,
    });
  }
  return out;
}

function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function stripBulletAndIndex(line: string): { text: string; hadOptionMarker: boolean } {
  let s = line.trim();
  const bullet = /^[-*•]\s+/.test(s);
  if (bullet) s = s.replace(/^[-*•]\s+/, '');
  const bracketIdx = /^\[\d+\]\s*/.test(s);
  const dotIdx = /^\d+[.)]\s+/.test(s);
  if (bracketIdx) s = s.replace(/^\[\d+\]\s*/, '');
  else if (dotIdx) s = s.replace(/^\d+[.)]\s+/, '');
  s = displayOption(s).label;
  return { text: norm(s), hadOptionMarker: bullet || bracketIdx || dotIdx };
}

function stripQuestionDecor(line: string): string {
  let s = line.trim();
  s = s.replace(/^\d+[.)]\s+/, '');
  s = s.replace(/^\*\*(.+)\*\*$/, '$1');
  s = s.replace(/^#+\s+/, '');
  return norm(s);
}

const ECHO_HINT_RE = /^(\(?select all that apply\)?|other|другое|свой ответ|выберите.*|reply with.*)$/i;

/**
 * Detect `agy acp`'s auto-generated plain-text fallback echo right after `ask_question`
 * (every question + `- [1] (Recommended) ...` bullets) so the UI can fold it into the collapsible question card
 * without ever hiding real assistant prose.
 */
export function isAskQuestionEcho(text: string, questions: Question[], streaming?: boolean): boolean {
  if (!questions.length) return false;
  const lines = text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return false;

  const qLines: string[] = [];
  const oLines: string[] = [];
  for (const q of questions) {
    for (const part of q.question.replace(/\r\n/g, '\n').split('\n')) {
      const n = norm(part);
      if (n) qLines.push(n);
    }
    for (const o of q.options) {
      const d = displayOption(o);
      for (const part of d.label.replace(/\r\n/g, '\n').split('\n')) {
        const n = norm(part);
        if (n) oLines.push(n);
      }
    }
  }
  const qSet = new Set(qLines);
  const oSet = new Set(oLines);

  let matchedQ = 0;
  let matchedO = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isLast = i === lines.length - 1;
    const qClean = stripQuestionDecor(line);
    const { text: oClean, hadOptionMarker } = stripBulletAndIndex(line);

    if (qSet.has(qClean)) {
      matchedQ++;
      continue;
    }
    if (oSet.has(oClean) && (hadOptionMarker || matchedQ > 0)) {
      matchedO++;
      continue;
    }
    if (ECHO_HINT_RE.test(qClean) && matchedQ > 0) {
      continue;
    }
    // While streaming, the last partial line may be an unfinished prefix of a question or option
    if (streaming && isLast) {
      const partialQ = qClean && qLines.some((q) => q.startsWith(qClean));
      const partialO =
        (hadOptionMarker && oClean === '') ||
        /^[-*•]\s*(\[\d*\]?)?\s*(\(Rec[a-z]*\)?)?$/i.test(line) ||
        (oClean && oLines.some((o) => o.startsWith(oClean)));
      if (partialQ || partialO) continue;
    }
    return false;
  }

  if (streaming) return true;
  if (matchedQ === 0) return false;
  if (oLines.length > 0 && matchedO === 0) return false;
  return true;
}
