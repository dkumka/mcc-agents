import type { Metadata, Viewport } from 'next';
import { cookies } from 'next/headers';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './globals.css';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';

export const metadata: Metadata = {
  title: 'mcc agents',
  description: 'Claude Code и Codex на сервере mcc',
  robots: { index: false, follow: false },
  appleWebApp: { capable: true, title: 'mcc agents', statusBarStyle: 'default' },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  viewportFit: 'cover',
  interactiveWidget: 'resizes-content',
};

function px(v: string | undefined, min: number, max: number): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(max, Math.max(min, Math.round(n))) : undefined;
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const jar = await cookies();
  // light by default; dark only when chosen (cookie shared by *.mcc.babochkin.com)
  const dark = jar.get('theme')?.value === 'dark';
  const sidebarW = px(jar.get('mcc_sidebar_w')?.value, 220, 480);
  const panelW = px(jar.get('mcc_panel_w')?.value, 320, 1400);
  const style = {
    colorScheme: dark ? 'dark' : 'light',
    ...(sidebarW ? { '--sidebar-w': `${sidebarW}px` } : {}),
    ...(panelW ? { '--panel-w': `${panelW}px` } : {}),
  } as React.CSSProperties;
  return (
    <html lang="ru" className={dark ? 'dark' : undefined} style={style} suppressHydrationWarning>
      <head>
        <meta name="theme-color" content={dark ? '#0a0a0a' : '#ffffff'} />
      </head>
      <body className="antialiased">
        <TooltipProvider delayDuration={400}>
          {children}
          <Toaster position="top-center" />
        </TooltipProvider>
      </body>
    </html>
  );
}
