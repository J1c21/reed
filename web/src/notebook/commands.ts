// Every action the app can perform, addressable by id. The menu bar, the command palette and
// the keyboard all go through this one registry.

import { call } from '../host';
import { copyText } from '../host/clipboard';
import { showCompletions } from '../editor/completion';
import { copyPiece, mainPiece } from '../render/outputs/actions';
import { interruptKernel, kernel, restartKernel, shutdownKernel } from '../kernel/kernel';
import { prefs, setPref, togglePref } from '../state/prefs';
import { surfaces } from '../state/surfaces';
import { clamp } from '../util/misc';
import { glideScrollTo, scrollGoal } from '../util/motion';
import { exportNotebook, save, saveAs } from './document';
import { execution, interrupt, restartAndRun, runCells, setNotice, staleCells } from './execution';
import type { CellType } from './nbformat';
import {
  activeCell,
  cellIndex,
  clearOutputs,
  convertCells,
  copyCells,
  deleteCells,
  duplicateCells,
  enterCommandMode,
  focusEditor,
  hasCellClipboard,
  insertRelative,
  isSourceHidden,
  mergeCells,
  moveCells,
  notebook,
  pasteCells,
  redoStructure,
  scrollToCell,
  select,
  selectAll,
  selectedCells,
  selectRelative,
  splitCell,
  toggleOutputHidden,
  toggleSourceHidden,
  undoStructure,
  type Cell,
} from './store';

export interface Command {
  id: string;
  title: string;
  group: 'File' | 'Edit' | 'Cell' | 'Run' | 'Kernel' | 'View' | 'Go';
  /** Shortcut shown to the user, in CodeMirror key notation ("Mod-Shift-Enter"). */
  keys?: string;
  run: () => unknown;
  enabled?: () => boolean;
  checked?: () => boolean;
  /** Hidden from the palette (navigation plumbing and the like). */
  internal?: boolean;
  /**
   * A preference rather than an action. Settings are kept together in their own list (⌘,)
   * instead of padding out the list of commands; searching the commands still finds them.
   */
  setting?: boolean;
}

const registry = new Map<string, Command>();

export function registerCommands(...commands: Command[]) {
  for (const command of commands) registry.set(command.id, command);
}

export function command(id: string): Command | undefined {
  return registry.get(id);
}

export function allCommands(): Command[] {
  return [...registry.values()];
}

export function runCommand(id: string): boolean {
  const entry = registry.get(id);
  if (!entry || (entry.enabled && !entry.enabled())) return false;
  try {
    const result = entry.run();
    if (result instanceof Promise) result.catch((error) => setNotice({ kind: 'error', text: String(error?.message ?? error) }));
  } catch (error) {
    setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
  }
  return true;
}

export { surfaces };

// ── Helpers ─────────────────────────────────────────────────────────────────

const selection = () => selectedCells();
const hasCells = () => notebook.cells().length > 0;
const editing = () => notebook.mode() === 'edit';

function advanceFrom(cell: Cell, wasEditing: boolean) {
  const all = notebook.cells();
  const next = all[cellIndex(cell) + 1];
  if (!next) {
    // Running the last cell opens a fresh one, ready for typing.
    insertRelative(cell, 'below', 'code', { edit: true });
    return;
  }
  if (wasEditing && next.isCode) focusEditor(next, 'start');
  else {
    enterCommandMode();
    selectRelative(1);
  }
}

function copyToSystemClipboard(text: string) {
  void copyText(text).catch(() => {});
}

/** Copies what the selected cell produced: its figure if it drew one, its table, else its text. */
async function copyOutput() {
  const element = activeCell()?.el;
  const piece = element ? mainPiece(element) : null;
  if (!piece) return;
  setNotice({ kind: 'info', text: await copyPiece(piece) });
}

/** Changes the selected cells' type. Someone who was typing goes on typing, caret in place. */
function convertSelection(type: CellType) {
  const before = activeCell();
  const caret = editing() ? (before?.view?.state.selection.main.head ?? 'end') : null;
  convertCells(selection(), type);
  const after = activeCell();
  if (caret !== null && after && after !== before) focusEditor(after, caret);
}

/**
 * Scrolls a windowful and takes the selection along, so that the next key acts on what is
 * in view rather than on a cell left behind.
 */
function scrollPage(direction: 1 | -1) {
  const scroller = document.querySelector<HTMLElement>('.scroller');
  if (!scroller) return;
  const view = scroller.getBoundingClientRect();
  // Pressed again while the page is still gliding, the next page is measured from where
  // the glide will end, not from wherever it happens to be.
  const top = clamp(scrollGoal(scroller) + direction * Math.max(120, view.height - 96), 0, scroller.scrollHeight - scroller.clientHeight);
  const shift = top - scroller.scrollTop;
  if (Math.abs(shift) < 1) {
    // Nothing left to scroll: finish on the first or last cell.
    selectRelative(direction * Infinity);
    return;
  }
  // The cell that will sit at the top of the window: the first one that starts in view,
  // unless the one cut off above it still fills most of the page.
  let target: Cell | undefined;
  for (const cell of notebook.cells()) {
    const rect = cell.el?.getBoundingClientRect();
    if (!rect || rect.bottom - shift <= view.top + 32) continue;
    target = cell;
    if (rect.top - shift >= view.top - 8 || rect.bottom - shift >= view.top + view.height / 2) break;
  }
  glideScrollTo(scroller, top);
  if (target) select(target.id, { scroll: false });
}

// (Buttons that wait for the pointer — copy, add a cell — take themselves out with tabindex -1.)
const TABBABLE =
  'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]):not([tabindex="-1"]), a[href], summary, [tabindex]:not([tabindex="-1"])';

/**
 * Moves focus to the first control in the selected cell's body — a widget, a link, a task
 * checkbox, a folded section — so that outputs can be worked without the pointer.
 */
function focusCellControl(): boolean {
  const body = activeCell()?.el?.querySelector('.cell-main');
  if (!body) return false;
  for (const control of body.querySelectorAll<HTMLElement>(TABBABLE)) {
    if (control.closest('.cm-editor') || control.offsetParent === null) continue;
    control.focus();
    return true;
  }
  return false;
}

// ── Registration ────────────────────────────────────────────────────────────

registerCommands(
  // File
  { id: 'file.save', title: 'Save', group: 'File', keys: 'Mod-s', run: () => save() },
  { id: 'file.saveAs', title: 'Save As…', group: 'File', keys: 'Mod-Shift-s', run: () => saveAs() },
  {
    id: 'file.rename',
    title: 'Rename…',
    group: 'File',
    // The name in the title bar becomes a field. A notebook with no file yet gets its name
    // the way it gets its file: in the Save panel.
    run: () => (notebook.path() ? void surfaces.setRenaming(true) : saveAs()),
  },
  { id: 'file.exportScript', title: 'Export as Script…', group: 'File', run: () => exportNotebook('script') },
  { id: 'file.exportMarkdown', title: 'Export as Markdown…', group: 'File', run: () => exportNotebook('markdown') },
  { id: 'file.openQuickly', title: 'Open Quickly…', group: 'File', keys: 'Mod-Shift-o', run: () => surfaces.togglePalette('files') },
  {
    id: 'file.reveal',
    title: 'Reveal in Finder',
    group: 'File',
    enabled: () => !!notebook.path(),
    run: () => call('app.reveal', { path: notebook.path() }),
  },

  // Run
  {
    id: 'cell.run',
    title: 'Run Cell',
    group: 'Run',
    keys: 'Mod-Enter',
    enabled: hasCells,
    run: () => runCells(selection()),
  },
  {
    id: 'cell.runAndAdvance',
    title: 'Run Cell and Select Next',
    group: 'Run',
    keys: 'Shift-Enter',
    enabled: hasCells,
    run: () => {
      const wasEditing = editing();
      const cells = selection();
      if (!cells.length) return;
      runCells(cells);
      advanceFrom(cells[cells.length - 1], wasEditing);
    },
  },
  {
    id: 'cell.runAndInsert',
    title: 'Run Cell and Insert Below',
    group: 'Run',
    keys: 'Alt-Enter',
    enabled: hasCells,
    run: () => {
      const cells = selection();
      if (!cells.length) return;
      runCells(cells);
      insertRelative(cells[cells.length - 1], 'below', 'code', { edit: true });
    },
  },
  { id: 'notebook.runAll', title: 'Run All Cells', group: 'Run', keys: 'Mod-Shift-Enter', enabled: hasCells, run: () => runCells(notebook.cells()) },
  {
    id: 'cell.runAbove',
    title: 'Run All Above',
    group: 'Run',
    enabled: hasCells,
    run: () => {
      const cell = activeCell();
      if (cell) runCells(notebook.cells().slice(0, cellIndex(cell)));
    },
  },
  {
    id: 'cell.runBelow',
    title: 'Run Cell and All Below',
    group: 'Run',
    enabled: hasCells,
    run: () => {
      const cell = activeCell();
      if (cell) runCells(notebook.cells().slice(cellIndex(cell)));
    },
  },
  {
    id: 'notebook.runStale',
    title: 'Run Stale Cells',
    group: 'Run',
    enabled: () => staleCells().length > 0,
    run: () => runCells(staleCells()),
  },
  {
    id: 'view.reactive', setting: true,
    title: 'Reactive Execution',
    group: 'Run',
    checked: () => prefs.reactive,
    run: () => {
      togglePref('reactive');
      setNotice({
        kind: 'info',
        text: prefs.reactive
          ? 'Reactive: running a cell also runs the cells that depend on it.'
          : 'Reactive off: dependent cells are marked stale instead.',
      });
    },
  },

  // Kernel
  { id: 'kernel.interrupt', title: 'Interrupt Kernel', group: 'Kernel', keys: 'Mod-.', run: () => interrupt() },
  {
    id: 'kernel.restart',
    title: 'Restart Kernel',
    group: 'Kernel',
    enabled: () => !!kernel.spec(),
    run: () => restartKernel(),
  },
  {
    id: 'kernel.restartRunAll',
    title: 'Restart Kernel and Run All',
    group: 'Kernel',
    enabled: () => !!kernel.spec(),
    run: () => restartAndRun(() => notebook.cells()),
  },
  {
    id: 'kernel.restartClear',
    title: 'Restart Kernel and Clear Outputs',
    group: 'Kernel',
    enabled: () => !!kernel.spec(),
    run: async () => {
      clearOutputs(notebook.cells());
      await restartKernel();
    },
  },
  {
    id: 'kernel.shutdown',
    title: 'Shut Down Kernel',
    group: 'Kernel',
    enabled: () => kernel.status() !== 'none',
    run: () => shutdownKernel(),
  },
  { id: 'kernel.pick', title: 'Select Kernel…', group: 'Kernel', keys: 'Alt-Mod-k', run: () => surfaces.togglePalette('kernels') },

  // Cell
  {
    id: 'cell.insertAbove',
    title: 'Insert Code Cell Above',
    group: 'Cell',
    keys: 'a',
    run: () => insertRelative(activeCell(), 'above', 'code', { edit: editing() }),
  },
  {
    id: 'cell.insertBelow',
    title: 'Insert Code Cell Below',
    group: 'Cell',
    keys: 'b',
    run: () => insertRelative(selection().at(-1) ?? activeCell(), 'below', 'code', { edit: editing() }),
  },
  {
    id: 'cell.insertMarkdownBelow',
    title: 'Insert Markdown Cell Below',
    group: 'Cell',
    run: () => insertRelative(selection().at(-1) ?? activeCell(), 'below', 'markdown', { edit: true }),
  },
  { id: 'cell.toCode', title: 'Change to Code', group: 'Cell', keys: 'y', enabled: hasCells, run: () => convertSelection('code') },
  { id: 'cell.toMarkdown', title: 'Change to Markdown', group: 'Cell', keys: 'm', enabled: hasCells, run: () => convertSelection('markdown') },
  { id: 'cell.toRaw', title: 'Change to Raw', group: 'Cell', keys: 'r', enabled: hasCells, run: () => convertSelection('raw') },
  { id: 'cell.moveUp', title: 'Move Cell Up', group: 'Cell', keys: 'Ctrl-Shift-ArrowUp', enabled: hasCells, run: () => void moveCells(selection(), -1) },
  { id: 'cell.moveDown', title: 'Move Cell Down', group: 'Cell', keys: 'Ctrl-Shift-ArrowDown', enabled: hasCells, run: () => void moveCells(selection(), 1) },
  {
    id: 'cell.split',
    title: 'Split Cell at Cursor',
    group: 'Cell',
    keys: 'Ctrl-Shift--',
    enabled: () => !!activeCell()?.view,
    run: () => {
      const cell = activeCell();
      if (cell?.view) splitCell(cell, cell.view.state.selection.main.head);
    },
  },
  {
    id: 'cell.merge',
    title: 'Merge with Cell Below',
    group: 'Cell',
    keys: 'Shift-m',
    enabled: hasCells,
    run: () => void mergeCells(selection()),
  },
  { id: 'cell.duplicate', title: 'Duplicate Cell', group: 'Cell', enabled: hasCells, run: () => void duplicateCells(selection()) },
  { id: 'cell.delete', title: 'Delete Cell', group: 'Cell', keys: 'd d', enabled: hasCells, run: () => deleteCells(selection()) },
  {
    id: 'cell.clearOutput',
    title: 'Clear Cell Output',
    group: 'Cell',
    enabled: hasCells,
    run: () => clearOutputs(selection()),
  },
  { id: 'notebook.clearOutputs', title: 'Clear All Outputs', group: 'Cell', enabled: hasCells, run: () => clearOutputs(notebook.cells()) },
  {
    id: 'cell.toggleCode',
    title: 'Hide or Show Code',
    group: 'Cell',
    keys: 'Shift-o',
    enabled: hasCells,
    run: () => selection().filter((cell) => cell.isCode).forEach(toggleSourceHidden),
  },
  {
    id: 'cell.toggleOutput',
    title: 'Hide or Show Output',
    group: 'Cell',
    keys: 'o',
    enabled: hasCells,
    run: () => selection().filter((cell) => cell.isCode).forEach(toggleOutputHidden),
  },

  // Edit
  {
    id: 'cell.cut',
    title: 'Cut Cell',
    group: 'Edit',
    keys: 'x',
    enabled: hasCells,
    run: () => {
      const cells = selection();
      copyToSystemClipboard(copyCells(cells));
      deleteCells(cells);
    },
  },
  { id: 'cell.copy', title: 'Copy Cell', group: 'Edit', keys: 'c', enabled: hasCells, run: () => copyToSystemClipboard(copyCells(selection())) },
  {
    id: 'cell.copyOutput',
    title: 'Copy Cell Output',
    group: 'Edit',
    keys: 'Shift-c',
    enabled: () => !!activeCell()?.state.outputs.length,
    run: () => copyOutput(),
  },
  { id: 'cell.paste', title: 'Paste Cell Below', group: 'Edit', keys: 'v', enabled: hasCellClipboard, run: () => void pasteCells(selection().at(-1) ?? activeCell(), 'below') },
  { id: 'cell.pasteAbove', title: 'Paste Cell Above', group: 'Edit', keys: 'Shift-v', enabled: hasCellClipboard, run: () => void pasteCells(activeCell(), 'above') },
  { id: 'edit.undoCells', title: 'Undo Cell Operation', group: 'Edit', keys: 'z', run: () => void undoStructure() },
  { id: 'edit.redoCells', title: 'Redo Cell Operation', group: 'Edit', keys: 'Shift-z', run: () => void redoStructure() },
  { id: 'cell.selectAll', title: 'Select All Cells', group: 'Edit', run: () => selectAll(), internal: true },
  {
    id: 'edit.complete',
    title: 'Show Completions',
    group: 'Edit',
    keys: 'Alt-Escape',
    enabled: () => editing() && !!activeCell()?.isCode && !!activeCell()?.view,
    run: () => {
      const view = activeCell()?.view;
      if (view) showCompletions(view);
    },
  },
  { id: 'edit.find', title: 'Find…', group: 'Edit', keys: 'Mod-f', run: () => surfaces.showFind() },
  { id: 'edit.findNext', title: 'Find Next', group: 'Edit', keys: 'Mod-g', run: () => surfaces.findStep(1) },
  { id: 'edit.findPrevious', title: 'Find Previous', group: 'Edit', keys: 'Mod-Shift-g', run: () => surfaces.findStep(-1) },

  // Go
  { id: 'nav.up', title: 'Select Cell Above', group: 'Go', internal: true, run: () => void selectRelative(-1) },
  { id: 'nav.down', title: 'Select Cell Below', group: 'Go', internal: true, run: () => void selectRelative(1) },
  { id: 'nav.extendUp', title: 'Extend Selection Up', group: 'Go', internal: true, run: () => void selectRelative(-1, { extend: true }) },
  { id: 'nav.extendDown', title: 'Extend Selection Down', group: 'Go', internal: true, run: () => void selectRelative(1, { extend: true }) },
  { id: 'nav.pageDown', title: 'Scroll Down', group: 'Go', internal: true, run: () => scrollPage(1) },
  { id: 'nav.pageUp', title: 'Scroll Up', group: 'Go', internal: true, run: () => scrollPage(-1) },
  { id: 'go.heading', title: 'Go to Heading…', group: 'Go', keys: 'Mod-j', run: () => surfaces.togglePalette('headings') },
  { id: 'go.variables', title: 'Variables…', group: 'Go', keys: 'Alt-Mod-v', run: () => surfaces.togglePalette('variables') },
  {
    id: 'nav.first',
    title: 'Go to First Cell',
    group: 'Go',
    run: () => {
      enterCommandMode();
      selectRelative(-Infinity);
    },
  },
  {
    id: 'nav.last',
    title: 'Go to Last Cell',
    group: 'Go',
    run: () => {
      enterCommandMode();
      selectRelative(Infinity);
    },
  },
  {
    id: 'nav.running',
    title: 'Go to Running Cell',
    group: 'Go',
    enabled: () => !!execution.runningCell(),
    run: () => {
      const cell = execution.runningCell();
      if (!cell) return;
      enterCommandMode();
      select(cell.id, { scroll: false });
      scrollToCell(cell, 'center');
    },
  },
  {
    id: 'cell.edit',
    title: 'Edit Cell',
    group: 'Go',
    internal: true,
    run: () => {
      const cell = activeCell();
      if (!cell) return;
      // Folded code is opened first: there is nothing to put the caret in otherwise.
      if (cell.isCode && isSourceHidden(cell)) toggleSourceHidden(cell);
      focusEditor(cell, 'keep');
    },
  },
  { id: 'cell.commandMode', title: 'Leave Cell', group: 'Go', internal: true, run: () => enterCommandMode() },
  { id: 'cell.focusControl', title: 'Into the Cell’s Output', group: 'Go', internal: true, run: () => focusCellControl() },

  // View
  { id: 'view.palette', title: 'Command Palette…', group: 'View', keys: 'Mod-k', run: () => surfaces.togglePalette('commands'), internal: true },
  { id: 'view.focusMode', setting: true, title: 'Focus Mode', group: 'View', keys: 'F8', checked: () => prefs.focusMode, run: () => togglePref('focusMode') },
  { id: 'view.typewriter', setting: true, title: 'Typewriter Mode', group: 'View', keys: 'F9', checked: () => prefs.typewriter, run: () => togglePref('typewriter') },
  { id: 'view.lineNumbers', setting: true, title: 'Line Numbers', group: 'View', keys: 'l', checked: () => prefs.lineNumbers, run: () => togglePref('lineNumbers') },
  { id: 'view.wrap', setting: true, title: 'Wrap Long Lines', group: 'View', checked: () => prefs.wrapCode, run: () => togglePref('wrapCode') },
  {
    id: 'view.completionList', setting: true,
    title: 'Completion List While Typing',
    group: 'View',
    checked: () => prefs.completionList,
    run: () => togglePref('completionList'),
  },
  { id: 'view.appearance.system', setting: true, title: 'Appearance: Match System', group: 'View', checked: () => prefs.appearance === 'system', run: () => setPref('appearance', 'system') },
  { id: 'view.appearance.light', setting: true, title: 'Appearance: Light', group: 'View', checked: () => prefs.appearance === 'light', run: () => setPref('appearance', 'light') },
  { id: 'view.appearance.dark', setting: true, title: 'Appearance: Dark', group: 'View', checked: () => prefs.appearance === 'dark', run: () => setPref('appearance', 'dark') },
  { id: 'view.serif', setting: true, title: 'Serif Text', group: 'View', checked: () => prefs.theme === 'serif', run: () => setPref('theme', prefs.theme === 'serif' ? 'sumi' : 'serif') },
  { id: 'view.wide', setting: true, title: 'Wide Layout', group: 'View', checked: () => prefs.width === 'wide', run: () => setPref('width', prefs.width === 'wide' ? 'normal' : 'wide') },
  { id: 'view.zoomIn', title: 'Zoom In', group: 'View', keys: 'Mod-=', run: () => setPref('zoom', Math.min(1.6, Math.round((prefs.zoom + 0.1) * 10) / 10)) },
  { id: 'view.zoomOut', title: 'Zoom Out', group: 'View', keys: 'Mod--', run: () => setPref('zoom', Math.max(0.7, Math.round((prefs.zoom - 0.1) * 10) / 10)) },
  { id: 'view.zoomReset', title: 'Actual Size', group: 'View', keys: 'Mod-0', run: () => setPref('zoom', 1) },
  { id: 'file.autosave', setting: true, title: 'Save Automatically', group: 'File', checked: () => prefs.autosave, run: () => togglePref('autosave') },
  { id: 'app.settings', title: 'Settings…', group: 'View', keys: 'Mod-,', run: () => surfaces.togglePalette('settings') },
  { id: 'help.shortcuts', title: 'Keyboard Shortcuts', group: 'View', keys: 'h', run: () => surfaces.setShortcutsOpen(!surfaces.shortcutsOpen()) },
);

export { interruptKernel };
