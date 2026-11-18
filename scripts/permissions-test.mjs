import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Never read or write the running daemon's state or start a model turn.
process.env.AGENTD_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-permissions-test-'));
const { CodexAdapter } = await import('../apps/agentd/src/codex/index.ts');
const { store, loadStore, flushStore } = await import('../apps/agentd/src/store.ts');
const { codexPermissions } = await import('../apps/agentd/src/codex/permissions.ts');
loadStore();
assert.throws(() => codexPermissions('bogus'), /Неизвестный/);

for (const [mode, sandbox, approval, type] of [
  ['on-request', 'workspace-write', 'on-request', 'workspaceWrite'],
  ['read-only', 'read-only', 'never', 'readOnly'],
  ['never', 'danger-full-access', 'never', 'dangerFullAccess'],
]) {
  const adapter = new CodexAdapter({ peek() {} });
  const calls = [];
  adapter.rpc.request = async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/start') return { thread: { id: mode } };
    if (method === 'thread/resume') return { model: 'test' };
    if (method === 'thread/turns/list') return { data: [] };
    return { turn: { id: 'active' } };
  };
  const chat = {
    id: `codex:${mode}`, nativeId: mode, cwd: '/tmp',
    state: { settings: { permissionMode: mode }, summary: {} },
    resetItems() {}, setStatus() {},
  };
  await adapter.prepare('/tmp', chat.state.settings);
  assert.equal(calls.at(-1).params.sandbox, sandbox);
  assert.equal(calls.at(-1).params.approvalPolicy, approval);
  store.setMeta(chat.id, { settings: chat.state.settings });
  flushStore();
  loadStore();
  await adapter.load(chat);
  const resume = calls.find((c) => c.method === 'thread/resume').params;
  assert.equal(resume.sandbox, sandbox);
  assert.equal(resume.approvalPolicy, approval);
  assert.equal(chat.state.settings.permissionMode, mode);
  await adapter.send(chat, { text: 'test' }, 'message');
  const turn = calls.at(-1).params;
  assert.equal(turn.approvalPolicy, approval);
  assert.equal(turn.sandboxPolicy.type, type);
  if (mode !== 'never') assert.equal(turn.sandboxPolicy.networkAccess, false);
  await assert.rejects(adapter.applySettings(chat, { permissionMode: mode === 'never' ? 'on-request' : 'never' }), /Остановите/);
  await adapter.applySettings(chat, { permissionMode: mode });
  await assert.rejects(adapter.applySettings(chat, { permissionMode: 'bogus' }), /Неизвестный/);
}

// Downgrading a formerly full-access thread must replace BOTH controls on its next turn.
const adapter = new CodexAdapter({ peek() {} });
const calls = [];
adapter.rpc.request = async (method, params) => {
  calls.push({ method, params });
  return method === 'thread/start' ? { thread: { id: 'downgrade' } } : {};
};
const chat = { nativeId: 'downgrade', state: { settings: { permissionMode: 'never' } }, setStatus() {} };
await adapter.prepare('/tmp', chat.state.settings);
await adapter.applySettings(chat, { permissionMode: 'on-request' });
chat.state.settings.permissionMode = 'on-request';
await adapter.send(chat, { text: 'test' }, 'message');
assert.equal(calls.at(-1).params.approvalPolicy, 'on-request');
assert.equal(calls.at(-1).params.sandboxPolicy.type, 'workspaceWrite');
console.log('PASS: create, persisted resume, turn policies, downgrade, active-turn and invalid-mode guards');
