'use client';

import { useEffect } from 'react';

/**
 * iOS Safari keeps the layout viewport full-height when the keyboard opens and scrolls the page
 * instead. We size the app to the *visual* viewport (CSS var --app-h) and pin the window scroll,
 * so the composer always sits right above the keyboard and nothing jumps.
 *
 * Home-screen app on iOS 26 (status bar "black-translucent"): the page covers the whole screen, but
 * WebKit reports innerHeight / visualViewport / 100dvh short by the status bar height (812 of 874 pt on
 * iPhone 17 Pro), while 100lvh is right. We add that gap back, otherwise a blank strip shows at the bottom.
 */
export function useAppViewport() {
  useEffect(() => {
    const vv = window.visualViewport;
    const root = document.documentElement;
    const standalone =
      window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;top:0;left:0;width:0;height:100lvh;visibility:hidden;pointer-events:none';
    document.body.appendChild(probe);
    let raf = 0;
    const apply = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const vh = vv ? vv.height : window.innerHeight;
        const kb = vv ? window.innerHeight - vv.height > 120 : false;
        // with the keyboard up the visual viewport is measured from the real top already — no correction then
        const gap = standalone && !kb ? Math.max(0, Math.round(probe.getBoundingClientRect().height - window.innerHeight)) : 0;
        root.style.setProperty('--app-h', `${Math.round(vh + gap)}px`);
        root.dataset.keyboard = kb ? 'open' : 'closed';
        if (window.scrollY !== 0 && vv && Math.abs(vv.offsetTop) > 0) window.scrollTo(0, 0);
      });
    };
    apply();
    vv?.addEventListener('resize', apply);
    vv?.addEventListener('scroll', apply);
    window.addEventListener('resize', apply);
    window.addEventListener('orientationchange', apply);
    return () => {
      cancelAnimationFrame(raf);
      probe.remove();
      vv?.removeEventListener('resize', apply);
      vv?.removeEventListener('scroll', apply);
      window.removeEventListener('resize', apply);
      window.removeEventListener('orientationchange', apply);
    };
  }, []);
}
