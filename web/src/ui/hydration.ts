// Progressive mounting.
//
// A cell's body (a CodeMirror editor, rendered markdown, outputs) is the expensive part of
// showing a notebook. When many cells appear at once — a notebook being opened — only the
// first screenful is built immediately. The rest show their source as plain text, laid out
// with the same metrics, and are filled in a few at a time while the app is idle, or at once
// when they come near the viewport. A notebook of any size opens as fast as a small one.

import { notebook, type Cell } from '../notebook/store';

const waiting = new Map<Cell, () => void>();
const cellFor = new WeakMap<Element, Cell>();

/** Cells mounted at once when many appear together: comfortably more than a screenful. */
const IMMEDIATE = 16;

let burstCount = 0;
let lastRequest = 0;
let scheduled = false;

// Work is sliced with a MessageChannel rather than timers: tasks posted this way run as soon
// as the page is free — rendering and input still get their turn in between — and, unlike
// timers, are not slowed to a crawl while the window is hidden.
const channel = new MessageChannel();
channel.port1.onmessage = () => pump();

function schedule() {
  if (scheduled) return;
  scheduled = true;
  channel.port2.postMessage(null);
}

const observer =
  typeof IntersectionObserver === 'undefined'
    ? null
    : new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const cell = cellFor.get(entry.target);
            if (cell) mountCell(cell);
          }
        },
        { rootMargin: '1200px 0px' },
      );

/**
 * Asks to mount a cell's body. Returns true when it should happen right now; otherwise
 * `mount` is called later.
 */
export function scheduleMount(cell: Cell, mount: () => void): boolean {
  const now = performance.now();
  if (now - lastRequest > 150) burstCount = 0;
  lastRequest = now;
  burstCount++;
  if (burstCount <= IMMEDIATE) return true;
  waiting.set(cell, mount);
  schedule();
  return false;
}

/** Lets a waiting cell mount as soon as it scrolls near the viewport. */
export function watchPlaceholder(cell: Cell, element: Element) {
  if (!observer || !waiting.has(cell)) return;
  cellFor.set(element, cell);
  observer.observe(element);
}

export function cancelMount(cell: Cell) {
  waiting.delete(cell);
  if (cell.el) observer?.unobserve(cell.el);
}

export function mountCell(cell: Cell) {
  const mount = waiting.get(cell);
  if (!mount) return;
  waiting.delete(cell);
  if (cell.el) observer?.unobserve(cell.el);
  mountKeepingScroll(cell, mount);
}

/** Mounts everything still waiting (before a search, for instance). */
export function mountAll() {
  for (const cell of [...waiting.keys()]) mountCell(cell);
}

/**
 * A mounted body is rarely the same height as its placeholder. Below the viewport that goes
 * unnoticed; above it the page would jump, so the scroll position is corrected.
 */
function mountKeepingScroll(cell: Cell, mount: () => void) {
  const element = cell.el;
  const scroller = element?.closest<HTMLElement>('.scroller');
  if (element && scroller && scroller.scrollTop > 0) {
    const above = element.getBoundingClientRect().bottom < scroller.getBoundingClientRect().top;
    if (above) {
      const before = element.offsetHeight;
      mount();
      const delta = element.offsetHeight - before;
      if (delta) scroller.scrollTop += delta;
      return;
    }
  }
  mount();
}

function pump() {
  scheduled = false;
  const start = performance.now();
  for (const cell of notebook.cells()) {
    if (waiting.size === 0) break;
    if (!waiting.has(cell)) continue;
    mountCell(cell);
    if (performance.now() - start > 9) break;
  }
  // Anything left belongs to cells that are still on the page.
  for (const cell of waiting.keys()) {
    if (!cell.el?.isConnected) waiting.delete(cell);
  }
  if (waiting.size > 0) schedule();
}
