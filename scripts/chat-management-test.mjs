import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-chat-management-test-'));
process.env.AGENTD_DATA = path.join(root, 'state');
process.env.AGENTD_PROJECT_ROOTS = root;
process.env.AGENTD_NOTIFY = '0';
fs.mkdirSync(process.env.AGENTD_DATA);
// Metadata created before projects/archive existed must remain readable.
fs.writeFileSync(path.join(process.env.AGENTD_DATA, 'state.json'), JSON.stringify({ version: 1, meta: { 'codex:one': { pinned: true, title: 'Old title' } } }));
const { store, loadStore, flushStore } = await import('../apps/agentd/src/store.ts');
const { Hub } = await import('../apps/agentd/src/hub.ts');
loadStore();
const cwd = path.join(root, 'project');
fs.mkdirSync(cwd);
fs.writeFileSync(path.join(cwd, 'keep.txt'), 'repository data');
const summaries = ['one', 'two'].map((nativeId) => ({ id: `codex:${nativeId}`, nativeId, agent: 'codex', cwd, title: nativeId, createdAt: 1, updatedAt: 2, status: 'idle', origin: 'web' }));
const hub = new Hub();
hub.register({ agent: 'codex', list: async () => summaries, isLive: () => false });
const client = { id: 1, send() {}, subs: new Set(), visible: null };
try {
  await hub.refresh();
  assert.equal(hub.summaries()[0].pinned, true);
  await hub.handle(client, { t: 'meta', chatId: 'codex:one', archived: true, taskStage: 'done' });
  assert.equal(hub.summaries().find((chat) => chat.id === 'codex:one').archived, true);
  await hub.handle(client, { t: 'projectMeta', cwd, action: 'archive', confirm: 'project' });
  assert.ok(hub.summaries().every((chat) => chat.projectArchived));
  await hub.handle(client, { t: 'projectMeta', cwd, action: 'restore', confirm: 'project' });
  assert.equal(hub.summaries().find((chat) => chat.id === 'codex:one').archived, true);
  assert.equal(hub.summaries().find((chat) => chat.id === 'codex:two').archived, false);
  await assert.rejects(hub.handle(client, { t: 'projectMeta', cwd, action: 'delete', confirm: 'wrong' }));
  hub.peek('codex:two').setSummary({ status: 'running' });
  await assert.rejects(hub.handle(client, { t: 'projectMeta', cwd, action: 'delete', confirm: 'project' }));
  assert.equal(store.project(cwd).deleted, false);
  hub.peek('codex:two').setSummary({ status: 'idle' });
  await hub.handle(client, { t: 'projectMeta', cwd, action: 'delete', confirm: 'project' });
  await hub.refresh();
  assert.ok(hub.summaries().every((chat) => chat.deleted && chat.projectDeleted));
  assert.equal(fs.readFileSync(path.join(cwd, 'keep.txt'), 'utf8'), 'repository data');
  flushStore();
  loadStore();
  assert.equal(store.meta('codex:one').taskStage, 'done');
  assert.equal(store.meta('codex:one').deleted, true);
  assert.equal(store.project(cwd).deleted, true);
  console.log('PASS: legacy metadata, independent chat/project archive, typed confirmation, busy protection, persistent deletion, repository preservation');
} finally {
  flushStore();
  // Let the summary batching timer finish before cleaning the isolated test state.
  await new Promise((resolve) => setTimeout(resolve, 180));
  fs.rmSync(root, { recursive: true, force: true });
}
