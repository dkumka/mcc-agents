// Antigravity ask_question parsing, answer formatting, and fallback-echo folding. Run: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Approval, ChatSummary } from '@mcc-agents/protocol';
import { AntigravityAdapter } from '../apps/agentd/src/antigravity/index.ts';
import {
  formatAskQuestionAnswers,
  isAskQuestionTool,
  parseAskQuestions,
  questionToolTitle,
  stripRecommended,
} from '../apps/agentd/src/antigravity/questions.ts';
import { Chat } from '../apps/agentd/src/chat.ts';
import { displayOption, extractQuestionsFromInput, isAskQuestionEcho } from '../apps/web/src/lib/questions.ts';

const SAMPLE_RAW_INPUT = {
  questions: [
    {
      question:
        'В «Сообществе» (Asset.jsx) у карточки музыки сейчас нет шапки «Музыка» и кнопки «Повторить». Как оформить карточку в «Сообществе» и клик по промпту?',
      is_multi_select: false,
      options: [
        '(Recommended) Показать метку режима компактной строкой над плеером/карточкой; клик по промпту подставляет режим, промпт и текст песни',
        'Добавить в «Сообществе» полную шапку как в «Ваших работах»',
        'Показать метку в «Сообществе» над плеером; клик подставляет только текст промпта',
      ],
    },
    {
      question: 'Как выбирать язык суффикса в режиме «С вокалом» без своего текста?',
      is_multi_select: false,
      options: [
        '(Recommended) По тексту промпта: есть кириллица → «Песня с вокалом.», иначе → «Song with vocals.»',
        'Строго по языку пользователя (user.lang === \'ru\' → «Песня с вокалом.»)',
      ],
    },
    {
      question: 'Какие документы обновляем?',
      is_multi_select: true,
      options: [
        '(Recommended) Обновить справку и FAQ',
        'Обновить только справку',
        'Добавить тесты',
      ],
    },
  ],
};

test('detects ask_question tool calls by name or title', () => {
  assert.ok(isAskQuestionTool({ name: 'ask_question', title: 'Run ask_question' }));
  assert.ok(isAskQuestionTool({ name: '', title: 'Run ask_question' }));
  assert.ok(isAskQuestionTool({ name: 'AskUserQuestion' }));
  assert.ok(!isAskQuestionTool({ name: 'run_command', title: 'git status' }));
});

test('parses Antigravity ask_question payload and strips (Recommended)', () => {
  const qs = parseAskQuestions(SAMPLE_RAW_INPUT);
  assert.equal(qs.length, 3);
  assert.equal(qs[0].multiSelect, undefined);
  assert.equal(qs[0].options[0].recommended, true);
  assert.ok(!qs[0].options[0].label.includes('(Recommended)'));
  assert.equal(qs[0].options[1].recommended, undefined);
  assert.equal(qs[2].multiSelect, true);
  assert.equal(stripRecommended('Option A (Recommended)').recommended, true);
  assert.equal(stripRecommended('Option A (Recommended)').label, 'Option A');
});

test('builds Russian pluralized titles for question cards', () => {
  const qs = parseAskQuestions(SAMPLE_RAW_INPUT);
  assert.equal(questionToolTitle([qs[0]]), qs[0].question);
  assert.ok(questionToolTitle(qs).startsWith('3 вопроса · '));
  assert.ok(questionToolTitle([...qs, ...qs]).startsWith('6 вопросов · '));
});

test('formats single-question and multi-question answers without breaking on commas', () => {
  const qs = parseAskQuestions(SAMPLE_RAW_INPUT);
  // Single question: direct [N] + label, even when label has commas
  const single = formatAskQuestionAnswers([qs[0]], { [qs[0].question]: qs[0].options[0].label });
  assert.equal(single, `[1] ${qs[0].options[0].label}`);

  // Single question with custom answer
  assert.equal(formatAskQuestionAnswers([qs[0]], { [qs[0].question]: 'Сделаем иначе' }), 'Сделаем иначе');

  // Multi-question with answerLists (preserves commas inside labels + multi-select)
  const formatted = formatAskQuestionAnswers(
    qs,
    {
      [qs[0].question]: qs[0].options[0].label,
      [qs[1].question]: qs[1].options[1].label,
      [qs[2].question]: `${qs[2].options[0].label}, ${qs[2].options[2].label}`,
    },
    {
      [qs[0].question]: [qs[0].options[0].label],
      [qs[1].question]: [qs[1].options[1].label],
      [qs[2].question]: [qs[2].options[0].label, qs[2].options[2].label],
    },
  );
  assert.ok(formatted.includes(`1. ${qs[0].question}\n→ [1] ${qs[0].options[0].label}`));
  assert.ok(formatted.includes(`2. ${qs[1].question}\n→ [2] ${qs[1].options[1].label}`));
  assert.ok(formatted.includes(`3. ${qs[2].question}\n→ [1] ${qs[2].options[0].label}; [3] ${qs[2].options[2].label}`));
});

test('displayOption keeps rawLabel intact for Claude/Codex while stripping visual tag', () => {
  const d = displayOption({ label: '(Recommended) Fast path', description: 'Safe' });
  assert.equal(d.rawLabel, '(Recommended) Fast path');
  assert.equal(d.label, 'Fast path');
  assert.equal(d.recommended, true);
  assert.equal(d.description, 'Safe');
});

test('extractQuestionsFromInput handles both Antigravity and Claude formats', () => {
  const agy = extractQuestionsFromInput(SAMPLE_RAW_INPUT);
  assert.equal(agy.length, 3);
  assert.equal(agy[0].options[0].recommended, true);

  const claude = extractQuestionsFromInput({
    questions: [
      {
        header: 'Scope',
        question: 'Deploy now?',
        multiSelect: false,
        options: [{ label: 'Yes (Recommended)', description: 'Ship to sandbox' }, { label: 'No' }],
      },
    ],
  });
  assert.equal(claude.length, 1);
  assert.equal(claude[0].header, 'Scope');
  assert.equal(claude[0].options[0].recommended, true);
  assert.equal(claude[0].options[0].label, 'Yes');
});

test('isAskQuestionEcho detects agy acp fallback echo and never hides real prose', () => {
  const qs = extractQuestionsFromInput(SAMPLE_RAW_INPUT);
  const echo = [
    SAMPLE_RAW_INPUT.questions[0].question,
    '',
    `- [1] ${SAMPLE_RAW_INPUT.questions[0].options[0]}`,
    `- [2] ${SAMPLE_RAW_INPUT.questions[0].options[1]}`,
    `- [3] ${SAMPLE_RAW_INPUT.questions[0].options[2]}`,
    '',
    SAMPLE_RAW_INPUT.questions[1].question,
    '',
    `- [1] ${SAMPLE_RAW_INPUT.questions[1].options[0]}`,
    `- [2] ${SAMPLE_RAW_INPUT.questions[1].options[1]}`,
    '',
    SAMPLE_RAW_INPUT.questions[2].question,
    '',
    `- [1] ${SAMPLE_RAW_INPUT.questions[2].options[0]}`,
    `- [2] ${SAMPLE_RAW_INPUT.questions[2].options[1]}`,
    `- [3] ${SAMPLE_RAW_INPUT.questions[2].options[2]}`,
  ].join('\n');

  assert.ok(isAskQuestionEcho(echo, qs, false));

  // Streaming prefixes must also match to avoid flicker
  assert.ok(isAskQuestionEcho(SAMPLE_RAW_INPUT.questions[0].question.slice(0, 20), qs, true));
  assert.ok(isAskQuestionEcho(`${SAMPLE_RAW_INPUT.questions[0].question}\n\n- [1] (Rec`, qs, true));
  assert.ok(isAskQuestionEcho(`${SAMPLE_RAW_INPUT.questions[0].question}\n\n- [1] (Recommended) Показать`, qs, true));

  // Real assistant text or echo + extra prose must NOT be hidden
  assert.ok(!isAskQuestionEcho('Перед началом работы уточню несколько моментов:', qs, false));
  assert.ok(!isAskQuestionEcho('Перед началом работы уточню несколько моментов:', qs, true));
  assert.ok(!isAskQuestionEcho(`${echo}\n\nКстати, я ещё нашёл баг в auth.ts.`, qs, false));
  assert.ok(!isAskQuestionEcho('', qs, false));
});

function makeHarness() {
  const chats = new Map<string, Chat>();
  const events: string[] = [];
  const hub = {
    peek: (id: string) => chats.get(id),
    ensureLoaded: async () => {},
    setLimits: () => {},
  };
  const adapter = new AntigravityAdapter(hub as never);
  // Prevent background timers or spawning the real CLI
  adapter.refreshUsage = () => {};
  const prompts: { sessionId: string; prompt: unknown[] }[] = [];
  let promptResolve: ((v: { stopReason: string }) => void) | null = null;
  adapter.acp.request = async (method: string, params: Record<string, unknown> = {}) => {
    if (method === 'session/prompt') {
      prompts.push({ sessionId: String(params.sessionId), prompt: params.prompt as unknown[] });
      return new Promise((resolve) => {
        promptResolve = resolve;
      });
    }
    if (method === 'session/load') {
      return { models: { availableModels: [], currentModelId: 'gemini-4-neon-high' }, modes: { availableModes: [{ id: 'auto', name: 'Auto' }], currentModeId: 'auto' } };
    }
    return {};
  };
  adapter.acp.notify = () => {};

  const summary: ChatSummary = {
    id: 'antigravity:sess-1',
    agent: 'antigravity',
    nativeId: 'sess-1',
    cwd: '/tmp',
    title: 'Test',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: 'idle',
    origin: 'web',
  };
  const chat = new Chat(summary, {
    toSubscribers: () => {},
    summaryChanged: () => {},
    turnFinished: (_c, outcome) => events.push(`finished:${outcome}`),
    approvalAdded: (_c, a: Approval) => events.push(`approvalAdded:${a.kind}`),
    approvalRemoved: (_c, id) => events.push(`approvalRemoved:${id}`),
  });
  chats.set(chat.id, chat);
  // Mark session as loaded
  (adapter as unknown as { loaded: Set<string> }).loaded.add('sess-1');
  return {
    adapter,
    chat,
    prompts,
    events,
    endTurn: (stopReason = 'end_turn') => {
      const r = promptResolve;
      promptResolve = null;
      r?.({ stopReason });
    },
    emitUpdate: (update: Record<string, unknown>) => adapter.acp.emit('notification', 'session/update', { sessionId: 'sess-1', update }),
  };
}

test('AntigravityAdapter keeps ask_question approval across end_turn and answers via session/prompt', async () => {
  const h = makeHarness();
  await h.adapter.send(h.chat, { text: 'Сделай фичу' });
  assert.equal(h.chat.summary.status, 'running');

  h.emitUpdate({ sessionUpdate: 'tool_call', toolCallId: 'tc-ask-1', name: 'ask_question', title: 'Run ask_question', status: 'in_progress', rawInput: SAMPLE_RAW_INPUT });
  assert.equal(h.chat.state.approvals.length, 1);
  assert.equal(h.chat.state.approvals[0].kind, 'question');
  assert.equal(h.chat.state.approvals[0].questions?.length, 3);
  assert.equal(h.chat.tool('tc-ask-1')?.category, 'question');
  assert.equal(h.chat.tool('tc-ask-1')?.status, 'pending');
  assert.equal(h.chat.summary.status, 'waiting');

  // agy acp ends the turn right after emitting ask_question
  h.endTurn('end_turn');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(h.chat.state.approvals.length, 1);
  assert.equal(h.chat.summary.status, 'waiting');
  assert.ok(!h.events.includes('finished:done'));

  // Answering via QuestionForm sends a formatted prompt and completes the tool
  const qs = h.chat.state.approvals[0].questions!;
  await h.adapter.decide(h.chat, {
    approvalId: h.chat.state.approvals[0].id,
    decision: 'allow',
    answers: {
      [qs[0].question]: qs[0].options[0].label,
      [qs[1].question]: qs[1].options[1].label,
      [qs[2].question]: `${qs[2].options[0].label}, ${qs[2].options[2].label}`,
    },
    answerLists: {
      [qs[0].question]: [qs[0].options[0].label],
      [qs[1].question]: [qs[1].options[1].label],
      [qs[2].question]: [qs[2].options[0].label, qs[2].options[2].label],
    },
  });
  assert.equal(h.chat.state.approvals.length, 0);
  assert.equal(h.chat.tool('tc-ask-1')?.status, 'done');
  assert.equal(h.chat.summary.status, 'running');
  assert.equal(h.prompts.length, 2);
  const sent = (h.prompts[1].prompt[0] as { text: string }).text;
  assert.ok(sent.includes(`[1] ${qs[0].options[0].label}`));
  assert.ok(sent.includes(`[1] ${qs[2].options[0].label}; [3] ${qs[2].options[2].label}`));

  h.endTurn('end_turn');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(h.chat.summary.status, 'idle');
  assert.ok(h.events.includes('finished:done'));
});

test('AntigravityAdapter skip (deny), direct send, and interrupt cleanly settle pending ask_question', async () => {
  // 1. Deny ("Пропустить") returns to idle
  const h1 = makeHarness();
  await h1.adapter.send(h1.chat, { text: 'start' });
  h1.emitUpdate({ sessionUpdate: 'tool_call', toolCallId: 'tc-1', name: 'ask_question', status: 'in_progress', rawInput: SAMPLE_RAW_INPUT });
  h1.endTurn('end_turn');
  await new Promise((r) => setTimeout(r, 10));
  await h1.adapter.decide(h1.chat, { approvalId: h1.chat.state.approvals[0].id, decision: 'deny' });
  assert.equal(h1.chat.state.approvals.length, 0);
  assert.equal(h1.chat.tool('tc-1')?.status, 'denied');
  assert.equal(h1.chat.summary.status, 'idle');
  assert.equal(h1.prompts.length, 1);

  // 2. Direct composer message dismisses pending question
  const h2 = makeHarness();
  await h2.adapter.send(h2.chat, { text: 'start' });
  h2.emitUpdate({ sessionUpdate: 'tool_call', toolCallId: 'tc-2', name: 'ask_question', status: 'in_progress', rawInput: SAMPLE_RAW_INPUT });
  h2.endTurn('end_turn');
  await new Promise((r) => setTimeout(r, 10));
  await h2.adapter.send(h2.chat, { text: 'отвечаю текстом' });
  assert.equal(h2.chat.state.approvals.length, 0);
  assert.equal(h2.chat.tool('tc-2')?.status, 'done');
  assert.equal(h2.chat.summary.status, 'running');

  // 3. Interrupt while idle-waiting cancels pending question
  const h3 = makeHarness();
  await h3.adapter.send(h3.chat, { text: 'start' });
  h3.emitUpdate({ sessionUpdate: 'tool_call', toolCallId: 'tc-3', name: 'ask_question', status: 'in_progress', rawInput: SAMPLE_RAW_INPUT });
  h3.endTurn('end_turn');
  await new Promise((r) => setTimeout(r, 10));
  await h3.adapter.interrupt(h3.chat);
  assert.equal(h3.chat.state.approvals.length, 0);
  assert.equal(h3.chat.tool('tc-3')?.status, 'interrupted');
  assert.equal(h3.chat.summary.status, 'idle');
});

test('AntigravityAdapter load() restores trailing unanswered ask_question and marks answered ones done', async () => {
  const h = makeHarness();
  h.adapter.acp.request = async (method: string) => {
    if (method === 'session/load') {
      h.emitUpdate({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'first' } });
      h.emitUpdate({ sessionUpdate: 'tool_call', toolCallId: 'old-ask', name: 'ask_question', status: 'in_progress', rawInput: SAMPLE_RAW_INPUT });
      h.emitUpdate({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '[1] ok' } });
      h.emitUpdate({ sessionUpdate: 'tool_call', toolCallId: 'last-ask', name: 'ask_question', status: 'in_progress', rawInput: SAMPLE_RAW_INPUT });
      return { models: { availableModels: [], currentModelId: 'gemini-4-neon-high' }, modes: { availableModes: [{ id: 'auto', name: 'Auto' }], currentModeId: 'auto' } };
    }
    return {};
  };
  await h.adapter.load(h.chat);
  assert.equal(h.chat.tool('old-ask')?.status, 'done');
  assert.equal(h.chat.tool('last-ask')?.status, 'pending');
  assert.equal(h.chat.state.approvals.length, 1);
  assert.equal(h.chat.state.approvals[0].toolItemId, 'last-ask');
  assert.equal(h.chat.summary.status, 'idle');
});

