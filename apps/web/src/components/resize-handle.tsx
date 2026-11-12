'use client';

import { useRef } from 'react';
import { cn } from '@/lib/utils';

function setCookie(name: string, value: string | null) {
  const secure = window.location.protocol === 'https:' ? '; secure' : '';
  document.cookie = value === null ? `${name}=; path=/; max-age=0` : `${name}=${value}; path=/; max-age=31536000; samesite=lax${secure}`;
}

/**
 * Drag handle that resizes a panel through a CSS variable on <html> (read by the layout) and
 * remembers the width in a cookie, so the server renders the same width next time.
 * Double click — back to the default width.
 */
export function ResizeHandle({
  side,
  cssVar,
  cookie,
  min,
  max,
  className,
}: {
  /** Which edge of the panel the handle sits on: the left sidebar is resized by its right edge. */
  side: 'left' | 'right';
  cssVar: string;
  cookie: string;
  min: number;
  max: () => number;
  className?: string;
}) {
  const dragging = useRef(false);

  const widthAt = (clientX: number) => {
    const w = side === 'right' ? clientX : window.innerWidth - clientX;
    return Math.round(Math.min(max(), Math.max(min, w)));
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Изменить ширину"
      title="Потяните, чтобы изменить ширину. Двойной клик — по умолчанию"
      className={cn(
        'group/resize absolute inset-y-0 z-20 hidden w-2 cursor-col-resize touch-none select-none md:block',
        side === 'right' ? '-right-1' : '-left-1',
        className,
      )}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        dragging.current = true;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        document.documentElement.dataset.resizing = '1';
      }}
      onPointerMove={(e) => {
        if (!dragging.current) return;
        document.documentElement.style.setProperty(cssVar, `${widthAt(e.clientX)}px`);
      }}
      onPointerUp={(e) => {
        if (!dragging.current) return;
        dragging.current = false;
        delete document.documentElement.dataset.resizing;
        setCookie(cookie, String(widthAt(e.clientX)));
      }}
      onDoubleClick={() => {
        document.documentElement.style.removeProperty(cssVar);
        setCookie(cookie, null);
      }}
    >
      <div className="mx-auto h-full w-px bg-transparent transition-colors group-hover/resize:bg-ring group-active/resize:bg-ring" />
    </div>
  );
}
