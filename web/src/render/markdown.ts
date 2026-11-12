// Markdown → safe HTML, the way notebooks expect it: GitHub-flavoured markdown, raw HTML,
// and TeX math (inline `$…$`, display `$$…$$`, and bare `\begin{…}` environments).

import katexPlugin from '@vscode/markdown-it-katex';
import DOMPurify from 'dompurify';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import MarkdownIt from 'markdown-it';
import { localFileUrl } from '../host';
import { joinPath } from '../util/misc';
import { highlightElement } from './highlight';
import type { MimeBundle } from '../notebook/nbformat';

const md = new MarkdownIt({ html: true, linkify: true, breaks: false, typographer: false });

const mathPlugin = ((katexPlugin as any).default ?? katexPlugin) as (md: unknown, options: unknown) => void;
md.use(mathPlugin as any, {
  katex,
  output: 'html',
  throwOnError: false,
  strict: false,
  enableBareBlocks: true,
  enableMathBlockInHtml: true,
  enableMathInlineInHtml: true,
});

export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-');
}

// Remember where each block came from, so a click on rendered text can put the caret at the
// matching place in the source.
md.core.ruler.push('source_lines', (state) => {
  for (const token of state.tokens) {
    if (!token.map) continue;
    if (token.type.endsWith('_open') || token.type === 'fence' || token.type === 'code_block' || token.type === 'hr' || token.type === 'html_block') {
      token.attrSet('data-sl', String(token.map[0]));
    }
  }
  return false;
});

md.core.ruler.push('heading_ids', (state) => {
  const used = new Map<string, number>();
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i].type !== 'heading_open' || tokens[i + 1].type !== 'inline') continue;
    const base = slugify(tokens[i + 1].content) || 'section';
    const count = used.get(base) ?? 0;
    used.set(base, count + 1);
    tokens[i].attrSet('id', count ? `${base}-${count}` : base);
  }
  return false;
});

// GitHub-style task lists: "- [ ] todo" / "- [x] done".
md.core.ruler.after('inline', 'task_lists', (state) => {
  const tokens = state.tokens;
  for (let i = 2; i < tokens.length; i++) {
    if (tokens[i].type !== 'inline' || tokens[i - 1].type !== 'paragraph_open' || tokens[i - 2].type !== 'list_item_open') continue;
    const first = tokens[i].children?.[0];
    if (!first || first.type !== 'text') continue;
    const match = /^\[([ xX])\]\s+/.exec(first.content);
    if (!match) continue;
    first.content = first.content.slice(match[0].length);
    const box = new state.Token('html_inline', '', 0);
    box.content = `<input type="checkbox" class="task-box"${match[1] !== ' ' ? ' checked' : ''}> `;
    tokens[i].children!.unshift(box);
    tokens[i - 2].attrJoin('class', 'task-item');
  }
  return false;
});

// Tables scroll on their own instead of stretching the page.
md.renderer.rules.table_open = (tokens, index, options, _env, self) =>
  `<div class="table-scroll">${self.renderToken(tokens, index, options)}`;
md.renderer.rules.table_close = (tokens, index, options, _env, self) =>
  `${self.renderToken(tokens, index, options)}</div>`;

const PURIFY: Parameters<typeof DOMPurify.sanitize>[1] = {
  USE_PROFILES: { html: true, svg: true, svgFilters: true },
  ADD_ATTR: ['target', 'align', 'valign', 'data-sl'],
  FORBID_TAGS: ['style', 'form', 'textarea', 'select', 'button', 'iframe', 'object', 'embed', 'meta', 'link', 'base'],
  FORBID_ATTR: ['formaction', 'ping'],
};

const cache = new Map<string, string>();

/** Renders markdown source to sanitised HTML. Results are cached by source. */
export function renderMarkdown(source: string): string {
  let html = cache.get(source);
  if (html === undefined) {
    let raw: string;
    try {
      raw = md.render(source);
    } catch (error) {
      raw = `<pre>${md.utils.escapeHtml(String(error))}</pre>`;
    }
    html = DOMPurify.sanitize(raw, PURIFY) as unknown as string;
    if (cache.size > 400) cache.clear();
    cache.set(source, html);
  }
  return html;
}

export function renderInlineMarkdown(source: string): string {
  return DOMPurify.sanitize(md.renderInline(source), PURIFY) as unknown as string;
}

export function renderTex(tex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(tex, { displayMode, throwOnError: false, strict: false, output: 'html' });
  } catch {
    return md.utils.escapeHtml(tex);
  }
}

export interface MarkdownContext {
  /** Directory relative image paths resolve against. */
  directory: string | null;
  attachments?: Record<string, MimeBundle>;
}

/** Fixes up freshly inserted rendered markdown: local images, external links, code colours. */
export function hydrateMarkdown(root: HTMLElement, context: MarkdownContext) {
  for (const image of root.querySelectorAll('img')) {
    const source = image.getAttribute('src') ?? '';
    image.loading = 'lazy';
    if (source.startsWith('attachment:')) {
      const bundle = context.attachments?.[decodeURIComponent(source.slice('attachment:'.length))];
      const mime = bundle && Object.keys(bundle)[0];
      if (bundle && mime) image.src = `data:${mime};base64,${String(bundle[mime]).replace(/\s/g, '')}`;
    } else if (source.startsWith('file://')) {
      image.src = localFileUrl(decodeURIComponent(source.slice('file://'.length)));
    } else if (source && !/^[a-z][a-z0-9+.-]*:/i.test(source) && !source.startsWith('//')) {
      let path = source;
      try {
        path = decodeURIComponent(source);
      } catch {
        /* keep the raw path */
      }
      if (path.startsWith('~')) continue;
      const absolute = path.startsWith('/') ? path : context.directory ? joinPath(context.directory, path) : null;
      if (absolute) image.src = localFileUrl(absolute);
    }
  }
  // A paragraph that is nothing but pictures is a figure, and is centred as one.
  for (const paragraph of root.querySelectorAll('p')) {
    if (paragraph.querySelector('img') && !paragraph.textContent?.trim()) paragraph.classList.add('figure');
  }
  for (const link of root.querySelectorAll('a[href]')) {
    const href = link.getAttribute('href') ?? '';
    if (!href.startsWith('#')) {
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noreferrer');
    }
  }
  for (const block of root.querySelectorAll<HTMLElement>('pre > code[class*="language-"]')) {
    const language = /language-([\w+#.-]+)/.exec(block.className)?.[1];
    if (language) void highlightElement(block, block.textContent ?? '', language);
  }
}

export interface Heading {
  level: number;
  text: string;
  slug: string;
  /** Zero-based source line of the heading. */
  line: number;
}

/** Extracts headings without rendering (for the outline). */
export function extractHeadings(source: string): Heading[] {
  const headings: Heading[] = [];
  const lines = source.split('\n');
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = /^\s{0,3}(```+|~~~+)/.exec(line);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1][0];
      else if (fenceMatch[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const atx = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (atx) {
      const text = plainText(atx[2]);
      if (text) headings.push({ level: atx[1].length, text, slug: slugify(text), line: i });
      continue;
    }
    const next = lines[i + 1];
    if (next && line.trim() && /^\s{0,3}(=+|-+)\s*$/.test(next) && !/^\s*([-*+>]|\d+[.)])\s/.test(line)) {
      const text = plainText(line.trim());
      if (text && /^\s{0,3}=+\s*$/.test(next)) headings.push({ level: 1, text, slug: slugify(text), line: i });
      else if (text && /^\s{0,3}-{2,}\s*$/.test(next)) headings.push({ level: 2, text, slug: slugify(text), line: i });
    }
  }
  return headings;
}

function plainText(markdown: string): string {
  return markdown
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|\*|_|`|~~)/g, '')
    .replace(/<[^>]+>/g, '')
    .trim();
}
