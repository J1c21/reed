// The sidebar: the notebook's outline, the folder it lives in, and the kernel's variables.
// ⌃⌘1 / 2 / 3 show a pane and move into it; arrows walk its rows, Return opens one, Tab
// goes to the next pane, Escape hands the keyboard back to the notebook.

import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, Show } from 'solid-js';
import { call } from '../host';
import { currentConnection, kernel, kernelLanguage } from '../kernel/kernel';
import { documentDirectory, home, openPath } from '../notebook/document';
import { execution } from '../notebook/execution';
import { jumpToHeading, outline } from '../notebook/outline';
import { enterCommandMode, notebook } from '../notebook/store';
import { prefs, setPref } from '../state/prefs';
import { surfaces } from '../state/surfaces';
import { basename, clamp, tildify } from '../util/misc';
import { ChevronRight, FileIcon, Folder, NotebookText } from './icons';

/** Rows are focused from the keyboard only; a click acts without taking focus from the page. */
const keepFocus = (event: MouseEvent) => event.preventDefault();

// ── Outline ─────────────────────────────────────────────────────────────────

function Outline() {
  return (
    <Show
      when={outline.entries().length}
      fallback={<div class="pane-empty">Headings in your markdown cells appear here as an outline.</div>}
    >
      <For each={outline.entries()}>
        {(entry, i) => (
          <button
            class="outline-item"
            classList={{ current: outline.current() === i() }}
            data-row
            data-level={entry.level - outline.topLevel() + 1}
            title={entry.text}
            tabindex={-1}
            onMouseDown={keepFocus}
            onClick={() => jumpToHeading(entry)}
          >
            {entry.text}
          </button>
        )}
      </For>
    </Show>
  );
}

// ── Files ───────────────────────────────────────────────────────────────────

interface Entry {
  name: string;
  path: string;
  isDirectory: boolean;
}

/**
 * Entries keep their identity from one listing to the next, so that re-reading a folder
 * (after a save, say) leaves its rows alone: open folders stay open, the focused row stays
 * focused.
 */
const known = new Map<string, Entry>();

async function list(path: string): Promise<Entry[]> {
  const result = await call<{ entries: Entry[] }>('fs.list', { path });
  return result.entries.map((entry) => {
    const seen = known.get(entry.path);
    if (seen && seen.isDirectory === entry.isDirectory) return seen;
    known.set(entry.path, entry);
    return entry;
  });
}

function FileNode(props: { entry: Entry; depth: number }) {
  const [open, setOpen] = createSignal(false);
  const [children] = createResource(
    () => (open() ? props.entry.path : null),
    (path) => list(path).catch(() => [] as Entry[]),
  );
  const isNotebook = () => props.entry.name.endsWith('.ipynb');
  return (
    <>
      <button
        class="file-row"
        classList={{ current: props.entry.path === notebook.path(), dim: !props.entry.isDirectory && !isNotebook() }}
        style={{ 'padding-left': `${8 + props.depth * 14}px` }}
        title={props.entry.name}
        data-row
        data-depth={props.depth}
        data-folder={props.entry.isDirectory ? (open() ? 'open' : 'closed') : undefined}
        tabindex={-1}
        onMouseDown={keepFocus}
        onClick={() => {
          if (props.entry.isDirectory) setOpen(!open());
          else if (isNotebook()) openPath(props.entry.path);
        }}
        onDblClick={() => {
          if (!props.entry.isDirectory && !isNotebook()) void call('app.reveal', { path: props.entry.path }).catch(() => {});
        }}
      >
        <Show when={props.entry.isDirectory} fallback={isNotebook() ? <NotebookText /> : <FileIcon />}>
          <ChevronRight class={open() ? 'chevron open' : 'chevron'} />
        </Show>
        <span class="name">{props.entry.name}</span>
      </button>
      <Show when={open()}>
        <For each={children() ?? []}>{(child) => <FileNode entry={child} depth={props.depth + 1} />}</For>
      </Show>
    </>
  );
}

function Files() {
  const directory = () => documentDirectory();
  const [entries, { refetch }] = createResource(directory, (path) => list(path).catch(() => [] as Entry[]));
  // New files (a notebook just saved, an exported script) should show up.
  createEffect(on(() => [notebook.path(), notebook.dirty()], () => void refetch(), { defer: true }));
  return (
    <Show when={directory()} fallback={<div class="pane-empty">Save the notebook to browse its folder.</div>}>
      <div class="pane-title" title={directory()!}>
        <Folder style={{ width: '12px', height: '12px', flex: 'none' }} />
        {basename(directory()!) || tildify(directory()!, home())}
      </div>
      <For each={entries() ?? []}>{(entry) => <FileNode entry={entry} depth={0} />}</For>
      <Show when={entries() && entries()!.length === 0}>
        <div class="pane-empty">This folder is empty.</div>
      </Show>
    </Show>
  );
}

// ── Variables ───────────────────────────────────────────────────────────────

interface Variable {
  name: string;
  type: string;
  value: string;
}

const VARIABLES_PROBE = String.raw`
def __sumi_vars__():
    import base64, json, types
    shell = get_ipython()
    hidden = set(shell.user_ns_hidden)
    out = []
    for name, value in list(shell.user_ns.items()):
        if name.startswith('_') or name in hidden or name in ('In', 'Out', 'exit', 'quit', 'get_ipython', 'open'):
            continue
        if isinstance(value, (types.ModuleType, types.FunctionType, types.BuiltinFunctionType, type)):
            continue
        kind = type(value).__name__
        try:
            shape = getattr(value, 'shape', None)
            if shape is not None and isinstance(shape, tuple):
                kind += ' ' + ' × '.join(str(n) for n in shape)
            elif hasattr(value, '__len__') and not isinstance(value, str):
                kind += ' (%d)' % len(value)
        except Exception:
            pass
        try:
            text = repr(value)
        except Exception:
            text = '<unprintable>'
        text = ' '.join(text.split())
        out.append({'name': name, 'type': kind, 'value': text[:160]})
        if len(out) >= 300:
            break
    return base64.b64encode(json.dumps(out).encode()).decode()
__sumi_r__ = __sumi_vars__()
del __sumi_vars__
`;

async function fetchVariables(): Promise<Variable[] | null> {
  const conn = currentConnection();
  if (!conn || conn.closed || kernelLanguage() !== 'python') return null;
  try {
    const reply = await conn.request('execute_request', {
      code: VARIABLES_PROBE,
      silent: true,
      store_history: false,
      user_expressions: { sumi: "globals().pop('__sumi_r__', '')" },
      allow_stdin: false,
      stop_on_error: false,
    }).done;
    const text: string | undefined = reply.content?.user_expressions?.sumi?.data?.['text/plain'];
    if (!text) return [];
    const bytes = Uint8Array.from(atob(text.replace(/^['"]|['"]$/g, '')), (char) => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as Variable[];
  } catch {
    return null;
  }
}

function Variables() {
  const [variables, setVariables] = createSignal<Variable[] | null>(null);
  let disposed = false;
  onCleanup(() => (disposed = true));

  // Refresh when a run finishes or a new kernel comes up. The probe itself makes the kernel
  // briefly busy, so the raw status must not be a dependency here.
  const alive = createMemo(() => kernel.status() !== 'none' && kernel.status() !== 'dead');
  createEffect(() => {
    kernel.generation();
    if (!alive()) {
      setVariables(null);
      return;
    }
    if (execution.busyCount() > 0) return;
    void fetchVariables().then((result) => {
      if (!disposed) setVariables(result);
    });
  });

  return (
    <Show
      when={variables()}
      fallback={
        <div class="pane-empty">
          {kernelLanguage() === 'python' ? 'Run a cell to see the variables the kernel holds.' : 'Variables are available for Python kernels.'}
        </div>
      }
    >
      {(items) => (
        <Show when={items().length} fallback={<div class="pane-empty">No variables defined yet.</div>}>
          <For each={items()}>
            {(variable) => (
              <div class="var-row" data-row tabindex={-1} title={`${variable.name}: ${variable.type}\n${variable.value}`}>
                <span class="var-name">{variable.name}</span>
                <span class="var-type">{variable.type}</span>
                <span class="var-value">{variable.value}</span>
              </div>
            )}
          </For>
        </Show>
      )}
    </Show>
  );
}

// ── Shell ───────────────────────────────────────────────────────────────────

const TABS = [
  ['outline', 'Outline'],
  ['files', 'Files'],
  ['variables', 'Variables'],
] as const;

export function Sidebar() {
  let pane!: HTMLDivElement;

  const startResize = (down: PointerEvent) => {
    down.preventDefault();
    const origin = down.clientX;
    const initial = prefs.sidebarWidth;
    const onMove = (event: PointerEvent) => setPref('sidebarWidth', clamp(initial + event.clientX - origin, 180, 420));
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.cursor = '';
    };
    document.body.style.cursor = 'col-resize';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  // ── Keyboard ──

  const rows = () => [...pane.querySelectorAll<HTMLElement>('[data-row]')];
  const focusRow = (row: HTMLElement | undefined) => {
    if (!row) return;
    row.focus({ preventScroll: true });
    row.scrollIntoView({ block: 'nearest' });
  };

  // Takes the keyboard when asked (⌃⌘1…3): onto the row for where you are — this section,
  // this file — or the first one. A pane that is still loading is tried again shortly.
  let retry: ReturnType<typeof setTimeout> | undefined;
  const settle = (attempt: number) => {
    const all = rows();
    if (all.length) {
      focusRow(pane.querySelector<HTMLElement>('[data-row].current') ?? all[0]);
    } else {
      pane.focus({ preventScroll: true });
      if (attempt < 6) retry = setTimeout(() => document.activeElement === pane && settle(attempt + 1), 80);
    }
  };
  createEffect(
    on(surfaces.sidebarFocus, () => {
      if (!surfaces.takeSidebarFocus()) return;
      clearTimeout(retry);
      queueMicrotask(() => settle(0));
    }),
  );
  onCleanup(() => clearTimeout(retry));

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
    const all = rows();
    const at = all.indexOf(document.activeElement as HTMLElement);
    const row = all[at];
    switch (event.key) {
      case 'ArrowDown':
      case 'j':
        focusRow(all[Math.min(at + 1, all.length - 1)]);
        break;
      case 'ArrowUp':
      case 'k':
        focusRow(all[Math.max(at - 1, 0)]);
        break;
      case 'Home':
        focusRow(all[0]);
        break;
      case 'End':
        focusRow(all[all.length - 1]);
        break;
      case 'ArrowRight':
        // Into a folder: open it, or step to its first entry if it is open already.
        if (row?.dataset.folder === 'closed') row.click();
        else if (row?.dataset.folder === 'open') focusRow(all[at + 1]);
        break;
      case 'ArrowLeft': {
        // Out of a folder: close it, or step up to the folder this entry is in.
        if (row?.dataset.folder === 'open') {
          row.click();
        } else if (row?.dataset.depth) {
          const depth = Number(row.dataset.depth);
          for (let i = at - 1; i >= 0; i--) {
            if (Number(all[i].dataset.depth) < depth) {
              focusRow(all[i]);
              break;
            }
          }
        }
        break;
      }
      case 'Tab': {
        const order = TABS.map(([id]) => id);
        const next = order[(order.indexOf(prefs.sidebarTab) + (event.shiftKey ? order.length - 1 : 1)) % order.length];
        setPref('sidebarTab', next);
        surfaces.focusSidebar();
        break;
      }
      case 'Escape':
        enterCommandMode();
        break;
      default:
        return; // Return and Space press the focused row, as for any button.
    }
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <aside class="sidebar" style={{ width: `${prefs.sidebarWidth}px` }} onKeyDown={onKeyDown}>
      <div
        class="sidebar-head"
        onMouseDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          if (event.detail === 2) void call('window.zoom').catch(() => {});
          else void call('window.startDrag').catch(() => {});
        }}
      />
      <div class="sidebar-tabs">
        <For each={TABS}>
          {([id, label]) => (
            <button
              class="sidebar-tab"
              classList={{ active: prefs.sidebarTab === id }}
              tabindex={-1}
              onMouseDown={keepFocus}
              onClick={() => setPref('sidebarTab', id)}
            >
              {label}
            </button>
          )}
        </For>
      </div>
      <div class="pane-scroll" ref={pane} tabindex={-1}>
        <Show when={prefs.sidebarTab === 'outline'}>
          <Outline />
        </Show>
        <Show when={prefs.sidebarTab === 'files'}>
          <Files />
        </Show>
        <Show when={prefs.sidebarTab === 'variables'}>
          <Variables />
        </Show>
      </div>
      <div class="sidebar-resizer" onPointerDown={startResize} />
    </aside>
  );
}
