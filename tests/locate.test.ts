// /api/locate (apps/agentd/src/locate.ts) on a temporary project tree. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'locate-')));
process.env.AGENTD_PROJECT_ROOTS = root;
const { locate } = await import('../apps/agentd/src/locate.ts');

const cwd = path.join(root, 'supa');
const put = (rel: string, body = 'x') => {
  fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
  fs.writeFileSync(path.join(cwd, rel), body);
};
put('supa-email-templates-v2/PRODUCTION-RELEASE.md', '# Release');
put('a/README.md');
put('b/README.md');
put('node_modules/pkg/ONLY-IN-DEPS.md');
put('a/b/c/d/e/TOO-DEEP.md');
put('a/b/c/d/DEEP-OK.md');
const release = path.join(cwd, 'supa-email-templates-v2/PRODUCTION-RELEASE.md');

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('a bare name missing in cwd opens the only match in the project', () => {
  const r = locate(path.join(cwd, 'PRODUCTION-RELEASE.md'), { cwd, bare: true });
  assert.equal(r.status, 'ok');
  assert.equal(r.path, release);
  assert.equal(r.size, 9);
});

test('an absolute path opens as is', () => {
  assert.deepEqual(locate(release, { cwd }), { path: release, status: 'ok', size: 9, matches: [] });
});

test('a missing file reports the full path it tried', () => {
  assert.deepEqual(locate(path.join(cwd, 'nope.md'), { cwd, bare: true }), { path: path.join(cwd, 'nope.md'), status: 'not_found', matches: [] });
});

test('several matches are offered to choose from', () => {
  const r = locate(path.join(cwd, 'README.md'), { cwd, bare: true });
  assert.equal(r.status, 'choose');
  assert.deepEqual(r.matches, [path.join(cwd, 'a/README.md'), path.join(cwd, 'b/README.md')]);
});

test('chat hints win over the folder search', () => {
  const r = locate(path.join(cwd, 'README.md'), { cwd, bare: true, hints: [path.join(cwd, 'b/README.md')] });
  assert.equal(r.status, 'ok');
  assert.equal(r.path, path.join(cwd, 'b/README.md'));
});

test('a wrong relative path is not guessed, only suggested', () => {
  const r = locate(path.join(cwd, 'docs/PRODUCTION-RELEASE.md'), { cwd });
  assert.equal(r.status, 'not_found');
  assert.deepEqual(r.matches, [release]);
});

test('search skips node_modules and stops at depth 4', () => {
  assert.equal(locate(path.join(cwd, 'ONLY-IN-DEPS.md'), { cwd, bare: true }).status, 'not_found');
  assert.equal(locate(path.join(cwd, 'TOO-DEEP.md'), { cwd, bare: true }).status, 'not_found');
  assert.equal(locate(path.join(cwd, 'DEEP-OK.md'), { cwd, bare: true }).status, 'ok');
});

test('folders, files outside the roots and unreadable files are told apart', () => {
  assert.equal(locate(path.join(cwd, 'a'), { cwd }).status, 'not_file');
  assert.equal(locate('/etc/hostname').status, 'forbidden');
  if (process.getuid?.() !== 0) {
    put('secret.md');
    fs.chmodSync(path.join(cwd, 'secret.md'), 0);
    assert.equal(locate(path.join(cwd, 'secret.md')).status, 'eacces');
  }
});
