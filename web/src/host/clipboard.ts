// The system clipboard: through the native shell in the app, through the browser otherwise.

import { call, hostKind } from './index';

/** Copies text; with `html`, also a rich version for apps that can paste one (a table, say). */
export async function copyText(text: string, html?: string): Promise<void> {
  if (hostKind === 'app') {
    await call('clipboard.writeText', html ? { text, html } : { text });
  } else if (html && typeof ClipboardItem !== 'undefined') {
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/plain': new Blob([text], { type: 'text/plain' }),
        'text/html': new Blob([html], { type: 'text/html' }),
      }),
    ]);
  } else {
    await navigator.clipboard.writeText(text);
  }
}

/** Copies a picture, given as base64-encoded PNG data. */
export async function copyImage(base64: string): Promise<void> {
  if (hostKind === 'app') {
    await call('clipboard.writeImage', { base64 });
    return;
  }
  const blob = await (await fetch(`data:image/png;base64,${base64}`)).blob();
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}
