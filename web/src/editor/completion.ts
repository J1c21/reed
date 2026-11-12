// Completion and introspection backed by the running kernel, with a local fallback.
//
// Completion comes in two forms. By default it is a quiet one: the likeliest ending of the
// name being typed, shown faintly after the caret (ghost.ts) — Tab takes it. The list of
// every possibility is shown only when asked for (⌥esc, or Tab where there is nothing to
// suggest), or as you type if "Completion List While Typing" is switched on.

import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
  startCompletion,
} from '@codemirror/autocomplete';
import { globalCompletion, localCompletionSource } from '@codemirror/lang-python';
import { type EditorState, StateEffect, StateField, type Extension } from '@codemirror/state';
import { EditorView, showTooltip, type Tooltip } from '@codemirror/view';
import type { KernelConnection, KernelMessage } from '../kernel/connection';
import { currentConnection, kernel, kernelLanguage } from '../kernel/kernel';
import { notebook } from '../notebook/store';
import { renderAnsi } from '../render/ansi';
import { codePointToUtf16, utf16ToCodePoint } from '../util/misc';
import { dismissGhost, ghostExtension, type GhostContext } from './ghost';

// ── Asking the kernel ───────────────────────────────────────────────────────

/** What the kernel calls a kind of name, in the word shown beside it in the list. */
const KIND: Record<string, string> = {
  function: 'function',
  module: 'module',
  class: 'class',
  param: 'parameter',
  property: 'property',
  keyword: 'keyword',
  path: 'path',
  magic: 'magic',
  'dict key': 'key',
};

// Only one completion request is in flight at a time; while it is, only the newest waits.
let inFlight = false;
let waiting: { run: () => void; cancel: () => void } | null = null;

function requestCompletion(conn: KernelConnection, code: string, cursor: number): Promise<KernelMessage | null> {
  const send = (): Promise<KernelMessage | null> => {
    inFlight = true;
    const request = conn.request('complete_request', { code, cursor_pos: cursor });
    const timeout = new Promise<null>((resolve) =>
      setTimeout(() => {
        conn.forget(request.msgId);
        resolve(null);
      }, 4000),
    );
    return Promise.race([request.done.catch(() => null), timeout]).finally(() => {
      inFlight = false;
      const next = waiting;
      waiting = null;
      next?.run();
    });
  };
  if (!inFlight) return send();
  waiting?.cancel();
  return new Promise((resolve) => {
    waiting = { run: () => send().then(resolve), cancel: () => resolve(null) };
  });
}

interface Matches {
  /** Where the text being completed starts. */
  from: number;
  /** The names on offer, in the kernel's order, each to replace the text from `from`. */
  entries: { text: string; kind?: string }[];
  /** Whether every entry is the bare name after the last dot (so typing on only narrows the list). */
  bare: boolean;
}

/** The kernel's completions at a position — null if it has none, or is busy and cannot say. */
async function kernelMatches(state: EditorState, pos: number): Promise<Matches | null> {
  const conn = currentConnection();
  // A busy kernel answers only after the running cell finishes, so do not wait for it.
  if (!conn || conn.closed || kernel.status() !== 'idle') return null;
  const code = state.doc.toString();
  const reply = await requestCompletion(conn, code, utf16ToCodePoint(code, pos));
  const content = reply?.content;
  if (!content || content.status !== 'ok' || !Array.isArray(content.matches) || content.matches.length === 0) return null;

  let from = codePointToUtf16(code, content.cursor_start ?? 0);
  const typed: { text: string; type?: string }[] | undefined = content.metadata?._jupyter_types_experimental;
  let entries = (content.matches as string[]).map((text, i) => ({ text, kind: typed?.[i]?.type }));

  // IPython may answer "df.he" with "df.head". Keep just "head", from the start of the word.
  const line = state.doc.lineAt(pos);
  const wordStart = pos - /\w*$/.exec(line.text.slice(0, pos - line.from))![0].length;
  let bare = false;
  if (wordStart >= from) {
    const prefix = code.slice(from, wordStart);
    if (entries.every((entry) => entry.text.startsWith(prefix))) {
      entries = entries.map((entry) => ({ ...entry, text: entry.text.slice(prefix.length) }));
      from = wordStart;
      bare = true;
    }
  }
  entries = entries.filter((entry) => entry.text.length > 0);
  return entries.length ? { from, entries, bare } : null;
}

// ── The quiet form: one suggestion after the caret ──────────────────────────

const PYTHON_WORDS = (
  'False None True and as assert async await break class continue def del elif else except finally for from global if ' +
  'import in is lambda nonlocal not or pass raise return try while with yield ' +
  'print len range list dict set tuple str int float bool open enumerate zip map filter sorted reversed sum min max abs ' +
  'round isinstance type super property staticmethod classmethod Exception ValueError TypeError KeyError IndexError'
).split(' ');

/** How often each name is written in the notebook's code — what you use, you are likely to want again. */
function namesInUse(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const cell of notebook.cells()) {
    if (!cell.isCode) continue;
    for (const word of cell.state.source.match(/[A-Za-z_]\w{2,}/g) ?? []) counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return counts;
}

/**
 * The ending to offer for the name being typed. Candidates come from the kernel when it is
 * free to answer, else from the notebook's own text. Among them, a name the notebook already
 * uses wins; after that the kernel's order decides. If what is typed is a complete name
 * already, nothing is offered.
 */
async function suggestEnding(state: EditorState, context: GhostContext): Promise<string | null> {
  const used = namesInUse();
  const matches = await kernelMatches(state, context.pos);
  let names: string[];
  let typed = context.name;
  if (matches) {
    typed = state.sliceDoc(matches.from, context.pos);
    names = matches.entries.map((entry) => entry.text);
  } else {
    // No kernel to ask: names already in the notebook, and the language's own words. (The
    // word being typed is in the notebook too, once; that one does not count.)
    const own = used.get(typed) ?? 0;
    if (own > 1) used.set(typed, own - 1);
    else used.delete(typed);
    names = [...used.keys()];
    if (!context.dotted && kernelLanguage() === 'python') names.push(...PYTHON_WORDS);
  }
  if (!typed) return null;
  let best: string | null = null;
  let bestScore = -Infinity;
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    if (!name.startsWith(typed)) continue;
    if (name === typed) return null;
    if (name.startsWith('_') && !typed.startsWith('_')) continue;
    const score = Math.min(used.get(name) ?? 0, 9) * 1000 - (matches ? i : name.length);
    if (score > bestScore) {
      bestScore = score;
      best = name;
    }
  }
  return best ? best.slice(typed.length) : null;
}

// ── The full form: the list ─────────────────────────────────────────────────

async function localCompletions(context: CompletionContext): Promise<CompletionResult | null> {
  if (kernelLanguage() !== 'python') return null;
  const [local, global] = await Promise.all([localCompletionSource(context), globalCompletion(context)]);
  if (local && global && local.from === global.from) {
    const seen = new Set(local.options.map((option) => option.label));
    return { ...global, options: [...local.options, ...global.options.filter((option) => !seen.has(option.label))] };
  }
  return local ?? global;
}

const kernelCompletions: CompletionSource = async (context) => {
  if (!context.explicit) {
    const word = context.matchBefore(/[\w.%]+$/);
    // Do not pop up on nothing, after a number, or in the middle of a float.
    if (!word || /^[\d.]+$/.test(word.text)) return null;
  }
  const matches = await kernelMatches(context.state, context.pos);
  if (context.aborted) return null;
  if (!matches) return context.explicit || kernel.status() !== 'idle' ? localCompletions(context) : null;

  // Asked for outright, a single possibility needs no list: it is simply filled in.
  if (context.explicit && matches.entries.length === 1 && context.view) {
    const only = matches.entries[0].text;
    context.view.dispatch({
      changes: { from: matches.from, to: context.pos, insert: only },
      selection: { anchor: matches.from + only.length },
      userEvent: 'input.complete',
    });
    return null;
  }

  const options: Completion[] = matches.entries.map((entry, i) => ({
    label: entry.text,
    detail: entry.kind ? KIND[entry.kind] : undefined,
    // Keep the kernel's ranking, but push private names down.
    boost: (entry.text.startsWith('_') ? -50 : 0) - Math.min(i, 40) * 0.5,
  }));
  return { from: matches.from, to: context.pos, options, validFor: matches.bare ? /^\w*$/ : undefined };
};

/** Shows every completion at the caret (and puts the single suggestion away). */
export function showCompletions(view: EditorView): boolean {
  dismissGhost(view);
  return startCompletion(view);
}

/**
 * Completion for a code cell. `list` is the "Completion List While Typing" preference: off,
 * typing shows one faint suggestion and the list comes only on request; on, the list follows
 * the typing and the faint suggestion is not used.
 */
export function completionExtension(list: boolean): Extension {
  return [
    autocompletion({
      override: [kernelCompletions],
      activateOnTyping: list,
      activateOnTypingDelay: 120,
      icons: false,
      maxRenderedOptions: 60,
      defaultKeymap: false,
      // A list that came uninvited must not take Return away from the line being typed.
      selectOnOpen: !list,
    }),
    list ? [] : ghostExtension(suggestEnding),
  ];
}

// ── Introspection tooltip (Shift-Tab) ───────────────────────────────────────

const setInspection = StateEffect.define<Tooltip | null>();

const inspectionField = StateField.define<Tooltip | null>({
  create: () => null,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setInspection)) return effect.value;
    }
    // Any edit or cursor movement dismisses the tooltip.
    if (value && (transaction.docChanged || transaction.selection)) return null;
    return value;
  },
  provide: (field) => showTooltip.from(field),
});

export function inspectionExtension(): Extension {
  return [
    inspectionField,
    EditorView.domEventHandlers({
      blur(_event, view) {
        if (view.state.field(inspectionField, false)) view.dispatch({ effects: setInspection.of(null) });
      },
    }),
  ];
}

export function hasInspection(view: EditorView): boolean {
  return !!view.state.field(inspectionField, false);
}

export function closeInspection(view: EditorView): boolean {
  if (!hasInspection(view)) return false;
  view.dispatch({ effects: setInspection.of(null) });
  return true;
}

/** Asks the kernel about the object under the cursor and shows its signature and docstring. */
export async function inspectAtCursor(view: EditorView): Promise<boolean> {
  const conn = currentConnection();
  if (!conn || conn.closed || kernel.status() !== 'idle') return false;
  const code = view.state.doc.toString();
  const position = view.state.selection.main.head;
  const request = conn.request('inspect_request', {
    code,
    cursor_pos: utf16ToCodePoint(code, position),
    detail_level: 0,
  });
  const reply = await Promise.race([
    request.done.catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
  ]);
  if (!reply) {
    conn.forget(request.msgId);
    return false;
  }
  const text: string | undefined = reply.content?.data?.['text/plain'];
  if (!reply.content?.found || !text) return false;
  if (view.state.selection.main.head !== position || view.state.doc.toString() !== code) return false;

  view.dispatch({
    effects: setInspection.of({
      pos: position,
      above: false,
      strictSide: false,
      arrow: false,
      create() {
        const dom = document.createElement('div');
        dom.className = 'inspect-tooltip';
        const body = document.createElement('pre');
        body.append(renderAnsi(text.replace(/\n+$/, '')));
        dom.append(body);
        return { dom };
      },
    }),
  });
  return true;
}
