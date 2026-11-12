// The open notebook: its cells, the selection, and every structural edit (with undo).
// One window edits one notebook, so the state lives in module-level signals.

import type { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { batch, createSignal } from 'solid-js';
import { createStore, reconcile, unwrap, type SetStoreFunction } from 'solid-js/store';
import { clamp } from '../util/misc';
import { glideIntoView, rearrange } from '../util/motion';
import {
  emptyNotebook,
  mergeStreams,
  newCell,
  newCellId,
  nextOutputKey,
  type CellData,
  type CellType,
  type NotebookData,
  type NotebookFormat,
  type Output,
} from './nbformat';

export interface InputRequest {
  prompt: string;
  password: boolean;
  submit: (value: string) => void;
}

export type RunState = 'idle' | 'queued' | 'running';

/** A cell's persisted fields plus what only matters while the notebook is open. */
export interface CellState extends CellData {
  run: RunState;
  runStarted: number;
  lastDuration: number | null;
  lastStatus: 'ok' | 'error' | 'aborted' | null;
  /** An upstream cell changed after this one ran. */
  stale: boolean;
  staleReason: string;
  /** The source as it was last executed in the current kernel session. */
  ranSource: string | null;
  /** Markdown/raw cells: showing the editor instead of the rendered result. */
  editing: boolean;
  /** The visible outputs belong to the previous run and are about to be replaced. */
  pendingClear: boolean;
  inputRequest: InputRequest | null;
}

export type FocusTarget = 'start' | 'end' | 'keep' | number;

/** Something that changes whenever an output's content does. */
function outputMark(output: Output): unknown {
  if (output.output_type === 'stream') return output.text;
  if (output.output_type === 'display_data' || output.output_type === 'execute_result') return output.data;
  return output;
}

export class Cell {
  readonly id: string;
  readonly state: CellState;
  readonly set: SetStoreFunction<CellState>;

  /** The mounted CodeMirror view, if any. */
  view: EditorView | null = null;
  /** CodeMirror state kept across unmounts so undo history survives moves and undo-delete. */
  savedEditorState: EditorState | null = null;
  el: HTMLElement | null = null;
  pendingFocus: FocusTarget | null = null;
  /** Mounts the cell's body now, if the view is still showing its placeholder. */
  mount: (() => void) | null = null;

  /**
   * Outputs exactly as they were read from disk, kept while what is shown is merely a
   * tidied-up view of them (see mergeStreams) so that saving does not rewrite them.
   */
  private loaded: { original: Output[]; shown: Output[]; marks: unknown[] } | null = null;

  constructor(data: CellData) {
    this.id = data.id;
    const shown = data.cell_type === 'code' ? mergeStreams(data.outputs) : data.outputs;
    if (shown !== data.outputs) {
      this.loaded = { original: data.outputs, shown: [...shown], marks: shown.map(outputMark) };
      data = { ...data, outputs: shown };
    }
    const [state, set] = createStore<CellState>({
      ...data,
      run: 'idle',
      runStarted: 0,
      lastDuration: null,
      lastStatus: null,
      stale: false,
      staleReason: '',
      ranSource: null,
      editing: false,
      pendingClear: false,
      inputRequest: null,
    });
    this.state = state;
    this.set = set;
  }

  get isCode(): boolean {
    return this.state.cell_type === 'code';
  }

  /** The persisted fields as plain data (outputs are shared, not copied). */
  snapshot(): CellData {
    const raw = unwrap(this.state);
    let outputs = raw.outputs;
    const loaded = this.loaded;
    if (loaded) {
      const untouched =
        outputs.length === loaded.shown.length &&
        outputs.every((output, i) => output === loaded.shown[i] && outputMark(output) === loaded.marks[i]);
      if (untouched) outputs = loaded.original;
      else this.loaded = null;
    }
    const data: CellData = {
      id: raw.id,
      cell_type: raw.cell_type,
      source: raw.source,
      metadata: raw.metadata,
      outputs,
      execution_count: raw.execution_count,
    };
    if (raw.attachments) data.attachments = raw.attachments;
    if (raw.extra) data.extra = raw.extra;
    return data;
  }
}

// ── State ───────────────────────────────────────────────────────────────────

const [cells, setCellsSignal] = createSignal<Cell[]>([]);
const [activeId, setActiveId] = createSignal<string | null>(null);
const [anchorId, setAnchorId] = createSignal<string | null>(null);
const [mode, setMode] = createSignal<'command' | 'edit'>('command');
const [path, setPath] = createSignal<string | null>(null);
const [dirty, setDirty] = createSignal(false);
const [revision, setRevision] = createSignal(0);
const [loadCount, setLoadCount] = createSignal(0);
const [meta, setMeta] = createStore<{
  metadata: Record<string, any>;
  nbformat_minor: number;
  extra: Record<string, unknown>;
  format: NotebookFormat;
}>({ metadata: {}, nbformat_minor: 5, extra: {}, format: { indent: ' ', trailingNewline: true } });

let index = new Map<string, Cell>();

function setCells(next: Cell[]) {
  index = new Map(next.map((cell) => [cell.id, cell]));
  setCellsSignal(next);
}

export const notebook = { cells, activeId, mode, path, dirty, revision, meta, loadCount };
export { setMode, setPath };

/** Records that the document differs from what is on disk. */
export function touch() {
  batch(() => {
    setDirty(true);
    setRevision((n) => n + 1);
  });
}

export function markSaved() {
  setDirty(false);
}

export function cellById(id: string | null | undefined): Cell | undefined {
  return id ? index.get(id) : undefined;
}

export function cellIndex(cell: Cell | string): number {
  const id = typeof cell === 'string' ? cell : cell.id;
  return cells().findIndex((candidate) => candidate.id === id);
}

export function activeCell(): Cell | undefined {
  return cellById(activeId());
}

/** The selected cells: the contiguous range between the anchor and the active cell. */
export function selectedCells(): Cell[] {
  const all = cells();
  const active = cellIndex(activeId() ?? '');
  if (active < 0) return [];
  const anchor = cellIndex(anchorId() ?? '');
  if (anchor < 0 || anchor === active) return [all[active]];
  return all.slice(Math.min(anchor, active), Math.max(anchor, active) + 1);
}

export function isSelected(cell: Cell): boolean {
  const active = activeId();
  if (cell.id === active) return true;
  const anchor = anchorId();
  if (!anchor || anchor === active) return false;
  const a = cellIndex(anchor);
  const b = cellIndex(active ?? '');
  const i = cellIndex(cell);
  return a >= 0 && b >= 0 && i >= Math.min(a, b) && i <= Math.max(a, b);
}

export function hasMultiSelection(): boolean {
  const anchor = anchorId();
  return !!anchor && anchor !== activeId() && index.has(anchor);
}

// ── Selection and focus ─────────────────────────────────────────────────────

export function select(id: string | null, options: { extend?: boolean; scroll?: boolean } = {}) {
  batch(() => {
    if (options.extend) {
      if (!anchorId()) setAnchorId(activeId());
    } else {
      setAnchorId(null);
    }
    setActiveId(id);
  });
  if (options.scroll !== false) scrollToCell(cellById(id));
}

let pendingScroll: { cell: Cell; block: 'nearest' | 'center' | 'start' } | null = null;

/** Brings a cell into view. Asked for several times in one go, only the last request counts. */
export function scrollToCell(cell: Cell | undefined, block: 'nearest' | 'center' | 'start' = 'nearest') {
  if (!cell) return;
  const scheduled = pendingScroll !== null;
  pendingScroll = { cell, block };
  if (scheduled) return;
  // Once whatever is going on has finished changing the page, and before it is painted.
  queueMicrotask(() => {
    const request = pendingScroll;
    pendingScroll = null;
    const element = request?.cell.el;
    const scroller = element?.closest<HTMLElement>('.scroller');
    if (request && element && scroller) glideIntoView(scroller, element, request.block);
  });
}

/** Moves the caret into a cell's editor (switching a rendered markdown cell to its source). */
export function focusEditor(cell: Cell, where: FocusTarget = 'keep') {
  const change = () =>
    batch(() => {
      select(cell.id, { scroll: false });
      stopEditingProse(cell);
      if (!cell.isCode && !cell.state.editing) cell.set('editing', true);
    });
  // Prose changes height between its source and its rendering; what follows glides.
  if ((!cell.isCode && !cell.state.editing) || proseBeingEdited(cell)) glideCells(change);
  else change();
  cell.pendingFocus = where;
  cell.mount?.();
  applyPendingFocus(cell);
}

/** Called by an editor once it is mounted, and by focusEditor when it already is. */
export function applyPendingFocus(cell: Cell) {
  const view = cell.view;
  const where = cell.pendingFocus;
  if (!view || where === null) return;
  cell.pendingFocus = null;
  if (where !== 'keep') {
    const length = view.state.doc.length;
    const position = where === 'start' ? 0 : where === 'end' ? length : clamp(where, 0, length);
    view.dispatch({ selection: { anchor: position }, scrollIntoView: true });
  }
  view.focus();
}

/**
 * Renders every markdown cell that is showing its source, except the one given. A cell can
 * be left that way without losing focus to another cell — while the palette or the find bar
 * has the keyboard — so this is done wherever the caret goes next.
 */
function stopEditingProse(except?: Cell) {
  for (const cell of cells()) {
    if (cell !== except && !cell.isCode && cell.state.editing) cell.set('editing', false);
  }
}

function proseBeingEdited(except?: Cell): boolean {
  return cells().some((cell) => cell !== except && !cell.isCode && cell.state.editing);
}

/** Leaves the editor: the cell stays selected and keys become commands. */
export function enterCommandMode() {
  const focused = document.activeElement as HTMLElement | null;
  if (focused && focused !== document.body) focused.blur();
  const change = () =>
    batch(() => {
      setMode('command');
      stopEditingProse();
    });
  if (proseBeingEdited()) glideCells(change);
  else change();
}

export function selectRelative(delta: number, options: { extend?: boolean } = {}): Cell | undefined {
  const all = cells();
  const current = cellIndex(activeId() ?? '');
  const next = all[clamp((current < 0 ? 0 : current) + delta, 0, all.length - 1)];
  if (next) select(next.id, options);
  return next;
}

export function selectAll() {
  const all = cells();
  if (!all.length) return;
  batch(() => {
    setAnchorId(all[0].id);
    setActiveId(all[all.length - 1].id);
  });
}

// ── Loading and saving ──────────────────────────────────────────────────────

export function loadNotebook(data: NotebookData, filePath: string | null) {
  undoStack.length = 0;
  redoStack.length = 0;
  const next = data.cells.map((cell) => new Cell(cell));
  if (next.length === 0) next.push(new Cell(newCell('code')));
  batch(() => {
    setMeta({
      metadata: data.metadata,
      nbformat_minor: data.nbformat_minor,
      extra: data.extra,
      format: data.format,
    });
    setCells(next);
    setPath(filePath);
    setActiveId(next[0].id);
    setAnchorId(null);
    setMode('command');
    setDirty(false);
    setRevision(0);
    setLoadCount((n) => n + 1);
  });
}

export function resetNotebook() {
  loadNotebook(emptyNotebook(), null);
}

export function snapshotNotebook(): NotebookData {
  const raw = unwrap(meta);
  return {
    cells: cells().map((cell) => cell.snapshot()),
    metadata: raw.metadata,
    nbformat: 4,
    nbformat_minor: raw.nbformat_minor,
    extra: raw.extra,
    format: raw.format,
  };
}

export function setNotebookMetadata(key: string, value: unknown) {
  setMeta('metadata', key, value as never);
  touch();
}

// ── Structural edits ────────────────────────────────────────────────────────
// Every edit replaces the cell list wholesale; undo simply restores the previous list.
// Cell objects are reused, so their editors (and text undo history) survive.

interface UndoEntry {
  before: Cell[];
  after: Cell[];
  activeBefore: string | null;
  activeAfter: string | null;
}

const undoStack: UndoEntry[] = [];
const redoStack: UndoEntry[] = [];

function commit(after: Cell[], activeAfter: string | null) {
  if (after.length === 0) {
    const blank = new Cell(newCell('code'));
    after = [blank];
    activeAfter = blank.id;
  }
  undoStack.push({ before: cells(), after, activeBefore: activeId(), activeAfter });
  if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0;
  arrange(after, activeAfter);
}

const cellElements = () => {
  const elements = new Map<string, HTMLElement>();
  for (const cell of cells()) if (cell.el) elements.set(cell.id, cell.el);
  return elements;
};

/**
 * Makes a change that resizes cells continuous: whatever ends up somewhere else on the page
 * glides there instead of jumping. For prose switching between source and rendering, a part
 * of a cell being folded away, output being cleared.
 */
export function glideCells(change: () => void) {
  const settle = rearrange(cellElements());
  change();
  settle(cellElements());
}

/**
 * Puts a new arrangement of cells in place. Cells that stay glide from where they were to
 * where they end up, so that inserting, removing and moving read as one continuous page.
 */
function arrange(next: Cell[], active: string | null) {
  const settle = rearrange(cellElements());
  batch(() => {
    setCells(next);
    setAnchorId(null);
    setActiveId(active);
    touch();
  });
  settle(cellElements());
}

export function canUndoStructure(): boolean {
  return undoStack.length > 0;
}

export function undoStructure(): boolean {
  const entry = undoStack.pop();
  if (!entry) return false;
  redoStack.push(entry);
  arrange(entry.before, entry.activeBefore);
  scrollToCell(cellById(entry.activeBefore));
  return true;
}

export function redoStructure(): boolean {
  const entry = redoStack.pop();
  if (!entry) return false;
  undoStack.push(entry);
  arrange(entry.after, entry.activeAfter);
  scrollToCell(cellById(entry.activeAfter));
  return true;
}

function usedIds(): Set<string> {
  return new Set(cells().map((cell) => cell.id));
}

export function insertCell(at: number, type: CellType, source = '', options: { edit?: boolean } = {}): Cell {
  const data = newCell(type, source);
  data.id = newCellId(usedIds());
  const cell = new Cell(data);
  const all = cells();
  const position = clamp(at, 0, all.length);
  commit([...all.slice(0, position), cell, ...all.slice(position)], cell.id);
  if (options.edit) focusEditor(cell, 'start');
  else scrollToCell(cell);
  return cell;
}

export function insertRelative(reference: Cell | undefined, where: 'above' | 'below', type: CellType, options: { edit?: boolean } = {}): Cell {
  const position = reference ? cellIndex(reference) + (where === 'below' ? 1 : 0) : cells().length;
  return insertCell(position, type, '', options);
}

export function deleteCells(targets: Cell[]) {
  if (!targets.length) return;
  const all = cells();
  const doomed = new Set(targets.map((cell) => cell.id));
  const lastIndex = Math.max(...targets.map((cell) => cellIndex(cell)));
  const after = all.filter((cell) => !doomed.has(cell.id));
  // Like Jupyter: land on the cell that followed the deleted ones, else the one before.
  const successor = all.slice(lastIndex + 1).find((cell) => !doomed.has(cell.id)) ?? after[after.length - 1];
  commit(after, successor?.id ?? null);
  scrollToCell(cellById(activeId()));
}

export function moveCells(targets: Cell[], delta: -1 | 1): boolean {
  if (!targets.length) return false;
  const all = cells();
  const indices = targets.map((cell) => cellIndex(cell)).sort((a, b) => a - b);
  const first = indices[0];
  const last = indices[indices.length - 1];
  if ((delta < 0 && first === 0) || (delta > 0 && last === all.length - 1)) return false;
  const after = [...all];
  const block = after.splice(first, last - first + 1);
  after.splice(first + delta, 0, ...block);
  const active = activeId();
  const anchor = anchorId();
  commit(after, active);
  if (anchor) setAnchorId(anchor);
  scrollToCell(cellById(active));
  return true;
}

function replaceCells(targets: Cell[], replacements: Cell[], activeAfter: string | null) {
  const all = cells();
  const first = cellIndex(targets[0]);
  const doomed = new Set(targets.map((cell) => cell.id));
  const after = all.filter((cell) => !doomed.has(cell.id));
  after.splice(first, 0, ...replacements);
  commit(after, activeAfter);
}

export function convertCells(targets: Cell[], type: CellType) {
  const changing = targets.filter((cell) => cell.state.cell_type !== type);
  if (!changing.length) return;
  const all = cells();
  const swap = new Map<string, Cell>();
  for (const cell of changing) {
    const data = cell.snapshot();
    const source = cell.view ? cell.view.state.doc.toString() : data.source;
    const next: CellData = {
      id: data.id,
      cell_type: type,
      source,
      metadata: { ...data.metadata },
      outputs: [],
      execution_count: null,
    };
    if (type !== 'code' && data.attachments) next.attachments = data.attachments;
    swap.set(cell.id, new Cell(next));
  }
  const active = activeId();
  const anchor = anchorId();
  commit(all.map((cell) => swap.get(cell.id) ?? cell), active);
  if (anchor) setAnchorId(anchor);
}

/** Splits a cell at a text offset. The second half keeps the outputs, as in JupyterLab. */
export function splitCell(cell: Cell, offset: number): Cell | undefined {
  const data = cell.snapshot();
  const source = cell.view ? cell.view.state.doc.toString() : data.source;
  const head = source.slice(0, offset).replace(/\n+$/, '');
  const tail = source.slice(offset).replace(/^\n+/, '');
  const first = new Cell({
    id: newCellId(usedIds()),
    cell_type: data.cell_type,
    source: head,
    metadata: {},
    outputs: [],
    execution_count: null,
  });
  const second = new Cell({ ...data, source: tail });
  replaceCells([cell], [first, second], second.id);
  focusEditor(second, 'start');
  return second;
}

export function mergeCells(targets: Cell[]): Cell | undefined {
  let group = targets;
  if (group.length === 1) {
    const next = cells()[cellIndex(group[0]) + 1];
    if (!next) return undefined;
    group = [group[0], next];
  }
  if (group.length < 2) return undefined;
  const head = group[0].snapshot();
  const sources = group.map((cell) => (cell.view ? cell.view.state.doc.toString() : cell.state.source));
  const attachments = Object.assign({}, ...group.map((cell) => cell.state.attachments ?? {}));
  const merged: CellData = {
    id: head.id,
    cell_type: head.cell_type,
    source: sources.join(head.cell_type === 'markdown' ? '\n\n' : '\n'),
    metadata: { ...head.metadata },
    outputs: [],
    execution_count: null,
  };
  if (head.cell_type !== 'code' && Object.keys(attachments).length) merged.attachments = attachments;
  const cell = new Cell(merged);
  replaceCells(group, [cell], cell.id);
  return cell;
}

// ── Clipboard ───────────────────────────────────────────────────────────────

let clipboard: CellData[] = [];

function cloneForClipboard(cell: Cell): CellData {
  const data = cell.snapshot();
  const copy = structuredClone({ ...data, outputs: [] as Output[] }) as CellData;
  copy.outputs = data.outputs.map((output) => structuredClone(output));
  if (cell.view) copy.source = cell.view.state.doc.toString();
  return copy;
}

export function copyCells(targets: Cell[]): string {
  clipboard = targets.map(cloneForClipboard);
  return clipboard.map((cell) => cell.source).join('\n\n');
}

export function hasCellClipboard(): boolean {
  return clipboard.length > 0;
}

export function pasteCells(reference: Cell | undefined, where: 'above' | 'below'): Cell[] {
  if (!clipboard.length) return [];
  const used = usedIds();
  const fresh = clipboard.map((data) => {
    const copy = structuredClone(data) as CellData;
    copy.id = newCellId(used);
    copy.outputs = copy.outputs.map((output) => ({ ...output, _key: nextOutputKey(), _displayId: undefined }));
    return new Cell(copy);
  });
  const all = cells();
  const position = reference ? cellIndex(reference) + (where === 'below' ? 1 : 0) : all.length;
  commit([...all.slice(0, position), ...fresh, ...all.slice(position)], fresh[fresh.length - 1].id);
  scrollToCell(fresh[fresh.length - 1]);
  return fresh;
}

export function duplicateCells(targets: Cell[]): Cell[] {
  const previous = clipboard;
  copyCells(targets);
  const pasted = pasteCells(targets[targets.length - 1], 'below');
  clipboard = previous;
  return pasted;
}

// ── Content edits ───────────────────────────────────────────────────────────

export function setSource(cell: Cell, source: string) {
  if (cell.state.source === source) return;
  cell.set('source', source);
  touch();
}

export function clearOutputs(targets: Cell[]) {
  let changed = false;
  glideCells(() =>
    batch(() => {
      for (const cell of targets) {
        if (!cell.isCode) continue;
        if (cell.state.outputs.length || cell.state.execution_count !== null) changed = true;
        cell.set({ outputs: [], execution_count: null, pendingClear: false });
      }
    }),
  );
  if (changed) touch();
}

export function setCellMetadata(cell: Cell, update: (metadata: Record<string, any>) => Record<string, any>) {
  // Replaced, not merged: a store merges objects by default, and a key the update removed
  // (a "hidden" flag being cleared) would then quietly stay.
  cell.set('metadata', reconcile(update({ ...unwrap(cell.state.metadata) })));
  touch();
}

export function isSourceHidden(cell: Cell): boolean {
  return cell.state.metadata?.jupyter?.source_hidden === true;
}

export function isOutputHidden(cell: Cell): boolean {
  return cell.state.metadata?.jupyter?.outputs_hidden === true || cell.state.metadata?.collapsed === true;
}

export function toggleSourceHidden(cell: Cell) {
  const hidden = !isSourceHidden(cell);
  glideCells(() =>
    setCellMetadata(cell, (metadata) => {
      const jupyter = { ...(metadata.jupyter ?? {}) };
      if (hidden) jupyter.source_hidden = true;
      else delete jupyter.source_hidden;
      if (Object.keys(jupyter).length) metadata.jupyter = jupyter;
      else delete metadata.jupyter;
      return metadata;
    }),
  );
}

export function toggleOutputHidden(cell: Cell) {
  const hidden = !isOutputHidden(cell);
  glideCells(() =>
    setCellMetadata(cell, (metadata) => {
      const jupyter = { ...(metadata.jupyter ?? {}) };
      if (hidden) jupyter.outputs_hidden = true;
      else delete jupyter.outputs_hidden;
      delete metadata.collapsed;
      if (Object.keys(jupyter).length) metadata.jupyter = jupyter;
      else delete metadata.jupyter;
      return metadata;
    }),
  );
}
