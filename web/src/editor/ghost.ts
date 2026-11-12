// Inline completion. The likeliest ending of the name being typed appears faintly after the
// caret: Tab (or → at the end of a line) takes it, and typing on simply ignores it. Nothing
// pops up and nothing takes a key away — the list of every possibility is there on request
// (see completion.ts), not by default.

import { syntaxTree } from '@codemirror/language';
import { type EditorState, StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view';

interface Ghost {
  pos: number;
  text: string;
}

/** Where a suggestion would go, and what has been typed of the name so far. */
export interface GhostContext {
  pos: number;
  /** The part of the identifier before the caret. */
  name: string;
  /** Whether it follows a dot (an attribute) rather than standing alone. */
  dotted: boolean;
}

/** Resolves to the rest of the name — what to show after the caret — or null for nothing. */
export type GhostSource = (state: EditorState, context: GhostContext) => Promise<string | null>;

const setGhost = StateEffect.define<Ghost | null>();

class GhostWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  eq(other: GhostWidget) {
    return other.text === this.text;
  }
  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-ghost';
    span.textContent = this.text;
    return span;
  }
  ignoreEvent() {
    return true;
  }
}

const ghostField = StateField.define<Ghost | null>({
  create: () => null,
  update(ghost, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setGhost)) return effect.value;
    }
    if (!ghost) return null;
    if (transaction.docChanged) {
      // Typing the very characters on offer walks into the suggestion instead of losing it.
      let rest: Ghost | null = null;
      let changes = 0;
      transaction.changes.iterChanges((from, to, _fromB, _toB, inserted) => {
        changes++;
        const typed = inserted.toString();
        if (from === ghost.pos && to === ghost.pos && typed && ghost.text.startsWith(typed) && ghost.text.length > typed.length) {
          rest = { pos: ghost.pos + typed.length, text: ghost.text.slice(typed.length) };
        }
      });
      const caret = transaction.newSelection.main;
      const kept = rest as Ghost | null;
      return changes === 1 && kept && caret.empty && caret.head === kept.pos ? kept : null;
    }
    // The caret went somewhere else.
    return transaction.selection ? null : ghost;
  },
  provide: (field) =>
    EditorView.decorations.from(field, (ghost) =>
      ghost ? Decoration.set([Decoration.widget({ widget: new GhostWidget(ghost.text), side: 1 }).range(ghost.pos)]) : Decoration.none,
    ),
});

/**
 * Whether the caret is somewhere a suggestion makes sense: at the end of a name of a couple
 * of letters (one is enough after a dot), with no more of the word to its right, and not
 * inside a comment or a string.
 */
function contextAt(state: EditorState): GhostContext | null {
  const selection = state.selection;
  if (selection.ranges.length !== 1 || !selection.main.empty) return null;
  const pos = selection.main.head;
  const line = state.doc.lineAt(pos);
  const before = line.text.slice(0, pos - line.from);
  if (/^\w/.test(line.text.slice(pos - line.from))) return null;
  const name = /\w*$/.exec(before)![0];
  const dotted = before.slice(0, before.length - name.length).endsWith('.');
  if (name.length < (dotted ? 1 : 2) || /^\d/.test(name)) return null;
  for (let node: { name: string; parent: unknown } | null = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent as typeof node) {
    if (/comment|string/i.test(node.name)) return null;
  }
  return { pos, name, dotted };
}

/** How long the typing must pause before a suggestion is looked for. */
const PAUSE_MS = 90;

function asker(source: GhostSource) {
  return ViewPlugin.fromClass(
    class {
      private timer: ReturnType<typeof setTimeout> | undefined;
      private serial = 0;

      constructor(private readonly view: EditorView) {}

      update(update: ViewUpdate) {
        if (!update.docChanged && !update.selectionSet && !update.focusChanged) return;
        clearTimeout(this.timer);
        this.serial++;
        // Only typing asks; moving about, pasting and undoing do not.
        const typing = update.transactions.some((transaction) => transaction.isUserEvent('input.type') || transaction.isUserEvent('delete.backward'));
        if (!typing || update.view.composing || update.state.field(ghostField)) return;
        const serial = this.serial;
        this.timer = setTimeout(() => void this.ask(serial), PAUSE_MS);
      }

      private async ask(serial: number) {
        const view = this.view;
        const state = view.state;
        const context = contextAt(state);
        if (!context || !view.hasFocus) return;
        const text = await source(state, context).catch(() => null);
        // Whatever has happened since, the answer was for then.
        if (!text || serial !== this.serial || view.state.doc !== state.doc || !view.state.selection.eq(state.selection)) return;
        view.dispatch({ effects: setGhost.of({ pos: context.pos, text }) });
      }

      destroy() {
        clearTimeout(this.timer);
      }
    },
  );
}

/** Takes the suggestion on show, if there is one. */
export function acceptGhost(view: EditorView): boolean {
  const ghost = view.state.field(ghostField, false);
  if (!ghost) return false;
  view.dispatch({
    changes: { from: ghost.pos, insert: ghost.text },
    selection: { anchor: ghost.pos + ghost.text.length },
    effects: setGhost.of(null),
    userEvent: 'input.complete',
    scrollIntoView: true,
  });
  return true;
}

/** Puts the suggestion away (when the full list is about to be shown instead). */
export function dismissGhost(view: EditorView) {
  if (view.state.field(ghostField, false)) view.dispatch({ effects: setGhost.of(null) });
}

/** → takes the suggestion too, where it could not mean anything else: at the end of the line. */
export function acceptGhostAtLineEnd(view: EditorView): boolean {
  const ghost = view.state.field(ghostField, false);
  if (!ghost || view.state.doc.lineAt(ghost.pos).to !== ghost.pos) return false;
  return acceptGhost(view);
}

export function ghostExtension(source: GhostSource): Extension {
  return [
    ghostField,
    asker(source),
    EditorView.domEventHandlers({
      blur(_event, view) {
        dismissGhost(view);
      },
    }),
  ];
}
