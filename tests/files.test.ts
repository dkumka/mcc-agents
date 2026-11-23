// Links to files in agent answers (apps/web/src/lib/files.ts). Run: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatItem } from '@mcc-agents/protocol';
import { isBareName, looksLikeFile, pathsNamed, resolvePath } from '../apps/web/src/lib/files.ts';

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
