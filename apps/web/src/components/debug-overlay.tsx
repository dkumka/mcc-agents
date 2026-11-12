'use client';

import { useEffect, useState } from 'react';

/** ?debug=1 or Settings → «Диагностика экрана» — viewport / safe-area / keyboard numbers (for the iOS home-screen app). */
export function DebugOverlay() {
  const [text, setText] = useState('');
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has('debug') && localStorage.getItem('mccDebug') !== '1') return;
    const probe = document.createElement('div');
    probe.style.cssText =
      'position:fixed;top:0;left:0;width:0;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom);visibility:hidden';
    document.body.appendChild(probe);
    const mk = (h: string) => {
      const d = document.createElement('div');
      d.style.cssText = `position:fixed;top:0;left:0;width:0;height:${h};visibility:hidden`;
      document.body.appendChild(d);
      return d;
    };
    const probes = { dvh: mk('100dvh'), lvh: mk('100lvh'), svh: mk('100svh'), vh: mk('100vh'), pct: mk('100%') };
    const tick = () => {
      const cs = getComputedStyle(probe);
      const vv = window.visualViewport;
      const header = document.querySelector('header');
      setText(
        [
          `standalone=${window.matchMedia('(display-mode: standalone)').matches} navStandalone=${(navigator as { standalone?: boolean }).standalone}`,
          `safeTop=${cs.paddingTop} safeBottom=${cs.paddingBottom}`,
          `inner=${window.innerWidth}x${window.innerHeight} screen=${screen.width}x${screen.height}`,
          `vv=${vv ? `${Math.round(vv.width)}x${Math.round(vv.height)} top=${Math.round(vv.offsetTop)}` : '-'} scrollY=${window.scrollY}`,
          `header top=${header ? Math.round(header.getBoundingClientRect().top) : '-'} h=${header ? Math.round(header.getBoundingClientRect().height) : '-'}`,
          `kb=${document.documentElement.dataset.keyboard} app-h=${getComputedStyle(document.documentElement).getPropertyValue('--app-h')} app-top=${getComputedStyle(document.documentElement).getPropertyValue('--app-top')} focus=${document.activeElement?.tagName}`,
          Object.entries(probes).map(([k, d]) => `${k}=${Math.round(d.getBoundingClientRect().height)}`).join(' ') + ` client=${document.documentElement.clientHeight}`,
        ].join('\n'),
      );
    };
    tick();
    const t = setInterval(tick, 300);
    return () => {
      clearInterval(t);
      probe.remove();
      Object.values(probes).forEach((d) => d.remove());
    };
  }, []);
  if (!text) return null;
  return (
    <pre className="pointer-events-none fixed inset-x-2 top-24 z-[100] whitespace-pre-wrap rounded-lg bg-black/80 p-3 font-mono text-[11px] text-green-300">{text}</pre>
  );
}
