'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArrowRightLeftIcon, Loader2Icon } from 'lucide-react';
import { toast } from 'sonner';
import { AGENTS, type AgentKind, type ChatSettings } from '@mcc-agents/protocol';
import { AGENT_NAME } from '@/components/agent-badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { store, useStore } from '@/lib/store';
import { ui, useUi } from '@/lib/ui';
import { useCaps } from './chat-view';
import { SettingsChips } from './composer';
import { AgentCards, autoMode, lastSettings } from './new-chat';

/** Open «Продолжить в другом агенте» for a chat (menu, limit errors). */
export function openHandoff(chatId: string) {
  ui.set({ handoff: { chatId } });
}

/**
 * «Продолжить в другом агенте»: pick the agent (model, mode), optionally add a word, and a new chat in the same folder
 * starts with the whole history as a file — the new agent sums it up and waits for a command.
 */
export function HandoffDialog() {
  const req = useUi((s) => s.handoff);
  const src = useStore((s) => (req ? s.chats[req.chatId] : undefined));
  const others = useMemo(() => AGENTS.filter((a) => a !== src?.agent), [src?.agent]);
  const [agent, setAgent] = useState<AgentKind>('codex');
  const [settings, setSettings] = useState<ChatSettings>({});
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const caps = useCaps(agent, src?.cwd);

  useEffect(() => {
    if (!req || !src) return;
    setAgent((a) => (others.includes(a) ? a : others[0]));
    setNote('');
    setBusy(false);
  }, [req, src, others]);

  // model / effort as last time for that agent, permissions — «Авто» (as a new chat)
  useEffect(() => {
    if (!caps) return;
    const last = lastSettings(agent);
    const models = caps.models.map((m) => m.id);
    setSettings({
      model: last.model && models.includes(last.model) ? last.model : caps.defaults.model,
      effort: last.effort ?? caps.defaults.effort,
      permissionMode: autoMode(caps),
    });
  }, [caps, agent]);

  const close = () => ui.set({ handoff: null });
  const submit = async () => {
    if (!req || busy) return;
    setBusy(true);
    try {
      const clean = Object.fromEntries(Object.entries(settings).filter(([, v]) => v)) as ChatSettings;
      if (agent === 'claude' && clean.model === 'default') delete clean.model;
      const id = await store.handoff(req.chatId, agent, clean, note);
      close();
      store.navigate({ kind: 'chat', chatId: id });
      toast.success(`Продолжаем в ${AGENT_NAME[agent]}`, { description: 'История передана файлом. Агент перескажет, где вы остановились, и будет ждать команды.' });
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(false);
    }
  };

  const running = src?.status === 'running' || src?.status === 'starting' || src?.status === 'waiting';

  return (
    <Dialog open={!!req} onOpenChange={(v) => !v && close()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowRightLeftIcon className="size-5" /> Продолжить в другом агенте
          </DialogTitle>
          <DialogDescription>
            Новый чат в той же папке. Вся история этого чата уйдёт файлом; новый агент коротко перескажет, где вы остановились, и
            будет ждать команды. Этот чат не меняется.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <AgentCards agent={agent} onChange={setAgent} agents={others} compact />
          <div className="flex min-h-9 flex-wrap items-center gap-1">
            <SettingsChips caps={caps} settings={settings} onChange={(p) => setSettings((cur) => ({ ...cur, ...p }))} />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="handoff-note" className="text-xs text-muted-foreground">
              Что добавить к передаче — необязательно
            </label>
            <textarea
              id="handoff-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              placeholder="Например: дальше займёмся тестами"
              className="w-full resize-none rounded-md border bg-background px-3 py-2 text-base outline-none focus:border-ring md:text-sm"
            />
          </div>
          {running && <p className="text-xs text-warning">Агент ещё работает — дождитесь конца ответа или остановите его.</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Отмена
            </Button>
            <Button type="submit" disabled={busy || running || !caps?.available}>
              {busy ? <Loader2Icon className="animate-spin" /> : <ArrowRightLeftIcon />} Продолжить в {AGENT_NAME[agent]}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
