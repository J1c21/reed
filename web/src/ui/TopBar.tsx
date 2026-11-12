// The title bar. It blends into the page and holds two things: the notebook's name and its
// kernel. The name can be changed where it stands; clicking the kernel lists the others.
// Everything else is done from the keyboard and the menu bar.

import { createEffect, createSignal, on, Show } from 'solid-js';
import { call } from '../host';
import { kernel, specLabel } from '../kernel/kernel';
import { runCommand, surfaces } from '../notebook/commands';
import { documentTitle, renameNotebook } from '../notebook/document';
import { enterCommandMode, notebook } from '../notebook/store';
import { prefs } from '../state/prefs';
import { Zap } from './icons';

const STATUS_TEXT: Record<string, string> = {
  none: 'Not running',
  starting: 'Starting…',
  idle: 'Idle',
  busy: 'Busy',
  dead: 'Stopped',
};

/** How far the pointer may wander during a click before it is a drag of the window instead. */
const DRAG_SLOP = 4;

/** The place in a field's text nearest to a point across the window, measured as the field draws it. */
function offsetAt(field: HTMLInputElement, clientX: number): number {
  const text = field.value;
  const pen = document.createElement('canvas').getContext('2d');
  if (!pen || !text) return text.length;
  const style = getComputedStyle(field);
  pen.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  const width = (to: number) => pen.measureText(text.slice(0, to)).width;
  const box = field.getBoundingClientRect();
  const whole = width(text.length);
  // The name is centred in the field; one too long for it starts at the left.
  const x = clientX - (whole < box.width ? box.left + (box.width - whole) / 2 : box.left);
  let nearest = 0;
  let distance = Math.abs(x);
  let to = 0;
  for (const character of text) {
    to += character.length;
    const away = Math.abs(width(to) - x);
    if (away < distance) {
      distance = away;
      nearest = to;
    }
  }
  return nearest;
}

/**
 * The notebook's name. It is text that can be changed where it stands: click it and the caret
 * is in it, at the letter you clicked; Return takes the new name, Escape leaves the old one,
 * and so does clicking anywhere else, as in the Finder. Nothing is drawn around it — it is the
 * same words in the same place, at rest or being typed in. Pressed and dragged it moves the
 * window, like the rest of the bar.
 */
function Title() {
  let field!: HTMLInputElement;
  const editing = surfaces.renaming;
  // What is typed lives in the field itself — an input method may be composing there — and
  // is only mirrored here: a hidden copy of the text gives the field its width, so the name
  // stays centred as it changes.
  const [held, setHeld] = createSignal(documentTitle());
  // The field borrows the keyboard — usually from a cell, mid-sentence — and gives it back.
  let lender: HTMLElement | null = null;
  let busy = false;
  /** Where across the window a click asked for the caret; unset when the keyboard asked. */
  let clickedAt: number | null = null;

  const close = () => surfaces.setRenaming(false);

  const commit = async (leaving: boolean) => {
    if (busy) return;
    busy = true;
    const done = await renameNotebook(field.value);
    busy = false;
    if (!editing()) return;
    if (done || leaving) {
      close();
    } else {
      // A name that cannot be used was said why; the field stays for another try.
      field.focus();
      field.select();
    }
  };

  // At rest it shows the notebook's name, whatever that becomes.
  createEffect(() => {
    const name = documentTitle();
    if (editing()) return;
    field.value = name;
    setHeld(name);
  });

  createEffect(
    on(
      editing,
      (now) => {
        if (now) {
          lender = document.activeElement as HTMLElement | null;
          field.readOnly = false;
          field.focus({ preventScroll: true });
          // Asked for by a click, the caret goes where the click was; asked for from the
          // keyboard, the whole name is selected, ready to be typed over.
          if (clickedAt === null) {
            field.select();
          } else {
            const at = offsetAt(field, clickedAt);
            field.setSelectionRange(at, at);
          }
          clickedAt = null;
          return;
        }
        const had = document.activeElement === field;
        const from = lender;
        lender = null;
        field.readOnly = true;
        field.scrollLeft = 0;
        if (!had) return; // left by a click elsewhere: the keyboard is already where it went
        if (from?.isConnected && from !== document.body) {
          from.focus({ preventScroll: true });
        } else {
          field.blur();
          // Nothing to return to: the notebook must not be left believing a cell is being typed in.
          queueMicrotask(() => {
            if (document.activeElement === document.body && notebook.mode() === 'edit') enterCommandMode();
          });
        }
      },
      { defer: true },
    ),
  );

  // Another notebook arriving in this window takes the field back to rest.
  createEffect(on(notebook.path, close, { defer: true }));

  const press = (event: MouseEvent) => {
    if (event.button !== 0) return;
    // The bar underneath would start dragging the window at once; it does not hear of this.
    event.stopPropagation();
    if (editing()) {
      // In the field the mouse does what it does in any text; just beside it, nothing.
      if (event.target !== field) event.preventDefault();
      return;
    }
    // Whoever has the keyboard keeps it until the name really is being changed.
    event.preventDefault();
    const from = { x: event.screenX, y: event.screenY };
    const done = () => {
      window.removeEventListener('mousemove', move, true);
      window.removeEventListener('mouseup', release, true);
    };
    const move = (moved: MouseEvent) => {
      if (Math.hypot(moved.screenX - from.x, moved.screenY - from.y) < DRAG_SLOP) return;
      done();
      void call('window.startDrag').catch(() => {});
    };
    const release = (released: MouseEvent) => {
      done();
      clickedAt = released.clientX;
      runCommand('file.rename');
      clickedAt = null;
    };
    window.addEventListener('mousemove', move, true);
    window.addEventListener('mouseup', release, true);
  };

  return (
    <div
      class="topbar-title"
      classList={{ editing: editing() }}
      data-value={held()}
      onMouseDown={press}
    >
      <input
        ref={field}
        readOnly
        tabindex={-1}
        size={1}
        spellcheck={false}
        autocomplete="off"
        autocorrect="off"
        autocapitalize="off"
        aria-label="Notebook name"
        onInput={() => setHeld(field.value)}
        onKeyDown={(event) => {
          // While an input method is composing, Return and Escape are its own.
          if (!editing() || event.isComposing || event.keyCode === 229) return;
          if (event.key === 'Enter') {
            event.preventDefault();
            event.stopPropagation();
            void commit(false);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            close();
          }
        }}
        onBlur={() => {
          // The window going to the background is not the field being left.
          if (!document.hasFocus() || !editing()) return;
          // Left for something else: the name is taken as it stands.
          void commit(true);
          setTimeout(() => {
            if (document.hasFocus() && document.activeElement === document.body && notebook.mode() === 'edit') enterCommandMode();
          }, 0);
        }}
      />
    </div>
  );
}

export function TopBar() {
  return (
    <header
      class="topbar"
      onMouseDown={(event) => {
        // The bar is the window's handle wherever it is not a control.
        if (event.button !== 0 || (event.target as HTMLElement).closest('button, input')) return;
        event.preventDefault();
        if (event.detail === 2) void call('window.zoom').catch(() => {});
        else void call('window.startDrag').catch(() => {});
      }}
    >
      {/* Unsaved changes are shown where macOS shows them: the dot in the close button. */}
      <Title />

      <div class="topbar-spacer" />

      {/* Reactive execution changes what running a cell does, so it is flagged while it is on. */}
      <Show when={prefs.reactive}>
        <button
          class="icon-button reactive-flag"
          title="Reactive execution is on"
          tabindex={-1}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => runCommand('view.reactive')}
        >
          <Zap />
        </button>
      </Show>

      {/* The kernel's name and state. Clicking it is the same as ⌥⌘K: the list of kernels. */}
      <button
        class="kernel-pill"
        classList={{ open: surfaces.palette() === 'kernels' }}
        title={`Kernel: ${STATUS_TEXT[kernel.shownStatus()]} (⌥⌘K)`}
        tabindex={-1}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => runCommand('kernel.pick')}
      >
        <span class="status-dot" data-status={kernel.shownStatus()} />
        <span class="label">{specLabel(kernel.spec())}</span>
      </button>
    </header>
  );
}
