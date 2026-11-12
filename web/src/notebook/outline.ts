// The notebook's headings: what "Go to Heading" lists.

import { createMemo, createRoot } from 'solid-js';
import { extractHeadings } from '../render/markdown';
import { glideIntoView } from '../util/motion';
import { cellById, enterCommandMode, notebook, select } from './store';

export interface OutlineEntry {
  cellId: string;
  level: number;
  text: string;
  slug: string;
}

const memos = createRoot(() => {
  const entries = createMemo<OutlineEntry[]>(() => {
    const out: OutlineEntry[] = [];
    for (const cell of notebook.cells()) {
      if (cell.state.cell_type !== 'markdown') continue;
      for (const heading of extractHeadings(cell.state.source)) {
        out.push({ cellId: cell.id, level: heading.level, text: heading.text, slug: heading.slug });
      }
    }
    return out;
  });
  // The section the selection is in: the last heading at or above the active cell.
  const current = createMemo(() => {
    const order = new Map(notebook.cells().map((cell, i) => [cell.id, i]));
    const active = order.get(notebook.activeId() ?? '') ?? -1;
    let found = -1;
    entries().forEach((entry, i) => {
      if ((order.get(entry.cellId) ?? Infinity) <= active) found = i;
    });
    return found;
  });
  /** The shallowest level in use, so a notebook that starts at "##" is not indented. */
  const topLevel = createMemo(() => Math.min(...entries().map((entry) => entry.level), 6));
  return { entries, current, topLevel };
});

export const outline = memos;

/** Selects the heading's cell and brings the heading to the top of the window. */
export function jumpToHeading(entry: OutlineEntry) {
  const cell = cellById(entry.cellId);
  if (!cell) return;
  enterCommandMode();
  select(cell.id, { scroll: false });
  cell.mount?.();
  const target = cell.el?.querySelector(`#${CSS.escape(entry.slug)}`) ?? cell.el;
  const scroller = target?.closest<HTMLElement>('.scroller');
  if (target && scroller) glideIntoView(scroller, target, 'start');
}
