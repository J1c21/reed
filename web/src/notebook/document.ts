// The notebook as a file: opening, saving, exporting, and keeping the window in sync.

import { createSignal } from 'solid-js';
import { call, hostKind, type FileStat } from '../host';
import {
  chooseSpec,
  kernel,
  kernelLanguage,
  refreshSpecs,
  selectionInProgress,
  selectSpec,
  shutdownKernel,
  type KernelSpecInfo,
} from '../kernel/kernel';
import { prefs, setPref } from '../state/prefs';
import { basename, dirname, extname, stripExt } from '../util/misc';
import { execution, setNotice } from './execution';
import { emptyNotebook, exportAsMarkdown, exportAsScript, parseNotebook, serializeNotebook } from './nbformat';
import { focusEditor, loadNotebook, markSaved, notebook, setNotebookMetadata, setPath, snapshotNotebook, touch } from './store';

const [home, setHome] = createSignal('');
/** Modification time of the file as we last read or wrote it. */
let knownMtime = 0;
let saving: Promise<boolean> | null = null;
/** The file is being renamed. Nothing is written while it is: it would land under the old name. */
let moving: Promise<unknown> | null = null;

export { home, setHome };

export function documentTitle(): string {
  const path = notebook.path();
  return path ? stripExt(basename(path)) : 'Untitled';
}

export function documentDirectory(): string | null {
  const path = notebook.path();
  return path ? dirname(path) : home() || null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── Opening ─────────────────────────────────────────────────────────────────

function pickKernelFor(path: string | null, metadata: Record<string, any>): Promise<void> {
  const task = (async () => {
    try {
      const specs = await refreshSpecs();
      await selectSpec(chooseSpec(specs, path, metadata));
    } catch (error) {
      console.warn('[kernel] discovery failed', error);
    }
  })();
  selectionInProgress(task);
  return task;
}

export async function openNotebook(path: string | null): Promise<boolean> {
  if (path === null) {
    await shutdownKernel();
    loadNotebook(emptyNotebook(), null);
    knownMtime = 0;
    autosaveStoodDown = false;
    void pickKernelFor(null, {});
    // A new notebook is a blank page: put the caret on it.
    const first = notebook.cells()[0];
    if (first) queueMicrotask(() => focusEditor(first, 'start'));
    return true;
  }
  try {
    const file = await call<FileStat & { text: string }>('fs.readText', { path });
    const data = parseNotebook(file.text);
    await shutdownKernel();
    loadNotebook(data, path);
    knownMtime = file.mtime ?? 0;
    autosaveStoodDown = false;
    call('app.noteRecent', { path }).catch(() => {});
    void pickKernelFor(path, data.metadata);
    return true;
  } catch (error) {
    setNotice({ kind: 'error', text: describe(error) });
    return false;
  }
}

/** Opens another notebook: in its own window in the app, in place under the development host. */
export function openPath(path: string) {
  if (path === notebook.path()) return;
  if (hostKind === 'app') call('app.open', { path }).catch((error) => setNotice({ kind: 'error', text: describe(error) }));
  else void openNotebook(path);
}

/** Re-reads the file if it changed on disk and there are no unsaved edits to lose. */
export async function checkForExternalChanges() {
  const path = notebook.path();
  if (!path || saving || moving) return;
  try {
    const stat = await call<FileStat>('fs.stat', { path });
    if (notebook.path() !== path) return; // renamed while we were looking
    if (!stat.exists || !stat.mtime || stat.mtime <= knownMtime + 1) return;
    if (notebook.dirty()) {
      knownMtime = stat.mtime;
      setNotice({ kind: 'info', text: 'This notebook was changed on disk by another program. Saving will overwrite those changes.' });
      return;
    }
    const file = await call<FileStat & { text: string }>('fs.readText', { path });
    const data = parseNotebook(file.text);
    knownMtime = file.mtime ?? stat.mtime;
    autosaveStoodDown = false;
    // Keep the kernel: only the document is replaced.
    loadNotebook(data, path);
  } catch {
    /* the file may be mid-write; try again next time */
  }
}

// ── Saving ──────────────────────────────────────────────────────────────────

/** Records which kernel the notebook uses, the way Jupyter does, without churning existing values. */
function stampKernelMetadata() {
  const spec = kernel.spec();
  const info = kernel.info();
  const metadata = notebook.meta.metadata;
  if (spec && !metadata.kernelspec) setNotebookMetadata('kernelspec', kernelspecMetadata(spec));
  if (info?.language_info && !metadata.language_info) setNotebookMetadata('language_info', info.language_info);
}

export function kernelspecMetadata(spec: KernelSpecInfo) {
  return spec.kind === 'environment'
    ? { display_name: 'Python 3 (ipykernel)', language: 'python', name: 'python3' }
    : { display_name: spec.displayName, language: spec.language, name: spec.name };
}

async function writeTo(path: string): Promise<boolean> {
  stampKernelMetadata();
  const revision = notebook.revision();
  const text = serializeNotebook(snapshotNotebook());
  try {
    const stat = await call<FileStat>('fs.writeText', { path, text });
    knownMtime = stat.mtime ?? Date.now();
    autosaveStoodDown = false;
    // Edits made while the write was in flight keep the document dirty.
    if (notebook.revision() === revision) markSaved();
    return true;
  } catch (error) {
    setNotice({ kind: 'error', text: describe(error) });
    return false;
  }
}

/** Autosave has stood down — the file changed under us, or would not be written — until a save by hand succeeds. */
let autosaveStoodDown = false;
let unattended = false;

/** Tells the document it is open in a scripted, off-screen window: it then never saves by itself. */
export function setUnattended(value: boolean) {
  unattended = value;
}

/**
 * Saves without being asked (a pause in the typing, the window losing focus). Unlike ⌘S it
 * never overwrites a file that another program has changed since we last saw it.
 */
export async function autosave(): Promise<void> {
  const path = notebook.path();
  if (!path || saving || moving || unattended || autosaveStoodDown || !notebook.dirty()) return;
  try {
    const stat = await call<FileStat>('fs.stat', { path });
    if (stat.exists && stat.mtime && stat.mtime > knownMtime + 1) {
      autosaveStoodDown = true;
      setNotice({
        kind: 'info',
        text: 'This notebook was changed on disk by another program, so it is no longer being saved automatically. ⌘S saves this version over it.',
      });
      return;
    }
  } catch {
    /* could not look; saving will say what is wrong */
  }
  // A save that fails says why, once; it is not tried again at every pause in the typing.
  if (notebook.path() === path && notebook.dirty() && !(await save())) autosaveStoodDown = true;
}

export function save(): Promise<boolean> {
  if (saving) return saving;
  if (moving) return moving.then(save);
  const path = notebook.path();
  saving = (path ? writeTo(path) : saveAsInternal()).finally(() => {
    saving = null;
  });
  return saving;
}

export function saveAs(): Promise<boolean> {
  if (saving) return saving;
  if (moving) return moving.then(saveAs);
  saving = saveAsInternal().finally(() => {
    saving = null;
  });
  return saving;
}

async function choosePath(suggestedName: string, extension: string): Promise<string | null> {
  if (hostKind === 'app') {
    const result = await call<{ path: string | null }>('dialog.save', {
      name: suggestedName,
      directory: documentDirectory(),
      extension,
    });
    return result.path;
  }
  const typed = window.prompt('Save as (absolute path):', `${documentDirectory() ?? ''}/${suggestedName}`);
  return typed && typed.trim() ? typed.trim() : null;
}

async function saveAsInternal(): Promise<boolean> {
  const target = await choosePath(`${documentTitle()}.ipynb`, 'ipynb');
  if (!target) return false;
  const path = target.endsWith('.ipynb') ? target : `${target}.ipynb`;
  if (!(await writeTo(path))) return false;
  setPath(path);
  markSaved();
  call('app.noteRecent', { path }).catch(() => {});
  return true;
}

/** What was last said about a name that would not do. It is taken back once a name does. */
let refusal: { kind: 'error'; text: string } | null = null;

function refuseName(text: string): false {
  refusal = { kind: 'error', text };
  setNotice(refusal);
  return false;
}

/**
 * Gives the notebook's file another name, in the folder it is in. Resolves to false when the
 * name was refused — and says why; a name that changes nothing is simply accepted.
 */
export async function renameNotebook(name: string): Promise<boolean> {
  const from = notebook.path();
  if (!from) return false;
  const extension = extname(from);
  let stem = name.trim();
  // Typed with its extension: that is the same name.
  if (extension && stem.toLowerCase().endsWith(extension.toLowerCase())) stem = stem.slice(0, -extension.length).trim();
  if (!stem || stem === documentTitle()) return true;
  if (/[/:]/.test(stem)) return refuseName('A name can’t contain “/” or “:”.');
  if (stem.startsWith('.')) return refuseName('A name can’t begin with a dot: the file would be hidden.');
  // A save on its way lands where it was aimed before the file moves.
  if (saving) await saving.catch(() => false);
  if (moving) await moving;
  if (notebook.path() !== from) return false;
  const to = `${dirname(from).replace(/\/$/, '')}/${stem}${extension}`;
  const task = call<FileStat>('fs.rename', { from, to });
  const settled = task.then(
    () => {},
    () => {},
  );
  moving = settled;
  void settled.then(() => {
    if (moving === settled) moving = null;
  });
  try {
    const stat = await task;
    setPath(to);
    if (stat.mtime) knownMtime = stat.mtime;
    // The kernel chosen for this file is still the kernel chosen for this file.
    const kernelId = prefs.kernelByPath[from];
    if (kernelId) {
      const { [from]: _left, ...others } = prefs.kernelByPath;
      setPref('kernelByPath', { ...others, [to]: kernelId });
    }
    call('app.noteRecent', { path: to }).catch(() => {});
    if (refusal && execution.notice() === refusal) setNotice(null);
    refusal = null;
    return true;
  } catch (error) {
    return refuseName(describe(error));
  }
}

export async function exportNotebook(kind: 'script' | 'markdown') {
  const data = snapshotNotebook();
  const language = kernelLanguage();
  const extension = kind === 'markdown' ? 'md' : (kernel.info()?.language_info?.file_extension ?? '.py').replace(/^\./, '');
  const target = await choosePath(`${documentTitle()}.${extension}`, extension);
  if (!target) return;
  const comment = language === 'python' || language === 'r' || language === 'julia' ? '#' : '//';
  const text = kind === 'markdown' ? exportAsMarkdown(data, language) : exportAsScript(data, comment);
  try {
    await call('fs.writeText', { path: target, text });
    setNotice({ kind: 'info', text: `Exported to ${basename(target)}` });
  } catch (error) {
    setNotice({ kind: 'error', text: describe(error) });
  }
}

/** The user picked a kernel by hand: remember it for this file and record it in the notebook. */
export async function chooseKernel(spec: KernelSpecInfo) {
  await selectSpec(spec, { remember: notebook.path() });
  const current = notebook.meta.metadata.kernelspec;
  const next = kernelspecMetadata(spec);
  if (!current || current.name !== next.name || current.language !== next.language) {
    setNotebookMetadata('kernelspec', next);
    if (notebook.meta.metadata.language_info?.name !== next.language) setNotebookMetadata('language_info', undefined);
    touch();
  }
}
