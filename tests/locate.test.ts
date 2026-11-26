// /api/locate (apps/agentd/src/locate.ts) on a temporary project tree. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'locate-')));
process.env.AGENTD_PROJECT_ROOTS = root;
const { gitRoots, locate } = await import('../apps/agentd/src/locate.ts');

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

// a multi-repo folder: two repositories and a worktree of one of them
const repo = (rel: string, worktree = false) => {
  fs.mkdirSync(path.join(cwd, rel), { recursive: true });
  if (worktree) fs.writeFileSync(path.join(cwd, rel, '.git'), 'gitdir: /x');
  else fs.mkdirSync(path.join(cwd, rel, '.git'), { recursive: true });
};
repo('supa-api');
repo('supa-nest');
repo('worktrees/pptx-recheck/supa-nest', true);
put('supa-api/models/partner.js', 'api');
put('supa-nest/models/partner.js', 'nest');
put('supa-nest/libs/pptx/index.js', 'main');
put('worktrees/pptx-recheck/supa-nest/libs/pptx/index.js', 'worktree');
put('supa-nest/libs/same.js', 'same');
put('worktrees/pptx-recheck/supa-nest/libs/same.js', 'same');
put('supa-api/src/deep/b/c/only-here.ts');
const wt = path.join(cwd, 'worktrees/pptx-recheck/supa-nest');
const at = (rel: string) => path.join(cwd, rel);

test('git roots of touched paths: nearest .git folder or worktree file, newest first, no repeats', () => {
  assert.deepEqual(gitRoots([at('worktrees/pptx-recheck/supa-nest/libs/pptx/index.js'), at('supa-api/models'), at('supa-api'), at('a/README.md')]), [wt, at('supa-api')]);
});

test('a path relative to its repository opens from the repository the chat touched', () => {
  const r = locate(at('models/partner.js'), { cwd, rel: 'models/partner.js', touched: [at('supa-api/models/partner.js')] });
  assert.equal(r.status, 'ok');
  assert.equal(r.path, at('supa-api/models/partner.js'));
});

test('without touched repositories, the repositories of the chat folder are tried and several give a choice', () => {
  const r = locate(at('models/partner.js'), { cwd, rel: 'models/partner.js' });
  assert.equal(r.status, 'choose');
  assert.deepEqual(r.matches, [at('supa-api/models/partner.js'), at('supa-nest/models/partner.js')]);
  // the recently touched one goes on top
  const both = locate(at('models/partner.js'), { cwd, rel: 'models/partner.js', touched: [at('supa-nest'), at('supa-api')] });
  assert.equal(both.status, 'choose');
  assert.deepEqual(both.matches, [at('supa-nest/models/partner.js'), at('supa-api/models/partner.js')]);
});

test('a worktree the agent worked in is not silently replaced by the main checkout', () => {
  const r = locate(at('supa-nest/libs/pptx/index.js'), { cwd, rel: 'supa-nest/libs/pptx/index.js', touched: [path.join(wt, 'libs/pptx/index.js')] });
  assert.equal(r.status, 'choose');
  assert.deepEqual(r.matches, [path.join(wt, 'libs/pptx/index.js'), at('supa-nest/libs/pptx/index.js')]);
  // same content: nothing to choose
  assert.equal(locate(at('supa-nest/libs/same.js'), { cwd, rel: 'supa-nest/libs/same.js', touched: [wt] }).status, 'ok');
  // no worktree in this chat: the file from the chat folder opens as before
  assert.equal(locate(at('supa-nest/libs/pptx/index.js'), { cwd, rel: 'supa-nest/libs/pptx/index.js' }).status, 'ok');
});

test('a relative path missing everywhere above is matched by its tail, not only by its name', () => {
  put('x/models/only-here.ts', 'other');
  const r = locate(at('c/only-here.ts'), { cwd, rel: 'c/only-here.ts' });
  assert.equal(r.status, 'not_found'); // too deep for the walk from cwd; x/models/only-here.ts has the name but not the tail
  assert.deepEqual(r.matches, [at('x/models/only-here.ts')]);
  const t = locate(at('b/c/only-here.ts'), { cwd, rel: 'b/c/only-here.ts', touched: [at('supa-api')] });
  assert.equal(t.status, 'ok');
  assert.equal(t.path, at('supa-api/src/deep/b/c/only-here.ts'));
});

test('a bare name is tried at the root of the touched repositories', () => {
  put('supa-nest/NEST-ONLY.md');
  put('a/NEST-ONLY.md');
  const r = locate(at('NEST-ONLY.md'), { cwd, bare: true, touched: [at('supa-nest/libs')] });
  assert.equal(r.status, 'ok');
  assert.equal(r.path, at('supa-nest/NEST-ONLY.md'));
});
