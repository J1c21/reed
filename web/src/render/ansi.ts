// Terminal-style text rendering for kernel output: ANSI colours, carriage returns (progress
// bars) and backspaces. `AnsiStream` renders incrementally — appending a chunk costs time
// proportional to the chunk, not to everything printed so far.

interface Style {
  fg: number | string | null;
  bg: number | string | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  inverse: boolean;
}

const PLAIN: Style = {
  fg: null,
  bg: null,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  strike: false,
  inverse: false,
};

interface Segment {
  text: string;
  style: Style;
}

// CSI sequences, OSC sequences (window titles, hyperlinks) and two-character escapes.
const ESCAPE = /\x1b(?:\[([0-9;:?<=>]*)([@-~])|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[@-Z\\^_])/y;
const COMPLETE_ESCAPE = /^\x1b(?:\[[0-9;:?<=>]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\^_])/;
const CONTROL = /[\x1b\r\n\x08]/g;
const URL = /https?:\/\/[^\s<>"'`)\]}]+[^\s<>"'`)\]}.,;:!?]/g;

const CUBE = [0, 95, 135, 175, 215, 255];

function extendedColor(params: number[], at: number): { color: number | string | null; used: number } {
  if (params[at] === 5 && params.length > at + 1) {
    const n = params[at + 1];
    if (n < 16) return { color: n, used: 2 };
    if (n < 232) {
      const c = n - 16;
      return { color: `rgb(${CUBE[Math.floor(c / 36)]},${CUBE[Math.floor(c / 6) % 6]},${CUBE[c % 6]})`, used: 2 };
    }
    const gray = 8 + (n - 232) * 10;
    return { color: `rgb(${gray},${gray},${gray})`, used: 2 };
  }
  if (params[at] === 2 && params.length > at + 3) {
    return { color: `rgb(${params[at + 1]},${params[at + 2]},${params[at + 3]})`, used: 4 };
  }
  return { color: null, used: params.length };
}

function applySgr(style: Style, raw: string): Style {
  const params = raw === '' ? [0] : raw.split(/[;:]/).map((p) => (p === '' ? 0 : Number(p)));
  const next = { ...style };
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    if (p === 0) Object.assign(next, PLAIN);
    else if (p === 1) next.bold = true;
    else if (p === 2) next.dim = true;
    else if (p === 3) next.italic = true;
    else if (p === 4) next.underline = true;
    else if (p === 7) next.inverse = true;
    else if (p === 9) next.strike = true;
    else if (p === 22) next.bold = next.dim = false;
    else if (p === 23) next.italic = false;
    else if (p === 24) next.underline = false;
    else if (p === 27) next.inverse = false;
    else if (p === 29) next.strike = false;
    else if (p >= 30 && p <= 37) next.fg = p - 30;
    else if (p === 38) {
      const { color, used } = extendedColor(params, i + 1);
      next.fg = color;
      i += used;
    } else if (p === 39) next.fg = null;
    else if (p >= 40 && p <= 47) next.bg = p - 40;
    else if (p === 48) {
      const { color, used } = extendedColor(params, i + 1);
      next.bg = color;
      i += used;
    } else if (p === 49) next.bg = null;
    else if (p >= 90 && p <= 97) next.fg = p - 90 + 8;
    else if (p >= 100 && p <= 107) next.bg = p - 100 + 8;
  }
  return next;
}

function isPlain(style: Style): boolean {
  return (
    style.fg === null && style.bg === null && !style.bold && !style.dim && !style.italic &&
    !style.underline && !style.strike && !style.inverse
  );
}

function appendLinked(parent: Node, text: string) {
  if (text.length > 20_000 || !text.includes('http')) {
    parent.appendChild(document.createTextNode(text));
    return;
  }
  URL.lastIndex = 0;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = URL.exec(text))) {
    if (match.index > last) parent.appendChild(document.createTextNode(text.slice(last, match.index)));
    const link = document.createElement('a');
    link.href = match[0];
    link.textContent = match[0];
    link.rel = 'noreferrer';
    link.target = '_blank';
    parent.appendChild(link);
    last = match.index + match[0].length;
  }
  if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
}

function styledNode(segment: Segment): Node {
  const { style, text } = segment;
  const span = document.createElement('span');
  let fg = style.fg;
  let bg = style.bg;
  const classes: string[] = [];
  if (style.inverse) {
    if (fg === null && bg === null) classes.push('ansi-inverse');
    else [fg, bg] = [bg, fg];
  }
  if (typeof fg === 'number') classes.push(`ansi-fg-${fg}`);
  else if (fg) span.style.color = fg;
  if (typeof bg === 'number') classes.push(`ansi-bg-${bg}`);
  else if (bg) span.style.backgroundColor = bg;
  if (style.bold) classes.push('ansi-bold');
  if (style.dim) classes.push('ansi-dim');
  if (style.italic) classes.push('ansi-italic');
  if (style.underline) classes.push('ansi-underline');
  if (style.strike) classes.push('ansi-strike');
  span.className = classes.join(' ');
  appendLinked(span, text);
  return span;
}

const TEXT_NODE_LIMIT = 48_000;

export class AnsiStream {
  /** Total characters received. */
  length = 0;

  private committed: HTMLElement;
  private live: HTMLElement;
  private style: Style = PLAIN;
  private line: Segment[] = [];
  private carriageReturn = false;
  private carry = '';
  private tail: Text | null = null;
  private rendered = 0;
  private dropped = false;

  constructor(
    readonly element: HTMLElement,
    private options: { maxChars?: number; onTruncate?: () => void } = {},
  ) {
    this.committed = document.createElement('span');
    this.live = document.createElement('span');
    element.replaceChildren(this.committed, this.live);
  }

  reset() {
    this.committed.replaceChildren();
    this.live.replaceChildren();
    this.style = PLAIN;
    this.line = [];
    this.carriageReturn = false;
    this.carry = '';
    this.tail = null;
    this.rendered = 0;
    this.length = 0;
    this.dropped = false;
  }

  write(chunk: string) {
    if (!chunk) return;
    this.length += chunk.length;
    let text = this.carry + chunk;
    this.carry = '';
    // Hold back an escape sequence that was cut in half by chunking.
    const escape = text.lastIndexOf('\x1b');
    if (escape >= 0 && text.length - escape < 32 && !COMPLETE_ESCAPE.test(text.slice(escape))) {
      this.carry = text.slice(escape);
      text = text.slice(0, escape);
    }

    let i = 0;
    while (i < text.length) {
      CONTROL.lastIndex = i;
      const match = CONTROL.exec(text);
      const stop = match ? match.index : text.length;
      if (stop > i) {
        this.put(text.slice(i, stop));
        i = stop;
        continue;
      }
      const code = text.charCodeAt(i);
      if (code === 10) {
        this.newline();
        i++;
      } else if (code === 13) {
        // Deferred: "\r\n" is a newline, "\r" followed by text overwrites the line.
        this.carriageReturn = true;
        i++;
      } else if (code === 8) {
        this.backspace();
        i++;
      } else {
        ESCAPE.lastIndex = i;
        const sequence = ESCAPE.exec(text);
        if (sequence) {
          if (sequence[2] === 'm') this.style = applySgr(this.style, sequence[1] ?? '');
          else if (sequence[2] === 'K' && (sequence[1] === '2' || sequence[1] === '1')) this.line = [];
          i += sequence[0].length;
        } else {
          i++;
        }
      }
    }
    this.renderLive();
    this.enforceLimit();
  }

  private put(text: string) {
    if (this.carriageReturn) {
      this.line = [];
      this.carriageReturn = false;
    }
    const last = this.line[this.line.length - 1];
    if (last && last.style === this.style) last.text += text;
    else this.line.push({ text, style: this.style });
  }

  private backspace() {
    for (let i = this.line.length - 1; i >= 0; i--) {
      const segment = this.line[i];
      if (segment.text.length > 0) {
        segment.text = segment.text.slice(0, -1);
        if (!segment.text) this.line.splice(i, 1);
        return;
      }
    }
  }

  private newline() {
    this.carriageReturn = false;
    for (const segment of this.line) this.commit(segment);
    this.commit({ text: '\n', style: PLAIN });
    this.line = [];
  }

  private commit(segment: Segment) {
    this.rendered += segment.text.length;
    if (isPlain(segment.style) && !segment.text.includes('http')) {
      if (this.tail && this.tail.length < TEXT_NODE_LIMIT) {
        this.tail.appendData(segment.text);
      } else {
        this.tail = document.createTextNode(segment.text);
        this.committed.appendChild(this.tail);
      }
      return;
    }
    this.tail = null;
    if (isPlain(segment.style)) appendLinked(this.committed, segment.text);
    else this.committed.appendChild(styledNode(segment));
  }

  private renderLive() {
    if (this.line.length === 0) {
      if (this.live.firstChild) this.live.replaceChildren();
      return;
    }
    const nodes = this.line.map((segment) =>
      isPlain(segment.style) ? document.createTextNode(segment.text) : styledNode(segment),
    );
    this.live.replaceChildren(...nodes);
  }

  /** Keeps the DOM bounded for runaway output; the notebook itself still holds all of it. */
  private enforceLimit() {
    const max = this.options.maxChars ?? 1_500_000;
    if (this.rendered <= max) return;
    while (this.rendered > max * 0.6 && this.committed.firstChild) {
      const node = this.committed.firstChild;
      this.rendered -= node.textContent?.length ?? 0;
      node.remove();
    }
    if (!this.dropped) {
      this.dropped = true;
      this.options.onTruncate?.();
    }
  }
}

/** Renders a complete piece of terminal text. */
export function renderAnsi(text: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  if (!/[\x1b\r\x08]/.test(text)) {
    appendLinked(fragment, text);
    return fragment;
  }
  const holder = document.createElement('span');
  const stream = new AnsiStream(holder, { maxChars: Infinity });
  stream.write(text);
  fragment.append(...Array.from(holder.childNodes).flatMap((node) => Array.from(node.childNodes)));
  return fragment;
}

/** Removes escape sequences, for plain-text contexts. */
export function stripAnsi(text: string): string {
  return text.replace(/\x1b(?:\[[0-9;:?<=>]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[@-Z\\^_])/g, '');
}
