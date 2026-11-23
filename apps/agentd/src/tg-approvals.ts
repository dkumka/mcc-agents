import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { Approval, ApprovalDecision, FileDiff } from '@mcc-agents/protocol';
import type { Chat } from './chat.ts';
import { isChatDir } from './chat-dirs.ts';
import { config } from './config.ts';
import { logger } from './log.ts';
import { store } from './store.ts';
import { escapeHtml as h, TelegramBridge, type TgButton } from './telegram.ts';

const log = logger('tg-approvals');
const AGENT: Record<string, string> = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity' };

export interface DecisionSink {
  peek(chatId: string): Chat | undefined;
  /** Apply a decision exactly like the web UI does. */
  decideFrom(chat: Chat, d: ApprovalDecision, source: 'tg'): Promise<void>;
}

interface Verdict {
  text: string;
}

function trim(s: string, n: number) {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function diffPreview(d: FileDiff, maxLines: number): { body: string; add: number; del: number } {
  let lines: string[] = [];
  if (d.unified) lines = d.unified.split('\n').filter((l) => !l.startsWith('---') && !l.startsWith('+++'));
  else {
    if (d.oldText) lines.push(...d.oldText.split('\n').map((l) => '-' + l));
    if (d.newText) lines.push(...d.newText.split('\n').map((l) => '+' + l));
  }
  const add = lines.filter((l) => l.startsWith('+')).length;
  const del = lines.filter((l) => l.startsWith('-')).length;
  const shown = lines.slice(0, maxLines);
  return { body: shown.join('\n') + (lines.length > maxLines ? `\n… ещё ${lines.length - maxLines} строк` : ''), add, del };
}

/**
 * Pending approvals/questions that nobody answered in the web UI within N seconds go to Telegram with buttons.
 * Answering anywhere (web or Telegram) updates the Telegram message; stale requests are marked as such.
 */
export class TgApprovals {
  private tg: TelegramBridge;
  private sink: DecisionSink;
  private timers = new Map<string, NodeJS.Timeout>(); // `${chatId}|${approvalId}` → timer
  private verdicts = new Map<string, Verdict>(); // `${chatId}|${approvalId}` → how it was answered

  constructor(tg: TelegramBridge, sink: DecisionSink) {
    this.tg = tg;
    this.sink = sink;
    tg.onCallback = (data, ack) => {
      this.onCallback(data, ack).catch((e) => {
        log.error('callback', e);
        ack('Ошибка');
      });
    };
  }

  get active() {
    return this.tg.ready && store.prefs().telegramDelaySec > 0;
  }

  /** Messages left from before a restart point to requests that no longer exist. */
  async markStale() {
    for (const [key, m] of Object.entries(store.tgMessages())) {
      await this.tg.edit(m.messageId, `${m.html}\n\n⌛ <i>Неактуально — сервис перезапущен</i>`);
      store.setTgMessage(key, null);
    }
  }

  added(chat: Chat, a: Approval) {
    if (!this.active) return;
    const k = `${chat.id}|${a.id}`;
    clearTimeout(this.timers.get(k));
    this.timers.set(
      k,
      setTimeout(() => {
        this.timers.delete(k);
        if (chat.state.approvals.some((x) => x.id === a.id)) this.send(chat, a).catch((e) => log.warn('send', e));
      }, store.prefs().telegramDelaySec * 1000),
    );
  }

  record(chatId: string, d: ApprovalDecision, source: 'web' | 'tg', a?: Approval) {
    const where = source === 'web' ? 'в вебе' : 'в Telegram';
    let text: string;
    if (d.decision === 'deny') text = `⛔ Отклонено ${where}`;
    else if (d.answers && Object.keys(d.answers).length) text = `💬 Ответ ${where}: ${h(Object.values(d.answers).join('; '))}`;
    else {
      const opt = a?.options?.find((o) => o.id === d.optionId);
      text = `✅ Разрешено ${where}${opt ? ` — ${h(opt.label)}` : ''}`;
    }
    this.verdicts.set(`${chatId}|${d.approvalId}`, { text });
  }

  removed(chat: Chat, approvalId: string) {
    const k = `${chat.id}|${approvalId}`;
    clearTimeout(this.timers.get(k));
    this.timers.delete(k);
    const v = this.verdicts.get(k);
    this.verdicts.delete(k);
    for (const [key, m] of Object.entries(store.tgMessages())) {
      if (m.chatId !== chat.id || m.approvalId !== approvalId) continue;
      const tail = v ? v.text : '⌛ <i>Неактуально — запрос снят (ход прерван или завершён)</i>';
      this.tg.edit(m.messageId, `${m.html}\n\n${tail}`).catch(() => {});
      store.setTgMessage(key, null);
    }
  }

  // ------------------------------------------------------------ message

  private render(chat: Chat, a: Approval): { html: string; rows: TgButton[][]; key: string } {
    const key = randomBytes(5).toString('hex');
    const s = chat.summary;
    const parts: string[] = [];
    const head = a.kind === 'question' ? 'задаёт вопрос' : a.kind === 'plan' ? 'предлагает план' : 'просит разрешения';
    parts.push(`✋ <b>${AGENT[s.agent] ?? s.agent}</b> ${head}`);
    parts.push(`💬 <i>${h(trim(s.title, 120))}</i>`);
    if (isChatDir(s.cwd)) parts.push('💭 беседа');
    else parts.push(`📁 ${h(path.basename(s.cwd) || s.cwd)} <code>${h(s.cwd.replace(config.home, '~'))}</code>`);
    parts.push('');
    const rows: TgButton[][] = [];
    const cb = (act: string) => `a:${key}:${act}`;
    const allowDeny = () => {
      rows.push([
        { text: '✅ Разрешить', data: cb('y') },
        { text: '⛔ Отклонить', data: cb('n') },
      ]);
      (a.options ?? []).slice(0, 2).forEach((o, i) => rows.push([{ text: trim(o.label, 60), data: cb(`o${i}`) }]));
    };
    switch (a.kind) {
      case 'command':
        parts.push('<b>Команда</b>');
        parts.push(`<pre>${h(trim(a.command ?? a.title, 1500))}</pre>`);
        if (a.detail) parts.push(`<i>${h(trim(a.detail, 300))}</i>`);
        allowDeny();
        break;
      case 'fileChange': {
        const diffs = a.diffs ?? [];
        parts.push(diffs.length ? '<b>Изменение файлов</b>' : `<b>Изменение</b> <code>${h(a.title)}</code>`);
        let budget = 40;
        for (const d of diffs.slice(0, 4)) {
          const p = diffPreview(d, Math.max(5, Math.min(25, budget)));
          budget -= 25;
          parts.push(`<code>${h(d.path.replace(s.cwd + '/', ''))}</code> <b>+${p.add} −${p.del}</b>`);
          if (budget > -25) parts.push(`<pre>${h(trim(p.body, 1400))}</pre>`);
        }
        if (diffs.length > 4) parts.push(`… и ещё ${diffs.length - 4} файл.`);
        allowDeny();
        break;
      }
      case 'question': {
        const qs = a.questions ?? [];
        for (const q of qs) {
          parts.push(`<b>${h(q.question)}</b>`);
          for (const o of q.options) parts.push(`• ${h(o.label)}${o.description ? ` — <i>${h(trim(o.description, 120))}</i>` : ''}`);
          parts.push('');
        }
        if (qs.length === 1 && !qs[0].multiSelect && qs[0].options.length) {
          qs[0].options.slice(0, 8).forEach((o, i) => rows.push([{ text: trim(o.label, 60), data: cb(`q${i}`) }]));
        } else parts.push('<i>Несколько вопросов или свой ответ — ответьте в вебе.</i>');
        break;
      }
      case 'plan':
        parts.push('<b>План</b>');
        parts.push(h(trim(a.plan ?? '', 2500)));
        rows.push([{ text: '▶️ Начать', data: cb('y') }]);
        (a.options ?? []).slice(0, 1).forEach((o, i) => rows.push([{ text: trim(o.label, 60), data: cb(`o${i}`) }]));
        parts.push('', '<i>Замечания к плану — в вебе.</i>');
        break;
      default:
        parts.push(`<b>${h(a.title || a.tool)}</b>`);
        if (a.detail) parts.push(`<i>${h(trim(a.detail, 300))}</i>`);
        if (a.input) parts.push(`<pre>${h(trim(JSON.stringify(a.input, null, 2), 1200))}</pre>`);
        allowDeny();
    }
    rows.push([{ text: '🔗 Открыть чат', url: `${config.publicUrl}/?chat=${encodeURIComponent(chat.id)}` }]);
    return { html: parts.join('\n').replace(/\n{3,}/g, '\n\n').trim(), rows, key };
  }

  private async send(chat: Chat, a: Approval) {
    const { html, rows, key } = this.render(chat, a);
    const id = await this.tg.send(html, rows);
    if (id === null) return;
    // the request may have been answered while we were sending
    if (!chat.state.approvals.some((x) => x.id === a.id)) {
      await this.tg.edit(id, `${html}\n\n${this.verdicts.get(`${chat.id}|${a.id}`)?.text ?? '⌛ <i>Уже неактуально</i>'}`);
      return;
    }
    store.setTgMessage(key, { chatId: chat.id, approvalId: a.id, messageId: id, html, sentAt: Date.now() });
    log.info(`sent ${chat.id} ${a.kind}`);
  }

  private async onCallback(data: string, ack: (t: string) => void) {
    const m = data.match(/^a:([0-9a-f]+):(y|n|o\d+|q\d+)$/);
    if (!m) return ack('Не понял кнопку');
    const msg = store.tgMessages()[m[1]];
    if (!msg) return ack('Запрос уже неактуален');
    const chat = this.sink.peek(msg.chatId);
    const a = chat?.state.approvals.find((x) => x.id === msg.approvalId);
    if (!chat || !a) {
      ack('Запрос уже неактуален');
      await this.tg.edit(msg.messageId, `${msg.html}\n\n⌛ <i>Неактуально</i>`);
      store.setTgMessage(m[1], null);
      return;
    }
    const act = m[2];
    let d: ApprovalDecision;
    if (act === 'y') d = { approvalId: a.id, decision: 'allow' };
    else if (act === 'n') d = { approvalId: a.id, decision: 'deny', message: 'Пользователь отклонил это действие (из Telegram).' };
    else if (act.startsWith('o')) {
      const opt = a.options?.[Number(act.slice(1))];
      if (!opt) return ack('Вариант не найден');
      d = { approvalId: a.id, decision: 'allow', optionId: opt.id };
    } else {
      const q = a.questions?.[0];
      const o = q?.options[Number(act.slice(1))];
      if (!q || !o) return ack('Вариант не найден');
      d = { approvalId: a.id, decision: 'allow', answers: { [q.question]: o.label } };
    }
    this.record(chat.id, d, 'tg', a);
    await this.sink.decideFrom(chat, d, 'tg');
    ack(d.decision === 'deny' ? 'Отклонено' : 'Принято');
  }
}
