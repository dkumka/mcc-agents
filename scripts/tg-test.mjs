#!/usr/bin/env node
// Telegram approvals smoke test (run ON THE SERVER): starts a Claude chat that needs an approval, does NOT answer in
// the web, waits for the Telegram message (prefs.telegramDelaySec), then waits for a button press in Telegram.
// If nobody presses within WAIT_TG seconds, answers from the "web" — the Telegram message must then say so.
// Usage: node scripts/tg-test.mjs /run/mcc-agents/local.sock [waitTgSeconds=240]
import WebSocket from 'ws';

const [sock = '/run/mcc-agents/local.sock', waitTg = '240'] = process.argv.slice(2);
const ws = new WebSocket(`ws+unix://${sock}:/ws`, { headers: { Host: 'localhost', Origin: 'http://localhost' } });
const t0 = Date.now();
const log = (...a) => console.log(((Date.now() - t0) / 1000).toFixed(0).padStart(4), ...a);
let chatId;
let approval = null;
let decidedBy = null;

ws.on('open', () => {
  ws.send(
    JSON.stringify({
      t: 'create',
      reqId: 'tg',
      agent: 'claude',
      cwd: '/tmp/agent-spike/proj',
      settings: { model: 'haiku', permissionMode: 'default' },
      message: { text: 'Проверка кнопок Telegram: создай файл tg-test.txt с текстом ok через Write, потом ответь одним словом «готово».' },
    }),
  );
});

ws.on('message', (raw) => {
  const m = JSON.parse(String(raw));
  if (m.t === 'created') {
    chatId = m.chatId;
    log('chat', chatId);
  }
  if (m.t === 'state' && m.chatId === chatId && m.patch.approvals) {
    if (m.patch.approvals.length && !approval) {
      approval = m.patch.approvals[0];
      log('approval pending:', approval.kind, approval.title, '— not answering in web');
      setTimeout(() => {
        if (decidedBy) return;
        decidedBy = 'web';
        log('no Telegram press — answering from web');
        ws.send(JSON.stringify({ t: 'decide', chatId, decision: { approvalId: approval.id, decision: 'allow' } }));
      }, Number(waitTg) * 1000);
    } else if (!m.patch.approvals.length && approval && !decidedBy) {
      decidedBy = 'telegram';
      log('approval resolved from Telegram ✔');
    }
  }
  if (m.t === 'item' && m.chatId === chatId && m.item.kind === 'tool') log('tool', m.item.title, m.item.status);
  if (m.t === 'item' && m.chatId === chatId && m.item.kind === 'assistant' && !m.item.streaming) log('assistant:', m.item.text.slice(0, 80));
  if (m.t === 'chat' && m.chat.id === chatId && m.chat.status === 'idle' && decidedBy) {
    log('done, decided by', decidedBy);
    setTimeout(() => process.exit(0), 3000);
  }
});
setTimeout(() => process.exit(2), (Number(waitTg) + 120) * 1000);
