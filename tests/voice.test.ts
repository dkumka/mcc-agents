import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DEFAULT_VOICE_MODEL, VOICE_MODELS, isLocalVoiceModel, type VoiceRecord } from '../packages/protocol/src/index.ts';

test('VOICE_MODELS exposes local GigaAM-v4 as default without forcing WAV', () => {
  assert.equal(DEFAULT_VOICE_MODEL, 'local/gigaam-v4');
  assert.equal(isLocalVoiceModel('local/gigaam-v4'), true);
  assert.equal(isLocalVoiceModel('microsoft/mai-transcribe-2'), false);
  const local = VOICE_MODELS.find((m) => m.id === 'local/gigaam-v4');
  assert.ok(local);
  assert.equal(local.wav, undefined);
  assert.equal(local.local, true);
});

test('processRecord uses local worker, skips cleanup without OpenRouter key, and reports overload cleanly', async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-voice-test-'));
  const dataDir = path.join(tmpHome, 'data');
  const voiceDir = path.join(dataDir, 'voice');
  fs.mkdirSync(voiceDir, { recursive: true });
  const audioFile = path.join(voiceDir, '2026-11-27-test0001.webm');
  fs.writeFileSync(audioFile, Buffer.alloc(2048, 1));

  let mode: 'ok' | 'overload' = 'ok';
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, model: 'local/gigaam-v4' }));
      return;
    }
    if (req.url === '/transcribe') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        if (mode === 'overload') {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Сервер сейчас перегружен' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ text: 'Привет из локальной модели.', model: 'local/gigaam-v4', ms: 320 }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  process.env.HOME = tmpHome;
  process.env.AGENTD_DATA = dataDir;
  process.env.AGENTD_LOCAL_VOICE_URL = `http://127.0.0.1:${port}`;

  try {
    const { flushStore, store } = await import('../apps/agentd/src/store.ts');
    const { getLocalVoiceReady, processRecord, refreshLocalVoiceReady } = await import('../apps/agentd/src/voice.ts');

    const changed = await refreshLocalVoiceReady();
    assert.equal(changed, true);
    assert.equal(getLocalVoiceReady(), true);

    store.setPrefs({ voiceModel: 'local/gigaam-v4', voiceCleanup: true, voiceTranslate: false });
    const baseRec: VoiceRecord = {
      id: '2026-11-27-test0001',
      createdAt: Date.now(),
      file: audioFile,
      mediaType: 'audio/webm',
      size: 2048,
      durationSec: 5,
      status: 'error',
    };

    // 1. Happy path: local ASR works without OpenRouter key, cleanup skipped silently
    const ok = await processRecord(baseRec, 'local/gigaam-v4');
    assert.equal(ok.status, 'ok');
    assert.equal(ok.model, 'local/gigaam-v4');
    assert.equal(ok.raw, 'Привет из локальной модели.');
    assert.equal(ok.text, 'Привет из локальной модели.');
    assert.equal(ok.cleanupError, undefined);

    // 2. Translate requested without OpenRouter key: returns raw text + explicit cleanupError
    store.setPrefs({ voiceTranslate: true });
    const tr = await processRecord(baseRec, 'local/gigaam-v4');
    assert.equal(tr.status, 'ok');
    assert.equal(tr.text, 'Привет из локальной модели.');
    assert.match(tr.cleanupError ?? '', /OpenRouter/);

    // 3. Local service 503 overload without OpenRouter key: returns error cleanly
    store.setPrefs({ voiceTranslate: false });
    mode = 'overload';
    const err = await processRecord(baseRec, 'local/gigaam-v4');
    assert.equal(err.status, 'error');
    assert.match(err.error ?? '', /перегружен/);
    flushStore();
  } finally {
    server.close();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});
