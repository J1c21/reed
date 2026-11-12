// Reading and writing .ipynb files (nbformat 4, with a best-effort upgrade from v3).
//
// The goal is a faithful round trip: opening a notebook and saving it untouched should
// produce a byte-identical file when it was written by Jupyter itself. That means matching
// nbformat's conventions — sorted keys, one-space indent, multi-line strings stored as arrays
// split the way Python's str.splitlines(keepends=True) splits them — and carrying along any
// fields this editor does not understand.

import { shortId } from '../util/misc';

export type MimeBundle = Record<string, unknown>;

interface OutputRuntime {
  /** Stable key for rendering; never written to disk. */
  _key: number;
  /** The display_id this output was published with, for update_display_data. */
  _displayId?: string;
}

export interface StreamOutput extends OutputRuntime {
  output_type: 'stream';
  name: string;
  text: string;
}

export interface RichOutput extends OutputRuntime {
  output_type: 'display_data' | 'execute_result';
  data: MimeBundle;
  metadata: Record<string, unknown>;
  execution_count?: number | null;
}

export interface ErrorOutput extends OutputRuntime {
  output_type: 'error';
  ename: string;
  evalue: string;
  traceback: string[];
}

/** An output type this editor does not know; preserved verbatim. */
export interface UnknownOutput extends OutputRuntime {
  output_type: 'unknown';
  raw: Record<string, unknown>;
}

export type Output = StreamOutput | RichOutput | ErrorOutput | UnknownOutput;

export type CellType = 'code' | 'markdown' | 'raw';

export interface CellData {
  id: string;
  cell_type: CellType;
  source: string;
  metadata: Record<string, any>;
  outputs: Output[];
  execution_count: number | null;
  attachments?: Record<string, MimeBundle>;
  /** Unrecognised cell fields, written back untouched. */
  extra?: Record<string, unknown>;
}

export interface NotebookFormat {
  indent: string;
  trailingNewline: boolean;
}

export interface NotebookData {
  cells: CellData[];
  metadata: Record<string, any>;
  nbformat: number;
  nbformat_minor: number;
  extra: Record<string, unknown>;
  format: NotebookFormat;
}

let outputKey = 1;
export function nextOutputKey(): number {
  return outputKey++;
}

// ── Line splitting ──────────────────────────────────────────────────────────

const LINE_BREAK = new RegExp('\\r\\n|[\\n\\r\\v\\f\\x1c\\x1d\\x1e\\x85\\u2028\\u2029]', 'g');

/** Python's `str.splitlines(keepends=True)`. */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines: string[] = [];
  let last = 0;
  LINE_BREAK.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = LINE_BREAK.exec(text))) {
    const end = match.index + match[0].length;
    lines.push(text.slice(last, end));
    last = end;
  }
  if (last < text.length) lines.push(text.slice(last));
  return lines;
}

function joinText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.join('');
  return value == null ? '' : String(value);
}

function isJsonMime(mime: string): boolean {
  return mime === 'application/json' || (mime.startsWith('application/') && mime.endsWith('+json'));
}

function rejoinBundle(data: unknown): MimeBundle {
  const bundle: MimeBundle = {};
  if (!data || typeof data !== 'object') return bundle;
  for (const [mime, value] of Object.entries(data as Record<string, unknown>)) {
    bundle[mime] =
      !isJsonMime(mime) && Array.isArray(value) && value.every((line) => typeof line === 'string')
        ? value.join('')
        : value;
  }
  return bundle;
}

function splitBundle(data: MimeBundle): MimeBundle {
  const bundle: MimeBundle = {};
  for (const [mime, value] of Object.entries(data)) {
    bundle[mime] =
      typeof value === 'string' &&
      (mime.startsWith('text/') || mime === 'application/javascript' || mime === 'image/svg+xml')
        ? splitLines(value)
        : value;
  }
  return bundle;
}

// ── Parsing ─────────────────────────────────────────────────────────────────

export function newCellId(used?: Set<string>): string {
  let id = shortId();
  while (used?.has(id)) id = shortId();
  used?.add(id);
  return id;
}

export function emptyNotebook(): NotebookData {
  return {
    cells: [newCell('code')],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
    extra: {},
    format: { indent: ' ', trailingNewline: true },
  };
}

export function newCell(type: CellType, source = ''): CellData {
  return { id: newCellId(), cell_type: type, source, metadata: {}, outputs: [], execution_count: null };
}

export function parseOutput(raw: any): Output {
  const _key = nextOutputKey();
  switch (raw?.output_type) {
    case 'stream':
      return { _key, output_type: 'stream', name: raw.name ?? 'stdout', text: joinText(raw.text) };
    case 'display_data':
      return { _key, output_type: 'display_data', data: rejoinBundle(raw.data), metadata: raw.metadata ?? {} };
    case 'execute_result':
      return {
        _key,
        output_type: 'execute_result',
        data: rejoinBundle(raw.data),
        metadata: raw.metadata ?? {},
        execution_count: raw.execution_count ?? null,
      };
    case 'error':
      return {
        _key,
        output_type: 'error',
        ename: String(raw.ename ?? ''),
        evalue: String(raw.evalue ?? ''),
        traceback: Array.isArray(raw.traceback) ? raw.traceback.map(String) : [],
      };
    default:
      return { _key, output_type: 'unknown', raw: raw ?? {} };
  }
}

function parseCell(raw: any, used: Set<string>): CellData {
  const { cell_type, source, metadata, outputs, execution_count, id, attachments, ...extra } = raw ?? {};
  const type: CellType = cell_type === 'markdown' ? 'markdown' : cell_type === 'raw' ? 'raw' : 'code';
  let cellId: string;
  if (typeof id === 'string' && /^[a-zA-Z0-9-_]{1,64}$/.test(id) && !used.has(id)) {
    cellId = id;
    used.add(id);
  } else {
    cellId = newCellId(used);
  }
  const cell: CellData = {
    id: cellId,
    cell_type: type,
    source: joinText(source),
    metadata: metadata && typeof metadata === 'object' ? metadata : {},
    outputs: type === 'code' && Array.isArray(outputs) ? outputs.map(parseOutput) : [],
    execution_count: typeof execution_count === 'number' ? execution_count : null,
  };
  if (attachments && typeof attachments === 'object') cell.attachments = attachments;
  if (Object.keys(extra).length) cell.extra = extra;
  return cell;
}

/** nbformat 3 kept cells inside "worksheets" and used different names for a few things. */
function upgradeFromV3(raw: any): any {
  const cells: any[] = [];
  for (const sheet of raw.worksheets ?? []) {
    for (const cell of sheet.cells ?? []) {
      if (cell.cell_type === 'code') {
        cells.push({
          cell_type: 'code',
          source: cell.input ?? '',
          metadata: cell.metadata ?? {},
          execution_count: cell.prompt_number ?? null,
          outputs: (cell.outputs ?? []).map((output: any) => {
            const { output_type, prompt_number, stream, metadata, ename, evalue, traceback, text, ...rest } = output;
            if (output_type === 'stream') return { output_type, name: stream ?? 'stdout', text };
            if (output_type === 'pyerr') return { output_type: 'error', ename, evalue, traceback };
            const data: MimeBundle = {};
            const mimes: Record<string, string> = {
              text: 'text/plain', html: 'text/html', svg: 'image/svg+xml', png: 'image/png',
              jpeg: 'image/jpeg', latex: 'text/latex', json: 'application/json', javascript: 'application/javascript',
            };
            if (text !== undefined) data['text/plain'] = text;
            for (const [key, value] of Object.entries(rest)) {
              if (mimes[key]) data[mimes[key]] = value;
            }
            return output_type === 'pyout'
              ? { output_type: 'execute_result', data, metadata: metadata ?? {}, execution_count: prompt_number ?? null }
              : { output_type: 'display_data', data, metadata: metadata ?? {} };
          }),
        });
      } else if (cell.cell_type === 'heading') {
        const text = joinText(cell.source);
        cells.push({ cell_type: 'markdown', source: '#'.repeat(cell.level ?? 1) + ' ' + text, metadata: cell.metadata ?? {} });
      } else {
        cells.push({ cell_type: cell.cell_type === 'raw' ? 'raw' : 'markdown', source: cell.source ?? '', metadata: cell.metadata ?? {} });
      }
    }
  }
  const metadata = { ...(raw.metadata ?? {}) };
  delete metadata.name;
  return { cells, metadata, nbformat: 4, nbformat_minor: 5 };
}

export function parseNotebook(text: string): NotebookData {
  if (text.trim() === '') return emptyNotebook();
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('This file is not a valid notebook — its contents are not valid JSON.');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('This file is not a Jupyter notebook.');
  }
  if (typeof raw.nbformat === 'number' && raw.nbformat < 4) raw = upgradeFromV3(raw);
  if (!Array.isArray(raw.cells)) throw new Error('This file is not a Jupyter notebook.');

  const { cells, metadata, nbformat, nbformat_minor, ...extra } = raw;
  const used = new Set<string>();
  const indentMatch = /^\{\r?\n([ \t]+)"/.exec(text);
  return {
    cells: (cells as unknown[]).map((cell) => parseCell(cell, used)),
    metadata: metadata && typeof metadata === 'object' ? metadata : {},
    nbformat: 4,
    nbformat_minor: typeof nbformat_minor === 'number' ? nbformat_minor : 5,
    extra,
    format: { indent: indentMatch ? indentMatch[1] : ' ', trailingNewline: text.endsWith('\n') },
  };
}

/**
 * Joins runs of consecutive stream outputs of the same name. Tools such as nbconvert save
 * every write separately; shown that way, a progress bar becomes a column of fragments.
 * Returns the same array when there is nothing to merge.
 */
export function mergeStreams(outputs: Output[]): Output[] {
  let merged: Output[] | null = null;
  // Outputs created here; the caller's objects are never modified.
  const owned = new Set<Output>();
  for (let i = 0; i < outputs.length; i++) {
    const output = outputs[i];
    const previous = merged ? merged[merged.length - 1] : outputs[i - 1];
    const joins = i > 0 && output.output_type === 'stream' && previous?.output_type === 'stream' && previous.name === output.name;
    if (!joins) {
      merged?.push(output);
      continue;
    }
    if (!merged) merged = outputs.slice(0, i);
    let last = merged[merged.length - 1] as StreamOutput;
    if (!owned.has(last)) {
      last = { ...last, _key: nextOutputKey() };
      merged[merged.length - 1] = last;
      owned.add(last);
    }
    last.text += (output as StreamOutput).text;
  }
  return merged ?? outputs;
}

// ── Serialising ─────────────────────────────────────────────────────────────

export function serializeOutput(output: Output): Record<string, unknown> {
  switch (output.output_type) {
    case 'stream':
      return { output_type: 'stream', name: output.name, text: splitLines(output.text) };
    case 'display_data':
      return { output_type: 'display_data', data: splitBundle(output.data), metadata: output.metadata ?? {} };
    case 'execute_result':
      return {
        output_type: 'execute_result',
        data: splitBundle(output.data),
        metadata: output.metadata ?? {},
        execution_count: output.execution_count ?? null,
      };
    case 'error':
      return { output_type: 'error', ename: output.ename, evalue: output.evalue, traceback: output.traceback };
    case 'unknown':
      return output.raw;
  }
}

export function serializeCell(cell: CellData, withId: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {
    ...(cell.extra ?? {}),
    cell_type: cell.cell_type,
    metadata: cell.metadata ?? {},
    source: splitLines(cell.source),
  };
  if (withId) out.id = cell.id;
  if (cell.cell_type === 'code') {
    out.execution_count = cell.execution_count ?? null;
    out.outputs = cell.outputs.map(serializeOutput);
  }
  if (cell.attachments && cell.cell_type !== 'code') out.attachments = cell.attachments;
  return out;
}

/** JSON with recursively sorted keys, formatted exactly like Python's json.dumps(indent=…). */
function writeJson(value: unknown, indent: string, depth: number, out: string[]): void {
  if (value === null || typeof value !== 'object') {
    out.push(value === undefined ? 'null' : JSON.stringify(value) ?? 'null');
    return;
  }
  const pad = indent.repeat(depth + 1);
  const closePad = indent.repeat(depth);
  if (Array.isArray(value)) {
    if (value.length === 0) {
      out.push('[]');
      return;
    }
    out.push('[\n');
    for (let i = 0; i < value.length; i++) {
      out.push(pad);
      writeJson(value[i], indent, depth + 1, out);
      out.push(i < value.length - 1 ? ',\n' : '\n');
    }
    out.push(closePad, ']');
    return;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
  if (keys.length === 0) {
    out.push('{}');
    return;
  }
  out.push('{\n');
  for (let i = 0; i < keys.length; i++) {
    out.push(pad, JSON.stringify(keys[i]), ': ');
    writeJson(record[keys[i]], indent, depth + 1, out);
    out.push(i < keys.length - 1 ? ',\n' : '\n');
  }
  out.push(closePad, '}');
}

export function serializeNotebook(notebook: NotebookData): string {
  const withIds = notebook.nbformat_minor >= 5;
  const document = {
    ...notebook.extra,
    cells: notebook.cells.map((cell) => serializeCell(cell, withIds)),
    metadata: notebook.metadata,
    nbformat: notebook.nbformat,
    nbformat_minor: notebook.nbformat_minor,
  };
  const out: string[] = [];
  writeJson(document, notebook.format.indent, 0, out);
  if (notebook.format.trailingNewline) out.push('\n');
  return out.join('');
}

// ── Exporting ───────────────────────────────────────────────────────────────

/** A plain script: code cells verbatim, everything else as comments (the "percent" format). */
export function exportAsScript(notebook: NotebookData, commentPrefix = '#'): string {
  const parts: string[] = [];
  for (const cell of notebook.cells) {
    if (cell.cell_type === 'code') {
      parts.push(`${commentPrefix} %%\n${cell.source}`);
    } else {
      const tag = cell.cell_type === 'markdown' ? '[markdown]' : '[raw]';
      const body = cell.source.split('\n').map((line) => (line ? `${commentPrefix} ${line}` : commentPrefix)).join('\n');
      parts.push(`${commentPrefix} %% ${tag}\n${body}`);
    }
  }
  return parts.join('\n\n') + '\n';
}

export function exportAsMarkdown(notebook: NotebookData, language: string): string {
  const parts: string[] = [];
  for (const cell of notebook.cells) {
    if (cell.cell_type === 'markdown') {
      parts.push(cell.source);
    } else if (cell.cell_type === 'code') {
      if (cell.source.trim()) parts.push('```' + language + '\n' + cell.source + '\n```');
      for (const output of cell.outputs) {
        if (output.output_type === 'stream') {
          parts.push('```\n' + output.text.replace(/\n$/, '') + '\n```');
        } else if (output.output_type === 'execute_result' || output.output_type === 'display_data') {
          const data = output.data;
          if (typeof data['text/markdown'] === 'string') parts.push(data['text/markdown'] as string);
          else if (typeof data['image/png'] === 'string') parts.push(`![output](data:image/png;base64,${(data['image/png'] as string).replace(/\s/g, '')})`);
          else if (typeof data['text/plain'] === 'string') parts.push('```\n' + data['text/plain'] + '\n```');
        } else if (output.output_type === 'error') {
          parts.push('```\n' + `${output.ename}: ${output.evalue}` + '\n```');
        }
      }
    } else if (cell.source.trim()) {
      parts.push('```\n' + cell.source + '\n```');
    }
  }
  return parts.join('\n\n') + '\n';
}
