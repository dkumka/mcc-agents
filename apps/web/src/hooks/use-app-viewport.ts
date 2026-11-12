'use client';

import { useEffect } from 'react';

/**
 * iOS Safari keeps the layout viewport full-height when the keyboard opens and scrolls the page
 * instead. We size the app to the *visual* viewport (CSS var --app-h) and pin the window scroll,
 * so the composer always sits right above the keyboard and nothing jumps.
 */
export function useAppViewport() {
  useEffect(() => {
    const vv = window.visualViewport;
    const root = document.documentElement;
    let raf = 0;
    const apply = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const h = vv ? vv.height : window.innerHeight;
        root.style.setProperty('--app-h', `${Math.round(h)}px`);
        const kb = vv ? window.innerHeight - vv.height > 120 : false;
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
      vv?.removeEventListener('resize', apply);
      vv?.removeEventListener('scroll', apply);
      window.removeEventListener('resize', apply);
      window.removeEventListener('orientationchange', apply);
    };
  }, []);
}
