'use client';

import { memo, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { CheckIcon, CopyIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export function CopyButton({ text, className, label }: { text: string; className?: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      aria-label={label ?? 'Скопировать'}
      className={cn(
        'inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground',
        className,
      )}
      onClick={(e) => {
        e.stopPropagation();
        copyText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        });
      }}
    >
      {done ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
      {label ? <span>{label}</span> : null}
    </button>
  );
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

function nodeText(n: unknown): string {
  if (typeof n === 'string') return n;
  if (Array.isArray(n)) return n.map(nodeText).join('');
  if (n && typeof n === 'object' && 'props' in n) return nodeText((n as { props: { children?: unknown } }).props.children);
  return '';
}

const components: Components = {
  pre({ children }) {
    const code = nodeText(children);
    const lang = (() => {
      const c = (children as { props?: { className?: string } })?.props?.className ?? '';
      return c.match(/language-([\w-]+)/)?.[1];
    })();
    return (
      <div className="group/code relative my-2 overflow-hidden rounded-lg border bg-muted/40">
        <div className="flex h-7 items-center justify-between border-b bg-muted/60 pl-3 pr-1 text-[11px] text-muted-foreground">
          <span className="font-mono">{lang ?? 'code'}</span>
          <CopyButton text={code} />
        </div>
        <pre className="scrollbar-thin overflow-x-auto p-3 font-mono text-[12.5px] leading-relaxed">{children}</pre>
      </div>
    );
  },
  a({ href, children }) {
    return (
      <a href={href} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    );
  },
  table({ children }) {
    return <table>{children}</table>;
  },
};

export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn('md text-[15px] md:text-sm', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
