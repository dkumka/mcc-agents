'use client';

import { useEffect, useRef, useState } from 'react';
import { FolderPlusIcon, Loader2Icon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { createProject } from '@/lib/api';
import { store } from '@/lib/store';

const NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/;

/** «Новый проект»: a folder in ~/dev (optionally a git repo), then a new chat in it. */
export function NewProjectDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (v: boolean) => void; onCreated?: (path: string) => void }) {
  const [name, setName] = useState('');
  const [git, setGit] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setName('');
    setError(null);
    setBusy(false);
  }, [open]);

  const valid = NAME.test(name);
  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await createProject(name, git);
      if (r.gitError) toast.warning('Папка создана, но git init не удался', { description: r.gitError });
      onOpenChange(false);
      if (onCreated) onCreated(r.path);
      else store.navigate({ kind: 'new', cwd: r.path, mode: 'code' });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" onOpenAutoFocus={(e) => (e.preventDefault(), input.current?.focus())}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderPlusIcon className="size-5" /> Новый проект
          </DialogTitle>
          <DialogDescription>Папка в ~/dev — сразу после создания откроется новый чат в ней.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="space-y-1.5">
            <input
              ref={input}
              value={name}
              onChange={(e) => {
                setName(e.target.value.trim());
                setError(null);
              }}
              placeholder="my-project"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="h-11 w-full rounded-md border bg-background px-3 font-mono text-base outline-none focus:border-ring md:text-sm"
            />
            <div className="font-mono text-xs text-muted-foreground">~/dev/{name || '…'}</div>
            {name && !valid && <div className="text-xs text-destructive">Латиница, цифры, «-», «_», «.»; начинается с буквы или цифры</div>}
            {error && <div className="text-xs text-destructive">{error}</div>}
          </div>
          <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-3">
            <input type="checkbox" checked={git} onChange={(e) => setGit(e.target.checked)} className="mt-0.5 size-4 shrink-0 accent-primary" />
            <span className="min-w-0">
              <span className="block text-sm font-medium">Git-репозиторий</span>
              <span className="block text-xs text-muted-foreground">git init (ветка main) — будут видны изменения и diff</span>
            </span>
          </label>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Отмена
            </Button>
            <Button type="submit" disabled={!valid || busy}>
              {busy && <Loader2Icon className="animate-spin" />} Создать
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
