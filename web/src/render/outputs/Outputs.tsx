// The output area of a code cell: one component per kind of output, with rich outputs
// dispatched by MIME type through a small registry.

import { createEffect, createMemo, createSignal, For, type JSX, Match, onMount, Show, Switch } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { unwrap } from 'solid-js/store';
import type { ErrorOutput, MimeBundle, Output, RichOutput, StreamOutput } from '../../notebook/nbformat';
import type { Cell, InputRequest } from '../../notebook/store';
import { documentDirectory } from '../../notebook/document';
import { CopyButton } from '../../ui/CopyButton';
import { AnsiStream, renderAnsi, stripAnsi } from '../ansi';
import { hydrateMarkdown, renderMarkdown, renderTex } from '../markdown';
import { copyPiece, noteWrittenForm, pieceOf, type OutputPiece } from './actions';
import { HtmlOutput, JavaScriptOutput, SandboxFrame } from './Html';

// ── Text ────────────────────────────────────────────────────────────────────

/** A box that scrolls once its content gets tall, and follows the bottom while output streams in. */
function ScrollBox(props: { children: JSX.Element; follow?: boolean; ref?: (el: HTMLDivElement) => void }) {
  return (
    <div class="out-scroll" ref={props.ref}>
      {props.children}
    </div>
  );
}

function StreamView(props: { output: StreamOutput }) {
  let box!: HTMLDivElement;
  let pre!: HTMLPreElement;
  const [truncated, setTruncated] = createSignal(false);

  onMount(() => {
    const stream = new AnsiStream(pre, { onTruncate: () => setTruncated(true) });
    let written = 0;
    let lastChar = -1;
    createEffect(() => {
      const text = props.output.text;
      const pinned = box.scrollHeight - box.scrollTop - box.clientHeight < 12;
      // Output only ever grows, so normally just the new tail needs rendering.
      if (text.length >= written && (written === 0 || text.charCodeAt(written - 1) === lastChar)) {
        stream.write(text.slice(written));
      } else {
        stream.reset();
        setTruncated(false);
        stream.write(text);
      }
      written = text.length;
      lastChar = written ? text.charCodeAt(written - 1) : -1;
      if (pinned) box.scrollTop = box.scrollHeight;
    });
  });

  return (
    <div classList={{ 'out-stderr': props.output.name === 'stderr' }}>
      <Show when={truncated()}>
        <div class="out-truncated">Earlier output is hidden here to keep things fast. All of it is kept in the notebook.</div>
      </Show>
      <ScrollBox ref={(el) => (box = el)}>
        <pre class="out-text" ref={pre} />
      </ScrollBox>
    </div>
  );
}

function AnsiText(props: { text: string; class?: string }) {
  let pre!: HTMLPreElement;
  onMount(() => {
    createEffect(() => pre.replaceChildren(renderAnsi(props.text)));
  });
  return <pre class={`out-text ${props.class ?? ''}`} ref={pre} />;
}

function ErrorView(props: { output: ErrorOutput }) {
  let box!: HTMLDivElement;
  const text = createMemo(() => {
    const lines = props.output.traceback.join('\n').split('\n');
    // IPython opens tracebacks with a full-width rule; it adds nothing here.
    if (lines.length > 1 && /^-{10,}$/.test(stripAnsi(lines[0]).trim())) lines.shift();
    return lines.join('\n').replace(/\n+$/, '');
  });
  onMount(() => {
    // The last frame and the message are at the bottom — start there.
    createEffect(() => {
      text();
      queueMicrotask(() => (box.scrollTop = box.scrollHeight));
    });
  });
  return (
    <div class="out-error">
      <Show
        when={text()}
        fallback={
          <div class="out-error-title">
            {props.output.ename}
            {props.output.evalue ? `: ${props.output.evalue}` : ''}
          </div>
        }
      >
        <ScrollBox ref={(el) => (box = el)}>
          <AnsiText text={text()} />
        </ScrollBox>
      </Show>
    </div>
  );
}

// ── Rich outputs ────────────────────────────────────────────────────────────

interface RendererProps {
  mime: string;
  data: unknown;
  metadata: Record<string, any>;
  bundle: MimeBundle;
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.join('');
  return value == null ? '' : JSON.stringify(value);
}

function PlainText(props: RendererProps) {
  return (
    <ScrollBox>
      <AnsiText text={asText(props.data)} />
    </ScrollBox>
  );
}

function Html(props: RendererProps) {
  return <HtmlOutput html={asText(props.data)} />;
}

function Markdown(props: RendererProps) {
  let host!: HTMLDivElement;
  onMount(() => {
    createEffect(() => {
      host.innerHTML = renderMarkdown(asText(props.data));
      hydrateMarkdown(host, { directory: documentDirectory() });
    });
  });
  return <div class="prose" ref={host} />;
}

function Latex(props: RendererProps) {
  const html = createMemo(() => {
    let tex = asText(props.data).trim();
    // SymPy and friends wrap their output in $…$ or $$…$$.
    const display = /^\$\$[\s\S]*\$\$$/.test(tex) || /\\displaystyle|\\begin\{/.test(tex);
    tex = tex.replace(/^\$\$?/, '').replace(/\$\$?$/, '');
    return renderTex(tex, display);
  });
  return <div class="out-latex" innerHTML={html()} />;
}

function Image(props: RendererProps) {
  const size = () => props.metadata?.[props.mime] ?? {};
  const source = () => `data:${props.mime};base64,${asText(props.data).replace(/\s+/g, '')}`;
  return (
    <img
      class="out-image"
      classList={{ 'dark-ok': props.metadata?.needs_background === 'dark' }}
      src={source()}
      width={size().width}
      height={size().height}
      alt=""
      draggable={true}
      tabindex={0}
    />
  );
}

function Svg(props: RendererProps) {
  // Shown through <img>, an SVG cannot run scripts or load anything.
  const source = () => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(asText(props.data))}`;
  return <img class="out-image" src={source()} alt="" tabindex={0} />;
}

function JsonNode(props: { name?: string; value: unknown; depth: number }) {
  const isObject = () => props.value !== null && typeof props.value === 'object';
  const entries = () =>
    Array.isArray(props.value)
      ? (props.value as unknown[]).map((value, i) => [String(i), value] as const)
      : Object.entries(props.value as Record<string, unknown>);
  const [open, setOpen] = createSignal(false);
  const [limit, setLimit] = createSignal(100);
  const summary = () => (Array.isArray(props.value) ? `[ ${(props.value as unknown[]).length} items ]` : `{ ${entries().length} keys }`);
  const label = () => (
    <Show when={props.name !== undefined}>
      <span class="json-key">{props.name}</span>
      <span class="json-meta">: </span>
    </Show>
  );
  return (
    <div class="json-node">
      <Show
        when={isObject()}
        fallback={
          <>
            {label()}
            <span
              class={typeof props.value === 'string' ? 'json-string' : typeof props.value === 'number' ? 'json-number' : 'json-atom'}
            >
              {JSON.stringify(props.value)}
            </span>
          </>
        }
      >
        <span class="json-toggle" onClick={() => setOpen(!open())}>
          {open() ? '▼' : '▶'}
        </span>
        <span onClick={() => setOpen(!open())}>
          {label()}
          <Show when={!open()}>
            <span class="json-meta">{summary()}</span>
          </Show>
        </span>
        <Show when={open()}>
          <For each={entries().slice(0, limit())}>
            {([key, value]) => <JsonNode name={key} value={value} depth={props.depth + 1} />}
          </For>
          <Show when={entries().length > limit()}>
            <div class="json-node json-meta" onClick={() => setLimit(limit() + 500)}>
              … {entries().length - limit()} more
            </div>
          </Show>
        </Show>
      </Show>
    </div>
  );
}

function Json(props: RendererProps) {
  const value = createMemo(() => {
    const raw = unwrap(props.data as object);
    if (typeof raw !== 'string') return raw;
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  });
  const rootEntries = () => {
    const root = value();
    if (root === null || typeof root !== 'object') return null;
    return Array.isArray(root) ? root.map((item, i) => [String(i), item] as const) : Object.entries(root as Record<string, unknown>);
  };
  return (
    <div class="out-json">
      <Show when={rootEntries()} fallback={<JsonNode value={value()} depth={1} />}>
        {(entries) => <For each={entries()}>{([key, item]) => <JsonNode name={key} value={item} depth={1} />}</For>}
      </Show>
    </div>
  );
}

function JavaScript(props: RendererProps) {
  return <JavaScriptOutput code={asText(props.data)} />;
}

function Plotly(props: RendererProps) {
  // Plotly's own bundle, in the sandbox. Needs the network the first time it is used.
  const html = createMemo(() => {
    const figure = JSON.stringify(unwrap(props.data as object)).replace(/</g, '\\u003c');
    return (
      `<div id="plot"></div><script src="https://cdn.plot.ly/plotly-3.0.1.min.js" charset="utf-8"></script>` +
      `<script>(function(){var f=${figure};var dark=document.documentElement.dataset.appearance==='dark';` +
      `var layout=Object.assign({},f.layout||{});` +
      `if(typeof Plotly==='undefined'){document.getElementById('plot').textContent='Plotly could not be loaded (offline?).';return;}` +
      `Plotly.newPlot('plot',f.data||[],layout,Object.assign({responsive:true,displaylogo:false},f.config||{}));})();</script>`
    );
  });
  return <SandboxFrame html={html()} minHeight={120} />;
}

type Renderer = (props: RendererProps) => JSX.Element;

interface RendererEntry {
  mime: string;
  renderer: Renderer;
  /** Lets a renderer decline data it cannot show, so the next representation is used. */
  accepts?: (data: unknown) => boolean;
}

/** Renderers in order of preference: the richest representation a bundle offers wins. */
const RENDERERS: RendererEntry[] = [
  { mime: 'text/html', renderer: Html },
  { mime: 'application/vnd.plotly.v1+json', renderer: Plotly },
  { mime: 'text/markdown', renderer: Markdown },
  { mime: 'image/svg+xml', renderer: Svg },
  { mime: 'image/png', renderer: Image },
  { mime: 'image/jpeg', renderer: Image },
  { mime: 'image/gif', renderer: Image },
  { mime: 'image/webp', renderer: Image },
  { mime: 'text/latex', renderer: Latex },
  { mime: 'application/json', renderer: Json },
  { mime: 'application/javascript', renderer: JavaScript },
  { mime: 'text/plain', renderer: PlainText },
];

/** Adds a renderer for a MIME type — the extension point for new kinds of output. */
export function registerRenderer(
  mime: string,
  renderer: Renderer,
  options: { first?: boolean; accepts?: (data: unknown) => boolean } = {},
) {
  const existing = RENDERERS.findIndex((entry) => entry.mime === mime);
  if (existing >= 0) RENDERERS.splice(existing, 1);
  const entry: RendererEntry = { mime, renderer, accepts: options.accepts };
  if (options.first) RENDERERS.unshift(entry);
  else RENDERERS.splice(RENDERERS.length - 1, 0, entry);
}

/** The representation a bundle is shown with: the richest one there is a renderer for. */
function chosenRenderer(data: MimeBundle | undefined): RendererEntry | null {
  for (const entry of RENDERERS) {
    const value = data?.[entry.mime];
    if (value === undefined || value === null) continue;
    if (entry.accepts && !entry.accepts(value)) continue;
    return entry;
  }
  return null;
}

/**
 * What an output says, when it is written in a notation and shown as its rendering: a formula's
 * TeX, markdown as it was typed, data as JSON. That is what is worth having on the clipboard;
 * for everything else the text is what is on the page.
 */
function writtenForm(output: Output): string | null {
  if (output.output_type !== 'display_data' && output.output_type !== 'execute_result') return null;
  const data = (output as RichOutput).data;
  const mime = chosenRenderer(data)?.mime;
  if (mime === 'text/latex' || mime === 'text/markdown') return asText(data[mime]).trim() || null;
  if (mime === 'application/json') {
    const value = unwrap(data[mime] as object);
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  }
  return null;
}

function RichView(props: { output: RichOutput }) {
  const choice = createMemo(() => chosenRenderer(props.output.data));
  return (
    <Show
      when={choice()}
      fallback={<pre class="out-text json-meta">{Object.keys(props.output.data ?? {}).join(', ') || 'Empty output'}</pre>}
    >
      {(selected) => (
        <Dynamic
          component={selected().renderer}
          mime={selected().mime}
          data={props.output.data[selected().mime]}
          metadata={props.output.metadata ?? {}}
          bundle={props.output.data}
        />
      )}
    </Show>
  );
}

// ── Input requests ──────────────────────────────────────────────────────────

function StdinPrompt(props: { request: InputRequest }) {
  let input!: HTMLInputElement;
  onMount(() => input.focus({ preventScroll: true }));
  return (
    <form
      class="stdin"
      onSubmit={(event) => {
        event.preventDefault();
        props.request.submit(input.value);
      }}
    >
      <span>{props.request.prompt}</span>
      <input
        ref={input}
        type={props.request.password ? 'password' : 'text'}
        autocomplete="off"
        spellcheck={false}
        onKeyDown={(event) => event.stopPropagation()}
      />
    </form>
  );
}

// ── The area ────────────────────────────────────────────────────────────────

const COPY_LABEL = { image: 'Copy this figure', table: 'Copy this table', text: 'Copy this output' } as const;

/**
 * One output. One that stands in a cell's output area (rather than inside a widget) has a copy
 * button waiting beside it for the pointer.
 */
export function OutputView(props: { output: Output; copyable?: boolean }) {
  let element!: HTMLDivElement;
  // What there is to copy is only known from what is on the page, and changes while output
  // streams in, so it is looked up as the pointer arrives. Until then a button is assumed.
  const [kind, setKind] = createSignal<OutputPiece['kind'] | null>('text');
  const copy = () => {
    const piece = pieceOf(element);
    if (!piece) throw new Error('Nothing to copy');
    return copyPiece(piece);
  };
  onMount(() => noteWrittenForm(element, () => writtenForm(props.output)));
  return (
    <div class="output" ref={element} onMouseEnter={() => props.copyable && setKind(pieceOf(element)?.kind ?? null)}>
      <Switch>
        <Match when={props.output.output_type === 'stream'}>
          <StreamView output={props.output as StreamOutput} />
        </Match>
        <Match when={props.output.output_type === 'error'}>
          <ErrorView output={props.output as ErrorOutput} />
        </Match>
        <Match when={props.output.output_type === 'display_data' || props.output.output_type === 'execute_result'}>
          <RichView output={props.output as RichOutput} />
        </Match>
      </Switch>
      <Show when={props.copyable && kind()}>{(found) => <CopyButton label={COPY_LABEL[found()]} copy={copy} />}</Show>
    </div>
  );
}

export function OutputArea(props: { cell: Cell; only?: boolean }) {
  const state = props.cell.state;
  return (
    <div class="cell-outputs" classList={{ outdated: state.pendingClear && state.run === 'running', only: props.only }}>
      <For each={state.outputs}>{(output) => <OutputView output={output} copyable />}</For>
      <Show when={state.inputRequest}>{(request) => <StdinPrompt request={request()} />}</Show>
    </div>
  );
}
