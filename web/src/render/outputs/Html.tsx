// HTML outputs.
//
// Passive markup (tables, styled text, inline SVG — a DataFrame, say) is sanitised and placed
// in a shadow root so it picks up the app's look without being able to restyle the app.
// Anything that needs scripts (Plotly, Altair, Bokeh, maps…) runs in a sandboxed iframe with
// an opaque origin: it cannot reach the page, the native bridge, or the file system.

import DOMPurify from 'dompurify';
import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from 'solid-js';
import richCss from '../../styles/rich.css?inline';

const ACTIVE_TAGS = new Set(['script', 'iframe', 'object', 'embed', 'link', 'form', 'base', 'meta', 'frame', 'frameset', 'applet']);

interface Analysis {
  html: string;
  needsSandbox: boolean;
}

function analyze(html: string): Analysis {
  const clean = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true, svg: true, svgFilters: true, mathMl: true },
    ADD_TAGS: ['style'],
    ADD_ATTR: ['target', 'border', 'cellspacing', 'cellpadding', 'align', 'valign', 'bgcolor', 'controls', 'loop', 'autoplay', 'muted', 'poster'],
    FORCE_BODY: true,
  }) as unknown as string;
  let needsSandbox = false;
  for (const entry of DOMPurify.removed as { element?: Element; attribute?: Attr | null }[]) {
    if (entry.element && ACTIVE_TAGS.has(entry.element.nodeName.toLowerCase())) needsSandbox = true;
    else if (entry.attribute && /^on/i.test(entry.attribute.name)) needsSandbox = true;
    if (needsSandbox) break;
  }
  return { html: clean, needsSandbox };
}

let sheet: CSSStyleSheet | null = null;
function richSheet(): CSSStyleSheet {
  if (!sheet) {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(richCss);
  }
  return sheet;
}

function hydrate(root: HTMLElement) {
  // Tables scroll inside their own box, with the header pinned.
  for (const table of root.querySelectorAll('table')) {
    if (table.parentElement?.classList.contains('table-wrap') || table.closest('table table')) continue;
    const wrap = document.createElement('div');
    wrap.className = 'table-wrap';
    table.replaceWith(wrap);
    wrap.append(table);
  }
  for (const link of root.querySelectorAll('a[href]')) {
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noreferrer');
  }
}

function ShadowHtml(props: { html: string }) {
  let host!: HTMLDivElement;
  onMount(() => {
    const root = host.attachShadow({ mode: 'open' });
    root.adoptedStyleSheets = [richSheet()];
    const body = document.createElement('div');
    body.className = 'rich';
    root.append(body);
    createEffect(() => {
      body.innerHTML = props.html;
      hydrate(body);
    });
  });
  return <div class="out-html" ref={host} />;
}

// ── Sandboxed frames ────────────────────────────────────────────────────────

const THEME_VARIABLES = [
  '--bg', '--bg-raised', '--bg-sunken', '--bg-hover', '--text', '--text-2', '--text-3', '--border',
  '--border-strong', '--accent', '--link', '--font-ui', '--font-mono',
];

function themeSnapshot() {
  const style = getComputedStyle(document.documentElement);
  const vars: Record<string, string> = {};
  for (const name of THEME_VARIABLES) vars[name] = style.getPropertyValue(name).trim();
  return { dark: document.documentElement.dataset.appearance === 'dark', vars };
}

const frames = new Map<Window, (data: any) => void>();
let listening = false;
function listen() {
  if (listening) return;
  listening = true;
  window.addEventListener('message', (event) => {
    const handler = event.source ? frames.get(event.source as Window) : undefined;
    if (handler && event.data && typeof event.data === 'object') handler(event.data);
  });
  // Follow appearance changes.
  new MutationObserver(() => {
    const theme = themeSnapshot();
    for (const target of frames.keys()) target.postMessage({ type: 'reed:theme', theme }, '*');
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-appearance', 'data-theme'] });
}

export function SandboxFrame(props: { html: string; minHeight?: number }) {
  let frame!: HTMLIFrameElement;
  const [height, setHeight] = createSignal(props.minHeight ?? 24);
  const [ready, setReady] = createSignal(false);

  onMount(() => {
    listen();
    const target = frame.contentWindow!;
    frames.set(target, (data) => {
      if (data.type === 'reed:ready') setReady(true);
      else if (data.type === 'reed:size' && typeof data.height === 'number') setHeight(Math.max(props.minHeight ?? 0, Math.ceil(data.height)));
    });
    onCleanup(() => frames.delete(target));
    createEffect(() => {
      if (!ready()) return;
      target.postMessage({ type: 'reed:render', html: props.html, theme: themeSnapshot() }, '*');
    });
  });

  return (
    <iframe
      ref={frame}
      class="out-frame"
      src="./sandbox.html"
      sandbox="allow-scripts allow-popups allow-forms allow-downloads allow-modals"
      style={{ height: `${height()}px` }}
      title="Notebook output"
    />
  );
}

export function HtmlOutput(props: { html: string }) {
  const analysis = createMemo(() => analyze(props.html));
  return (
    <Show when={analysis().needsSandbox} fallback={<ShadowHtml html={analysis().html} />}>
      <SandboxFrame html={props.html} />
    </Show>
  );
}

/** `application/javascript` outputs get the classic `element` variable, inside the sandbox. */
export function JavaScriptOutput(props: { code: string }) {
  const html = () =>
    `<div id="reed-output"></div><script>(function(element){\n${props.code.replace(/<\/script/gi, '<\\/script')}\n})(document.getElementById("reed-output"));</script>`;
  return <SandboxFrame html={html()} />;
}
