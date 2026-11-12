// The palette: one keyboard-driven list for everything that is picked by name — commands
// (⌘K), kernels (⌥⌘K), headings (⌘J), notebooks to open (⇧⌘O), the kernel's variables (⌥⌘V)
// and settings (⌘,). Type to narrow it down, arrows to move, Return to choose; Backspace on
// an empty field goes back to the commands. It is the app's only panel: there is no sidebar.

import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from 'solid-js';
import { call } from '../host';
import { copyText } from '../host/clipboard';
import { kernel, kernelLanguage, refreshSpecs, type KernelSpecInfo } from '../kernel/kernel';
import { fetchVariables, type Variable } from '../kernel/variables';
import { allCommands, command, runCommand, surfaces, type Command } from '../notebook/commands';
import { chooseKernel, documentDirectory, home, openPath } from '../notebook/document';
import { setNotice } from '../notebook/execution';
import { displayKeys } from '../notebook/keymap';
import { jumpToHeading, outline } from '../notebook/outline';
import { activeCell, enterCommandMode, notebook } from '../notebook/store';
import { prefs, setPref } from '../state/prefs';
import type { PaletteMode } from '../state/surfaces';
import { basename, dirname, stripExt, tildify } from '../util/misc';
import { Check } from './icons';

interface Item {
  id: string;
  title: string;
  /** Dim text beside the title: where a file is, which interpreter a kernel runs. */
  detail?: string;
  /** Short note at the right-hand edge. */
  hint?: string;
  keys?: string;
  checked?: boolean;
  busy?: boolean;
  disabled?: boolean;
  /** Indentation steps, for an outline. */
  depth?: number;
  /** Set as code: a name from the program rather than a phrase. */
  code?: boolean;
  /** More text the query may be found in, as typed (the folder a file is in). */
  keywords?: string;
  /** Added to the match score: recently used commands come first. */
  bonus?: number;
  /** Runs at once and leaves the palette open (switching list, installing something). */
  stay?: boolean;
  run: () => void;
}

interface Scored {
  item: Item;
  score: number;
  /** Indices of the matched characters in the title. */
  hits: number[];
}

/** Subsequence match that favours word starts and consecutive characters. */
function match(query: string, title: string): { score: number; hits: number[] } | null {
  if (!query) return { score: 0, hits: [] };
  const text = title.toLowerCase();
  const hits: number[] = [];
  let score = 0;
  let from = 0;
  let previous = -2;
  for (const char of query.toLowerCase()) {
    if (char === ' ') continue;
    const at = text.indexOf(char, from);
    if (at < 0) return null;
    const wordStart = at === 0 || /[\s:\-/_.]/.test(text[at - 1]);
    score += wordStart ? 8 : 1;
    if (at === previous + 1) score += 5;
    score -= Math.min(at - from, 6) * 0.4;
    hits.push(at);
    previous = at;
    from = at + 1;
  }
  return { score: score - title.length * 0.02, hits };
}

function Highlighted(props: { text: string; hits: number[] }) {
  const parts = createMemo(() => {
    const marks = new Set(props.hits);
    const out: { text: string; hit: boolean }[] = [];
    for (let i = 0; i < props.text.length; i++) {
      const hit = marks.has(i);
      const last = out[out.length - 1];
      if (last && last.hit === hit) last.text += props.text[i];
      else out.push({ text: props.text[i], hit });
    }
    return out;
  });
  return <For each={parts()}>{(part) => (part.hit ? <mark>{part.text}</mark> : <>{part.text}</>)}</For>;
}

// ── Recently used commands ──────────────────────────────────────────────────

const RECENT_KEY = 'sumi.recentCommands';
let recent: string[] = [];
try {
  const stored: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
  if (Array.isArray(stored)) recent = stored.filter((id): id is string => typeof id === 'string').slice(0, 6);
} catch {
  /* private mode, or nothing stored yet */
}

function noteRecent(id: string) {
  recent = [id, ...recent.filter((other) => other !== id)].slice(0, 6);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
  } catch {
    /* private mode */
  }
}

// ── The lists ───────────────────────────────────────────────────────────────

/** Commands that open another list do so in place instead of closing the palette. */
const LISTS: Record<string, PaletteMode> = {
  'kernel.pick': 'kernels',
  'go.heading': 'headings',
  'go.variables': 'variables',
  'file.openQuickly': 'files',
  'app.settings': 'settings',
};

/** The settings, in the order they are listed: how the page looks, then how it behaves. */
const SETTINGS = [
  'view.serif',
  'view.wide',
  'view.lineNumbers',
  'view.wrap',
  'view.focusMode',
  'view.typewriter',
  'view.completionList',
  'file.autosave',
  'view.reactive',
];

const APPEARANCES = ['system', 'light', 'dark'] as const;
const APPEARANCE_NAME = { system: 'Match System', light: 'Light', dark: 'Dark' };

const PLACEHOLDER: Record<PaletteMode, string> = {
  commands: 'Type a command…',
  kernels: 'Select a kernel…',
  headings: 'Go to heading…',
  files: 'Open notebook…',
  variables: 'Variables',
  settings: 'Settings',
};

const NOTHING: Record<PaletteMode, string> = {
  commands: 'No matching commands',
  kernels: 'No matching kernels',
  headings: 'No matching headings',
  files: 'No matching notebooks',
  variables: 'No matching variables',
  settings: 'No matching settings',
};

export function Palette() {
  let input!: HTMLInputElement;
  let layer!: HTMLDivElement;
  let list!: HTMLDivElement;
  const mode = (): PaletteMode => surfaces.palette() ?? 'commands';
  const [query, setQuery] = createSignal('');
  const [focused, setFocused] = createSignal(0);
  const previousFocus = document.activeElement as HTMLElement | null;

  const close = () => surfaces.setPalette(null);

  const commandItem = (command: Command, bonus = 0): Item => {
    const next = LISTS[command.id];
    return {
      id: command.id,
      title: command.title,
      keys: command.keys,
      checked: command.checked?.(),
      disabled: command.enabled ? !command.enabled() : false,
      bonus,
      stay: !!next,
      run: next ? () => surfaces.setPalette(next) : () => runCommand(command.id),
    };
  };

  // Commands: the ones used lately first — ⌘K ↩ repeats the last one. Settings are not
  // listed among them (they have their own list), but a search finds them all the same.
  const commandItems = (): Item[] => {
    const searching = query().trim() !== '';
    const rank = new Map(recent.map((id, i) => [id, i]));
    const position = (command: Command) => rank.get(command.id) ?? recent.length;
    return allCommands()
      .filter((command) => !command.internal && (searching || !command.setting))
      .sort((a, b) => position(a) - position(b))
      .map((command) => commandItem(command, rank.has(command.id) ? 1.5 : 0));
  };

  // Variables: what the kernel holds right now — name, kind and a glimpse of the value.
  // Choosing one puts its name where you were typing (or, with no caret anywhere, on the
  // clipboard).
  const [variables, setVariables] = createSignal<Variable[] | null | undefined>(undefined);
  const loadVariables = async () => {
    setVariables(undefined);
    setVariables(await fetchVariables());
  };
  const useName = (name: string) => {
    const view = notebook.mode() === 'edit' ? activeCell()?.view : null;
    if (view) {
      view.dispatch(view.state.replaceSelection(name), { userEvent: 'input.complete', scrollIntoView: true });
    } else {
      void copyText(name).then(() => setNotice({ kind: 'info', text: `Copied “${name}”` }));
    }
  };
  const variableItems = (): Item[] =>
    (variables() ?? []).map((variable) => ({
      id: variable.name,
      title: variable.name,
      detail: variable.value,
      hint: variable.type,
      code: true,
      run: () => useName(variable.name),
    }));

  // Settings: each one with its current state. Return changes it and the list stays, so
  // several can be set in one visit.
  const settingItems = (): Item[] => {
    const appearance: Item = {
      id: 'appearance',
      title: 'Appearance',
      hint: APPEARANCE_NAME[prefs.appearance],
      keywords: 'light dark system theme',
      stay: true,
      run: () => setPref('appearance', APPEARANCES[(APPEARANCES.indexOf(prefs.appearance) + 1) % APPEARANCES.length]),
    };
    const toggles = SETTINGS.flatMap((id) => {
      const setting = command(id);
      return setting ? [{ ...commandItem(setting), stay: true }] : [];
    });
    return [appearance, ...toggles];
  };

  // Kernels: every interpreter that can run this notebook, those that could with one
  // install, and what can be done to the one that is running.
  const [searching, setSearching] = createSignal(false);
  const [installing, setInstalling] = createSignal<string | null>(null);
  const install = async (spec: KernelSpecInfo) => {
    setInstalling(spec.id);
    try {
      await call('kernels.install', { specId: spec.id });
      const fresh = (await refreshSpecs()).find((candidate) => candidate.id === spec.id);
      if (fresh?.available) {
        setNotice({ kind: 'info', text: `ipykernel is now installed in “${spec.displayName}”.` });
        close();
        void chooseKernel(fresh);
      }
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setInstalling(null);
    }
  };
  const kernelItems = (): Item[] => {
    const specs = kernel.specs();
    const ordered = [...specs.filter((spec) => spec.kind === 'environment'), ...specs.filter((spec) => spec.kind !== 'environment')];
    const items = ordered.map((spec): Item => {
      if (!spec.available) {
        const busy = installing() === spec.id;
        return {
          id: spec.id,
          title: spec.displayName,
          detail: busy ? 'Installing ipykernel…' : 'Needs ipykernel',
          hint: busy ? undefined : 'Install',
          busy,
          disabled: installing() !== null,
          stay: true,
          run: () => void install(spec),
        };
      }
      return {
        id: spec.id,
        title: spec.displayName,
        detail: tildify(spec.pythonPath ?? spec.resourceDir ?? '', home()),
        hint: spec.pythonVersion ? `Python ${spec.pythonVersion.split('.').slice(0, 2).join('.')}` : spec.language,
        checked: kernel.spec()?.id === spec.id,
        run: () => void chooseKernel(spec),
      };
    });
    for (const command of allCommands()) {
      if (command.group === 'Kernel' && command.id !== 'kernel.pick') items.push(commandItem(command));
    }
    return items;
  };

  // Headings: the outline, with the section the selection is in marked.
  const headingItems = (): Item[] =>
    outline.entries().map((entry, i) => ({
      id: `${i}:${entry.cellId}`,
      title: entry.text,
      depth: entry.level - outline.topLevel(),
      checked: i === outline.current(),
      run: () => jumpToHeading(entry),
    }));

  // Notebooks: the ones opened lately, then every one in this notebook's folder.
  const [files, setFiles] = createSignal<{ recents: string[]; found: string[] } | null>(null);
  const loadFiles = async () => {
    const directory = documentDirectory();
    const [recents, found] = await Promise.all([
      call<{ paths: string[] } | null>('app.recents').then(
        (result) => result?.paths ?? [],
        () => [] as string[],
      ),
      directory
        ? call<{ paths: string[] }>('fs.find', { path: directory, extension: 'ipynb' }).then(
            (result) => result.paths,
            () => [] as string[],
          )
        : Promise.resolve([] as string[]),
    ]);
    setFiles({ recents, found });
  };
  const fileItems = (): Item[] => {
    const data = files();
    if (!data) return [];
    const directory = documentDirectory();
    const seen = new Set<string>();
    const items: Item[] = [];
    for (const path of [...data.recents, ...data.found]) {
      if (seen.has(path)) continue;
      seen.add(path);
      const folder = dirname(path);
      const nearby = directory && (folder === directory || folder.startsWith(directory + '/'));
      items.push({
        id: path,
        title: stripExt(basename(path)),
        detail: nearby ? folder.slice(directory.length + 1) : tildify(folder, home()),
        keywords: nearby ? path.slice(directory.length + 1) : tildify(path, home()),
        checked: path === notebook.path(),
        run: () => openPath(path),
      });
    }
    return items;
  };

  const items = createMemo<Item[]>(() => {
    switch (mode()) {
      case 'kernels':
        return kernelItems();
      case 'headings':
        return headingItems();
      case 'files':
        return fileItems();
      case 'variables':
        return variableItems();
      case 'settings':
        return settingItems();
      default:
        return commandItems();
    }
  });

  const results = createMemo<Scored[]>(() => {
    const text = query().trim();
    const scored: Scored[] = [];
    for (const item of items()) {
      const found = match(text, item.title);
      if (found) {
        scored.push({ item, score: found.score + (item.bonus ?? 0), hits: found.hits });
      } else if (item.keywords) {
        // Paths are long enough to contain any few letters in order, so they are matched
        // literally: every word of the query must appear as written.
        const haystack = item.keywords.toLowerCase();
        const words = text.toLowerCase().split(/\s+/);
        if (words.every((word) => haystack.includes(word))) scored.push({ item, score: -10, hits: [] });
      }
    }
    if (text) scored.sort((a, b) => b.score - a.score);
    return scored;
  });

  /** A line shown instead of results: the list is empty, still loading, or nothing matches. */
  const note = () => {
    if (query().trim()) return results().length ? null : NOTHING[mode()];
    // The kernel list always ends with the kernel commands, so "none found" sits above them.
    if (results().length) return mode() === 'kernels' && !kernel.specs().length ? kernelNote() : null;
    switch (mode()) {
      case 'kernels':
        return kernelNote();
      case 'headings':
        return 'No headings yet. A line that starts with # in a text cell becomes one.';
      case 'files':
        return files() ? 'No notebooks in this folder.' : 'Looking for notebooks…';
      case 'variables':
        if (kernelLanguage() !== 'python') return 'Variables are listed for Python kernels.';
        if (kernel.status() === 'none' || kernel.status() === 'dead') return 'Nothing has run yet, so the kernel holds no variables.';
        if (variables() === undefined) return kernel.status() === 'busy' ? 'The kernel is busy. Its variables will be listed when it is free.' : 'Asking the kernel…';
        return variables() === null ? 'The kernel did not answer.' : 'No variables yet.';
      default:
        return NOTHING.commands;
    }
  };
  const kernelNote = () => (searching() ? 'Looking for kernels…' : 'No kernels were found. Install one with:  pip install ipykernel');

  const choose = (entry: Scored | undefined) => {
    const item = entry?.item;
    if (!item || item.disabled || item.busy) return;
    if (item.stay) {
      item.run();
      return;
    }
    if (mode() === 'commands') noteRecent(item.id);
    close();
    // Let the palette go (and the caret return to where it was) before anything changes.
    queueMicrotask(item.run);
  };

  // Each list starts fresh: an empty field, and whatever it needs fetched.
  createEffect(
    on(mode, (current) => {
      setQuery('');
      if (current === 'kernels') {
        setSearching(true);
        void refreshSpecs()
          .catch(() => {})
          .finally(() => setSearching(false));
      } else if (current === 'files') {
        void loadFiles();
      } else if (current === 'variables') {
        void loadVariables();
      }
    }),
  );

  // Where there is a current choice — this kernel, this section, this notebook — the
  // highlight starts on it; everywhere else, at the top.
  const HAS_CURRENT: PaletteMode[] = ['kernels', 'headings', 'files'];
  createEffect(
    on([mode, query], ([current, text]) => {
      const here = HAS_CURRENT.includes(current) && !text.trim() ? results().findIndex((entry) => entry.item.checked) : -1;
      setFocused(Math.max(here, 0));
    }),
  );
  const cursor = () => Math.min(focused(), results().length - 1);
  createEffect(() => {
    list.querySelectorAll('.palette-item')[cursor()]?.scrollIntoView({ block: 'nearest' });
  });

  const move = (delta: number) => {
    const count = results().length;
    if (count) setFocused((cursor() + delta + count) % count);
  };

  // The pointer moves the highlight only by really moving: a list that scrolls or appears
  // under a resting pointer reports movement too, and must not steal it from the keys.
  let pointer: { x: number; y: number } | null = null;
  const onPointer = (event: MouseEvent, index: number) => {
    const moved = pointer !== null && (pointer.x !== event.screenX || pointer.y !== event.screenY);
    pointer = { x: event.screenX, y: event.screenY };
    if (moved) setFocused(index);
  };

  onMount(() => input.focus());
  onCleanup(() => {
    const active = document.activeElement;
    if (active !== document.body && !(active && layer.contains(active))) return; // focus has moved on already
    if (previousFocus?.isConnected && previousFocus !== document.body) {
      // Give the keyboard back to whoever had it — the editor, usually, mid-sentence.
      previousFocus.focus({ preventScroll: true });
    } else {
      // Nothing to return to: make sure the notebook is not left believing a cell is being typed in.
      queueMicrotask(() => {
        if (document.activeElement === document.body && notebook.mode() === 'edit') enterCommandMode();
      });
    }
  });

  return (
    <div class="palette-layer" ref={layer} onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <div class="palette">
        <input
          ref={input}
          class="palette-input"
          placeholder={PLACEHOLDER[mode()]}
          spellcheck={false}
          autocomplete="off"
          value={query()}
          onInput={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.isComposing) return;
            const key = event.key;
            if (key === 'ArrowDown' || (event.ctrlKey && key === 'n')) {
              event.preventDefault();
              move(1);
            } else if (key === 'ArrowUp' || (event.ctrlKey && key === 'p')) {
              event.preventDefault();
              move(-1);
            } else if (key === 'PageDown' || key === 'PageUp') {
              event.preventDefault();
              const count = results().length;
              if (count) setFocused(Math.max(0, Math.min(count - 1, cursor() + (key === 'PageDown' ? 8 : -8))));
            } else if (key === 'Enter') {
              event.preventDefault();
              choose(results()[cursor()]);
            } else if (key === 'Escape') {
              event.preventDefault();
              close();
            } else if (key === 'Backspace' && !query() && mode() !== 'commands') {
              event.preventDefault();
              surfaces.setPalette('commands');
            } else if (key === 'Tab') {
              event.preventDefault();
            }
          }}
        />
        <div class="palette-list" ref={list}>
          <Show when={note()}>{(text) => <div class="palette-empty">{text()}</div>}</Show>
          <For each={results()}>
            {(entry, i) => (
              <button
                class="palette-item"
                classList={{ focused: cursor() === i() }}
                style={entry.item.depth ? { 'padding-left': `${10 + entry.item.depth * 16}px` } : undefined}
                disabled={entry.item.disabled}
                tabindex={-1}
                onMouseMove={(event) => onPointer(event, i())}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(entry)}
              >
                <span class="title" classList={{ code: entry.item.code }}>
                  <Highlighted text={entry.item.title} hits={entry.hits} />
                </span>
                <span class="detail" classList={{ code: entry.item.code }}>
                  {entry.item.detail}
                </span>
                <Show when={entry.item.hint}>
                  <span class="hint">{entry.item.hint}</span>
                </Show>
                <Show when={entry.item.busy}>
                  <span class="spinner" />
                </Show>
                <Show when={entry.item.checked}>
                  <span class="tick">
                    <Check />
                  </span>
                </Show>
                <Show when={entry.item.keys}>
                  <span class="keys">
                    <For each={displayKeys(entry.item.keys!)}>{(key) => <kbd>{key}</kbd>}</For>
                  </span>
                </Show>
              </button>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}
