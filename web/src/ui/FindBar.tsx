// Find across the whole notebook: code and markdown being edited are searched in their
// source; rendered markdown and text output are searched as they appear on screen.
//
// It is worked from the keyboard: ↩ / ⇧↩ (or ⌘G / ⇧⌘G from anywhere) step through the
// matches, and Escape closes the bar leaving you at the match — caret on it if you were
// typing, its cell selected otherwise.

import { EditorView } from '@codemirror/view';
import { createEffect, createSignal, on, onCleanup, onMount } from 'solid-js';
import { findInText, setActiveFindQuery, setFindCurrent, setFindQuery, type FindQuery } from '../editor/find';
import { surfaces } from '../notebook/commands';
import { activeCell, cellIndex, enterCommandMode, focusEditor, notebook, select, type Cell } from '../notebook/store';
import { debounce } from '../util/misc';
import { glideIntoView } from '../util/motion';
import { mountAll } from './hydration';

/** What was last searched for, offered again the next time the bar opens. */
let lastQuery = '';

type Match =
  | { cell: Cell; kind: 'source'; from: number; to: number }
  | { cell: Cell; kind: 'dom'; range: Range };

const highlights = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
declare const Highlight: { new (...ranges: Range[]): unknown } | undefined;

function findInDom(root: Element, query: FindQuery): Range[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  const starts: number[] = [];
  let text = '';
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push(node as Text);
    starts.push(text.length);
    text += (node as Text).data;
  }
  const locate = (offset: number): [Text, number] => {
    // Binary search for the text node containing this offset.
    let low = 0;
    let high = nodes.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (starts[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    return [nodes[low], offset - starts[low]];
  };
  return findInText(text, query).map(({ from, to }) => {
    const range = document.createRange();
    const [startNode, startOffset] = locate(from);
    const [endNode, endOffset] = locate(Math.max(from, to - 1));
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset + 1);
    return range;
  });
}

function collect(query: FindQuery): Match[] {
  const matches: Match[] = [];
  if (!query.text) return matches;
  for (const cell of notebook.cells()) {
    if (cell.view) {
      for (const hit of findInText(cell.view.state.doc.toString(), query)) matches.push({ cell, kind: 'source', ...hit });
    } else if (cell.el) {
      const rendered = cell.el.querySelector('.markdown-view .prose, .cell-folded .preview');
      if (rendered) for (const range of findInDom(rendered, query)) matches.push({ cell, kind: 'dom', range });
    }
    if (cell.isCode && cell.el) {
      for (const output of cell.el.querySelectorAll('.cell-outputs .out-text, .cell-outputs .prose')) {
        for (const range of findInDom(output, query)) matches.push({ cell, kind: 'dom', range });
      }
    }
  }
  return matches;
}

export function FindBar() {
  let input!: HTMLInputElement;
  const previousFocus = document.activeElement as HTMLElement | null;
  // Searching starts from where you are — the caret, or the selected cell — not from the top.
  const originCell = activeCell();
  const origin = { cell: originCell ? cellIndex(originCell) : 0, offset: originCell?.view?.state.selection.main.from ?? 0 };
  const [text, setText] = createSignal('');
  const [matches, setMatches] = createSignal<Match[]>([]);
  const [current, setCurrent] = createSignal(-1);

  const query = (): FindQuery => {
    const value = text();
    // Like most editors: lowercase searches ignore case, mixed case is exact.
    return { text: value, caseSensitive: value !== value.toLowerCase() };
  };

  const paint = () => {
    const all = matches();
    const active = all[current()];
    if (highlights && typeof Highlight !== 'undefined') {
      const ranges = all.filter((match) => match.kind === 'dom' && match !== active).map((match) => (match as { range: Range }).range);
      highlights.set('sumi-find', new Highlight(...ranges));
      highlights.set('sumi-find-current', active?.kind === 'dom' ? new Highlight(active.range) : new Highlight());
    }
    for (const cell of notebook.cells()) {
      cell.view?.dispatch({
        effects: setFindCurrent.of(active?.kind === 'source' && active.cell === cell ? { from: active.from, to: active.to } : null),
      });
    }
  };

  /** The first match at or after the origin (or, going backwards, the last one before it). */
  const nearest = (found: Match[], direction: number): number => {
    const ahead = (match: Match) => {
      const at = cellIndex(match.cell);
      return at > origin.cell || (at === origin.cell && (match.kind !== 'source' || match.from >= origin.offset));
    };
    const next = found.findIndex(ahead);
    if (direction >= 0) return next < 0 ? 0 : next; // past the last one: around to the top
    const before = (next < 0 ? found.length : next) - 1;
    return before < 0 ? found.length - 1 : before;
  };

  const search = (keepPosition = false, direction = 1) => {
    const next = query();
    setActiveFindQuery(next.text ? next : null);
    for (const cell of notebook.cells()) cell.view?.dispatch({ effects: setFindQuery.of(next.text ? next : null) });
    const found = collect(next);
    setMatches(found);
    setCurrent(found.length ? (keepPosition ? Math.min(Math.max(current(), 0), found.length - 1) : nearest(found, direction)) : -1);
    paint();
    if (!keepPosition) reveal();
  };

  /** Brings the current match into view the way the page moves everywhere else: it glides. */
  const reveal = () => {
    const match = matches()[current()];
    if (!match) return;
    select(match.cell.id, { scroll: false });
    const scroller = match.cell.el?.closest<HTMLElement>('.scroller');
    if (!scroller) return;
    const view = match.kind === 'source' ? match.cell.view : null;
    const rect = match.kind === 'dom' ? match.range.getBoundingClientRect() : view?.coordsAtPos(match.from);
    if (!rect) {
      // The line is not laid out yet (a very long cell): let the editor find it.
      if (match.kind === 'source') view?.dispatch({ effects: EditorView.scrollIntoView(match.from, { y: 'center' }) });
      return;
    }
    const frame = scroller.getBoundingClientRect();
    // Already comfortably in sight: leave the page where it is.
    if (rect.top < frame.top + 80 || rect.bottom > frame.bottom - 120) glideIntoView(scroller, rect, 'center');
    // A match far along a long line still needs the editor to scroll sideways.
    if (view && match.kind === 'source') {
      const line = view.scrollDOM.getBoundingClientRect();
      if (rect.left < line.left || rect.right > line.right) {
        view.dispatch({ effects: EditorView.scrollIntoView(match.from, { y: 'nearest', x: 'center' }) });
      }
    }
  };

  /**
   * Goes to a match for real: the caret onto it when a cell is being edited, its cell
   * selected otherwise (with the editor's selection left on the match for a later Return).
   */
  const land = (match: Match) => {
    const view = match.kind === 'source' ? match.cell.view : null;
    if (match.kind === 'source' && view) {
      view.dispatch({ selection: { anchor: match.from, head: match.to } });
      if (notebook.mode() === 'edit') {
        focusEditor(match.cell, 'keep');
        return;
      }
    }
    enterCommandMode();
    select(match.cell.id, { scroll: false });
  };

  const step = (delta: number) => {
    const count = matches().length;
    if (!count) return;
    setCurrent((current() + delta + count) % count);
    paint();
    reveal();
    // Stepping from outside the field (⌘G while in a cell) moves you along with it.
    if (document.activeElement !== input) land(matches()[current()]);
  };

  const close = () => {
    const match = matches()[current()];
    surfaces.setFindOpen(false);
    if (match) land(match);
    else if (previousFocus?.isConnected && previousFocus !== document.body) previousFocus.focus({ preventScroll: true });
    else enterCommandMode();
  };

  // Keep results fresh while the notebook changes underneath.
  const refresh = debounce(() => search(true), 250);
  createEffect(on(() => [notebook.revision(), notebook.cells()], () => refresh(), { defer: true }));

  onMount(() => {
    // Search needs every cell on the page for real.
    mountAll();
    const selection = window.getSelection()?.toString() ?? '';
    if (selection && !selection.includes('\n') && selection.length < 80) setText(selection);
    else setText(lastQuery);
    // Opened by "find next / previous": go straight to that match and leave the caret in
    // the notebook; the bar is only there to say what is being sought.
    const jump = surfaces.takeFindJump();
    if (jump && text()) {
      // Whatever is selected is itself a match: "next" means the one after it.
      if (jump > 0 && originCell?.view && !originCell.view.state.selection.main.empty) origin.offset += 1;
      search(false, jump);
      const match = matches()[current()];
      if (match) land(match);
      else input.focus();
    } else {
      input.focus();
      input.select();
      search();
    }
    surfaces.setFindBar({
      step,
      focus: () => {
        input.focus();
        input.select();
      },
    });
  });

  onCleanup(() => {
    surfaces.setFindBar(null);
    refresh.cancel();
    setActiveFindQuery(null);
    highlights?.delete('sumi-find');
    highlights?.delete('sumi-find-current');
    for (const cell of notebook.cells()) cell.view?.dispatch({ effects: setFindQuery.of(null) });
  });

  return (
    <div class="find-bar">
      <input
        ref={input}
        placeholder="Find"
        spellcheck={false}
        autocomplete="off"
        value={text()}
        onInput={(event) => {
          setText(event.currentTarget.value);
          lastQuery = event.currentTarget.value;
          search();
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.isComposing) return;
          if (event.key === 'Enter') {
            event.preventDefault();
            step(event.shiftKey ? -1 : 1);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            close();
          }
        }}
        onBlur={() => {
          // Focus that goes nowhere (a click on the page's margin) must not leave the
          // notebook thinking a cell is still being typed in.
          setTimeout(() => {
            if (!document.hasFocus() || !surfaces.findOpen()) return;
            if (document.activeElement === document.body && notebook.mode() === 'edit') enterCommandMode();
          }, 0);
        }}
      />
      <span class="count">{text() ? (matches().length ? `${current() + 1} of ${matches().length}` : 'No results') : ''}</span>
    </div>
  );
}
