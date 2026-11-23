#!/usr/bin/env node
// End-to-end smoke test against a running agentd (run ON THE SERVER — it starts real CLI sessions).
// Usage: node scripts/e2e.mjs <socket> <claude|codex|antigravity> <cwd> [model]
import WebSocket from 'ws';

const [sock, agent = 'claude', cwd = '/tmp/agent-spike/proj', model] = process.argv.slice(2);
const ws = new WebSocket(`ws+unix://${sock}:/ws`, { headers: { Host: 'localhost', Origin: 'http://localhost' } });
const t0 = Date.now();
const log = (...a) => console.log(((Date.now() - t0) / 1000).toFixed(1), ...a);
let chatId;
let phase = 0;
const settings =
  agent === 'claude'
    ? { model: model ?? 'haiku', permissionMode: 'default' }
    : agent === 'antigravity'
      ? { model: model ?? 'gemini-3.8-flash', permissionMode: 'default', effort: 'low' }
      : { model, permissionMode: 'untrusted', effort: 'low' };

ws.on('open', () => {
  ws.send(
    JSON.stringify({
      t: 'create',
      reqId: 'r1',
      agent,
      cwd,
      settings,
      message: { text: 'Run the shell command `echo e2e-ok && date` and then reply with one short sentence.' },
    }),
  );
});

ws.on('message', (raw) => {
  const m = JSON.parse(String(raw));
  switch (m.t) {
    case 'created':
      chatId = m.chatId;
      log('created', chatId);
      break;
    case 'item': {
      const it = m.item;
      if (it.kind === 'tool') log('tool', it.category, it.status, JSON.stringify(it.title).slice(0, 80), it.output ? JSON.stringify(it.output.slice(0, 60)) : '');
      else if (it.kind === 'assistant' && !it.streaming) log('assistant', JSON.stringify(it.text.slice(0, 120)));
      else if (it.kind === 'notice') log('notice', it.level, it.text);
      else if (it.kind === 'user') log('user', JSON.stringify(it.text.slice(0, 60)));
      break;
    }
    case 'state':
      if (m.patch.approvals?.length) {
        const a = m.patch.approvals[0];
        log('approval', a.kind, a.title, (a.options ?? []).map((o) => o.label).join(' | '));
        ws.send(JSON.stringify({ t: 'decide', chatId, decision: { approvalId: a.id, decision: 'allow' } }));
      }
      if (m.patch.usage) log('usage', JSON.stringify(m.patch.usage));
      break;
    case 'chat':
      if (m.chat.id === chatId) {
        log('status', m.chat.status, JSON.stringify(m.chat.title));
        if (m.chat.status === 'idle' && phase === 0) {
          phase = 1;
          log('turn 1 done; sending follow-up');
          ws.send(JSON.stringify({ t: 'send', chatId, message: { text: 'What did the command print first? One word.' } }));
        } else if (m.chat.status === 'idle' && phase === 1) {
          phase = 2;
          log('turn 2 done');
          setTimeout(() => process.exit(0), 1500);
        }
      }
      break;
    case 'limits':
      log('limits', JSON.stringify(m.limits.map((l) => [l.agent, l.windows.map((w) => `${w.label}:${w.usedPercent}%`)])));
      break;
    case 'error':
      log('ERROR', m.message);
      break;
  }
});
ws.on('error', (e) => {
  console.error('ws error', e.message);
  process.exit(1);
});
setTimeout(() => {
  log('timeout');
  process.exit(2);
}, 180_000);
