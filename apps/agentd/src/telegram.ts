import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';
import { logger } from './log.ts';
import { store } from './store.ts';

const log = logger('telegram');
type Json = Record<string, any>;

export interface TgButton {
  text: string;
  data?: string;
  url?: string;
}

function readEnv(file: string): Record<string, string> {
  try {
    const out: Record<string, string> = {};
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m) out[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
    }
    return out;
  } catch {
    return {};
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The agents' own Telegram bot (separate from the server bot used by `ops`: two getUpdates readers on one
 * bot would steal each other's button presses, and the ops bot's state is deliberately out of serzhb's reach).
 * Token: ~/secrets/agents-telegram.env (TELEGRAM_BOT_TOKEN, optional TELEGRAM_CHAT_ID — else from telegram.env).
 * Only callbacks from that chat are accepted.
 */
export class TelegramBridge {
  private token = '';
  private chatId = '';
  private polling = false;
  private stopped = false;
  private lastCheck = 0;
  onCallback: ((data: string, ack: (text: string) => void) => void) | null = null;

  get ready() {
    return !!(this.token && this.chatId);
  }

  /** (Re)read the secret files; start polling once a token appears. */
  reload() {
    this.lastCheck = Date.now();
    const own = readEnv(path.join(config.home, 'secrets/agents-telegram.env'));
    const main = readEnv(path.join(config.home, 'secrets/telegram.env'));
    const token = own.TELEGRAM_BOT_TOKEN ?? '';
    const chat = own.TELEGRAM_CHAT_ID || main.TELEGRAM_CHAT_ID || '';
    const changed = token !== this.token || chat !== this.chatId;
    this.token = token;
    this.chatId = chat;
    if (changed) log.info(this.ready ? 'bot configured' : 'bot not configured (~/secrets/agents-telegram.env)');
    if (this.ready && !this.polling) this.poll();
    return changed;
  }

  maybeReload() {
    if (Date.now() - this.lastCheck > 60_000) this.reload();
  }

  stop() {
    this.stopped = true;
  }

  private async api(method: string, body: Json, timeoutMs = 20_000): Promise<Json> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const j = (await r.json()) as Json;
      if (!j.ok) throw new Error(`${method}: ${j.description ?? r.status}`);
      return j.result;
    } finally {
      clearTimeout(t);
    }
  }

  private keyboard(rows: TgButton[][]) {
    return {
      inline_keyboard: rows.map((row) => row.map((b) => (b.url ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.data }))),
    };
  }

  async send(html: string, rows: TgButton[][]): Promise<number | null> {
    if (!this.ready) return null;
    try {
      const r = await this.api('sendMessage', {
        chat_id: this.chatId,
        text: html.slice(0, 4000),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: this.keyboard(rows),
      });
      return r.message_id ?? null;
    } catch (e) {
      log.warn('sendMessage failed', e);
      return null;
    }
  }

  async edit(messageId: number, html: string, rows: TgButton[][] = []) {
    if (!this.ready) return;
    try {
      await this.api('editMessageText', {
        chat_id: this.chatId,
        message_id: messageId,
        text: html.slice(0, 4000),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: this.keyboard(rows),
      });
    } catch (e) {
      if (!String(e).includes('message is not modified')) log.warn('editMessageText failed', e);
    }
  }

  private async poll() {
    this.polling = true;
    let backoff = 1000;
    while (!this.stopped && this.ready) {
      try {
        const updates = (await this.api(
          'getUpdates',
          { offset: store.tgOffset(), timeout: 50, allowed_updates: ['callback_query'] },
          60_000,
        )) as unknown as Json[];
        backoff = 1000;
        for (const u of updates) {
          store.setTgOffset(u.update_id + 1);
          const cq = u.callback_query;
          if (!cq) continue;
          if (String(cq.from?.id) !== this.chatId && String(cq.message?.chat?.id) !== this.chatId) {
            this.api('answerCallbackQuery', { callback_query_id: cq.id, text: 'Не принято' }).catch(() => {});
            continue;
          }
          const ack = (text: string) => this.api('answerCallbackQuery', { callback_query_id: cq.id, text }).catch(() => {});
          try {
            this.onCallback?.(String(cq.data ?? ''), ack);
          } catch (e) {
            log.error('callback handler', e);
            ack('Ошибка');
          }
        }
      } catch (e) {
        if (!this.stopped) log.warn('getUpdates', e);
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
    this.polling = false;
  }
}
