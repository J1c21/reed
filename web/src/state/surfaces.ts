// The floating surfaces — palette, find bar, shortcut sheet, menus — and who has the keyboard.

import { createSignal } from 'solid-js';

/** What the palette is listing: every command, or one kind of thing to pick by name. */
export type PaletteMode = 'commands' | 'kernels' | 'headings' | 'files' | 'variables' | 'settings';

const [palette, setPalette] = createSignal<PaletteMode | null>(null);
const [findOpen, setFindOpen] = createSignal(false);
const [shortcutsOpen, setShortcutsOpen] = createSignal(false);
/** The notebook's name in the title bar is a field at the moment, being changed. */
const [renaming, setRenaming] = createSignal(false);
/** The picture being looked at up close, and the element on the page it came from. */
const [preview, setPreview] = createSignal<HTMLImageElement | null>(null);
/** How many pop-up menus are showing; like native menus, they take every key while open. */
const [menus, setMenus] = createSignal(0);

/** What the find bar can be asked to do from outside while it is open. */
export interface FindBarHandle {
  /** Moves to the next (1) or previous (-1) match. */
  step: (delta: number) => void;
  /** Puts the caret back in the search field. */
  focus: () => void;
}
let findBar: FindBarHandle | null = null;
/** A "find next / previous" that opened the bar and is still owed its jump. */
let findJump = 0;

export const surfaces = {
  palette,
  setPalette,
  /** Opens the palette on a list, or closes it if that list is already showing. */
  togglePalette(mode: PaletteMode) {
    setPalette(palette() === mode ? null : mode);
  },
  findOpen,
  setFindOpen,
  setFindBar(handle: FindBarHandle | null) {
    findBar = handle;
  },
  /** Opens the find bar, or returns to its field if it is already open. */
  showFind() {
    if (findBar) findBar.focus();
    else setFindOpen(true);
  },
  /**
   * Moves to the next (or previous) match. With the bar closed, it opens and goes straight
   * to the match after (or before) the caret, for whatever is selected or was last sought.
   */
  findStep(delta: number) {
    if (findBar) {
      findBar.step(delta);
    } else {
      findJump = delta;
      setFindOpen(true);
    }
  },
  /** The jump owed by `findStep`, once; the find bar collects it as it opens. */
  takeFindJump(): number {
    const jump = findJump;
    findJump = 0;
    return jump;
  },
  shortcutsOpen,
  setShortcutsOpen,
  renaming,
  setRenaming,
  preview,
  setPreview,
  menuOpen: () => menus() > 0,
  menuOpened: () => setMenus(menus() + 1),
  menuClosed: () => setMenus(Math.max(0, menus() - 1)),
};
