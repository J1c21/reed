import { render } from 'solid-js/web';
import { call, connectHost, hostKind, on as onHost, type HostInit } from './host';
import { configureKernel } from './kernel/kernel';
import { documentDirectory, openNotebook, save, setHome, setUnattended } from './notebook/document';
import { runCommand } from './notebook/commands';
import { notebook } from './notebook/store';
import { loadPreferences } from './state/prefs';
import { App } from './ui/App';
import './render/outputs/Widgets';

import './styles/theme.css';
import './styles/base.css';
import './styles/cells.css';
import './styles/prose.css';

declare global {
  interface Window {
    /** Entry points the native shell calls directly. */
    __sumi: {
      /** Saves before the window closes. Resolves to false if the user cancelled. */
      saveForClose: () => Promise<boolean>;
      isDirty: () => boolean;
      run: (id: string) => boolean;
    };
  }
}

async function start() {
  const root = document.getElementById('root')!;
  try {
    await connectHost();
  } catch (error) {
    root.innerHTML = `<div style="padding:48px;font:14px -apple-system,sans-serif;color:#888;line-height:1.6">${
      error instanceof Error ? error.message : String(error)
    }</div>`;
    return;
  }
  document.documentElement.dataset.host = hostKind;

  const query = new URLSearchParams(location.search);
  const init = await call<HostInit>('window.init', { filePath: query.get('file') });
  loadPreferences(init.preferences ?? {});
  setHome(init.home ?? '');
  setUnattended(!!init.automated);
  document.documentElement.style.setProperty('--titlebar', `${init.titlebarHeight}px`);
  document.documentElement.style.setProperty('--traffic', `${init.trafficLightsWidth}px`);

  configureKernel({ cwd: () => documentDirectory() });
  window.__sumi = {
    saveForClose: () => save(),
    isDirty: () => notebook.dirty(),
    run: (id: string) => runCommand(id),
  };
  // The app reuses an untouched window when a file is opened.
  onHost('doc.open', ({ path }: { path: string }) => void openNotebook(path));

  if (import.meta.env.DEV) {
    // Handy handles for poking at the app from the browser console while developing.
    const [commands, store, kernelModule, execution] = await Promise.all([
      import('./notebook/commands'),
      import('./notebook/store'),
      import('./kernel/kernel'),
      import('./notebook/execution'),
    ]);
    Object.assign(window, { sumi: { ...commands, ...store, ...kernelModule, ...execution } });
  }

  render(() => <App />, root);
  await openNotebook(init.filePath ?? null);
  // The window is created hidden and revealed once the notebook is on the page. (A hidden
  // page gets no animation frames, so this must not wait for one.)
  setTimeout(() => void call('window.ready').catch(() => {}), 0);
}

void start();
