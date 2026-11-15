// Isolated contract test: no Telegram network, CLI, commands or live daemon state.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.AGENTD_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-tg-test-'));
const { TgApprovals } = await import('../apps/agentd/src/tg-approvals.ts');
const { store, flushStore } = await import('../apps/agentd/src/store.ts');
const sent = [], edited = [], decisions = [];
const tg = { ready: true, async send(html, rows) { sent.push({ html, rows }); return sent.length; }, async edit(...args) { edited.push(args); } };
const chat = { id: 'codex:test /?', summary: { agent: 'codex', title: 'ТЕСТ <MCC>', cwd: '/tmp/mcc-test' }, state: { approvals: [] } };
const manager = new TgApprovals(tg, {
  peek: id => id === chat.id ? chat : undefined,
  async decideFrom(c, d, source) {
    decisions.push({ d, source });
    c.state.approvals = [];
    manager.removed(c, d.approvalId);
  },
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
const command = { id: 'a', kind: 'command', command: 'TEST ONLY', title: 'ТЕСТ' };
async function add(a) { chat.state.approvals = [a]; manager.added(chat, a); await sleep(35); }
async function press(data) { await new Promise(resolve => tg.onCallback(data, resolve)); }
try {
  store.setPrefs({ telegramDelaySec: 0 });
  await add(command);
  assert.equal(sent.length, 0);
  store.setPrefs({ telegramDelaySec: .08 });
  chat.state.approvals = [command]; manager.added(chat, command);
  await sleep(25); assert.equal(sent.length, 0);
  chat.state.approvals = []; manager.removed(chat, command.id);
  await sleep(90); assert.equal(sent.length, 0); // web answer before delay cancels delivery
  store.setPrefs({ telegramDelaySec: .01 });
  await add(command);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].html.includes('&lt;MCC&gt;'));
  assert.equal(new URL(sent[0].rows.at(-1)[0].url).searchParams.get('chat'), chat.id);
  await press(sent[0].rows[0][0].data);
  assert.equal(decisions.at(-1).d.decision, 'allow');
  assert.ok(edited.at(-1)[1].includes('Разрешено в Telegram'));
  const count = decisions.length;
  await press(sent[0].rows[0][0].data);
  assert.equal(decisions.length, count); // stale button
  await add(command); await press(sent.at(-1).rows[0][1].data);
  assert.equal(decisions.at(-1).d.decision, 'deny');
  const question = { id: 'q', kind: 'question', questions: [{ question: 'Выбор?', options: [{ label: 'Да' }, { label: 'Нет' }] }] };
  await add(question); await press(sent.at(-1).rows[1][0].data);
  assert.deepEqual(decisions.at(-1).d.answers, { 'Выбор?': 'Нет' });
  await add(question);
  manager.record(chat.id, { approvalId: 'q', decision: 'allow', answers: { 'Выбор?': 'Свой ответ' } }, 'web', question);
  chat.state.approvals = []; manager.removed(chat, 'q');
  assert.ok(edited.at(-1)[1].includes('Ответ в вебе: Свой ответ'));
  await add({ ...question, questions: [{ ...question.questions[0], multiSelect: true }] });
  assert.equal(sent.at(-1).rows.length, 1); // web link only
  chat.state.approvals = []; manager.removed(chat, 'q');
  assert.ok(edited.at(-1)[1].includes('Неактуально'));
  await add(command); await manager.markStale();
  assert.ok(edited.at(-1)[1].includes('сервис перезапущен'));
  console.log('PASS: delay/off, cancellation, chat URL, allow/deny, question, web sync, stale buttons/restart');
} finally {
  flushStore();
  fs.rmSync(process.env.AGENTD_DATA, { recursive: true, force: true });
}
