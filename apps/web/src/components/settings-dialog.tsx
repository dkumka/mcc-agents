'use client';

import { useEffect, useState } from 'react';
import { ArrowUpIcon, CheckCircle2Icon, CircleAlertIcon, LogOutIcon, MoonIcon, PaperclipIcon, PencilLineIcon, SunIcon } from 'lucide-react';
import { CLEANUP_MODELS, DEFAULT_CLEANUP_MODEL, DEFAULT_VOICE_MODEL, VOICE_MODELS } from '@mcc-agents/protocol';
import { VoiceHistory } from '@/components/voice-history';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api } from '@/lib/api';
import { fmtSize } from '@/lib/files';
import { store, useStore } from '@/lib/store';
import { useTheme } from '@/lib/theme';

const DELAYS: { v: number; label: string }[] = [
  { v: 0, label: 'Не отправлять' },
  { v: 30, label: 'через 30 секунд' },
  { v: 60, label: 'через 1 минуту' },
  { v: 120, label: 'через 2 минуты' },
  { v: 300, label: 'через 5 минут' },
  { v: 600, label: 'через 10 минут' },
  { v: 1800, label: 'через 30 минут' },
];

const TABS = [
  { id: 'voice', label: 'Голос' },
  { id: 'telegram', label: 'Telegram' },
  { id: 'files', label: 'Файлы' },
  { id: 'general', label: 'Общие' },
] as const;
type Tab = (typeof TABS)[number]['id'];

function ModelSelect({ value, models, onChange }: { value: string; models: { id: string; label: string; description: string }[]; onChange: (v: string) => void }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-auto min-h-11 w-full py-2 text-left">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {models.map((m) => (
          <SelectItem key={m.id} value={m.id} className="py-2">
            <div className="min-w-0">
              <div className="text-sm">{m.label}</div>
              <div className="text-xs text-muted-foreground">{m.description}</div>
            </div>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function Check({ checked, onChange, title, hint }: { checked: boolean; onChange: (v: boolean) => void; title: string; hint: string }) {
  return (
    <label className={cn('flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors', checked && 'border-primary/40 bg-muted/40')}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 size-4 shrink-0 accent-primary" />
      <span className="min-w-0">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
    </label>
  );
}

export function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const prefs = useStore((s) => s.prefs);
  const [theme, setTheme] = useTheme();
  const [tab, setTab] = useState<Tab>('voice');
  const delay = prefs?.telegramDelaySec ?? 60;
  const [uploads, setUploads] = useState<{ dir: string; files: number; bytes: number } | null>(null);
  useEffect(() => {
    if (open && tab === 'files') api.uploads().then(setUploads).catch(() => setUploads(null));
  }, [open, tab]);
  const options = DELAYS.some((d) => d.v === delay) ? DELAYS : [...DELAYS, { v: delay, label: `через ${delay} с` }];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90dvh] flex-col gap-4 overflow-hidden sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Настройки</DialogTitle>
          <DialogDescription>Сохраняются на сервере и действуют на всех устройствах (тема — в этом браузере).</DialogDescription>
        </DialogHeader>

        <div role="tablist" aria-label="Разделы настроек" className="grid shrink-0 grid-cols-4 gap-0.5 rounded-lg bg-muted p-[3px]">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                'h-9 truncate rounded-md px-1 text-[13px] font-medium transition-colors sm:h-8',
                tab === t.id
                  ? 'bg-background text-foreground shadow-sm dark:border dark:border-input dark:bg-input/30'
                  : 'text-foreground/60 hover:text-foreground dark:text-muted-foreground dark:hover:text-foreground',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div role="tabpanel" className="-mx-6 min-h-0 flex-1 space-y-5 overflow-y-auto px-6 pb-1">
          {tab === 'voice' && (
            <>
            <section className="space-y-2">
              <h3 className="text-sm font-medium">Распознавание речи</h3>
              <p className="text-sm text-muted-foreground">
                Кнопка 🎤 в поле ввода: говорите, нажмите ещё раз — запись распознаётся через OpenRouter (серверный ключ). Русский с английскими словами
                понимают все четыре модели.
              </p>
              <ModelSelect value={prefs?.voiceModel ?? DEFAULT_VOICE_MODEL} models={VOICE_MODELS} onChange={(v) => store.setPrefs({ voiceModel: v })} />
              {prefs && !prefs.voiceReady && (
                <div className="flex items-center gap-2 text-xs text-warning">
                  <CircleAlertIcon className="size-3.5" /> Нет ключа OpenRouter на сервере: <code>secret-set openrouter</code>
                </div>
              )}
            </section>

            <section className="space-y-2">
              <h3 className="text-sm font-medium">Обработка текста</h3>
              <Check
                checked={prefs?.voiceCleanup ?? true}
                onChange={(v) => store.setPrefs({ voiceCleanup: v })}
                title="Исправлять текст"
                hint="Убирать «э-э», повторы и оборванные слова; английские слова и названия — латиницей (Айфон → iPhone). Смысл и формулировки не меняются."
              />
              <Check
                checked={prefs?.voiceTranslate ?? false}
                onChange={(v) => store.setPrefs({ voiceTranslate: v })}
                title="Переводить на английский"
                hint="Всё наговорённое дополнительно переводится на английский. Выключено — текст остаётся на языке, на котором говорили."
              />
              {(prefs?.voiceCleanup ?? true) || prefs?.voiceTranslate ? (
                <>
                  <div className="pt-1 text-xs text-muted-foreground">Модель для исправления и перевода</div>
                  <ModelSelect value={prefs?.voiceCleanupModel ?? DEFAULT_CLEANUP_MODEL} models={CLEANUP_MODELS} onChange={(v) => store.setPrefs({ voiceCleanupModel: v })} />
                </>
              ) : null}
            </section>

            <section className="space-y-2">
              <h3 className="text-sm font-medium">После распознавания</h3>
              <div className="grid grid-cols-2 gap-2">
                <Button variant={!prefs?.voiceAutoSend ? 'default' : 'outline'} className="h-auto min-h-11 whitespace-normal py-2" onClick={() => store.setPrefs({ voiceAutoSend: false })}>
                  <PencilLineIcon /> Текст в поле
                </Button>
                <Button variant={prefs?.voiceAutoSend ? 'default' : 'outline'} className="h-auto min-h-11 whitespace-normal py-2" onClick={() => store.setPrefs({ voiceAutoSend: true })}>
                  <ArrowUpIcon /> Отправлять сразу
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {prefs?.voiceAutoSend ? 'Готовый текст сразу уходит агенту — без клавиатуры.' : 'Готовый текст появляется в поле: можно поправить и отправить.'} Запись — до 5
                минут.
              </p>
            </section>

            <section className="space-y-2">
              <h3 className="text-sm font-medium">История записей</h3>
              <p className="text-xs text-muted-foreground">
                Каждая запись сохраняется на сервере до распознавания — если что-то пошло не так, её можно распознать ещё раз. Хранятся, пока вы их не удалите.
              </p>
              <VoiceHistory onInsert={() => onOpenChange(false)} />
            </section>
            </>
          )}
          {tab === 'telegram' && (
            <>
            <section className="space-y-2">
              <h3 className="text-sm font-medium">Вопросы и подтверждения в Telegram</h3>
              <p className="text-sm text-muted-foreground">
                Если агент ждёт вашего ответа (разрешить команду, правку, ответить на вопрос) и вы не ответили здесь — сообщение с кнопками придёт в
                Telegram. Ответ в одном месте отмечается в другом.
              </p>
              <Select value={String(delay)} onValueChange={(v) => store.setPrefs({ telegramDelaySec: Number(v) })}>
                <SelectTrigger className="h-11 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {options.map((d) => (
                    <SelectItem key={d.v} value={String(d.v)} className="py-2.5">
                      {d.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {prefs?.telegramReady ? (
                <div className="flex items-center gap-2 text-xs text-success">
                  <CheckCircle2Icon className="size-3.5" /> Бот агентов подключён
                </div>
              ) : (
                <div className="space-y-1.5 rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs">
                  <div className="flex items-center gap-2 font-medium text-warning">
                    <CircleAlertIcon className="size-3.5" /> Бот агентов ещё не подключён
                  </div>
                  <ol className="list-decimal space-y-1 pl-4 text-muted-foreground">
                    <li>
                      В Telegram у <b>@BotFather</b> создайте бота (<code>/newbot</code>) и скопируйте токен.
                    </li>
                    <li>
                      На сервере: <code className="break-all">secret-set agents-telegram TELEGRAM_BOT_TOKEN</code> (вставьте токен).
                    </li>
                    <li>Откройте нового бота и нажмите «Start». Через минуту здесь станет зелёным.</li>
                  </ol>
                  <p className="text-muted-foreground">Пока бот не подключён, приходит обычное уведомление без кнопок от бота сервера.</p>
                </div>
              )}
            </section>

            </>
          )}
          {tab === 'files' && (
            <>
            <section className="space-y-2">
              <h3 className="text-sm font-medium">Вложения</h3>
              <div className="flex items-start gap-3 rounded-lg border p-3 text-sm">
                <PaperclipIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 space-y-1">
                  <div>{uploads ? (uploads.files ? `${uploads.files} файл. · ${fmtSize(uploads.bytes)}` : 'Пока нет') : '…'}</div>
                  <p className="text-xs text-muted-foreground">
                    Файлы, приложенные к чатам, хранятся на сервере бессрочно — сами не удаляются. Открыть их можно из чата или в панели «Файлы» → «Вложения».
                  </p>
                  {uploads && <div className="break-all font-mono text-[11px] text-muted-foreground">{uploads.dir.replace(/^\/home\/[^/]+/, '~')}</div>}
                </div>
              </div>
            </section>

            </>
          )}
          {tab === 'general' && (
            <>
            <section className="space-y-2">
              <h3 className="text-sm font-medium">Тема</h3>
              <div className="grid grid-cols-2 gap-2">
                <Button variant={theme === 'light' ? 'default' : 'outline'} className="h-11" onClick={() => setTheme('light')}>
                  <SunIcon /> Светлая
                </Button>
                <Button variant={theme === 'dark' ? 'default' : 'outline'} className="h-11" onClick={() => setTheme('dark')}>
                  <MoonIcon /> Тёмная
                </Button>
              </div>
            </section>

            <section className="space-y-2">
              <h3 className="text-sm font-medium">Диагностика</h3>
              <Button
                variant="outline"
                className="h-11 w-full"
                onClick={() => {
                  localStorage.setItem('mccDebug', localStorage.getItem('mccDebug') === '1' ? '0' : '1');
                  window.location.reload();
                }}
              >
                Показать / скрыть размеры экрана
              </Button>
            </section>

            <section className="space-y-2">
              <h3 className="text-sm font-medium">Вход</h3>
              <Button variant="outline" className="h-11 w-full" asChild>
                <a href="https://mcc.klemid.ru/logout">
                  <LogOutIcon /> Выйти на всех сайтах mcc
                </a>
              </Button>
            </section>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
