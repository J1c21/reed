// The window: sidebar, title bar, notebook, and the floating surfaces above them.

import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from 'solid-js';
import { call, hostKind, on as onHost } from '../host';
import { allCommands, runCommand, surfaces } from '../notebook/commands';
import { autosave, checkForExternalChanges, documentTitle } from '../notebook/document';
import { execution, setNotice } from '../notebook/execution';
import { displayKeys, installKeymap, keyName, PALETTE_COMMANDS } from '../notebook/keymap';
import { notebook, scrollToCell } from '../notebook/store';
import { prefs } from '../state/prefs';
import { debounce } from '../util/misc';
import { FindBar } from './FindBar';
import { NotebookView } from './NotebookView';
import { Palette } from './Palette';
import { Preview } from './Preview';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';

function Toast() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  createEffect(() => {
    const current = execution.notice();
    clearTimeout(timer);
    if (current) timer = setTimeout(() => setNotice(null), current.kind === 'error' ? 9000 : 3800);
  });
  onCleanup(() => clearTimeout(timer));
  return (
    <Show when={execution.notice()}>
      {(current) => (
        <div class="toast" classList={{ error: current().kind === 'error' }} onClick={() => setNotice(null)}>
          <span class="toast-text">{current().text}</span>
        </div>
      )}
    </Show>
  );
}

/** Whole seconds, as a clock would say them: "8s", "2m 05s", "1h 12m". */
function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/**
 * A long-running cell that has scrolled out of sight is easy to forget. Then — and only then —
 * a small chip says what is happening and which key stops it; clicking it leads back to the cell.
 */
function RunningChip() {
  const [now, setNow] = createSignal(Date.now());
  const [offscreen, setOffscreen] = createSignal(false);
  const cell = () => execution.runningCell();
  const check = () => {
    setNow(Date.now());
    const rect = cell()?.el?.getBoundingClientRect();
    setOffscreen(!!rect && (rect.bottom < 48 || rect.top > window.innerHeight));
  };
  const timer = setInterval(check, 500);
  onCleanup(() => clearInterval(timer));
  const queued = () => Math.max(0, execution.busyCount() - 1);
  const shown = () => {
    const running = cell();
    return running && offscreen() && now() - running.state.runStarted > 1500 ? running : undefined;
  };
  return (
    <Show when={shown()}>
      {(running) => (
        <div class="running-chip" onClick={() => scrollToCell(running(), 'center')} title="Show the running cell">
          <span class="spinner" />
          <span>
            Running {elapsed(now() - running().state.runStarted)}
            <Show when={queued() > 0}> · {queued()} queued</Show>
          </span>
          <span class="keys" title="Interrupt">
            <kbd>⌘</kbd>
            <kbd>.</kbd>
          </span>
        </div>
      )}
    </Show>
  );
}

/** One line of the sheet: the keys (alternatives side by side) and what they do. */
type SheetRow = [keys: string | string[], label: string];

/**
 * The whole keyboard on one page, arranged by where you are when you press the key. Keys are
 * in the keymap's notation; "=" introduces key caps to show as written.
 */
const SHEET: { title: string; rows: SheetRow[] }[] = [
  {
    title: 'Anywhere',
    rows: [
      ['Mod-k', 'Command palette: everything, by name'],
      ['Mod-j', 'Go to a heading'],
      ['Mod-Shift-o', 'Open a notebook'],
      ['Alt-Mod-k', 'Choose the kernel'],
      ['Mod-f', 'Find'],
      [['Mod-g', 'Mod-Shift-g'], 'Next / previous match'],
      ['Mod-s', 'Save'],
      ['Mod-Shift-Enter', 'Run all cells'],
      ['Mod-.', 'Interrupt the kernel'],
      [['Ctrl-Shift-ArrowUp', 'Ctrl-Shift-ArrowDown'], 'Move the cell up / down'],
      [['Mod-Shift-m', 'Mod-Shift-y'], 'Make the cell text / code'],
      ['Ctrl-Shift--', 'Split the cell at the caret'],
      ['Mod-Shift-l', 'Sidebar'],
      ['=⌃ ⌘ 1–3', 'Outline, files, variables'],
      [['F8', 'F9'], 'Focus mode / typewriter mode'],
      ['F1', 'This sheet'],
    ],
  },
  {
    title: 'While typing in a cell',
    rows: [
      ['Shift-Enter', 'Run, and on to the next cell'],
      ['Mod-Enter', 'Run, and stay'],
      ['Alt-Enter', 'Run, and add a cell below'],
      ['Escape', 'Leave the cell: keys become commands'],
      [['ArrowUp', 'ArrowDown'], 'Past the first / last line: the next cell'],
      [['Backspace', 'Backspace'], 'In an empty cell, twice: remove it'],
      [['Tab', 'Alt-Escape'], 'Take the faint suggestion / list them all'],
      ['Shift-Tab', 'Show documentation'],
      ['Mod-/', 'Comment out'],
    ],
  },
  {
    title: 'With a cell selected',
    rows: [
      ['Enter', 'Type in it'],
      [['j', 'k'], 'Next / previous cell'],
      [['Shift-j', 'Shift-k'], 'Select more cells'],
      [['Space', 'Shift-Space'], 'A page down / up'],
      [['a', 'b'], 'New cell above / below'],
      [['m', 'y', 'r'], 'Make it text / code / raw'],
      [['x', 'c', 'v'], 'Cut / copy / paste'],
      ['Shift-c', 'Copy what the cell printed or drew'],
      ['d d', 'Delete'],
      [['z', 'Shift-z'], 'Undo / redo that'],
      ['Shift-m', 'Merge with the cell below'],
      [['o', 'Shift-o'], 'Hide the output / the code'],
      ['Tab', 'Into the output: figures, widgets, links'],
      ['l', 'Line numbers'],
      [['i i', '0 0'], 'Interrupt / restart the kernel'],
      [['g', 'p'], 'Go to a heading / command palette'],
      [['h', '=?'], 'This sheet'],
    ],
  },
  {
    title: 'In a list: palette, sidebar, menu',
    rows: [
      [['ArrowUp', 'ArrowDown'], 'Move'],
      ['Enter', 'Choose'],
      ['Escape', 'Back to the notebook'],
      [['ArrowLeft', 'ArrowRight'], 'Sidebar: close / open a folder'],
      ['Tab', 'Sidebar: the next pane'],
      ['Backspace', 'Palette, empty field: back to commands'],
      [['Enter', 'Mod-c'], 'On a figure: look closer / copy it'],
    ],
  },
];

const keyCaps = (keys: string) => (keys.startsWith('=') ? keys.slice(1).split(' ') : displayKeys(keys));

function Shortcuts() {
  let sheet!: HTMLDivElement;
  const close = () => surfaces.setShortcutsOpen(false);
  onMount(() => {
    // The sheet has the keyboard while it is up: the keys that opened it close it, the
    // arrows and the space bar scroll it, and nothing reaches the notebook underneath.
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey) return;
      event.preventDefault();
      event.stopPropagation();
      const key = event.key;
      const name = keyName(event);
      if (key === 'Escape' || key === 'Enter' || key === 'F1' || name === 'h' || name === 'Shift-/') close();
      else if (key === 'ArrowDown' || key === 'j') sheet.scrollBy({ top: 56 });
      else if (key === 'ArrowUp' || key === 'k') sheet.scrollBy({ top: -56 });
      else if (key === ' ' || key === 'PageDown' || key === 'PageUp') {
        sheet.scrollBy({ top: (event.shiftKey || key === 'PageUp' ? -1 : 1) * (sheet.clientHeight - 60) });
      }
    };
    window.addEventListener('keydown', onKey, true);
    onCleanup(() => window.removeEventListener('keydown', onKey, true));
  });
  return (
    <div class="palette-layer" style={{ 'padding-top': '5vh' }} onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <div class="palette shortcuts" ref={sheet}>
        <div class="columns">
          <For each={SHEET}>
            {(section) => (
              <section>
                <h3>{section.title}</h3>
                <For each={section.rows}>
                  {([keys, label]) => (
                    <div class="row">
                      <span>{label}</span>
                      <span class="keys">
                        <For each={Array.isArray(keys) ? keys : [keys]}>
                          {(chord) => (
                            <span class="chord">
                              <For each={keyCaps(chord)}>{(cap) => <kbd>{cap}</kbd>}</For>
                            </span>
                          )}
                        </For>
                      </span>
                    </div>
                  )}
                </For>
              </section>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}

export function App() {
  const [windowActive, setWindowActive] = createSignal(document.hasFocus());
  const [fullscreen, setFullscreen] = createSignal(false);

  // Immersion: while text is going into an editor the chrome fades away, and it returns the
  // moment the pointer travels. (Layout shifting under a resting pointer also fires
  // mousemove, so only real movement counts.)
  const [typing, setTyping] = createSignal(false);
  let pointerAtRest: { x: number; y: number } | null = null;
  const inEditor = (target: EventTarget | null) => target instanceof HTMLElement && !!target.closest('.cm-content');
  const startTyping = () => {
    pointerAtRest = null;
    setTyping(true);
  };
  const stopTyping = () => setTyping(false);
  const onTextInput = (event: Event) => {
    if (inEditor(event.target)) startTyping();
  };
  const onTypingKey = (event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || !inEditor(event.target)) return;
    if (event.key === 'Enter' || event.key === 'Backspace' || event.key === 'Delete') startTyping();
  };
  const onPointerTravel = (event: MouseEvent) => {
    if (!typing()) return;
    if (!pointerAtRest) {
      pointerAtRest = { x: event.screenX, y: event.screenY };
    } else if (Math.hypot(event.screenX - pointerAtRest.x, event.screenY - pointerAtRest.y) > 6) {
      stopTyping();
    }
  };
  createEffect(() => {
    if (notebook.mode() !== 'edit') stopTyping();
  });

  const root = document.documentElement;
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
  const [systemIsDark, setSystemIsDark] = createSignal(systemDark.matches);
  systemDark.addEventListener('change', (event) => setSystemIsDark(event.matches));

  // Appearance, typeface and width live on <html> so every stylesheet can key off them.
  createEffect(() => {
    const dark = prefs.appearance === 'dark' || (prefs.appearance === 'system' && systemIsDark());
    root.dataset.appearance = dark ? 'dark' : 'light';
  });
  createEffect(() => {
    void call('window.setAppearance', { appearance: prefs.appearance }).catch(() => {});
  });
  createEffect(() => (root.dataset.theme = prefs.theme));
  createEffect(() => (root.dataset.width = prefs.width));
  createEffect(() => {
    void call('window.setZoom', { zoom: prefs.zoom }).catch(() => {});
  });

  // Keep the native window (title, proxy icon, close-button dot) in step with the document.
  // A notebook with a file saves itself; one that has never been saved has nowhere to go yet.
  const savesItself = () => prefs.autosave && !!notebook.path();
  createEffect(() => {
    const state = { path: notebook.path(), dirty: notebook.dirty(), title: documentTitle(), autosave: savesItself() };
    document.title = state.title;
    void call('doc.setState', state).catch(() => {});
  });

  // Native menus show a tick or grey out according to each command's state.
  const pushMenuState = debounce(() => {
    const states: Record<string, { checked?: boolean; enabled?: boolean }> = {};
    for (const command of allCommands()) {
      if (!command.checked && !command.enabled) continue;
      states[command.id] = {
        ...(command.checked ? { checked: command.checked() } : {}),
        ...(command.enabled ? { enabled: command.enabled() } : {}),
      };
    }
    void call('menu.setState', { states }).catch(() => {});
  }, 60);
  createEffect(() => {
    // Reading every predicate here subscribes this effect to whatever they depend on.
    for (const command of allCommands()) {
      command.checked?.();
      command.enabled?.();
    }
    pushMenuState();
  });

  // Autosave: a moment after the last change, whenever the window is left, and — because a
  // long run keeps changing the notebook and would hold the first of these off — every so
  // often regardless.
  const saveQuietly = () => {
    if (savesItself() && notebook.dirty()) void autosave();
  };
  const saveSoon = debounce(saveQuietly, 1200);
  createEffect(on(() => [notebook.revision(), savesItself()], () => saveSoon(), { defer: true }));
  const heartbeat = setInterval(saveQuietly, 20_000);
  onCleanup(() => clearInterval(heartbeat));

  onMount(() => {
    const removeKeymap = installKeymap();
    const onFocus = () => {
      setWindowActive(true);
      void checkForExternalChanges();
    };
    const onBlur = () => {
      setWindowActive(false);
      saveSoon.cancel();
      saveQuietly();
    };
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    window.addEventListener('blur', stopTyping);
    window.addEventListener('input', onTextInput, true);
    window.addEventListener('keydown', onTypingKey, true);
    window.addEventListener('mousemove', onPointerTravel);
    window.addEventListener('mousedown', stopTyping, true);
    window.addEventListener('wheel', stopTyping, { passive: true });
    const unsubscribe = [
      onHost('menu.command', ({ id }: { id: string }) => {
        // Chosen from the menu bar while the palette or the shortcut sheet is up: they step
        // aside rather than have the command act behind them.
        if (surfaces.shortcutsOpen() && id !== 'help.shortcuts') surfaces.setShortcutsOpen(false);
        if (surfaces.palette() !== null && !PALETTE_COMMANDS.has(id)) surfaces.setPalette(null);
        runCommand(id);
      }),
      onHost('window.fullscreen', ({ on: value }: { on: boolean }) => setFullscreen(value)),
      onHost('host.disconnected', () => setNotice({ kind: 'error', text: 'Lost the connection to the development host.' })),
    ];
    onCleanup(() => {
      removeKeymap();
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('blur', stopTyping);
      window.removeEventListener('input', onTextInput, true);
      window.removeEventListener('keydown', onTypingKey, true);
      window.removeEventListener('mousemove', onPointerTravel);
      window.removeEventListener('mousedown', stopTyping, true);
      window.removeEventListener('wheel', stopTyping);
      unsubscribe.forEach((stop) => stop());
    });
  });

  // Files dropped on the window open as notebooks (the app handles this natively).
  const onDrop = (event: DragEvent) => {
    if (hostKind === 'app') return;
    event.preventDefault();
  };

  return (
    <div
      class="app"
      classList={{
        'with-sidebar': prefs.sidebarVisible,
        inactive: !windowActive(),
        fullscreen: fullscreen(),
        typing: typing(),
        'focus-mode': prefs.focusMode,
      }}
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDrop}
    >
      <Show when={prefs.sidebarVisible}>
        <Sidebar />
      </Show>
      <div class="main">
        <TopBar />
        <Show when={surfaces.findOpen()}>
          <FindBar />
        </Show>
        <main class="scroller">
          <NotebookView />
        </main>
        <RunningChip />
      </div>
      <Show when={surfaces.palette()}>
        <Palette />
      </Show>
      <Show when={surfaces.shortcutsOpen()}>
        <Shortcuts />
      </Show>
      <Show when={surfaces.preview()} keyed>
        {(source) => <Preview source={source} />}
      </Show>
      <Toast />
    </div>
  );
}
