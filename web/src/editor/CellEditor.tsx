// The CodeMirror editor inside a cell.

import { completionStatus } from '@codemirror/autocomplete';
import { Annotation, EditorState, type EditorSelection, type Extension, type SelectionRange } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { batch, createEffect, onCleanup, onMount } from 'solid-js';
import { ensureKernel, kernel, kernelLanguage } from '../kernel/kernel';
import { runCommand } from '../notebook/commands';
import { ARROW_PAIR_MS } from '../notebook/keymap';
import {
  applyPendingFocus,
  cellIndex,
  deleteCells,
  enterCommandMode,
  focusEditor,
  glideCells,
  hasMultiSelection,
  isSourceHidden,
  notebook,
  select,
  setMode,
  setSource,
  type Cell,
} from '../notebook/store';
import { prefs } from '../state/prefs';
import { closeInspection, completionExtension, inspectAtCursor, inspectionExtension } from './completion';
import {
  codeExtensions,
  completionConfig,
  languageConfig,
  languageSupport,
  lineNumbersConfig,
  lineNumbersExtension,
  markdownExtensions,
  rawExtensions,
  wrapConfig,
  wrapExtension,
  type EditorHooks,
} from './setup';

function warmKernel() {
  if (kernel.status() === 'none' && kernel.spec()?.available) ensureKernel().catch(() => {});
}

/**
 * Typewriter mode: the line being typed stays at one height in the window and the page moves
 * under it, so your eyes never have to follow the caret down the screen.
 */
function holdCaretSteady(view: EditorView) {
  view.requestMeasure({
    key: 'reed-typewriter',
    read: () => {
      const scroller = view.dom.closest<HTMLElement>('.scroller');
      const caret = view.coordsAtPos(view.state.selection.main.head);
      if (!scroller || !caret) return null;
      const box = scroller.getBoundingClientRect();
      return { scroller, delta: (caret.top + caret.bottom) / 2 - (box.top + box.height * 0.44) };
    },
    write: (measured) => {
      if (!measured || Math.abs(measured.delta) < 2) return;
      // Line-to-line steps are immediate, like a carriage return; longer trips glide.
      measured.scroller.scrollBy({ top: measured.delta, behavior: Math.abs(measured.delta) > 200 ? 'smooth' : 'auto' });
    },
  });
}

/** How close together two presses of ⌫ must be to count as "remove this cell". */
const DOUBLE_PRESS_MS = 600;
/** After a cell is removed that way, ⌫ rests for a moment: a third tap must not start on the cell above. */
let backspaceRestsUntil = 0;

/**
 * ⌫ in a cell that is already empty. Deleting text never spills over into deleting the cell:
 * a held key stops at the empty cell, and the cell goes only on two fresh presses in a row
 * (the first one says so, quietly, in the cell).
 */
function emptyCellBackspace(cell: Cell): Extension {
  let armedAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const disarm = () => {
    armedAt = 0;
    clearTimeout(timer);
    cell.el?.classList.remove('armed');
  };
  return EditorView.domEventHandlers({
    keydown(event, view) {
      if (event.key !== 'Backspace' || event.metaKey || event.ctrlKey || event.altKey || event.isComposing) {
        if (armedAt) disarm();
        return false;
      }
      if (performance.now() < backspaceRestsUntil) {
        event.preventDefault();
        return true;
      }
      if (view.state.doc.length > 0) {
        if (armedAt) disarm();
        return false; // ordinary deleting
      }
      // Nothing left to delete. The key is spent here either way.
      event.preventDefault();
      if (event.repeat || cell.state.outputs.length > 0 || notebook.cells().length <= 1) return true;
      const now = performance.now();
      if (armedAt && now - armedAt < DOUBLE_PRESS_MS) {
        disarm();
        const previous = neighbour(cell, -1);
        const next = neighbour(cell, 1);
        deleteCells([cell]);
        backspaceRestsUntil = performance.now() + 450;
        if (previous) focusEditor(previous, 'end');
        else if (next) focusEditor(next, 'start');
      } else {
        armedAt = now;
        cell.el?.classList.add('armed');
        clearTimeout(timer);
        timer = setTimeout(disarm, DOUBLE_PRESS_MS);
      }
      return true;
    },
    blur: () => {
      if (armedAt) disarm();
    },
  });
}

/** Whether the caret stands at the left edge of the cell: the start of a line, or of one of its wrapped rows. */
function atLeftEdge(view: EditorView, caret: SelectionRange): boolean {
  if (caret.head === view.state.doc.lineAt(caret.head).from) return true;
  return view.lineWrapping && view.moveToLineBoundary(caret, false).head === caret.head;
}

/**
 * ← twice at the left edge of a cell steps out of its text: the cell is selected and keys
 * become commands (→ twice steps back in, to where the caret was). The first press does what
 * ← always does there; the second takes that back and leaves. Only a pair pressed on its own
 * counts — a held key, or taps that were already carrying the caret leftwards, are travel.
 */
function leftEdgeExit(): Extension {
  let lastPress = -Infinity;
  let armed: { at: number; selection: EditorSelection } | null = null;
  return EditorView.domEventHandlers({
    keydown(event, view) {
      if (event.key !== 'ArrowLeft' || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.isComposing) {
        armed = null;
        return false;
      }
      const now = performance.now();
      const rested = now - lastPress > ARROW_PAIR_MS;
      lastPress = now;
      if (event.repeat) {
        armed = null;
        return false;
      }
      if (armed && now - armed.at < ARROW_PAIR_MS) {
        const before = armed.selection;
        armed = null;
        event.preventDefault();
        if (before.main.head <= view.state.doc.length) view.dispatch({ selection: before });
        enterCommandMode();
        return true;
      }
      armed = null;
      const selection = view.state.selection;
      if (rested && selection.ranges.length === 1 && selection.main.empty && atLeftEdge(view, selection.main)) {
        armed = { at: now, selection };
      }
      return false;
    },
    blur: () => {
      armed = null;
    },
  });
}

/** Marks transactions that mirror a change made elsewhere, so they are not echoed back. */
const external = Annotation.define<boolean>();

function neighbour(cell: Cell, direction: -1 | 1): Cell | undefined {
  const all = notebook.cells();
  for (let i = cellIndex(cell) + direction; i >= 0 && i < all.length; i += direction) {
    if (!isSourceHidden(all[i])) return all[i];
  }
  return undefined;
}

/** Arrow keys walk out of a cell at its first/last line, making the notebook one document. */
function leave(cell: Cell, view: EditorView, direction: -1 | 1): boolean {
  const selection = view.state.selection;
  if (selection.ranges.length > 1 || !selection.main.empty) return false;
  if (completionStatus(view.state) === 'active') return false;
  const head = selection.main.head;
  const doc = view.state.doc;
  const line = doc.lineAt(head);
  if (direction < 0 ? line.number !== 1 : line.number !== doc.lines) return false;
  if (view.lineWrapping) {
    // With soft wrapping, only the first/last visual row counts as the edge.
    const here = view.coordsAtPos(head);
    const edge = view.coordsAtPos(direction < 0 ? 0 : doc.length);
    if (here && edge && Math.abs(here.top - edge.top) > 3) return false;
  }
  const target = neighbour(cell, direction);
  if (!target) return false;
  focusEditor(target, direction < 0 ? 'end' : 'start');
  return true;
}

function cellKeys(cell: Cell): Extension {
  const run = (id: string) => () => {
    runCommand(id);
    return true;
  };
  const runInPlace = () => {
    runCommand('cell.run');
    if (!cell.isCode) enterCommandMode();
    return true;
  };
  return keymap.of([
    { key: 'Shift-Enter', run: run('cell.runAndAdvance') },
    { key: 'Mod-Enter', run: runInPlace },
    // Jupyter's own key for the same thing, for hands that already know it.
    { key: 'Ctrl-Enter', run: runInPlace },
    { key: 'Alt-Enter', run: run('cell.runAndInsert') },
    {
      key: 'Escape',
      run: (view) => {
        if (completionStatus(view.state) !== null) return false;
        if (closeInspection(view)) return true;
        enterCommandMode();
        return true;
      },
    },
    { key: 'ArrowUp', run: (view) => leave(cell, view, -1) },
    { key: 'ArrowDown', run: (view) => leave(cell, view, 1) },
    {
      key: 'Shift-Tab',
      run: (view) => {
        if (!cell.isCode) return false;
        const selection = view.state.selection.main;
        const line = view.state.doc.lineAt(selection.head);
        if (!selection.empty || /^\s*$/.test(line.text.slice(0, selection.head - line.from))) return false;
        void inspectAtCursor(view);
        return true;
      },
    },
  ]);
}

function createState(cell: Cell): EditorState {
  const listeners: Extension = [
    EditorView.updateListener.of((update) => {
      if (prefs.typewriter && update.view.hasFocus && (update.docChanged || update.selectionSet)) {
        // Keyboard-driven changes only: a click should not send the page sliding.
        const byKeyboard = update.transactions.some(
          (transaction) =>
            transaction.isUserEvent('input') ||
            transaction.isUserEvent('delete') ||
            transaction.isUserEvent('move') ||
            (transaction.isUserEvent('select') && !transaction.isUserEvent('select.pointer')),
        );
        if (byKeyboard) holdCaretSteady(update.view);
      }
      if (!update.docChanged) return;
      if (update.transactions.some((transaction) => transaction.annotation(external))) return;
      setSource(cell, update.state.doc.toString());
      // Someone typing code will want completions, and soon a result: have the kernel ready.
      if (cell.isCode && update.transactions.some((transaction) => transaction.isUserEvent('input'))) warmKernel();
    }),
    EditorView.domEventHandlers({
      focus() {
        batch(() => {
          if (notebook.activeId() !== cell.id || hasMultiSelection()) select(cell.id, { scroll: false });
          setMode('edit');
        });
      },
      blur(_event, view) {
        // Decide once focus has settled somewhere.
        setTimeout(() => {
          if (!document.hasFocus()) return; // the window was deactivated; nothing to do
          const focused = document.activeElement;
          if (focused && view.dom.contains(focused)) return;
          // The palette, the find bar and the name in the title bar only borrow the keyboard:
          // the cell stays as it is — a markdown cell keeps showing its source — and gets
          // the caret back after.
          if (focused?.closest('.palette-layer, .find-bar, .topbar-title')) return;
          const inAnotherEditor = !!focused && !!(focused as HTMLElement).closest?.('.cm-editor');
          const settle = () =>
            batch(() => {
              if (!inAnotherEditor && notebook.mode() === 'edit') setMode('command');
              if (!cell.isCode && cell.state.editing) cell.set('editing', false);
            });
          if (!cell.isCode && cell.state.editing) glideCells(settle);
          else settle();
        }, 0);
      },
    }),
  ];
  const hooks: EditorHooks = {
    keys: [emptyCellBackspace(cell), leftEdgeExit(), cellKeys(cell)],
    completion: [completionExtension(prefs.completionList), inspectionExtension()],
    listeners,
  };
  const type = cell.state.cell_type;
  const extensions =
    type === 'code'
      ? codeExtensions(hooks, { language: kernelLanguage(), lineNumbers: prefs.lineNumbers, wrap: prefs.wrapCode })
      : type === 'markdown'
        ? markdownExtensions(hooks)
        : rawExtensions(hooks);
  return EditorState.create({ doc: cell.state.source, extensions });
}

export function CellEditor(props: { cell: Cell }) {
  let host!: HTMLDivElement;
  const cell = props.cell;

  onMount(() => {
    const view = new EditorView({ state: cell.savedEditorState ?? createState(cell), parent: host });
    cell.savedEditorState = null;
    cell.view = view;

    // Changes made outside the editor (undo of a split, %load, find & replace…).
    createEffect(() => {
      const source = cell.state.source;
      const doc = view.state.doc;
      if (doc.length === source.length && doc.toString() === source) return;
      view.dispatch({ changes: { from: 0, to: doc.length, insert: source }, annotations: external.of(true) });
    });

    if (cell.isCode) {
      createEffect(() => {
        view.dispatch({ effects: lineNumbersConfig.reconfigure(lineNumbersExtension(prefs.lineNumbers)) });
      });
      createEffect(() => {
        view.dispatch({ effects: wrapConfig.reconfigure(wrapExtension(prefs.wrapCode)) });
      });
      createEffect(() => {
        view.dispatch({ effects: completionConfig.reconfigure([completionExtension(prefs.completionList), inspectionExtension()]) });
      });
      createEffect(() => {
        const language = kernelLanguage();
        let cancelled = false;
        onCleanup(() => (cancelled = true));
        void languageSupport(language).then((support) => {
          if (!cancelled && cell.view === view) view.dispatch({ effects: languageConfig.reconfigure(support) });
        });
      });
    }

    applyPendingFocus(cell);

    onCleanup(() => {
      cell.savedEditorState = view.state;
      if (cell.view === view) cell.view = null;
      view.destroy();
    });
  });

  return <div class="cell-editor" ref={host} />;
}
