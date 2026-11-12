// Static syntax highlighting with the same parsers and colours as the editors, so a code
// block in rendered markdown looks exactly like the code cell next to it.

import { pythonLanguage } from '@codemirror/lang-python';
import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import type { Parser } from '@lezer/common';
import { highlightTree } from '@lezer/highlight';
import { StyleModule } from 'style-mod';
import { codeHighlightStyle } from '../editor/setup';

let mounted = false;
function mountStyles() {
  if (mounted || !codeHighlightStyle.module) return;
  StyleModule.mount(document, codeHighlightStyle.module);
  mounted = true;
}

const parsers = new Map<string, Promise<Parser | null>>();

function parserFor(language: string): Promise<Parser | null> {
  const key = language.toLowerCase().trim();
  let cached = parsers.get(key);
  if (!cached) {
    cached = (async () => {
      if (key === 'python' || key === 'py' || key === 'ipython' || key === 'ipython3') return pythonLanguage.parser;
      const description = LanguageDescription.matchLanguageName(languages, key, true);
      if (!description) return null;
      try {
        return (await description.load()).language.parser;
      } catch {
        return null;
      }
    })();
    parsers.set(key, cached);
  }
  return cached;
}

function paint(target: HTMLElement, code: string, parser: Parser) {
  mountStyles();
  const fragment = document.createDocumentFragment();
  let position = 0;
  highlightTree(parser.parse(code), codeHighlightStyle, (from, to, classes) => {
    if (from > position) fragment.append(code.slice(position, from));
    const span = document.createElement('span');
    span.className = classes;
    span.textContent = code.slice(from, to);
    fragment.append(span);
    position = to;
  });
  if (position < code.length) fragment.append(code.slice(position));
  target.replaceChildren(fragment);
}

/** Highlights `code` into `target` (which should already show the plain text). */
export async function highlightElement(target: HTMLElement, code: string, language: string) {
  if (!language || code.length > 200_000) return;
  const parser = await parserFor(language);
  if (parser && target.isConnected) paint(target, code, parser);
}

/** Synchronous variant for Python, the common case. */
export function highlightPython(target: HTMLElement, code: string) {
  paint(target, code, pythonLanguage.parser);
}
