// One cell: gutter (run state), body (editor / rendered markdown / outputs).

import { createEffect, createMemo, createSignal, on, onCleanup, onMount, Show } from 'solid-js';
import { CellEditor } from '../editor/CellEditor';
import { surfaces } from '../notebook/commands';
import { documentDirectory } from '../notebook/document';
import { runCells, setNotice, stopCell } from '../notebook/execution';
import {
  enterCommandMode,
  focusEditor,
  glideCells,
  hasMultiSelection,
  isOutputHidden,
  isSelected,
  isSourceHidden,
  notebook,
  scrollToCell,
  select,
  setSource,
  toggleOutputHidden,
  toggleSourceHidden,
  type Cell,
} from '../notebook/store';
import { hydrateMarkdown, renderMarkdown } from '../render/markdown';
import { copyPiece, pieceAt, saveImage, type OutputPiece } from '../render/outputs/actions';
import { OutputArea } from '../render/outputs/Outputs';
import { formatDuration } from '../util/misc';
import { glideIntoView } from '../util/motion';
import { cancelMount, scheduleMount, watchPlaceholder } from './hydration';
import { ChevronRight, Play, Square } from './icons';
import { cmd, Menu, separator, type Anchor, type MenuEntry } from './Popover';

// A clock that only ticks while something is running, for live elapsed times.
const [now, setNow] = createSignal(Date.now());
let ticking = 0;
let timer: ReturnType<typeof setInterval> | undefined;
function useClock() {
  if (ticking++ === 0) {
    setNow(Date.now());
    timer = setInterval(() => setNow(Date.now()), 250);
  }
  onCleanup(() => {
    if (--ticking === 0) clearInterval(timer);
  });
}

function Elapsed(props: { since: number }) {
  useClock();
  const seconds = () => Math.floor((now() - props.since) / 1000);
  const label = () => {
    const s = seconds();
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
  };
  return (
    <Show when={seconds() >= 1}>
      <span class="cell-time">{label()}</span>
    </Show>
  );
}

function RunButton(props: { cell: Cell }) {
  const state = props.cell.state;
  const idle = () => state.run === 'idle';
  // One signal for "this output no longer matches": the code was edited since it ran, or
  // something it depends on has changed.
  const edited = () => state.ranSource !== null && state.ranSource !== state.source;
  const outdated = () => idle() && (state.stale || edited());
  const title = () => {
    if (state.run === 'running') return 'Interrupt';
    if (state.run === 'queued') return 'Remove from queue';
    if (state.stale) return `Out of date — “${state.staleReason}” changed. Run again (⇧↩)`;
    if (edited()) return 'Edited since it last ran. Run (⇧↩)';
    return 'Run (⇧↩)';
  };
  return (
    <button
      class="run-button"
      classList={{
        queued: state.run === 'queued',
        running: state.run === 'running',
        error: idle() && state.lastStatus === 'error',
        outdated: outdated(),
      }}
      title={title()}
      tabindex={-1}
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => {
        event.stopPropagation();
        if (idle()) {
          select(props.cell.id, { scroll: false });
          runCells([props.cell]);
        } else {
          stopCell(props.cell);
        }
      }}
    >
      <span class="count">{state.execution_count ?? ''}</span>
      <span class="ring" />
      <Play class="glyph-idle" />
      <Square class="glyph-stop" />
    </button>
  );
}

function CodeBody(props: { cell: Cell }) {
  const cell = props.cell;
  const state = cell.state;
  const sourceHidden = () => isSourceHidden(cell);
  const outputHidden = () => isOutputHidden(cell);
  const hasOutput = () => state.outputs.length > 0 || state.inputRequest !== null;
  const firstLine = () => state.source.split('\n').find((line) => line.trim()) ?? '';

  // Running a cell again must not make the page lurch. While it runs the cell keeps at least
  // the height it had — the old results go, the new ones arrive, and nothing below moves up
  // only to be pushed down again. When the run is over the cell settles at its real height,
  // and if that is shorter, what follows glides up once.
  let card!: HTMLDivElement;
  createEffect(
    on(
      () => state.run !== 'idle',
      (running) => {
        if (running) {
          if (state.outputs.length) card.style.minHeight = `${card.offsetHeight}px`;
        } else if (card.style.minHeight) {
          glideCells(() => (card.style.minHeight = ''));
        }
      },
      { defer: true },
    ),
  );

  return (
    <div class="cell-card" ref={card}>
      <Show
        when={!sourceHidden()}
        fallback={
          <button class="cell-folded" title="Show code" onClick={() => toggleSourceHidden(cell)}>
            <ChevronRight />
            <span class="preview">{firstLine() || 'Code hidden'}</span>
          </button>
        }
      >
        <CellEditor cell={cell} />
      </Show>
      <Show when={hasOutput()}>
        <Show
          when={!outputHidden()}
          fallback={
            <div class="cell-outputs" classList={{ only: sourceHidden() }}>
              <button class="output-fold" title="Show output" onClick={() => toggleOutputHidden(cell)}>
                <ChevronRight />
                Output hidden
              </button>
            </div>
          }
        >
          <OutputArea cell={cell} only={sourceHidden()} />
        </Show>
      </Show>
    </div>
  );
}

/**
 * Finds the place in the markdown source that corresponds to a click on its rendered form:
 * the clicked block knows its source line, and the text around the caret is looked up there.
 */
function sourceOffsetAt(event: MouseEvent, source: string): number | 'end' {
  const target = event.target as HTMLElement;
  const block = target.closest<HTMLElement>('[data-sl]');
  if (!block) return 'end';
  const startLine = Number(block.dataset.sl) || 0;
  let lineStart = 0;
  for (let i = 0; i < startLine; i++) {
    const next = source.indexOf('\n', lineStart);
    if (next < 0) break;
    lineStart = next + 1;
  }
  const blockLength = (block.textContent?.length ?? 0) * 2 + 240;
  const range = document.caretRangeFromPoint?.(event.clientX, event.clientY);
  if (range && range.startContainer.nodeType === Node.TEXT_NODE) {
    const text = range.startContainer.textContent ?? '';
    const offset = range.startOffset;
    const before = text.slice(Math.max(0, offset - 14), offset);
    const after = text.slice(offset, offset + 14);
    const attempts: [string, number][] = [
      [before + after, before.length],
      [after, 0],
      [before, before.length],
    ];
    for (const [needle, shift] of attempts) {
      if (needle.trim().length < 2) continue;
      const found = source.indexOf(needle, lineStart);
      if (found >= 0 && found < lineStart + blockLength) return found + shift;
    }
  }
  const lineEnd = source.indexOf('\n', lineStart);
  return lineEnd < 0 ? source.length : lineEnd;
}

function toggleTask(cell: Cell, box: HTMLInputElement) {
  const item = box.closest<HTMLElement>('[data-sl]');
  if (!item) return;
  const lines = cell.state.source.split('\n');
  const index = Number(item.dataset.sl) || 0;
  if (lines[index] === undefined) return;
  lines[index] = lines[index].replace(/\[([ xX])\]/, (_match, mark: string) => (mark === ' ' ? '[x]' : '[ ]'));
  setSource(cell, lines.join('\n'));
}

function MarkdownBody(props: { cell: Cell }) {
  const cell = props.cell;
  const state = cell.state;

  const Rendered = () => {
    let host!: HTMLDivElement;
    onMount(() => {
      createEffect(() => {
        host.innerHTML = renderMarkdown(state.source);
        hydrateMarkdown(host, { directory: documentDirectory(), attachments: state.attachments });
      });
    });
    return (
      <div
        class="markdown-view"
        onClick={(event) => {
          const target = event.target as HTMLElement;
          if (target instanceof HTMLInputElement && target.classList.contains('task-box')) {
            // Ticking a box rewrites the source, and with it this whole rendering. A box
            // ticked from the keyboard gets its focus back, so the next one is a Tab away.
            const at = [...host.querySelectorAll('.task-box')].indexOf(target);
            const focused = document.activeElement === target;
            toggleTask(cell, target);
            if (focused) host.querySelectorAll<HTMLElement>('.task-box')[at]?.focus();
            return;
          }
          const link = target.closest('a');
          if (link) {
            const href = link.getAttribute('href') ?? '';
            if (href.startsWith('#')) {
              event.preventDefault();
              const heading = document.getElementById(decodeURIComponent(href.slice(1)));
              const scroller = heading?.closest<HTMLElement>('.scroller');
              if (heading && scroller) glideIntoView(scroller, heading, 'start');
            }
            return;
          }
          if (event.shiftKey || event.metaKey || target.closest('summary')) return;
          // Dragging to select text is not a request to edit.
          if (!window.getSelection()?.isCollapsed) return;
          focusEditor(cell, sourceOffsetAt(event, state.source));
        }}
      >
        <div class="prose" ref={host} />
        <Show when={!state.source.trim()}>
          <div class="markdown-empty">Write…</div>
        </Show>
      </div>
    );
  };

  return (
    <Show when={state.editing} fallback={<Rendered />}>
      <CellEditor cell={cell} />
    </Show>
  );
}

/** What a cell shows until its body is mounted: its source, set in the same metrics. */
function Placeholder(props: { cell: Cell }) {
  const state = props.cell.state;
  return state.cell_type === 'markdown' ? (
    <div class="markdown-view markdown-placeholder prose">{state.source}</div>
  ) : (
    <div class="cell-card">
      <pre class="code-placeholder">{state.source || ' '}</pre>
    </div>
  );
}

/** Copies a piece of output and says so; a picture that cannot be read says that instead. */
function copy(piece: OutputPiece) {
  copyPiece(piece).then(
    (done) => setNotice({ kind: 'info', text: done }),
    () => setNotice({ kind: 'error', text: 'That could not be copied.' }),
  );
}

function save(image: HTMLImageElement) {
  saveImage(image).then(
    (name) => name && setNotice({ kind: 'info', text: `Saved as ${name}` }),
    () => setNotice({ kind: 'error', text: 'That image could not be saved.' }),
  );
}

/** What the menu offers for the piece of output that was right-clicked. */
function pieceMenu(piece: OutputPiece | null): MenuEntry[] {
  const action = (title: string, run: () => void, hint?: string): MenuEntry => ({ kind: 'action', title, run, hint });
  if (piece?.kind === 'image') {
    return [
      action('Copy Image', () => copy(piece)),
      action('Save Image…', () => save(piece.image)),
      action('Look Closer', () => surfaces.setPreview(piece.image)),
      separator,
    ];
  }
  if (piece?.kind === 'table') return [action('Copy Table', () => copy(piece)), separator];
  if (piece?.kind === 'text') return [action('Copy Output', () => copy(piece)), separator];
  return [];
}

/**
 * The cell's menu (right-click) is the pointer's one way to act on a cell; every entry shows
 * the key that does the same thing. Over a figure, a table or printed text it starts with
 * what can be done with that.
 */
function cellMenu(cell: Cell, piece: OutputPiece | null): MenuEntry[] {
  // Over a piece of output the menu is about the output, and stays short.
  if (piece && cell.isCode) {
    return [...pieceMenu(piece), cmd('cell.toggleOutput', isOutputHidden(cell) ? 'Show Output' : 'Hide Output'), cmd('cell.clearOutput')];
  }
  const entries: MenuEntry[] = pieceMenu(piece);
  if (cell.isCode) entries.push(cmd('cell.run'), separator);
  entries.push(cmd('cell.insertAbove', 'Insert Cell Above'), cmd('cell.insertBelow', 'Insert Cell Below'), separator);
  entries.push(cmd('cell.cut'), cmd('cell.copy'), cmd('cell.paste'), separator);
  entries.push(cmd('cell.moveUp'), cmd('cell.moveDown'), separator);
  entries.push(cell.state.cell_type === 'markdown' ? cmd('cell.toCode') : cmd('cell.toMarkdown'));
  if (cell.isCode) {
    entries.push(
      cmd('cell.toggleCode', isSourceHidden(cell) ? 'Show Code' : 'Hide Code'),
      cmd('cell.toggleOutput', isOutputHidden(cell) ? 'Show Output' : 'Hide Output'),
      cmd('cell.clearOutput'),
    );
  }
  entries.push(separator, cmd('cell.delete'));
  return entries;
}

export function CellView(props: { cell: Cell }) {
  const cell = props.cell;
  const state = cell.state;
  const type = state.cell_type;
  const selected = createMemo(() => isSelected(cell));
  const [menu, setMenu] = createSignal<{ anchor: Anchor; piece: OutputPiece | null } | null>(null);

  // The body is mounted right away, or — when a whole notebook is appearing — a little later.
  const [mounted, setMounted] = createSignal(false);
  const mount = () => setMounted(true);
  if (scheduleMount(cell, mount)) setMounted(true);
  cell.mount = () => {
    cancelMount(cell);
    setMounted(true);
  };

  onCleanup(() => {
    cancelMount(cell);
    cell.mount = null;
    cell.el = null;
  });

  const openMenu = (anchor: Anchor, piece: OutputPiece | null) => {
    // The menu acts on cells, not on text: whatever was being typed elsewhere is left.
    enterCommandMode();
    if (!selected()) select(cell.id, { scroll: false });
    setMenu({ anchor, piece });
  };

  // A figure that has the keyboard (Tab goes into a cell's output): Return looks closer, ⌘C copies.
  const onFigureKey = (event: KeyboardEvent) => {
    const target = event.target;
    if (!(target instanceof HTMLImageElement) || !target.classList.contains('out-image')) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      surfaces.setPreview(target);
    } else if (event.metaKey && event.key.toLowerCase() === 'c' && window.getSelection()?.isCollapsed !== false) {
      event.preventDefault();
      event.stopPropagation();
      copy({ kind: 'image', image: target });
    }
  };

  // Re-rendering a markdown cell after editing must not strand the selection off screen.
  createEffect(
    on(
      () => state.editing,
      () => {
        if (selected()) scrollToCell(cell);
      },
      { defer: true },
    ),
  );

  return (
    <div
      class={`cell ${type}`}
      classList={{
        selected: selected(),
        multi: selected() && hasMultiSelection(),
        running: state.run === 'running',
      }}
      data-cell={cell.id}
      ref={(element) => {
        cell.el = element;
        if (!mounted()) watchPlaceholder(cell, element);
      }}
      onMouseDown={(event) => {
        if (event.button !== 0) return;
        const target = event.target as HTMLElement;
        const inEditor = !!target.closest('.cm-editor');
        if (event.shiftKey && !inEditor) {
          // Shift-click extends the cell selection.
          event.preventDefault();
          enterCommandMode();
          select(cell.id, { extend: true, scroll: false });
          return;
        }
        if (inEditor) return; // the editor's focus handler takes it from here
        if (notebook.activeId() !== cell.id || hasMultiSelection()) select(cell.id, { scroll: false });
        // Controls look after themselves, and a click on rendered markdown starts editing it.
        if (target.closest('button, a, .markdown-view')) return;
        // Anywhere else beside the editor — gutter, outputs, margins — leaves edit mode.
        enterCommandMode();
      }}
      onContextMenu={(event) => {
        const target = event.target as HTMLElement;
        // Editors and selectable output keep the system menu (copy, look up, …).
        if (target.closest('.cm-editor') || !window.getSelection()?.isCollapsed) return;
        event.preventDefault();
        openMenu({ x: event.clientX, y: event.clientY }, pieceAt(event));
      }}
      onDblClick={(event) => {
        // Double-click a figure to look at it closer.
        const piece = (event.target as HTMLElement).closest('.cell-outputs') ? pieceAt(event) : null;
        if (piece?.kind === 'image') surfaces.setPreview(piece.image);
      }}
      onKeyDown={onFigureKey}
    >
      <div class="cell-gutter">
        <Show when={type === 'code'}>
          <RunButton cell={cell} />
          <Show
            when={state.run === 'running'}
            fallback={
              <Show when={state.run === 'idle' && (state.lastDuration ?? 0) >= 1000}>
                <span class="cell-time" title="Run time">
                  {formatDuration(state.lastDuration!)}
                </span>
              </Show>
            }
          >
            <Elapsed since={state.runStarted} />
          </Show>
        </Show>
      </div>

      <div class="cell-main">
        <Show when={mounted()} fallback={<Placeholder cell={cell} />}>
          {type === 'code' ? <CodeBody cell={cell} /> : type === 'markdown' ? <MarkdownBody cell={cell} /> : <CellEditor cell={cell} />}
        </Show>
      </div>

      <Show when={menu()}>
        {(open) => <Menu anchor={open().anchor} entries={cellMenu(cell, open().piece)} onClose={() => setMenu(null)} />}
      </Show>
    </div>
  );
}
