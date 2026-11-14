'use client';

import { useEffect } from 'react';

function editableFocused(): boolean {
  const a = document.activeElement as HTMLElement | null;
  if (!a) return false;
  if (a.isContentEditable || a.tagName === 'TEXTAREA') return true;
  if (a.tagName === 'INPUT') return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes((a as HTMLInputElement).type);
  return false;
}

/**
 * Size the app to what is actually visible, so the composer always sits right above the keyboard.
 *
 * Measured on iOS (home-screen app, status bar "black-translucent"):
 *  - without the keyboard, iOS 26 reports innerHeight / visualViewport / 100dvh short by the status bar
 *    (812 of 874 pt on iPhone 17 Pro) while the page really covers the screen → use 100lvh then;
 *  - with the keyboard, the visual viewport is the visible area; depending on the iOS version the layout
 *    viewport (innerHeight) shrinks too or not, so we do not rely on it — "keyboard open" = an input has focus
 *    and the visual viewport is much shorter than the screen;
 *  - iOS may also pan the visual viewport (offsetTop > 0) to reveal the focused field → we move the app with it.
 * Writes --app-h / --app-top on <html> and data-keyboard="open|closed".
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
    const timers: number[] = [];

    const apply = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const full = Math.round(probe.getBoundingClientRect().height) || window.innerHeight;
        const vh = Math.round(vv ? vv.height : window.innerHeight);
        const kb = editableFocused() && full - vh > 150;
        let h: number;
        let top = 0;
        if (kb) {
          h = vh;
          top = vv ? Math.max(0, Math.round(vv.offsetTop)) : 0;
        } else {
          h = standalone ? Math.max(vh, full) : vh;
        }
        root.style.setProperty('--app-h', `${h}px`);
        root.style.setProperty('--app-top', `${top}px`);
        root.dataset.keyboard = kb ? 'open' : 'closed';
        if (window.scrollY !== 0) window.scrollTo(0, 0);
      });
    };
    // the keyboard animates in after focus; vv resize events can come late or not at all on some keyboards
    const settle = () => {
      apply();
      for (const t of timers.splice(0)) clearTimeout(t);
      for (const d of [80, 250, 500, 900]) timers.push(window.setTimeout(apply, d));
    };

    apply();
    vv?.addEventListener('resize', apply);
    vv?.addEventListener('scroll', apply);
    window.addEventListener('resize', apply);
    window.addEventListener('orientationchange', settle);
    document.addEventListener('focusin', settle);
    document.addEventListener('focusout', settle);
    return () => {
      cancelAnimationFrame(raf);
      for (const t of timers) clearTimeout(t);
      probe.remove();
      vv?.removeEventListener('resize', apply);
      vv?.removeEventListener('scroll', apply);
      window.removeEventListener('resize', apply);
      window.removeEventListener('orientationchange', settle);
      document.removeEventListener('focusin', settle);
      document.removeEventListener('focusout', settle);
    };
  }, []);
}
