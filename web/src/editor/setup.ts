// CodeMirror configuration shared by every cell editor.
//
// All colours come from CSS variables, so switching appearance or theme never touches
// CodeMirror — the stylesheet does the work.

import {
  acceptCompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  completionStatus,
  moveCompletionSelection,
} from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentLess, indentMore, insertNewlineAndIndent } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import {
  bracketMatching,
  HighlightStyle,
  indentOnInput,
  indentUnit,
  LanguageDescription,
  syntaxHighlighting,
  type LanguageSupport,
} from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { highlightSelectionMatches } from '@codemirror/search';
import { Compartment, EditorState, type Extension, Prec } from '@codemirror/state';
import {
  crosshairCursor,
  Decoration,
  type DecorationSet,
  drawSelection,
  dropCursor,
  EditorView,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  placeholder,
  rectangularSelection,
  tooltips,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { showCompletions } from './completion';
import { findExtension } from './find';
import { acceptGhost, acceptGhostAtLineEnd } from './ghost';

// ── Theme ───────────────────────────────────────────────────────────────────

const theme = EditorView.theme({
  '&': {
    color: 'var(--text)',
    backgroundColor: 'transparent',
    fontSize: 'var(--code-size)',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
    lineHeight: 'var(--code-leading)',
    overflowX: 'auto',
    // CodeMirror's default of 100% makes WebKit add 10px of phantom height to an
    // auto-height editor, leaving every cell bottom-heavy.
    height: 'auto',
  },
  '.cm-content': {
    padding: 'var(--cell-pad-y) 0',
    caretColor: 'var(--caret)',
    fontVariantLigatures: 'none',
    // The page as a whole uses the arrow (it is an app, not a document), and the pointer's
    // shape is inherited — so text that can be typed in has to ask for its I-beam back.
    cursor: 'text',
  },
  '.cm-line': { padding: '0 var(--cell-pad-x)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--caret)', borderLeftWidth: '1.5px' },
  '.cm-selectionBackground': { backgroundColor: 'var(--selection-inactive)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
    backgroundColor: 'var(--selection)',
  },
  '.cm-selectionMatch': { backgroundColor: 'var(--selection-match)', borderRadius: '2px' },
  '&.cm-focused .cm-matchingBracket': {
    backgroundColor: 'var(--bracket-match)',
    outline: 'none',
    borderRadius: '2px',
  },
  '&.cm-focused .cm-nonmatchingBracket': { backgroundColor: 'transparent', color: 'var(--error)' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    border: 'none',
    color: 'var(--text-3)',
    fontFamily: 'var(--font-mono)',
    cursor: 'default',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    padding: '0 2px 0 12px',
    minWidth: '30px',
    fontSize: '11px',
    fontVariantNumeric: 'tabular-nums',
  },
  '.cm-placeholder': { color: 'var(--text-3)', fontStyle: 'normal' },
  '.cm-specialChar': { color: 'var(--error)' },
});

const codeHighlight = HighlightStyle.define([
  { tag: t.keyword, color: 'var(--syn-keyword)' },
  { tag: [t.bool, t.null, t.atom], color: 'var(--syn-constant)' },
  { tag: t.number, color: 'var(--syn-number)' },
  { tag: [t.string, t.special(t.string), t.character], color: 'var(--syn-string)' },
  { tag: [t.escape, t.regexp], color: 'var(--syn-escape)' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--syn-function)' },
  { tag: t.function(t.definition(t.variableName)), color: 'var(--syn-function)', fontWeight: '500' },
  { tag: [t.className, t.definition(t.className), t.typeName, t.namespace], color: 'var(--syn-type)' },
  { tag: [t.self, t.special(t.variableName)], color: 'var(--syn-self)', fontStyle: 'italic' },
  { tag: [t.operator, t.derefOperator], color: 'var(--syn-operator)' },
  { tag: [t.punctuation, t.separator, t.bracket], color: 'var(--syn-punctuation)' },
  { tag: [t.meta, t.annotation, t.processingInstruction], color: 'var(--syn-meta)' },
  { tag: [t.tagName, t.attributeName], color: 'var(--syn-keyword)' },
  { tag: t.attributeValue, color: 'var(--syn-string)' },
  { tag: t.invalid, color: 'var(--error)' },
]);

// In markdown cells the source is styled to resemble the rendered result — headings at their
// real size, emphasis shown, markup characters dimmed — so toggling between the two is calm.
const markdownHighlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: 'var(--h1)', fontWeight: '650', lineHeight: '1.3' },
  { tag: t.heading2, fontSize: 'var(--h2)', fontWeight: '600', lineHeight: '1.35' },
  { tag: t.heading3, fontSize: 'var(--h3)', fontWeight: '600', lineHeight: '1.4' },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: '600' },
  { tag: t.strong, fontWeight: '600' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through', color: 'var(--text-2)' },
  { tag: t.link, color: 'var(--link)' },
  { tag: t.url, color: 'var(--text-3)' },
  { tag: t.monospace, fontFamily: 'var(--font-mono)', fontSize: '0.88em', color: 'var(--syn-string)' },
  { tag: t.quote, color: 'var(--text-2)' },
  { tag: [t.processingInstruction, t.contentSeparator], color: 'var(--text-3)', fontWeight: '400' },
  { tag: t.labelName, color: 'var(--text-3)' },
  { tag: t.keyword, color: 'var(--syn-keyword)' },
  { tag: [t.bool, t.null, t.atom], color: 'var(--syn-constant)' },
  { tag: t.number, color: 'var(--syn-number)' },
  { tag: [t.string, t.special(t.string)], color: 'var(--syn-string)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--syn-function)' },
  { tag: [t.className, t.typeName], color: 'var(--syn-type)' },
]);

export const codeHighlightStyle = codeHighlight;

const markdownTheme = EditorView.theme({
  '.cm-scroller': {
    fontFamily: 'var(--font-prose)',
    fontSize: 'var(--prose-size)',
    lineHeight: 'var(--prose-leading)',
  },
  '.cm-content': { padding: '0', fontVariantLigatures: 'normal' },
  '.cm-line': { padding: '0' },
  '.cm-line.cm-md-blank': { lineHeight: '0.75' },
  '.cm-line.cm-md-fence': { fontFamily: 'var(--font-mono)', fontSize: '0.86em' },
});

/** Gives blank lines and fenced code their own line classes in markdown editors. */
const markdownLines = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) this.decorations = this.build(update.view);
    }

    build(view: EditorView): DecorationSet {
      const ranges = [];
      const doc = view.state.doc;
      let inFence = false;
      let fenceMarker = '';
      // Fences are tracked from the top so that a viewport starting mid-block is right.
      for (let number = 1; number <= doc.lines; number++) {
        const line = doc.line(number);
        const text = line.text;
        const fence = /^\s{0,3}(```+|~~~+)/.exec(text);
        let cls = '';
        if (fence && (!inFence || text.trim().startsWith(fenceMarker))) {
          cls = 'cm-md-fence';
          if (!inFence) {
            inFence = true;
            fenceMarker = fence[1][0].repeat(3);
          } else {
            inFence = false;
          }
        } else if (inFence) {
          cls = 'cm-md-fence';
        } else if (text.trim() === '' && number > 1 && number < doc.lines) {
          cls = 'cm-md-blank';
        }
        if (cls) ranges.push(Decoration.line({ class: cls }).range(line.from));
      }
      return Decoration.set(ranges);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

// ── Reconfigurable pieces ───────────────────────────────────────────────────

export const lineNumbersConfig = new Compartment();
/** Completion is switched between its two forms (suggestion / list) without rebuilding the editor. */
export const completionConfig = new Compartment();
export const wrapConfig = new Compartment();
export const languageConfig = new Compartment();

export function lineNumbersExtension(enabled: boolean): Extension {
  return enabled ? lineNumbers() : [];
}

export function wrapExtension(enabled: boolean): Extension {
  return enabled ? EditorView.lineWrapping : [];
}

const pythonSupport = python();

/** Loads syntax support for a kernel language ("python", "r", "julia", …). */
export async function languageSupport(name: string): Promise<Extension> {
  const key = name.toLowerCase();
  if (key === 'python' || key === 'ipython' || key === '') return pythonSupport;
  const description = LanguageDescription.matchLanguageName(languages, key, true);
  if (!description) return [];
  try {
    return (await description.load()) as LanguageSupport;
  } catch {
    return [];
  }
}

export function initialLanguage(name: string): Extension {
  const key = name.toLowerCase();
  return key === 'python' || key === 'ipython' || key === '' ? pythonSupport : [];
}

// ── Extension sets ──────────────────────────────────────────────────────────

/**
 * Tab completes after a word and indents elsewhere — the notebook convention. Completing
 * means: take the suggestion shown after the caret; with none on show, ask for the list.
 */
function smartTab(view: EditorView): boolean {
  if (completionStatus(view.state) === 'active') {
    // With the list open, Tab takes the highlighted entry — or the first, if none is yet.
    if (acceptCompletion(view)) return true;
    moveCompletionSelection(true)(view);
    return acceptCompletion(view);
  }
  if (acceptGhost(view)) return true;
  const selection = view.state.selection.main;
  if (!selection.empty || view.state.selection.ranges.length > 1) return indentMore(view);
  const line = view.state.doc.lineAt(selection.head);
  const before = line.text.slice(0, selection.head - line.from);
  if (/^\s*$/.test(before)) {
    const unit = view.state.facet(indentUnit).length || 4;
    const spaces = unit - (before.length % unit);
    view.dispatch(view.state.replaceSelection(' '.repeat(spaces)), { scrollIntoView: true, userEvent: 'input' });
    return true;
  }
  return showCompletions(view);
}

function markdownTab(view: EditorView): boolean {
  const selection = view.state.selection.main;
  const line = view.state.doc.lineAt(selection.head);
  if (!selection.empty || /^\s*([-*+]|\d+[.)])\s/.test(line.text)) return indentMore(view);
  view.dispatch(view.state.replaceSelection('    '), { scrollIntoView: true, userEvent: 'input' });
  return true;
}

const shared: Extension = [
  highlightSpecialChars(),
  history(),
  drawSelection(),
  dropCursor(),
  EditorState.allowMultipleSelections.of(true),
  indentOnInput(),
  bracketMatching(),
  closeBrackets(),
  rectangularSelection(),
  crosshairCursor(),
  tooltips({ parent: document.body }),
  findExtension(),
  // When a long line scrolls sideways and the caret comes back, bring the left padding back
  // too, so the text lines up with every other cell again.
  EditorView.scrollMargins.of(() => ({ left: 20, right: 20 })),
  theme,
];

export interface EditorHooks {
  /** Bindings that must win over everything else (run, navigate between cells, …). */
  keys: Extension;
  /** Kernel-backed completion source and friends. */
  completion: Extension;
  listeners: Extension;
}

export function codeExtensions(hooks: EditorHooks, options: { language: string; lineNumbers: boolean; wrap: boolean }): Extension {
  return [
    Prec.highest(hooks.keys),
    shared,
    highlightSelectionMatches({ minSelectionLength: 2 }),
    indentUnit.of('    '),
    EditorState.tabSize.of(4),
    completionConfig.of(hooks.completion),
    keymap.of([
      { key: 'Tab', run: smartTab },
      { key: 'Shift-Tab', run: indentLess },
      { key: 'ArrowRight', run: acceptGhostAtLineEnd },
      // The list of every completion, on request. ⌥esc is the Mac's own key for it (F5 too);
      // ⌃Space is the usual one elsewhere, for keyboards where it is not switching input sources.
      { key: 'Alt-Escape', run: showCompletions },
      { key: 'F5', run: showCompletions },
      { key: 'Ctrl-Space', run: showCompletions },
      ...closeBracketsKeymap,
      ...completionKeymap,
      ...defaultKeymap,
      ...historyKeymap,
    ]),
    syntaxHighlighting(codeHighlight),
    languageConfig.of(initialLanguage(options.language)),
    lineNumbersConfig.of(lineNumbersExtension(options.lineNumbers)),
    wrapConfig.of(wrapExtension(options.wrap)),
    hooks.listeners,
  ];
}

export function markdownExtensions(hooks: EditorHooks): Extension {
  return [
    Prec.highest(hooks.keys),
    shared,
    indentUnit.of('    '),
    EditorView.lineWrapping,
    markdown({ base: markdownLanguage, codeLanguages: languages, addKeymap: true }),
    syntaxHighlighting(markdownHighlight),
    Prec.high(markdownTheme),
    markdownLines,
    placeholder('Write…'),
    keymap.of([
      { key: 'Tab', run: markdownTab },
      { key: 'Shift-Tab', run: indentLess },
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...historyKeymap,
    ]),
    hooks.listeners,
  ];
}

export function rawExtensions(hooks: EditorHooks): Extension {
  return [
    Prec.highest(hooks.keys),
    shared,
    EditorView.lineWrapping,
    keymap.of([{ key: 'Enter', run: insertNewlineAndIndent }, ...defaultKeymap, ...historyKeymap]),
    hooks.listeners,
  ];
}
