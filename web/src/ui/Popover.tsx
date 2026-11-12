// Pop-up menus: a floating panel that takes the keyboard while it is open — arrows move,
// Return chooses, a letter jumps to the entry that starts with it, Escape dismisses.

import { createSignal, For, type JSX, onCleanup, onMount, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import { command, runCommand } from '../notebook/commands';
import { displayKeys } from '../notebook/keymap';
import { surfaces } from '../state/surfaces';
import { Check } from './icons';

export interface Anchor {
  /** Viewport coordinates of the anchoring corner. */
  x: number;
  y: number;
  /** Which corner of the popover sits at the anchor. */
  align?: 'left' | 'right';
}

export function anchorBelow(element: Element, align: 'left' | 'right' = 'left'): Anchor {
  const rect = element.getBoundingClientRect();
  return { x: align === 'left' ? rect.left : rect.right, y: rect.bottom + 4, align };
}

export function Popover(props: {
  anchor: Anchor;
  onClose: () => void;
  /** Keys other than Escape. The panel owns the keyboard, so nothing reaches the notebook. */
  onKey?: (event: KeyboardEvent) => void;
  children: JSX.Element;
  class?: string;
  width?: number;
}) {
  let panel!: HTMLDivElement;
  const [position, setPosition] = createSignal<JSX.CSSProperties>({ visibility: 'hidden' });

  onMount(() => {
    // Keep the panel on screen.
    const rect = panel.getBoundingClientRect();
    const margin = 8;
    let left = props.anchor.align === 'right' ? props.anchor.x - rect.width : props.anchor.x;
    left = Math.max(margin, Math.min(left, window.innerWidth - rect.width - margin));
    let top = props.anchor.y;
    if (top + rect.height > window.innerHeight - margin) top = Math.max(margin, window.innerHeight - rect.height - margin);
    setPosition({
      left: `${left}px`,
      top: `${top}px`,
      'transform-origin': props.anchor.align === 'right' ? 'top right' : 'top left',
    });

    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      // A ⌘ shortcut is meant for the app: the menu steps aside and lets it through.
      if (event.metaKey) {
        props.onClose();
        return;
      }
      event.stopPropagation();
      event.preventDefault();
      if (event.key === 'Escape') props.onClose();
      else props.onKey?.(event);
    };
    window.addEventListener('keydown', onKey, true);
    surfaces.menuOpened();
    onCleanup(() => {
      window.removeEventListener('keydown', onKey, true);
      surfaces.menuClosed();
    });
  });

  return (
    <Portal>
      <div
        class="backdrop"
        onMouseDown={(event) => {
          event.preventDefault();
          props.onClose();
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          props.onClose();
        }}
      />
      <div
        ref={panel}
        class={`popover ${props.class ?? ''}`}
        style={{ ...position(), width: props.width ? `${props.width}px` : undefined }}
        onMouseDown={(event) => {
          // Keep focus (and the text selection) where it was.
          if (!(event.target as HTMLElement).closest('input')) event.preventDefault();
        }}
      >
        {props.children}
      </div>
    </Portal>
  );
}

export type MenuEntry =
  | { kind: 'command'; id: string; title?: string }
  | { kind: 'action'; title: string; run: () => void; checked?: boolean; disabled?: boolean; hint?: string }
  | { kind: 'separator' }
  | { kind: 'heading'; title: string };

export const cmd = (id: string, title?: string): MenuEntry => ({ kind: 'command', id, title });
export const separator: MenuEntry = { kind: 'separator' };

/** A menu entry reduced to what is needed to show it and to run it. */
interface Row {
  title: string;
  run: () => void;
  disabled: boolean;
  checked: boolean;
  keys?: string;
  hint?: string;
}

function resolve(entry: MenuEntry): Row | null {
  if (entry.kind === 'action') {
    return { title: entry.title, run: entry.run, disabled: !!entry.disabled, checked: !!entry.checked, hint: entry.hint };
  }
  if (entry.kind !== 'command') return null;
  const definition = command(entry.id);
  if (!definition) return null;
  return {
    title: entry.title ?? definition.title,
    run: () => runCommand(entry.id),
    disabled: definition.enabled ? !definition.enabled() : false,
    checked: definition.checked?.() ?? false,
    keys: definition.keys,
  };
}

export function Menu(props: { anchor: Anchor; entries: MenuEntry[]; onClose: () => void }) {
  const rows = props.entries.map(resolve);
  const choosable = rows.flatMap((row, index) => (row && !row.disabled ? [index] : []));
  // One highlight, moved by the arrow keys and by the pointer alike.
  const [focused, setFocused] = createSignal(-1);

  // Only real movement counts: a menu that opens under a resting pointer highlights nothing.
  let pointer: { x: number; y: number } | null = null;
  const onPointer = (event: MouseEvent, index: number) => {
    const moved = pointer !== null && (pointer.x !== event.screenX || pointer.y !== event.screenY);
    pointer = { x: event.screenX, y: event.screenY };
    if (moved) setFocused(index);
  };

  const pick = (row: Row | null | undefined) => {
    if (!row || row.disabled) return;
    props.onClose();
    // Let the menu disappear before the command changes the layout.
    queueMicrotask(row.run);
  };

  const step = (delta: number) => {
    if (!choosable.length) return;
    const at = choosable.indexOf(focused());
    const next = at < 0 ? (delta > 0 ? 0 : choosable.length - 1) : (at + delta + choosable.length) % choosable.length;
    setFocused(choosable[next]);
  };

  const onKey = (event: KeyboardEvent) => {
    const key = event.key;
    if (key === 'ArrowDown' || (event.ctrlKey && key === 'n')) step(1);
    else if (key === 'ArrowUp' || (event.ctrlKey && key === 'p')) step(-1);
    else if (key === 'Home') setFocused(choosable[0] ?? -1);
    else if (key === 'End') setFocused(choosable[choosable.length - 1] ?? -1);
    else if (key === 'Enter' || key === ' ') pick(rows[focused()]);
    else if (key.length === 1 && !event.ctrlKey && !event.altKey) {
      // Type a letter to jump to the next entry that starts with it.
      const from = choosable.indexOf(focused());
      const order = [...choosable.slice(from + 1), ...choosable.slice(0, from + 1)];
      const match = order.find((index) => rows[index]!.title.toLowerCase().startsWith(key.toLowerCase()));
      if (match !== undefined) setFocused(match);
    }
  };

  return (
    <Popover anchor={props.anchor} onClose={props.onClose} onKey={onKey}>
      <div onMouseLeave={() => setFocused(-1)}>
        <For each={props.entries}>
          {(entry, i) => {
            if (entry.kind === 'separator') return <div class="menu-separator" />;
            if (entry.kind === 'heading') return <div class="menu-heading">{entry.title}</div>;
            const row = rows[i()];
            if (!row) return null;
            return (
              <button
                class="menu-item"
                classList={{ focused: focused() === i() }}
                disabled={row.disabled}
                tabindex={-1}
                onMouseMove={(event) => onPointer(event, i())}
                onClick={() => pick(row)}
              >
                <span class="check">
                  <Show when={row.checked}>
                    <Check />
                  </Show>
                </span>
                <span class="grow">{row.title}</span>
                <Show when={row.keys ?? row.hint}>
                  <span class="hint">{row.keys ? displayKeys(row.keys).join(' ') : row.hint}</span>
                </Show>
              </button>
            );
          }}
        </For>
      </div>
    </Popover>
  );
}
