// Keyboard handling outside the editors: shortcuts that work everywhere, and Jupyter's
// single-key "command mode" for when a cell is selected but not being edited.

import { runCommand, surfaces } from './commands';
import { enterCommandMode, hasMultiSelection, notebook, select } from './store';

/** Shortcuts that apply no matter where focus is. */
const GLOBAL: Record<string, string> = {
  'Mod-s': 'file.save',
  'Mod-Shift-s': 'file.saveAs',
  'Mod-k': 'view.palette',
  'Mod-Shift-p': 'view.palette',
  'Mod-j': 'go.heading',
  'Mod-Shift-o': 'file.openQuickly',
  'Mod-p': 'file.openQuickly',
  'Alt-Mod-k': 'kernel.pick',
  'Mod-.': 'kernel.interrupt',
  'Mod-Shift-Enter': 'notebook.runAll',
  'Mod-f': 'edit.find',
  'Mod-g': 'edit.findNext',
  'Mod-Shift-g': 'edit.findPrevious',
  'Mod-Shift-l': 'view.toggleSidebar',
  'Ctrl-Shift-ArrowUp': 'cell.moveUp',
  'Ctrl-Shift-ArrowDown': 'cell.moveDown',
  'Ctrl-Shift--': 'cell.split',
  // The command-mode letters with ⇧⌘ added, for changing a cell's type without leaving it.
  'Mod-Shift-m': 'cell.toMarkdown',
  'Mod-Shift-y': 'cell.toCode',
  'Ctrl-Mod-1': 'view.outline',
  'Ctrl-Mod-2': 'view.files',
  'Ctrl-Mod-3': 'view.variables',
  F1: 'help.shortcuts',
  F8: 'view.focusMode',
  F9: 'view.typewriter',
  'Mod-=': 'view.zoomIn',
  'Mod--': 'view.zoomOut',
  'Mod-0': 'view.zoomReset',
};

/** Shortcuts for a selected cell that is not being edited. */
const COMMAND_MODE: Record<string, string> = {
  Enter: 'cell.edit',
  ArrowUp: 'nav.up',
  ArrowDown: 'nav.down',
  k: 'nav.up',
  j: 'nav.down',
  'Shift-ArrowUp': 'nav.extendUp',
  'Shift-ArrowDown': 'nav.extendDown',
  'Shift-k': 'nav.extendUp',
  'Shift-j': 'nav.extendDown',
  'Mod-ArrowUp': 'nav.first',
  'Mod-ArrowDown': 'nav.last',
  Home: 'nav.first',
  End: 'nav.last',
  Space: 'nav.pageDown',
  'Shift-Space': 'nav.pageUp',
  PageDown: 'nav.pageDown',
  PageUp: 'nav.pageUp',
  'Shift-Enter': 'cell.runAndAdvance',
  'Mod-Enter': 'cell.run',
  'Ctrl-Enter': 'cell.run',
  'Alt-Enter': 'cell.runAndInsert',
  a: 'cell.insertAbove',
  b: 'cell.insertBelow',
  x: 'cell.cut',
  c: 'cell.copy',
  'Shift-c': 'cell.copyOutput',
  v: 'cell.paste',
  'Shift-v': 'cell.pasteAbove',
  'Mod-x': 'cell.cut',
  'Mod-c': 'cell.copy',
  'Mod-v': 'cell.paste',
  z: 'edit.undoCells',
  'Shift-z': 'edit.redoCells',
  'Mod-z': 'edit.undoCells',
  'Mod-Shift-z': 'edit.redoCells',
  m: 'cell.toMarkdown',
  y: 'cell.toCode',
  r: 'cell.toRaw',
  'Shift-m': 'cell.merge',
  o: 'cell.toggleOutput',
  'Shift-o': 'cell.toggleCode',
  l: 'view.lineNumbers',
  g: 'go.heading',
  p: 'view.palette',
  h: 'help.shortcuts',
  'Shift-/': 'help.shortcuts',
  Tab: 'cell.focusControl',
  'Mod-a': 'cell.selectAll',
};

/** Commands a held-down key may repeat: moving about, and running cell after cell. */
const REPEATABLE = new Set([
  'nav.up',
  'nav.down',
  'nav.extendUp',
  'nav.extendDown',
  'nav.pageDown',
  'nav.pageUp',
  'cell.runAndAdvance',
  'cell.moveUp',
  'cell.moveDown',
  'view.zoomIn',
  'view.zoomOut',
]);

/** Two-key sequences, as in Jupyter. */
const SEQUENCES: Record<string, string> = {
  'd d': 'cell.delete',
  'i i': 'kernel.interrupt',
  '0 0': 'kernel.restart',
};

const CODE_KEYS: Record<string, string> = {
  Minus: '-',
  Equal: '=',
  Period: '.',
  Comma: ',',
  Slash: '/',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Backquote: '`',
};

/** `Ctrl-Alt-Shift-Mod-key`, with the key taken from the physical position when modified. */
export function keyName(event: KeyboardEvent): string {
  let key = event.key;
  const code = event.code;
  if (code.startsWith('Digit')) key = code.slice(5);
  else if (CODE_KEYS[code]) key = CODE_KEYS[code];
  else if (code.startsWith('Key') && (key.length !== 1 || !/[a-z]/i.test(key))) key = code.slice(3);
  // An input method saw the key first and hid what it was; the physical key still says.
  else if (code && (key === 'Process' || key === 'Unidentified' || key === 'Dead')) key = code;
  if (key.length === 1) key = key.toLowerCase();
  if (key === ' ') key = 'Space';
  return (
    (event.ctrlKey ? 'Ctrl-' : '') +
    (event.altKey ? 'Alt-' : '') +
    (event.shiftKey ? 'Shift-' : '') +
    (event.metaKey ? 'Mod-' : '') +
    key
  );
}

function canonical(binding: string): string {
  const parts = binding.split('-');
  let key = parts.pop()!;
  if (key === '') key = '-'; // "Mod--"
  const mods = new Set(parts.filter(Boolean));
  return (
    (mods.has('Ctrl') ? 'Ctrl-' : '') +
    (mods.has('Alt') ? 'Alt-' : '') +
    (mods.has('Shift') ? 'Shift-' : '') +
    (mods.has('Mod') ? 'Mod-' : '') +
    key
  );
}

function index(table: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(table).map(([binding, id]) => [canonical(binding), id]));
}

const globalKeys = index(GLOBAL);
const commandKeys = index(COMMAND_MODE);

/**
 * Whether the key press belongs to a control that has focus — a text field, a widget, a link,
 * a sidebar row — rather than to the notebook as a whole.
 */
function onControl(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement) || target === document.body) return false;
  return target.isContentEditable || !!target.closest('input, textarea, select, button, a[href], summary, [tabindex]');
}

/** A surface that takes every key while it is open. */
function overlayOpen(): boolean {
  return surfaces.palette() !== null || surfaces.shortcutsOpen() || surfaces.menuOpen() || surfaces.preview() !== null;
}

/** Commands that still work with the palette open: they switch what it lists, or close it. */
export const PALETTE_COMMANDS = new Set(['view.palette', 'kernel.pick', 'go.heading', 'file.openQuickly']);

let pendingKey = '';
let pendingAt = 0;

export function installKeymap(): () => void {
  const onGlobal = (event: KeyboardEvent) => {
    if (event.isComposing || event.keyCode === 229) return;
    const id = globalKeys.get(keyName(event));
    if (!id) return;
    // A pop-up menu lets the key through: it closes itself, and the menu bar's own
    // shortcut then does the work.
    if (surfaces.menuOpen()) return;
    // The palette and the shortcut sheet are modal. Their shortcuts are spent here, so that
    // they do not fall through to the menu bar and act behind the surface — apart from the
    // ones that drive the palette itself.
    if (overlayOpen() && !(surfaces.palette() !== null && PALETTE_COMMANDS.has(id))) {
      event.preventDefault();
      return;
    }
    // A held key repeats movement, never an action: one press, one save, one palette.
    if (event.repeat && !REPEATABLE.has(id)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (runCommand(id)) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const onCommandMode = (event: KeyboardEvent) => {
    if (event.defaultPrevented || notebook.mode() !== 'command' || overlayOpen()) return;
    const name = keyName(event);

    // A focused control (a widget, a link, a checkbox in a cell) keeps its own keys;
    // Escape hands the keyboard back to the notebook.
    if (onControl(event.composedPath()[0] ?? event.target)) {
      if (name === 'Escape' && !event.isComposing) {
        event.preventDefault();
        enterCommandMode();
      }
      return;
    }
    // (No check for an input method here: with no text field in focus there is nothing for
    // it to compose into, and `keyName` reads the physical key if it hid the character.)

    if (name === 'Escape') {
      if (surfaces.findOpen()) surfaces.setFindOpen(false);
      else if (hasMultiSelection()) select(notebook.activeId(), { scroll: false });
      return;
    }
    // Tab goes into the selected cell (see `cell.focusControl`) and nowhere else: the page's
    // own tab order would wander off to some editor far away.
    if (name === 'Shift-Tab') {
      event.preventDefault();
      return;
    }

    const startsSequence = Object.keys(SEQUENCES).some((entry) => entry.startsWith(name + ' '));
    if (event.repeat) {
      // A held key repeats movement, never an edit: one press of B is one new cell, and
      // leaning on D does not empty the notebook.
      const held = commandKeys.get(name);
      if (held && REPEATABLE.has(held)) runCommand(held);
      if (held || startsSequence) event.preventDefault();
      return;
    }

    const now = performance.now();
    const sequence = pendingKey && now - pendingAt < 900 ? `${pendingKey} ${name}` : '';
    if (sequence && SEQUENCES[sequence]) {
      pendingKey = '';
      event.preventDefault();
      runCommand(SEQUENCES[sequence]);
      return;
    }
    if (startsSequence) {
      pendingKey = name;
      pendingAt = now;
      event.preventDefault();
      return;
    }
    pendingKey = '';

    const id = commandKeys.get(name);
    if (!id) return;
    // ⌘C / ⌘X with text selected (in an output, say) mean that text, not the whole cell.
    if ((name === 'Mod-c' || name === 'Mod-x') && !window.getSelection()?.isCollapsed) return;
    event.preventDefault();
    runCommand(id);
  };

  window.addEventListener('keydown', onGlobal, true);
  window.addEventListener('keydown', onCommandMode);
  return () => {
    window.removeEventListener('keydown', onGlobal, true);
    window.removeEventListener('keydown', onCommandMode);
  };
}

// ── Display ─────────────────────────────────────────────────────────────────

const SYMBOLS: Record<string, string> = {
  Mod: '⌘',
  Shift: '⇧',
  Alt: '⌥',
  Ctrl: '⌃',
  Enter: '↩',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Escape: 'esc',
  Backspace: '⌫',
  Tab: '⇥',
  Space: 'space',
  PageUp: '⇞',
  PageDown: '⇟',
};

/** "Mod-Shift-Enter" → ["⇧", "⌘", "↩"]; "d d" → ["D", "D"]. */
export function displayKeys(binding: string): string[] {
  const out: string[] = [];
  for (const chord of binding.split(' ')) {
    const parts = chord.split('-');
    let key = parts.pop()!;
    if (key === '') key = '-';
    const mods = parts.filter(Boolean);
    for (const mod of ['Ctrl', 'Alt', 'Shift', 'Mod']) {
      if (mods.includes(mod)) out.push(SYMBOLS[mod]);
    }
    out.push(SYMBOLS[key] ?? (key.length === 1 ? key.toUpperCase() : key));
  }
  return out;
}
