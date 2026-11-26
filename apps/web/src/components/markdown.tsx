'use client';

import { createContext, memo, useContext, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { CheckIcon, CopyIcon } from 'lucide-react';
import { api, type Located, type LocateQuery } from '@/lib/api';
import { baseName, isBareName, isWorkspace, linkUrl, looksLikeFile, rawUrl as rawUrlFor, relOf, resolvePath, workspaceUrl } from '@/lib/files';
import { writingBlocks } from '@/lib/writing-blocks';
import { taskPrompt } from '@/lib/task-prompt';
import { ui } from '@/lib/ui';
import { cn } from '@/lib/utils';

/** Chat folder: paths the agent mentions are resolved against it and become clickable. */
export const FileBase = createContext<string | null>(null);

/** What this chat touched: paths with a given file name (see pathsNamed) and all paths, newest first (touchedPaths). */
export const FileHints = createContext<{ named: (name: string) => string[]; touched: () => string[] } | null>(null);

const located = new Map<string, { at: number; r: Promise<Located> }>();

/** /api/locate for the hover title; the viewer asks again on open (the file may have appeared meanwhile). */
function locateCached(path: string, q: LocateQuery): Promise<Located> {
  const key = JSON.stringify([path, q]);
  const hit = located.get(key);
  if (hit && Date.now() - hit.at < 30_000) return hit.r;
  const r = api.locate(path, q);
  located.set(key, { at: Date.now(), r });
  r.catch(() => located.delete(key));
  return r;
}

function titleFor(r: Located): string {
  switch (r.status) {
    case 'ok':
      return `Открыть ${r.path}`;
    case 'choose':
      return `Несколько файлов, откроется выбор:\n${r.matches.slice(0, 5).join('\n')}${r.matches.length > 5 ? '\n…' : ''}`;
    case 'not_found':
      return `Не найден: ${r.path}`;
    case 'not_file':
      return `Не файл: ${r.path}`;
    default:
      return `Нет доступа: ${r.path}`;
  }
}

/**
 * A path the agent wrote: open it in the viewer (which looks it up in the chat's repositories if it is not where the
 * text says), and on hover show the file that will actually open.
 */
function useFileRef(text: string, path: string | null) {
  const cwd = useContext(FileBase);
  const hints = useContext(FileHints);
  const [title, setTitle] = useState<string>();
  const query = (p: string): LocateQuery => ({
    cwd: cwd ?? undefined,
    bare: isBareName(text),
    rel: relOf(text),
    hints: hints?.named(baseName(p)),
    touched: hints?.touched(),
  });
  return {
    title: title ?? (path ? `Открыть ${path}` : undefined),
    open: () => path && ui.openFile({ path, ...query(path) }),
    hover: () => {
      if (path) locateCached(path, query(path)).then((r) => setTitle(titleFor(r)), () => {});
    },
  };
}

export function WorkspaceActions({ path }: { path: string }) {
  return <span className="inline-flex max-w-full flex-wrap items-center gap-1 align-middle text-xs">
    <a href={workspaceUrl(path)} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-10 items-center rounded-md border px-2 hover:bg-muted">Открыть в VS Code</a>
    <button type="button" onClick={() => ui.previewFile(path)} className="min-h-10 rounded-md border px-2 hover:bg-muted">Просмотреть</button>
  </span>;
}

function FilePathCode({ text }: { text: string }) {
  const cwd = useContext(FileBase);
  const path = cwd && looksLikeFile(text) ? resolvePath(text, cwd) : null;
  const ref = useFileRef(text, path);
  if (!path) return <code>{text}</code>;
  if (isWorkspace(path)) return <span><code className="break-anywhere">{text}</code> <WorkspaceActions path={path} /></span>;
  return (
    <code
      role="button"
      tabIndex={0}
      title={ref.title}
      className="file-link"
      onClick={ref.open}
      onMouseEnter={ref.hover}
      onFocus={ref.hover}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), ref.open())}
    >
      {text}
    </code>
  );
}

function LinkOrFile({ href, children }: { href?: string; children?: React.ReactNode }) {
  const cwd = useContext(FileBase);
  let target = href ?? '';
  let path: string | null = null;
  const fileUrl = /^file:\/\//i.test(target);
  if (href && (fileUrl || (cwd && !/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(href)))) {
    try {
      target = decodeURI(href);
    } catch {}
    // file:// is a file whatever its name (Makefile, no extension); a plain link target only if it looks like one
    if (fileUrl || looksLikeFile(target)) path = resolvePath(target, cwd ?? '/');
  }
  const ref = useFileRef(target, path);
  if (path && isWorkspace(path)) return <span>{children} <WorkspaceActions path={path} /></span>;
  if (path)
    return (
      <a
        href={rawUrlFor(path)}
        title={ref.title}
        onClick={(e) => {
          e.preventDefault();
          ref.open();
        }}
        onMouseEnter={ref.hover}
        onFocus={ref.hover}
        className="file-link"
      >
        {children}
      </a>
    );
  // a file:// link that did not resolve: nothing to open, and not a page to open in a new tab either
  if (fileUrl) return <span>{children}</span>;
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
      <ReactMarkdown urlTransform={linkUrl} remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]} components={taskPrompts ? { ...components, pre({ node, children }) {
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
