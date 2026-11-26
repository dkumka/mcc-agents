// Links to files in agent answers (apps/web/src/lib/files.ts). Run: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatItem } from '@mcc-agents/protocol';
import { isBareName, linkUrl, looksLikeFile, pathsNamed, relOf, resolvePath, touchedPaths } from '../apps/web/src/lib/files.ts';

const cwd = '/home/klemid/dev/supa';

test('file-like references become links', () => {
  for (const s of ['PRODUCTION-RELEASE.md', '/home/klemid/dev/supa/supa-email-templates-v2/PRODUCTION-RELEASE.md', '~/dev/x.ts', 'src/app.tsx:12', './a/b.json', 'file:///tmp/x.log']) {
    assert.ok(looksLikeFile(s), s);
  }
});

test('things that are not files stay plain text', () => {
  for (const s of ['localhost:3000', 'api.supa.video:443', 'db.users', 'origin/main', 'feature/new-login', 'github.com/dkumka/mcc-agents/README.md', 'www.klemid.ru/index.html', 'https://x.ru/a.md', 'v1.2', 'foo.bar()', 'email_templates']) {
    assert.ok(!looksLikeFile(s), s);
  }
});

test('paths resolve against the chat folder', () => {
  assert.equal(resolvePath('PRODUCTION-RELEASE.md', cwd), '/home/klemid/dev/supa/PRODUCTION-RELEASE.md');
  assert.equal(resolvePath('nope.md', cwd), '/home/klemid/dev/supa/nope.md');
  assert.equal(resolvePath('/home/klemid/dev/supa/supa-email-templates-v2/PRODUCTION-RELEASE.md', cwd), '/home/klemid/dev/supa/supa-email-templates-v2/PRODUCTION-RELEASE.md');
  assert.equal(resolvePath('~/dev/a.md', cwd), '/home/klemid/dev/a.md');
  assert.equal(resolvePath('../mcc/x.ts:10:2', cwd), '/home/klemid/dev/mcc/x.ts');
  assert.ok(isBareName('PRODUCTION-RELEASE.md'));
  assert.ok(!isBareName('docs/PRODUCTION-RELEASE.md'));
});

test('paths the chat already touched are hints for a bare name', () => {
  const items = [
    { kind: 'tool', id: '1', tool: 'Read', category: 'read', title: 'supa-email-templates-v2/PRODUCTION-RELEASE.md', input: { file_path: '/home/klemid/dev/supa/supa-email-templates-v2/PRODUCTION-RELEASE.md' }, status: 'done' },
    { kind: 'assistant', id: '2', text: 'Готово: `/home/klemid/dev/supa/other/PRODUCTION-RELEASE.md`, и README.md.' },
    { kind: 'tool', id: '3', tool: 'Edit', category: 'edit', title: 'x', input: { file_path: '/home/klemid/dev/supa/README.md' }, status: 'done' },
  ] as unknown as ChatItem[];
  assert.deepEqual(pathsNamed(items, 'PRODUCTION-RELEASE.md', cwd).sort(), [
    '/home/klemid/dev/supa/other/PRODUCTION-RELEASE.md',
    '/home/klemid/dev/supa/supa-email-templates-v2/PRODUCTION-RELEASE.md',
  ]);
});

test('file:// links and paths with a line survive react-markdown, dangerous schemes do not', () => {
  const art = 'file:///home/klemid/.gemini/antigravity-cli/brain/25b476f4-e5d5-46a1-9635-d1ef89193ed7/implementation_plan.md';
  assert.equal(linkUrl(art), art);
  assert.equal(resolvePath(art, cwd), art.slice('file://'.length));
  for (const u of ['README.md:12', 'src/app.tsx:12:3', 'models/partner.js', 'https://x.ru/a.md', 'mailto:a@b.ru']) assert.equal(linkUrl(u), u, u);
  for (const u of ['javascript:alert(1)', 'javascript:alert(1).md', 'data:text/html,x.html', 'vbscript:x']) assert.equal(linkUrl(u), '', u);
});

test('the path as written is kept when relative', () => {
  assert.equal(relOf('models/partner.js:23'), 'models/partner.js');
  assert.equal(relOf('./supa-api/models/partner.js'), 'supa-api/models/partner.js');
  assert.equal(relOf('README.md'), 'README.md');
  assert.equal(relOf('/home/klemid/dev/supa/x.js'), undefined);
  assert.equal(relOf('file:///tmp/x.log'), undefined);
  assert.equal(relOf('~/x.md'), undefined);
});

test('paths a chat touched, newest first: tool inputs, diffs, cd / git -C, Codex cwd', () => {
  const items = [
    { kind: 'tool', id: '1', tool: 'Read', category: 'read', title: '', input: { file_path: '/home/klemid/dev/supa/supa-api/models/partner.js' }, status: 'done' },
    { kind: 'tool', id: '2', tool: 'Bash', category: 'bash', title: '', input: { command: 'cd worktrees/pptx-recheck/supa-nest && git -C "/home/klemid/dev/supa/supa-admin" status' }, status: 'done' },
    { kind: 'assistant', id: '3', text: 'ok' },
    { kind: 'tool', id: '4', tool: 'commandExecution', category: 'bash', title: '', input: { command: 'git status', cwd: '/home/klemid/dev/supa/supa-dashboard' }, status: 'done' },
    { kind: 'tool', id: '5', tool: 'write_to_file', category: 'write', title: '', input: { TargetFile: '/home/klemid/dev/supa/supa-landing/a.md' }, diffs: [{ path: '/home/klemid/dev/supa/supa-landing/a.md', kind: 'add', newText: '' }], status: 'done' },
  ] as unknown as ChatItem[];
  assert.deepEqual(touchedPaths(items, cwd), [
    '/home/klemid/dev/supa/supa-landing/a.md',
    '/home/klemid/dev/supa/supa-dashboard',
    '/home/klemid/dev/supa/worktrees/pptx-recheck/supa-nest',
    '/home/klemid/dev/supa/supa-admin',
    '/home/klemid/dev/supa/supa-api/models/partner.js',
  ]);
  assert.equal(touchedPaths(items, cwd, 2).length, 2);
});
