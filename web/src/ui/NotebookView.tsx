// The notebook column: one cell after another, with nothing in between. Cells are added,
// moved and removed from the keyboard (or the menus), and the page at rest carries no controls —
// only a line in the left margin that says which cell you are in. (What the pointer can call
// up as it hovers — a copy button, a line that adds a cell — belongs to each cell: see CellView.)

import { createEffect, createSignal, For, onCleanup, onMount, Show, untrack } from 'solid-js';
import { kernel, restartKernel } from '../kernel/kernel';
import { runCommand } from '../notebook/commands';
import { enterCommandMode, hasMultiSelection, notebook, select, selectedCells, type Cell } from '../notebook/store';
import { GLIDE_MS, still } from '../util/motion';
import { CellView } from './CellView';

function KernelBanner() {
  return (
    <Show when={kernel.status() === 'dead' && kernel.failure()}>
      {(message) => {
        const [summary, ...detail] = message().split('\n\n');
        return (
          <div class="banner">
            <div class="grow">
              <strong>{summary}</strong>
              <Show when={detail.length}>
                <pre>{detail.join('\n\n')}</pre>
              </Show>
            </div>
            <button class="text-button" onClick={() => runCommand('kernel.pick')}>
              Choose Kernel…
            </button>
            <button class="text-button primary" onClick={() => void restartKernel().catch(() => {})}>
              Restart
            </button>
          </div>
        );
      }}
    </Show>
  );
}

/** How far the line stops short of the top and bottom of the cells it marks. */
const INSET = 3;

/**
 * The line in the margin. There is one of it, and it travels: when the selection moves it
 * glides to the new cell (stretching over several when several are selected); when the page
 * changes shape under it — output arriving, text wrapping — it simply stays where its cell is.
 */
function Marker() {
  let line!: HTMLDivElement;
  const [box, setBox] = createSignal<{ top: number; height: number } | null>(null);
  const [gliding, setGliding] = createSignal(false);
  let settle: ReturnType<typeof setTimeout> | undefined;

  const measure = () => {
    const chosen = selectedCells();
    const first = chosen[0]?.el;
    const last = chosen[chosen.length - 1]?.el;
    if (!first || !last) return null;
    const top = first.offsetTop + INSET;
    return { top, height: Math.max(INSET * 2, last.offsetTop + last.offsetHeight - INSET - top) };
  };

  // The selection moved, or the cells did.
  createEffect(() => {
    const next = measure();
    const travelling = untrack(box) !== null && next !== null && !still();
    setGliding(travelling);
    setBox(next);
    clearTimeout(settle);
    if (travelling) settle = setTimeout(() => setGliding(false), GLIDE_MS + 80);
  });

  // The page changed shape.
  onMount(() => {
    const observer = new ResizeObserver(() => setBox(measure()));
    observer.observe(line.parentElement!);
    onCleanup(() => {
      observer.disconnect();
      clearTimeout(settle);
    });
  });

  return (
    <div
      class="cell-marker"
      classList={{ gliding: gliding() }}
      ref={line}
      style={box() ? { top: `${box()!.top}px`, height: `${box()!.height}px` } : { display: 'none' }}
    />
  );
}

/** The cell level with a height in the window, or failing that the nearest one above or below. */
function cellBeside(clientY: number): Cell | undefined {
  let nearest: Cell | undefined;
  let distance = Infinity;
  for (const cell of notebook.cells()) {
    const box = cell.el?.getBoundingClientRect();
    if (!box) continue;
    const away = clientY < box.top ? box.top - clientY : clientY > box.bottom ? clientY - box.bottom : 0;
    if (away < distance) {
      nearest = cell;
      distance = away;
    }
    if (away === 0) break;
  }
  return nearest;
}

/**
 * A press on the bare page — the margins either side of the cells, the gaps between them, the
 * space below the last — selects the cell it is level with, and keys become commands. (Left to
 * itself the engine looks for the nearest place a caret could go, which is a line of some
 * editor, and puts it there.)
 */
export function pressOnPage(event: MouseEvent) {
  if (event.button !== 0) return;
  const page = event.currentTarget as HTMLElement;
  const target = event.target as HTMLElement;
  if (target !== page && !target.classList.contains('notebook')) return;
  // A scroll bar that takes up room is not the page.
  if (event.clientX >= page.getBoundingClientRect().left + page.clientWidth) return;
  event.preventDefault();
  // Found before anything changes: leaving a cell of prose re-renders it, and cells shift.
  const cell = cellBeside(event.clientY);
  enterCommandMode();
  // (A click on nothing lets go of whatever text was selected, as it would have.)
  window.getSelection()?.removeAllRanges();
  if (!cell) return;
  if (event.shiftKey) select(cell.id, { extend: true, scroll: false });
  else if (notebook.activeId() !== cell.id || hasMultiSelection()) select(cell.id, { scroll: false });
}

export function NotebookView() {
  return (
    <div class="notebook" classList={{ editing: notebook.mode() === 'edit' }}>
      <KernelBanner />
      <For each={notebook.cells()}>{(cell) => <CellView cell={cell} />}</For>
      <Marker />
    </div>
  );
}
