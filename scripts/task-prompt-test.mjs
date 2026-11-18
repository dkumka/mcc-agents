import assert from 'node:assert/strict';
import { taskPrompt } from '../apps/web/src/lib/task-prompt.ts';
const prompt = '\n# Задача\n\n  - Markdown **жирный**\n```ts\nx()\n```\n\n';
assert.equal(taskPrompt('````mcc-task\n' + prompt + '\n````'), prompt);
assert.equal(taskPrompt('~~~mcc-task\nтекст\n~~~'), 'текст');
for (const raw of ['```mcc-task\nнезавершённый', '```ts\nx\n```', '```mcc-task\n\n```', '````mcc-task\nx\n```']) assert.equal(taskPrompt(raw), null);
console.log('PASS: multiline Markdown, whitespace, nested fences, incomplete and empty blocks');
