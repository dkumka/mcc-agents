'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_VOICE_MODEL, VOICE_MODELS, type TranscribeResult } from '@mcc-agents/protocol';
import { toLogin } from '@/lib/auth';
import { store } from '@/lib/store';

/** Longest dictation; the recording stops by itself and goes to transcription. */
export const MAX_DICTATION_SEC = 5 * 60;

export type DictationState = 'idle' | 'starting' | 'recording' | 'transcribing';

type Rec = { mr: MediaRecorder; stream: MediaStream; ctx?: AudioContext; raf?: number; timer?: number; cancelled?: boolean };

/** Opus in WebM (Chrome, Firefox, Android) or AAC in MP4 (Safari, iOS) — both accepted by OpenRouter as is. */
function pickMime(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  for (const t of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/ogg;codecs=opus']) {
    if (MediaRecorder.isTypeSupported?.(t)) return t;
  }
  return undefined;
}

export function dictationSupported(): boolean {
  return typeof window !== 'undefined' && typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
}

function micError(e: unknown): string {
  const name = (e as { name?: string })?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Нет доступа к микрофону — разрешите его в настройках браузера';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'Микрофон не найден';
  if (name === 'NotReadableError') return 'Микрофон занят другим приложением';
  return `Не удалось включить микрофон: ${(e as Error)?.message ?? e}`;
}

/** Decode the take and re-encode it as 16 kHz mono 16-bit WAV (~32 KB/s) — for models that refuse WebM/MP4. */
async function toWav(blob: Blob): Promise<Blob> {
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Ctx();
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
  } finally {
    ctx.close().catch(() => {});
  }
  const rate = 16_000;
  const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * rate)), rate);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const pcm = (await off.startRendering()).getChannelData(0);
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + pcm.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
  return new Blob([buf], { type: 'audio/wav' });
}

async function transcribe(take: Blob): Promise<TranscribeResult> {
  const id = store.state.prefs?.voiceModel ?? DEFAULT_VOICE_MODEL;
  let blob = take;
  if (VOICE_MODELS.find((m) => m.id === id)?.wav) {
    try {
      blob = await toWav(take);
    } catch {
      // can't decode here — send as recorded, the server will report if the model refuses it
    }
  }
  const r = await fetch('/api/transcribe', { method: 'POST', headers: { 'Content-Type': blob.type || 'audio/webm' }, body: blob });
  if (r.status === 401) toLogin();
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body?.error ?? `Ошибка распознавания (${r.status})`);
  return body as TranscribeResult;
}

/**
 * Voice input: record from the microphone, send to the server (`/api/transcribe` → OpenRouter), get text back.
 * `level` is 0..1 (for the meter), `seconds` — recording time.
 */
export function useDictation(onText: (text: string) => void, onError: (msg: string) => void) {
  const [state, setState] = useState<DictationState>('idle');
  const [seconds, setSeconds] = useState(0);
  const [level, setLevel] = useState(0);
  const rec = useRef<Rec | null>(null);
  const cb = useRef({ onText, onError });
  cb.current = { onText, onError };

  const release = useCallback(() => {
    const r = rec.current;
    if (!r) return;
    if (r.raf) cancelAnimationFrame(r.raf);
    if (r.timer) clearInterval(r.timer);
    r.stream.getTracks().forEach((t) => t.stop());
    r.ctx?.close().catch(() => {});
    rec.current = null;
    setLevel(0);
  }, []);

  const stop = useCallback(() => {
    const r = rec.current;
    if (r && r.mr.state !== 'inactive') r.mr.stop();
  }, []);

  const cancel = useCallback(() => {
    const r = rec.current;
    if (!r) return;
    r.cancelled = true;
    if (r.mr.state !== 'inactive') r.mr.stop();
    else release();
  }, [release]);

  const start = useCallback(async () => {
    if (rec.current || state !== 'idle') return;
    if (!dictationSupported()) return cb.current.onError('Этот браузер не умеет записывать звук');
    setState('starting');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      setState('idle');
      return cb.current.onError(micError(e));
    }
    const mime = pickMime();
    let mr: MediaRecorder;
    try {
      mr = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 64_000 } : undefined);
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop());
      setState('idle');
      return cb.current.onError(`Запись не поддерживается: ${(e as Error).message}`);
    }
    const chunks: Blob[] = [];
    const r: Rec = { mr, stream };
    rec.current = r;
    mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    mr.onstop = async () => {
      const cancelled = r.cancelled;
      release();
      const blob = new Blob(chunks, { type: (mr.mimeType || mime || 'audio/webm').split(';')[0] });
      if (cancelled || blob.size < 1000) {
        setState('idle');
        return;
      }
      setState('transcribing');
      try {
        const res = await transcribe(blob);
        if (res.text) cb.current.onText(res.text);
        else cb.current.onError('Ничего не распознано — попробуйте ещё раз');
      } catch (e) {
        cb.current.onError((e as Error).message);
      } finally {
        setState('idle');
      }
    };
    // level meter (cosmetic: failure here must not break recording)
    try {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx();
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(an);
      const buf = new Uint8Array(an.fftSize);
      r.ctx = ctx;
      let frame = 0;
      const tick = () => {
        r.raf = requestAnimationFrame(tick);
        // ~15 updates/s is enough for the eye and spares re-rendering the composer every frame on phones
        if (frame++ % 4) return;
        an.getByteTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += (v - 128) * (v - 128);
        // speech is quiet in absolute terms (RMS ~3–20 of 128): a square-root curve makes the meter lively
        setLevel(Math.min(1, Math.sqrt(Math.sqrt(sum / buf.length) / 28)));
      };
      tick();
    } catch {}
    const t0 = Date.now();
    setSeconds(0);
    r.timer = window.setInterval(() => {
      const s = Math.floor((Date.now() - t0) / 1000);
      setSeconds(s);
      if (s >= MAX_DICTATION_SEC) stop();
    }, 250);
    mr.start(1000);
    setState('recording');
  }, [state, release, stop]);

  // leaving the chat mid-recording: drop it, free the microphone
  useEffect(() => () => {
    if (rec.current) {
      rec.current.cancelled = true;
      if (rec.current.mr.state !== 'inactive') rec.current.mr.stop();
    }
  }, []);

  return { state, seconds, level, start, stop, cancel };
}
