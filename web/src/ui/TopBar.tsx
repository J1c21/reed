// The title bar. It blends into the page and holds two things: the notebook's name and its
// kernel. Both are there to be read; everything is done from the keyboard and the menu bar.

import { Show } from 'solid-js';
import { call } from '../host';
import { kernel, specLabel } from '../kernel/kernel';
import { runCommand, surfaces } from '../notebook/commands';
import { documentTitle } from '../notebook/document';
import { prefs } from '../state/prefs';
import { Zap } from './icons';

const STATUS_TEXT: Record<string, string> = {
  none: 'Not running',
  starting: 'Starting…',
  idle: 'Idle',
  busy: 'Busy',
  dead: 'Stopped',
};

export function TopBar() {
  return (
    <header
      class="topbar"
      onMouseDown={(event) => {
        // The bar is the window's handle wherever it is not a control.
        if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return;
        event.preventDefault();
        if (event.detail === 2) void call('window.zoom').catch(() => {});
        else void call('window.startDrag').catch(() => {});
      }}
    >
      {/* Unsaved changes are shown where macOS shows them: the dot in the close button. */}
      <div class="topbar-title">{documentTitle()}</div>

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
