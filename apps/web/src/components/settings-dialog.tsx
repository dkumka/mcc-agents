'use client';

import { CheckCircle2Icon, CircleAlertIcon, LogOutIcon, MoonIcon, SunIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
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

export function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const prefs = useStore((s) => s.prefs);
  const [theme, setTheme] = useTheme();
  const delay = prefs?.telegramDelaySec ?? 60;
  const options = DELAYS.some((d) => d.v === delay) ? DELAYS : [...DELAYS, { v: delay, label: `через ${delay} с` }];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Настройки</DialogTitle>
          <DialogDescription>Сохраняются на сервере и действуют на всех устройствах (тема — в этом браузере).</DialogDescription>
        </DialogHeader>

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
          <h3 className="text-sm font-medium">Вход</h3>
          <Button variant="outline" className="h-11 w-full" asChild>
            <a href="https://auth.mcc.babochkin.com/logout">
              <LogOutIcon /> Выйти на всех сайтах mcc
            </a>
          </Button>
        </section>
      </DialogContent>
    </Dialog>
  );
}
