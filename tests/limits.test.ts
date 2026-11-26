// Antigravity limits error parsing and AgentLimits error state. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { AgentLimits } from '@mcc-agents/protocol';

const dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-limits-')));
process.env.AGENTD_DATA = dataDir;
const { AntigravityAdapter, parseUsageError } = await import('../apps/agentd/src/antigravity/index.ts');
const { flushStore, store } = await import('../apps/agentd/src/store.ts');

test.after(() => {
  flushStore();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('parseUsageError extracts JSON error from agy -p /usage stdout', () => {
  const stdout = JSON.stringify({
    conversation_id: '',
    status: 'ERROR',
    response: '',
    error: 'Eligibility check failed: Your current account is not eligible for Antigravity, because it is not currently available in your location.',
  });
  const err = new Error('Command failed: /home/klemid/.local/bin/agy -p /usage --output-format json\nerror: something else');
  assert.equal(
    parseUsageError(err, stdout, 'error: raw stderr'),
    'Eligibility check failed: Your current account is not eligible for Antigravity, because it is not currently available in your location.',
  );
});

test('parseUsageError falls back to stderr or stripped Error.message', () => {
  assert.equal(
    parseUsageError(new Error('Command failed: agy -p /usage\nerror: network timeout'), '', 'error: Eligibility check failed\n'),
    'Eligibility check failed',
  );
  assert.equal(
    parseUsageError(new Error('Command failed: agy -p /usage\nerror: ENOENT'), '', ''),
    'ENOENT',
  );
  assert.equal(parseUsageError(null, JSON.stringify({ status: 'SUCCESS', command: { data: { groups: [] } } }), ''), 'нет данных');
});

test('AntigravityAdapter publishes limits error and clears it on success', () => {
  const published: AgentLimits[] = [];
  const hub = {
    setLimits(l: AgentLimits) {
      store.setLimits(l);
      published.push(l);
    },
  } as any;

  const adapter = new AntigravityAdapter(hub) as any;
  adapter.tier = 'Google AI Pro';
  adapter.publishLimits(undefined, 'Eligibility check failed: not available in your location.');

  assert.equal(published.length, 1);
  assert.equal(published[0].agent, 'antigravity');
  assert.equal(published[0].plan, 'Google AI Pro');
  assert.deepEqual(published[0].windows, []);
  assert.equal(published[0].error, 'Eligibility check failed: not available in your location.');
  assert.ok(typeof published[0].errorAt === 'number' && published[0].errorAt > 0);

  // tier-only update preserves error
  adapter.publishLimits();
  assert.equal(published.length, 2);
  assert.equal(published[1].error, 'Eligibility check failed: not available in your location.');

  // successful windows clear error
  adapter.publishLimits([{ id: 'g-5h', label: '5 часов', usedPercent: 12 }]);
  assert.equal(published.length, 3);
  assert.equal(published[2].windows.length, 1);
  assert.equal(published[2].error, undefined);
  assert.equal(published[2].errorAt, undefined);
});
