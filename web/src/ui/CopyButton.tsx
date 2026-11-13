// The copy button that waits in the right-hand margin, level with what it copies: a cell's own
// text, or one piece of what it printed. It is not there until the pointer is on that piece
// (see "Things that wait for the pointer" in cells.css), and it answers where it stands — for
// a moment its glyph is a tick.

import { createSignal, onCleanup } from 'solid-js';
import { setNotice } from '../notebook/execution';
import { Check, Copy } from './icons';

/** How long the tick stays before the button is itself again. */
const DONE_MS = 1300;

export function CopyButton(props: { label: string; copy: () => void | Promise<unknown> }) {
  const [done, setDone] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));

  const run = async () => {
    try {
      await props.copy();
    } catch {
      setNotice({ kind: 'error', text: 'That could not be copied.' });
      return;
    }
    setDone(true);
    clearTimeout(timer);
    timer = setTimeout(() => setDone(false), DONE_MS);
  };

  return (
    // The rail runs the height of the piece, so that the button can stay in view (it is
    // sticky) while a long cell is scrolled past its top.
    <div class="copy-rail">
      <button
        class="copy-button hover-tool"
        classList={{ done: done() }}
        aria-label={props.label}
        tabindex={-1}
        onMouseDown={(event) => {
          // Copying is done from wherever you are: the caret stays where it is, and so does
          // the selection of cells.
          event.preventDefault();
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.stopPropagation();
          void run();
        }}
      >
        <Copy class="glyph-copy" />
        <Check class="glyph-done" />
      </button>
    </div>
  );
}
