#!/usr/bin/env node
// Attachments smoke test (run ON THE SERVER): uploads a file via /api/upload and asks the agent to read it.
// Usage: node scripts/files-test.mjs <socket> <claude|codex> <file> [model]
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import WebSocket from 'ws';

const [sock = '/run/mcc-agents/local.sock', agent = 'claude', file, model] = process.argv.slice(2);
const t0 = Date.now();
const log = (...a) => console.log(((Date.now() - t0) / 1000).toFixed(1).padStart(5), ...a);

function upload() {
  const body = fs.readFileSync(file);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: sock,
        path: '/api/upload',
        method: 'POST',
        headers: {
          Host: 'localhost',
          Origin: 'http://localhost',
          'X-File-Name': encodeURIComponent(path.basename(file)),
          'Content-Type': 'application/octet-stream',
          'Content-Length': body.length,
        },
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => (res.statusCode === 200 ? resolve(JSON.parse(d)) : reject(new Error(`${res.statusCode} ${d}`))));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

const att = await upload();
log('uploaded', JSON.stringify(att));
const ws = new WebSocket(`ws+unix://${sock}:/ws`, { headers: { Host: 'localhost', Origin: 'http://localhost' } });
let chatId;
ws.on('open', () =>
  ws.send(
    JSON.stringify({
      t: 'create',
      reqId: 'f',
      agent,
      cwd: '/tmp/agent-spike/proj',
      settings: agent === 'claude' ? { model: model ?? 'haiku', permissionMode: 'bypassPermissions' } : { model, permissionMode: 'never', effort: 'low' },
      message: { text: 'Что написано в приложенном документе? Ответь одной строкой, дословно.', files: [att] },
    }),
  ),
);
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw));
  if (m.t === 'created') (chatId = m.chatId), log('chat', chatId);
  if (m.t === 'item' && m.chatId === chatId) {
    const it = m.item;
    if (it.kind === 'user') log('user item: text=', JSON.stringify(it.text), 'files=', JSON.stringify(it.files));
    if (it.kind === 'tool') log('tool', it.category, it.status, String(it.title).slice(0, 100));
    if (it.kind === 'assistant' && !it.streaming) log('assistant:', it.text.slice(0, 200));
  }
  if (m.t === 'chat' && m.chat.id === chatId && m.chat.status === 'idle' && Date.now() - t0 > 3000) {
    log('done');
    setTimeout(() => process.exit(0), 1000);
  }
  if (m.t === 'error') log('ERROR', m.message);
});
setTimeout(() => process.exit(2), 240_000);
