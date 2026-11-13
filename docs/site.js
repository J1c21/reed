// Reed's site. The page behaves the way the app does, where that makes sense on the web: one
// line in the margin says which part you are on, and glides to the next; J and K walk it; ⌘K
// opens the one panel; a copy button waits in the margin beside a command.
//
// Without this file the page reads the same. It only has no line.

(() => {
  'use strict';

  const root = document.documentElement;
  const page = document.querySelector('.page');
  const cells = page ? Array.from(page.querySelectorAll('.cell')) : [];
  if (!page || !cells.length) return;

  const strings = JSON.parse(document.getElementById('strings')?.textContent || '{}');
  const mac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

  // ── Motion ────────────────────────────────────────────────────────────────

  // One duration and one curve, as in the app, and none of it when macOS is set to reduce motion.
  const GLIDE_MS = 200;
  const ease = (t) => 1 - Math.pow(1 - t, 3);
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const still = () => document.hidden || reducedMotion.matches;

  /** A scroll of the page's own making, in flight. */
  let glide = null;
  /** Until then, scrolling is the page's own doing and does not move the line. */
  let hushedUntil = 0;

  function stopGlide() {
    if (glide) cancelAnimationFrame(glide);
    glide = null;
  }

  /** Scrolls to a position the way everything else moves. Scrolling by hand takes over at once. */
  function glideScrollTo(top) {
    const limit = Math.max(0, root.scrollHeight - window.innerHeight);
    const goal = Math.min(Math.max(top, 0), limit);
    stopGlide();
    let from = window.scrollY;
    if (Math.abs(goal - from) < 1) return;
    hushedUntil = performance.now() + GLIDE_MS + 160;
    if (still()) {
      window.scrollTo(0, goal);
      return;
    }
    // A long way is mostly a jump: only the arrival is worth watching.
    const reach = window.innerHeight * 1.5;
    if (Math.abs(goal - from) > reach) {
      from = goal - Math.sign(goal - from) * reach;
      window.scrollTo(0, from);
    }
    const started = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - started) / GLIDE_MS);
      window.scrollTo(0, from + (goal - from) * ease(t));
      glide = t < 1 ? requestAnimationFrame(step) : null;
    };
    glide = requestAnimationFrame(step);
  }

  const byHand = () => {
    stopGlide();
    hushedUntil = 0;
  };
  window.addEventListener('wheel', byHand, { passive: true });
  window.addEventListener('touchstart', byHand, { passive: true });

  /** Room kept clear above and below whatever is brought into view. */
  const MARGIN_TOP = 64;
  const MARGIN_BOTTOM = 96;

  /** Brings a cell into view: no further than needed, or ('start') to the top of the window. */
  function glideIntoView(element, block) {
    const rect = element.getBoundingClientRect();
    const top = MARGIN_TOP;
    const bottom = window.innerHeight - MARGIN_BOTTOM;
    let delta = 0;
    if (block === 'start') {
      delta = rect.top - top;
    } else if (rect.top < top && rect.bottom > bottom) {
      delta = 0; // it fills the window already
    } else {
      const tall = rect.height > bottom - top;
      if (rect.top < top) delta = tall ? rect.bottom - bottom : rect.top - top;
      else if (rect.bottom > bottom) delta = tall ? rect.top - top : rect.bottom - bottom;
    }
    if (Math.abs(delta) >= 1) glideScrollTo(window.scrollY + delta);
  }

  // ── The line in the margin ────────────────────────────────────────────────

  /** How far the line stops short of the top and bottom of the cell it marks. */
  const INSET = 3;

  const line = document.createElement('div');
  line.className = 'cell-marker';
  line.hidden = true;
  page.append(line);

  let current = 0;
  let settle;

  function place(travel) {
    const cell = cells[current];
    const travelling = travel && !line.hidden && !still();
    line.classList.toggle('gliding', travelling);
    line.style.top = `${cell.offsetTop + INSET}px`;
    line.style.height = `${Math.max(INSET * 2, cell.offsetHeight - INSET * 2)}px`;
    line.hidden = false;
    clearTimeout(settle);
    if (travelling) settle = setTimeout(() => line.classList.remove('gliding'), GLIDE_MS + 80);
  }

  function select(index) {
    if (index === current && !line.hidden) return;
    current = index;
    place(true);
  }

  /**
   * The cell being read. A third of the way down the window is where the eye is, so the cell
   * that has reached that height is the one; over the last stretch of the page that height
   * sinks to the foot of the window, so that the last cells have their turn too.
   */
  function reading() {
    const limit = root.scrollHeight - window.innerHeight;
    if (limit <= 0) return 0;
    const scrolled = Math.min(Math.max(window.scrollY, 0), limit);
    const ramp = Math.min(window.innerHeight, limit);
    const left = limit - scrolled;
    const share = left >= ramp ? 0.3 : 0.3 + 0.7 * (1 - left / ramp);
    const height = window.innerHeight * share - page.getBoundingClientRect().top;
    let found = 0;
    for (let index = 0; index < cells.length; index++) {
      if (cells[index].offsetTop <= height) found = index;
      else break;
    }
    return found;
  }

  // Scrolling by hand moves the line when the reading moves on to another cell, and only
  // then: a cell chosen with a key or a click stays chosen until it does.
  let read = reading();
  let pending = false;
  window.addEventListener(
    'scroll',
    () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        const now = reading();
        if (now === read) return;
        read = now;
        if (performance.now() >= hushedUntil) select(now);
      });
    },
    { passive: true },
  );

  // The page changed shape: the line simply stays where its cell is.
  new ResizeObserver(() => place(false)).observe(page);

  function cellNamed(hash) {
    const id = decodeURIComponent(hash.replace(/^#/, ''));
    return id ? cells.findIndex((cell) => cell.id === id) : -1;
  }

  // A link to a part of the page arrives at that part, whatever the scrolling says.
  function arrive() {
    const named = cellNamed(location.hash);
    if (named < 0) return false;
    hushedUntil = performance.now() + 600;
    current = named;
    place(false);
    return true;
  }
  if (!arrive()) {
    current = read;
    place(false);
  }
  window.addEventListener('hashchange', arrive);

  /** J and K: the next cell, the one before. The page follows only as far as it has to. */
  function walk(by) {
    const next = Math.min(cells.length - 1, Math.max(0, current + by));
    select(next);
    if (next === 0) glideScrollTo(0);
    else glideIntoView(cells[next]);
  }

  function goTo(index) {
    select(index);
    glideIntoView(cells[index], 'start');
    if (cells[index].id) history.replaceState(null, '', `#${cells[index].id}`);
  }

  /** The cell level with a height in the window, or failing that the nearest one. */
  function cellBeside(clientY) {
    let nearest = -1;
    let distance = Infinity;
    cells.forEach((cell, index) => {
      const box = cell.getBoundingClientRect();
      const away = clientY < box.top ? box.top - clientY : clientY > box.bottom ? clientY - box.bottom : 0;
      if (away < distance) {
        nearest = index;
        distance = away;
      }
    });
    return nearest;
  }

  // A click on a cell, or on the bare page beside one, chooses it — as in the app. A click
  // that selected text, or pressed something, is not that.
  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0 || panel) return;
    const target = event.target;
    if (!(target instanceof Element) || target.closest('a, button, input, .palette-layer')) return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;
    const cell = target.closest('.cell');
    // Everything that is not a cell is paper, but for the title bar and the foot of the page.
    const paper = !target.closest('.topbar, .colophon');
    const index = cell ? cells.indexOf(cell) : paper ? cellBeside(event.clientY) : -1;
    if (index >= 0) select(index);
  });

  // ── Appearance ────────────────────────────────────────────────────────────

  // Light, dark, or following the system. The choice is kept under the same name the app uses.
  const APPEARANCE = 'reed.appearance';
  const dark = window.matchMedia('(prefers-color-scheme: dark)');

  function appearance() {
    const chosen = root.dataset.appearance;
    return chosen === 'light' || chosen === 'dark' ? chosen : 'system';
  }

  /** The pictures follow the page: each has a dark twin, offered by a <source>. */
  function matchPictures(mode) {
    for (const source of document.querySelectorAll('source[data-appearance]')) {
      const twin = source.dataset.appearance;
      source.media = mode === 'system' ? `(prefers-color-scheme: ${twin})` : mode === twin ? 'all' : 'not all';
    }
  }

  function setAppearance(mode) {
    if (mode === 'system') delete root.dataset.appearance;
    else root.dataset.appearance = mode;
    try {
      if (mode === 'system') localStorage.removeItem(APPEARANCE);
      else localStorage.setItem(APPEARANCE, mode);
    } catch {
      /* private mode */
    }
    matchPictures(mode);
  }

  /** The first press always changes what is on screen; the third goes back to the system's. */
  function cycleAppearance() {
    const order = ['system', dark.matches ? 'light' : 'dark', dark.matches ? 'dark' : 'light'];
    setAppearance(order[(order.indexOf(appearance()) + 1) % order.length]);
  }

  if (appearance() !== 'system') matchPictures(appearance());

  // ── The one panel ─────────────────────────────────────────────────────────

  let panel = null;

  function make(tag, className) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    return element;
  }

  /** Everything the page can do, by name. */
  function commands() {
    const list = [];
    const download = document.querySelector('[data-download]');
    const source = document.querySelector('[data-source]');
    const language = document.querySelector('[data-language]');
    if (download) list.push({ title: strings.download, hint: strings.downloadHint, run: () => download.click() });
    if (source) list.push({ title: strings.source, run: () => source.click() });
    cells.forEach((cell, index) => {
      const heading = cell.querySelector('h2');
      if (heading) list.push({ title: heading.textContent.trim(), run: () => goTo(index) });
    });
    // A setting shows its state, and stays to be changed again.
    list.push({ title: strings.appearance, hint: () => strings.appearances[appearance()], run: cycleAppearance, stay: true });
    if (language) list.push({ title: language.textContent.trim(), run: () => language.click() });
    return list;
  }

  /** Where the letters of what was typed fall in a name, in order — or null if they do not. */
  function match(title, query) {
    const name = title.toLowerCase();
    const typed = query.toLowerCase().replace(/\s+/g, '');
    if (!typed) return { rank: 0, at: [] };
    const whole = name.indexOf(typed);
    if (whole >= 0) return { rank: whole === 0 ? 0 : 1, at: Array.from(typed, (_, i) => whole + i) };
    const at = [];
    let from = 0;
    for (const letter of typed) {
      const found = name.indexOf(letter, from);
      if (found < 0) return null;
      at.push(found);
      from = found + 1;
    }
    return { rank: 2 + (at[at.length - 1] - at[0]), at };
  }

  function render() {
    const { list, input } = panel;
    const query = input.value.trim();
    const shown = [];
    panel.all.forEach((command, order) => {
      const found = match(command.title, query);
      if (found) shown.push({ command, found, order });
    });
    shown.sort((a, b) => a.found.rank - b.found.rank || a.order - b.order);
    panel.shown = shown.map((entry) => entry.command);
    panel.index = Math.min(panel.index, Math.max(0, shown.length - 1));

    list.textContent = '';
    if (!shown.length) {
      const empty = make('div', 'palette-empty');
      empty.textContent = strings.empty;
      list.append(empty);
      input.removeAttribute('aria-activedescendant');
      return;
    }
    shown.forEach(({ command, found }, index) => {
      const item = make('div', 'palette-item');
      item.id = `palette-item-${index}`;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(index === panel.index));
      item.classList.toggle('focused', index === panel.index);
      const title = make('span', 'title');
      const marked = new Set(found.at);
      Array.from(command.title).forEach((letter, position) => {
        if (marked.has(position)) {
          const mark = make('mark');
          mark.textContent = letter;
          title.append(mark);
        } else {
          title.append(letter);
        }
      });
      item.append(title, make('span', 'grow'));
      const hint = typeof command.hint === 'function' ? command.hint() : command.hint;
      if (hint) {
        const note = make('span', 'hint');
        note.textContent = hint;
        item.append(note);
      }
      list.append(item);
    });
    input.setAttribute('aria-activedescendant', `palette-item-${panel.index}`);
  }

  function focusItem(index) {
    if (!panel || index === panel.index || index < 0 || index >= panel.shown.length) return;
    panel.index = index;
    Array.from(panel.list.children).forEach((item, at) => {
      item.classList.toggle('focused', at === index);
      item.setAttribute('aria-selected', String(at === index));
    });
    panel.input.setAttribute('aria-activedescendant', `palette-item-${index}`);
    panel.list.children[index].scrollIntoView({ block: 'nearest' });
  }

  function choose() {
    const command = panel?.shown[panel.index];
    if (!command) return;
    if (command.stay) {
      command.run();
      render();
    } else {
      closePalette();
      command.run();
    }
  }

  function openPalette() {
    if (panel) return;
    const layer = make('div', 'palette-layer');
    const box = make('div', 'palette');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', strings.palette);

    const input = make('input', 'palette-input');
    input.type = 'text';
    input.placeholder = strings.placeholder;
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', 'palette-list');
    input.setAttribute('aria-label', strings.placeholder);

    const list = make('div', 'palette-list');
    list.id = 'palette-list';
    list.setAttribute('role', 'listbox');

    box.append(input, list);
    layer.append(box);
    panel = { layer, input, list, all: commands(), shown: [], index: 0, restore: document.activeElement };

    input.addEventListener('input', () => {
      panel.index = 0;
      render();
    });
    input.addEventListener('keydown', (event) => {
      // Return that ends a word being composed (pinyin, kana) is not a choice.
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'ArrowDown') focusItem(panel.index + 1);
      else if (event.key === 'ArrowUp') focusItem(panel.index - 1);
      else if (event.key === 'Enter') choose();
      else if (event.key === 'Escape') closePalette();
      else if (event.key !== 'Tab') return;
      event.preventDefault();
    });
    // One highlight, shared by the arrow keys and the pointer. It follows a pointer that
    // moves, not a list that scrolls under one at rest.
    list.addEventListener('mousemove', (event) => {
      const item = event.target instanceof Element ? event.target.closest('.palette-item') : null;
      if (item) focusItem(Array.from(list.children).indexOf(item));
    });
    // The keyboard stays in the field whatever is pressed.
    box.addEventListener('mousedown', (event) => {
      if (event.target !== input) event.preventDefault();
    });
    list.addEventListener('click', (event) => {
      const item = event.target instanceof Element ? event.target.closest('.palette-item') : null;
      if (!item) return;
      focusItem(Array.from(list.children).indexOf(item));
      choose();
    });
    layer.addEventListener('click', (event) => {
      if (event.target === layer) closePalette();
    });
    // The page behind stays where it is.
    const hold = (event) => {
      if (!(event.target instanceof Node) || !list.contains(event.target)) event.preventDefault();
    };
    layer.addEventListener('wheel', hold, { passive: false });
    layer.addEventListener('touchmove', hold, { passive: false });

    document.body.append(layer);
    render();
    input.focus({ preventScroll: true });
  }

  /** Whatever borrows the keyboard gives it back. */
  function closePalette() {
    if (!panel) return;
    const { layer, restore } = panel;
    panel = null;
    layer.remove();
    if (restore instanceof HTMLElement && restore !== document.body && restore.isConnected) {
      restore.focus({ preventScroll: true });
    }
  }

  // ── Keys ──────────────────────────────────────────────────────────────────

  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.isComposing) return;
    const mod = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
    const key = event.key.toLowerCase();
    if (mod && !event.altKey && !event.shiftKey && key === 'k') {
      event.preventDefault();
      if (panel) closePalette();
      else openPalette();
      return;
    }
    if (panel || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const target = event.target;
    if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
    if (key === 'j') walk(1);
    else if (key === 'k') walk(-1);
    else return;
    event.preventDefault();
  });

  // The key in the text that names the panel opens it.
  for (const key of document.querySelectorAll('[data-palette]')) {
    key.addEventListener('click', (event) => {
      event.preventDefault();
      // Pressed with the pointer, it does not keep the keyboard: nothing is left with a ring
      // round it when the panel closes. Reached with Tab, it gets the keyboard back.
      if (event.detail > 0) key.blur();
      openPalette();
    });
    if (!mac) {
      const cap = key.querySelector('kbd');
      if (cap) cap.textContent = 'Ctrl K';
    }
  }

  // ── Copy ──────────────────────────────────────────────────────────────────

  // The button that waits in the right-hand margin beside a command, and answers where it
  // stands: for a moment its glyph is a tick.
  const DONE_MS = 1300;
  const glyph = (name, paths) =>
    `<svg class="${name}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  const COPY = glyph('glyph-copy', '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>');
  const DONE = glyph('glyph-done', '<path d="M20 6 9 17l-5-5"/>');

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const field = make('textarea');
      field.value = text;
      field.setAttribute('readonly', '');
      field.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0';
      document.body.append(field);
      field.select();
      const done = document.execCommand('copy');
      field.remove();
      if (!done) throw new Error('copy failed');
    }
  }

  for (const block of document.querySelectorAll('[data-copy]')) {
    const rail = make('div', 'copy-rail');
    const button = make('button', 'copy-button');
    button.type = 'button';
    button.tabIndex = -1;
    button.setAttribute('aria-label', strings.copy);
    button.innerHTML = COPY + DONE;
    let timer;
    // Copying is done from wherever you are: nothing that was selected is let go.
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', async (event) => {
      event.preventDefault();
      try {
        await copyText(block.querySelector('code')?.textContent ?? block.textContent ?? '');
      } catch {
        return;
      }
      button.classList.add('done');
      clearTimeout(timer);
      timer = setTimeout(() => button.classList.remove('done'), DONE_MS);
    });
    rail.append(button);
    block.append(rail);
  }
})();
