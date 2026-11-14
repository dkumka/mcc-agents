'use client';

import { createContext, memo, useContext, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { CheckIcon, CopyIcon } from 'lucide-react';
import { looksLikeFile, rawUrl as rawUrlFor, resolvePath } from '@/lib/files';
import { ui } from '@/lib/ui';
import { cn } from '@/lib/utils';

/** Chat folder: paths the agent mentions are resolved against it and become clickable. */
export const FileBase = createContext<string | null>(null);

function FilePathCode({ text }: { text: string }) {
  const cwd = useContext(FileBase);
  const path = cwd && looksLikeFile(text) ? resolvePath(text, cwd) : null;
  if (!path) return <code>{text}</code>;
  return (
    <code
      role="button"
      tabIndex={0}
      title={`Открыть ${path}`}
      className="file-link"
      onClick={() => ui.openFile({ path })}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), ui.openFile({ path }))}
    >
      {text}
    </code>
  );
}

function LinkOrFile({ href, children }: { href?: string; children?: React.ReactNode }) {
  const cwd = useContext(FileBase);
  let path: string | null = null;
  if (href && cwd && (href.startsWith('file://') || !/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(href))) {
    let target = href;
    try {
      target = decodeURI(href);
    } catch {}
    if (looksLikeFile(target)) path = resolvePath(target, cwd);
  }
  if (path)
    return (
      <a
        href={rawUrlFor(path)}
        onClick={(e) => {
          e.preventDefault();
          ui.openFile({ path });
        }}
        className="file-link"
      >
        {children}
      </a>
    );
  return (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  );
}

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
    return <LinkOrFile href={href}>{children}</LinkOrFile>;
  },
  code({ className, children }) {
    const text = typeof children === 'string' ? children : null;
    // inline code only (fenced blocks have a language class or a trailing newline)
    if (!className && text && !text.includes('\n')) return <FilePathCode text={text} />;
    return <code className={className}>{children}</code>;
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
