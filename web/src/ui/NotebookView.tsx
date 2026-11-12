// The notebook column: one cell after another, with nothing in between. Cells are added,
// moved and removed from the keyboard (or the menus), so the page itself carries no controls —
// only a line in the left margin that says which cell you are in.

import { createEffect, createSignal, For, onCleanup, onMount, Show, untrack } from 'solid-js';
import { kernel, restartKernel } from '../kernel/kernel';
import { runCommand } from '../notebook/commands';
import { enterCommandMode, notebook, selectedCells } from '../notebook/store';
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

export function NotebookView() {
  let container!: HTMLDivElement;
  return (
    <div
      class="notebook"
      classList={{ editing: notebook.mode() === 'edit' }}
      ref={container}
      onMouseDown={(event) => {
        // A click on the empty page around the cells leaves edit mode.
        if (event.target === container) enterCommandMode();
      }}
    >
      <KernelBanner />
      <For each={notebook.cells()}>{(cell) => <CellView cell={cell} />}</For>
      <Marker />
    </div>
  );
}
