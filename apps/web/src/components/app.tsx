'use client';

import { useEffect } from 'react';
import { toast } from 'sonner';
import { AppSidebar } from '@/components/app-sidebar';
import { DebugOverlay } from '@/components/debug-overlay';
import { FileViewer } from '@/components/file-viewer';
import { ForkDialog } from '@/components/chat/fork-dialog';
import { ChatView } from '@/components/chat/chat-view';
import { NewChat } from '@/components/chat/new-chat';
import { SidePanel } from '@/components/panel/side-panel';
import { ResizeHandle } from '@/components/resize-handle';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { useAppViewport } from '@/hooks/use-app-viewport';
import { useIsMobile } from '@/hooks/use-mobile';
import { modeOf, store, useStore } from '@/lib/store';
import { ui, useUi } from '@/lib/ui';

function Panel() {
  const route = useStore((s) => s.route);
  const state = useStore((s) => (s.route.kind === 'chat' ? s.states[s.route.chatId] : undefined));
  const panel = useUi((s) => s.panel);
  const isMobile = useIsMobile();
  if (route.kind !== 'chat' || !state) return null;
  if (isMobile)
    return (
      <Sheet open={!!panel} onOpenChange={(o) => !o && ui.set({ panel: null })}>
        <SheetContent side="right" className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-full [&>button]:hidden">
          <SheetTitle className="sr-only">Панель</SheetTitle>
          {panel && <SidePanel tab={panel} state={state} />}
        </SheetContent>
      </Sheet>
    );
  if (!panel) return null;
  return (
    <aside className="relative hidden w-[var(--panel-w,min(44vw,560px))] min-w-[320px] max-w-[70vw] shrink-0 border-l md:block">
      <ResizeHandle side="left" cssVar="--panel-w" cookie="mcc_panel_w" min={320} max={() => Math.round(window.innerWidth * 0.7)} />
      <SidePanel tab={panel} state={state} />
    </aside>
  );
}

export function App() {
  useAppViewport();
  const route = useStore((s) => s.route);
  const mode = useStore(modeOf);
  useEffect(() => {
    store.start();
    store.errorHandler = (m) => toast.error(m);
    const wake = () => document.visibilityState === 'visible' && store.wake();
    document.addEventListener('visibilitychange', wake);
    return () => document.removeEventListener('visibilitychange', wake);
  }, []);

  return (
    <SidebarProvider className="app-h min-h-0 overflow-hidden" style={{ '--sidebar-width': 'var(--sidebar-w, 16rem)' } as React.CSSProperties}>
      <AppSidebar />
      <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
        <div className="flex h-full min-h-0 min-w-0">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {route.kind === 'chat' ? (
              <ChatView key={route.chatId} chatId={route.chatId} />
            ) : (
              <NewChat key={route.kind === 'new' ? route.draft : undefined} draft={route.kind === 'new' ? route.draft : undefined} mode={mode} initialCwd={route.kind === 'new' ? route.cwd : undefined} initialAgent={route.kind === 'new' ? route.agent : undefined} />
            )}
          </div>
          <Panel />
        </div>
      </SidebarInset>
      <FileViewer />
      <ForkDialog />
      <DebugOverlay />
    </SidebarProvider>
  );
}
