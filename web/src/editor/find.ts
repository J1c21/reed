// Find-in-notebook support inside editors: highlights for every match of the notebook-wide
// query, and a stronger mark on the current one.

import { RangeSetBuilder, StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view';

export interface FindQuery {
  text: string;
  caseSensitive: boolean;
}

/** The query currently shown by the find bar; new editors pick it up when they mount. */
let activeQuery: FindQuery | null = null;

export const setFindQuery = StateEffect.define<FindQuery | null>();
export const setFindCurrent = StateEffect.define<{ from: number; to: number } | null>();

const matchMark = Decoration.mark({ class: 'cm-find-match' });
const currentMark = Decoration.mark({ class: 'cm-find-current' });

export function findInText(text: string, query: FindQuery): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  if (!query.text) return out;
  const haystack = query.caseSensitive ? text : text.toLowerCase();
  const needle = query.caseSensitive ? query.text : query.text.toLowerCase();
  let at = haystack.indexOf(needle);
  while (at >= 0 && out.length < 5000) {
    out.push({ from: at, to: at + needle.length });
    at = haystack.indexOf(needle, at + needle.length);
  }
  return out;
}

interface FindState {
  query: FindQuery | null;
  current: { from: number; to: number } | null;
  decorations: DecorationSet;
}

function build(text: string, query: FindQuery | null, current: FindState['current']): DecorationSet {
  if (!query?.text) return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();
  for (const match of findInText(text, query)) {
    const isCurrent = current && current.from === match.from && current.to === match.to;
    builder.add(match.from, match.to, isCurrent ? currentMark : matchMark);
  }
  return builder.finish();
}

const findField = StateField.define<FindState>({
  create(state) {
    return { query: activeQuery, current: null, decorations: build(state.doc.toString(), activeQuery, null) };
  },
  update(value, transaction) {
    let { query, current } = value;
    let changed = transaction.docChanged;
    for (const effect of transaction.effects) {
      if (effect.is(setFindQuery)) {
        query = effect.value;
        current = null;
        changed = true;
      } else if (effect.is(setFindCurrent)) {
        current = effect.value;
        changed = true;
      }
    }
    if (!changed) return value;
    if (transaction.docChanged && current) current = null;
    return { query, current, decorations: build(transaction.state.doc.toString(), query, current) };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

export function findExtension(): Extension {
  return findField;
}

export function setActiveFindQuery(query: FindQuery | null) {
  activeQuery = query;
}
