'use client';

import { createContext, memo, useContext, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { CheckIcon, CopyIcon } from 'lucide-react';
import { isWorkspace, looksLikeFile, rawUrl as rawUrlFor, resolvePath, workspaceUrl } from '@/lib/files';
import { writingBlocks } from '@/lib/writing-blocks';
import { taskPrompt } from '@/lib/task-prompt';
import { ui } from '@/lib/ui';
import { cn } from '@/lib/utils';

/** Chat folder: paths the agent mentions are resolved against it and become clickable. */
export const FileBase = createContext<string | null>(null);

export function WorkspaceActions({ path }: { path: string }) {
  return <span className="inline-flex max-w-full flex-wrap items-center gap-1 align-middle text-xs">
    <a href={workspaceUrl(path)} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-10 items-center rounded-md border px-2 hover:bg-muted">Открыть в VS Code</a>
    <button type="button" onClick={() => ui.previewFile(path)} className="min-h-10 rounded-md border px-2 hover:bg-muted">Просмотреть</button>
  </span>;
}

function FilePathCode({ text }: { text: string }) {
  const cwd = useContext(FileBase);
  const path = cwd && looksLikeFile(text) ? resolvePath(text, cwd) : null;
  if (!path) return <code>{text}</code>;
  if (isWorkspace(path)) return <span><code className="break-anywhere">{text}</code> <WorkspaceActions path={path} /></span>;
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
  if (path && isWorkspace(path)) return <span>{children} <WorkspaceActions path={path} /></span>;
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

export const TaskPrompt = createContext<((text: string) => void) | null>(null);

function PromptBlock({ text }: { text: string }) {
  const open = useContext(TaskPrompt);
  return <div className="my-2 min-w-0 overflow-hidden rounded-lg border bg-muted/40">
    <div className="flex flex-wrap items-center justify-between gap-1 border-b px-3 py-1">
      <span className="text-xs text-muted-foreground">Готовый промпт</span>
      <button type="button" className="min-h-10 rounded-md px-2 text-sm hover:bg-muted" onClick={() => open?.(text)}>Открыть как новую задачу</button>
    </div>
    <pre className="whitespace-pre-wrap break-words p-3 text-sm [overflow-wrap:anywhere]">{text}</pre>
  </div>;
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
    return <div className="md-table scrollbar-thin" role="region" aria-label="Таблица" tabIndex={0}><table>{children}</table></div>;
  },
};

export const Markdown = memo(function Markdown({ text, className, taskPrompts = false }: { text: string; className?: string; taskPrompts?: boolean }) {
  const renderedText = writingBlocks(text);
  return (
    <div className={cn('md min-w-0 text-[15px] md:text-sm', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]} components={taskPrompts ? { ...components, pre({ node, children }) {
        const child = node?.children[0];
        if (child?.type === 'element' && child.properties.className instanceof Array && child.properties.className.includes('language-mcc-task')) {
          const start = node?.position?.start.offset;
          const end = node?.position?.end.offset;
          const raw = start !== undefined && end !== undefined ? renderedText.slice(start, end) : '';
          // Only complete fences are actionable, including while a response streams.
          const prompt = taskPrompt(raw);
          if (prompt !== null) return <PromptBlock text={prompt} />;
        }
        const Pre = components.pre!;
        return <Pre node={node}>{children}</Pre>;
      } } : components}>
        {renderedText}
      </ReactMarkdown>
    </div>
  );
});
