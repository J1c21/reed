// What can be done with a piece of output besides looking at it: copy it, save it, see it
// larger. A "piece" is one figure, one table, or one output's worth of text.

import { call, hostKind } from '../../host';
import { copyImage, copyText } from '../../host/clipboard';
import { documentDirectory, documentTitle } from '../../notebook/document';

export type OutputPiece =
  | { kind: 'image'; image: HTMLImageElement }
  | { kind: 'table'; table: HTMLTableElement }
  | { kind: 'text'; text: string };

/** The text of one output as it reads on screen (HTML outputs live in a shadow root). */
function textOf(output: HTMLElement): string {
  const rich = output.querySelector<HTMLElement>('.out-html')?.shadowRoot?.querySelector<HTMLElement>('.rich');
  return (rich ?? output).innerText.replace(/\n+$/, '');
}

/**
 * The piece of a cell a pointer event landed on: the picture or table under the pointer, else
 * the text of the output around it. Events from inside HTML outputs are followed through
 * their shadow root.
 */
export function pieceAt(event: Event): OutputPiece | null {
  let table: HTMLTableElement | null = null;
  for (const node of event.composedPath()) {
    if (!(node instanceof HTMLElement)) continue;
    if (node.classList.contains('cm-editor') || node.classList.contains('cell')) break;
    if (node instanceof HTMLImageElement) return { kind: 'image', image: node };
    if (node instanceof HTMLTableElement) table = node; // the outermost one, if they nest
    if (node.classList.contains('output')) {
      if (table) return { kind: 'table', table };
      const text = textOf(node);
      return text ? { kind: 'text', text } : null;
    }
  }
  return table ? { kind: 'table', table } : null;
}

/**
 * What "this cell's output" means when no particular piece is pointed at: its figure if it
 * drew one, else its table, else everything it printed.
 */
export function mainPiece(cell: HTMLElement): OutputPiece | null {
  const area = cell.querySelector<HTMLElement>('.cell-outputs');
  if (!area) return null;
  const image = area.querySelector<HTMLImageElement>('img.out-image');
  if (image) return { kind: 'image', image };
  for (const host of area.querySelectorAll<HTMLElement>('.out-html')) {
    const table = host.shadowRoot?.querySelector('table');
    if (table) return { kind: 'table', table };
  }
  const text = [...area.querySelectorAll<HTMLElement>('.output')].map(textOf).filter(Boolean).join('\n');
  return text ? { kind: 'text', text } : null;
}

/** The picture as PNG data: the very bytes the kernel sent when it is a PNG already. */
async function pngOf(image: HTMLImageElement): Promise<string> {
  const original = /^data:image\/png;base64,(.+)$/s.exec(image.src);
  if (original) return original[1];
  if (!image.complete) await image.decode();
  // Vector pictures are drawn at twice their nominal size so the copy stays crisp.
  const scale = image.src.startsWith('data:image/svg') ? 2 : 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round((image.naturalWidth || image.width) * scale));
  canvas.height = Math.max(1, Math.round((image.naturalHeight || image.height) * scale));
  canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png').split(',')[1];
}

function tableText(table: HTMLTableElement): { text: string; rows: number } {
  const lines = [...table.rows].map((row) =>
    [...row.cells].map((cell) => (cell.textContent ?? '').trim().replace(/\s+/g, ' ')).join('\t'),
  );
  return { text: lines.join('\n'), rows: table.tBodies[0]?.rows.length ?? lines.length };
}

/** Copies a piece to the clipboard and says, in a few words, what went there. */
export async function copyPiece(piece: OutputPiece): Promise<string> {
  if (piece.kind === 'image') {
    await copyImage(await pngOf(piece.image));
    return 'Image copied';
  }
  if (piece.kind === 'table') {
    // Tab-separated for spreadsheets and plain text, HTML for anything that pastes tables.
    const { text, rows } = tableText(piece.table);
    await copyText(text, piece.table.outerHTML);
    return `Table copied — ${rows} ${rows === 1 ? 'row' : 'rows'}`;
  }
  await copyText(piece.text);
  return 'Output copied';
}

/** Saves a picture as a PNG file wherever the user says. Resolves to the name it was given. */
export async function saveImage(image: HTMLImageElement): Promise<string | null> {
  const base64 = await pngOf(image);
  const name = `${documentTitle()} figure.png`;
  if (hostKind !== 'app') {
    const link = document.createElement('a');
    link.href = `data:image/png;base64,${base64}`;
    link.download = name;
    link.click();
    return name;
  }
  const { path } = await call<{ path: string | null }>('dialog.save', { name, directory: documentDirectory(), extension: 'png' });
  if (!path) return null;
  await call('fs.writeBinary', { path, base64 });
  return path.split('/').pop() ?? name;
}
