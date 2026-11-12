// The notebook's kernel: which one is selected, its lifecycle, and its live status.
// One window edits one notebook, so this is a module-level singleton.

import { batch, createEffect, createRoot, createSignal } from 'solid-js';
import { call } from '../host';
import { prefs, setPref } from '../state/prefs';
import { KernelConnection, type KernelExit, type KernelMessage } from './connection';

export interface KernelSpecInfo {
  id: string;
  kind: 'kernelspec' | 'environment';
  name: string;
  displayName: string;
  language: string;
  interruptMode: string;
  available: boolean;
  pythonPath?: string;
  pythonVersion?: string;
  envKind?: string;
  envPrefix?: string;
  envName?: string;
  resourceDir?: string;
}

export interface KernelInfo {
  implementation: string;
  implementation_version: string;
  banner: string;
  protocol_version: string;
  language_info: {
    name: string;
    version: string;
    mimetype?: string;
    file_extension?: string;
    codemirror_mode?: unknown;
    pygments_lexer?: string;
    nbconvert_exporter?: string;
  };
}

export type KernelStatus = 'none' | 'starting' | 'idle' | 'busy' | 'dead';

const [status, setStatus] = createSignal<KernelStatus>('none');
const [spec, setSpecSignal] = createSignal<KernelSpecInfo | null>(null);
const [specs, setSpecs] = createSignal<KernelSpecInfo[]>([]);
const [info, setInfo] = createSignal<KernelInfo | null>(null);
const [failure, setFailure] = createSignal<string | null>(null);
/** Increments every time a fresh kernel process becomes ready. */
const [generation, setGeneration] = createSignal(0);

/**
 * The status as shown to the user. Background requests (completion, dependency analysis)
 * make the kernel busy for a few milliseconds; that flicker is not worth showing.
 */
const [shownStatus, setShownStatus] = createSignal<KernelStatus>('none');
let busyTimer: ReturnType<typeof setTimeout> | undefined;
createRoot(() => {
  createEffect(() => {
    const next = status();
    clearTimeout(busyTimer);
    if (next === 'busy') busyTimer = setTimeout(() => setShownStatus('busy'), 160);
    else setShownStatus(next);
  });
});

export const kernel = { status, shownStatus, spec, specs, info, failure, generation };

let connection: KernelConnection | null = null;
let starting: Promise<KernelConnection> | null = null;
let interruptMode = 'signal';
let epoch = 0;
let workingDirectory: () => string | null = () => null;

type Listener<T> = (value: T) => void;
const commListeners = new Set<Listener<KernelMessage>>();
const unsolicitedListeners = new Set<Listener<KernelMessage>>();
const resetListeners = new Set<Listener<'restart' | 'died' | 'shutdown'>>();

export function onComm(listener: Listener<KernelMessage>) {
  commListeners.add(listener);
}
export function onUnsolicited(listener: Listener<KernelMessage>) {
  unsolicitedListeners.add(listener);
}
/** Fired whenever the kernel's in-memory state is gone. */
export function onKernelReset(listener: Listener<'restart' | 'died' | 'shutdown'>) {
  resetListeners.add(listener);
}

export function configureKernel(options: { cwd: () => string | null }) {
  workingDirectory = options.cwd;
}

export function currentConnection(): KernelConnection | null {
  return connection;
}

// ── Discovery and selection ─────────────────────────────────────────────────

export async function refreshSpecs(): Promise<KernelSpecInfo[]> {
  const result = await call<{ specs: KernelSpecInfo[] }>('kernels.list', { notebookDir: workingDirectory() });
  setSpecs(result.specs);
  const selected = spec();
  if (selected) {
    const fresh = result.specs.find((candidate) => candidate.id === selected.id);
    if (fresh) setSpecSignal(fresh);
  }
  return result.specs;
}

/** Picks the most plausible kernel for a notebook that does not say which one to use. */
export function chooseSpec(
  available: KernelSpecInfo[],
  notebookPath: string | null,
  metadata: Record<string, any>,
): KernelSpecInfo | null {
  const usable = available.filter((candidate) => candidate.available);
  if (usable.length === 0) return null;
  const byId = (id: string | null | undefined) => (id ? usable.find((candidate) => candidate.id === id) : undefined);

  // 1. What this notebook used last time on this machine.
  const remembered = notebookPath ? byId(prefs.kernelByPath[notebookPath]) : undefined;
  if (remembered) return remembered;

  const wantedName: string | undefined = metadata?.kernelspec?.name;
  const wantedLanguage: string = (metadata?.kernelspec?.language ?? metadata?.language_info?.name ?? 'python').toLowerCase();

  // 2. A registered kernelspec with the name the notebook asks for.
  if (wantedName && wantedName !== 'python3') {
    const named = usable.find((candidate) => candidate.kind === 'kernelspec' && candidate.name === wantedName);
    if (named) return named;
  }

  const sameLanguage = usable.filter((candidate) => candidate.language.toLowerCase() === wantedLanguage);
  const pool = sameLanguage.length ? sameLanguage : usable;
  // 3. A virtual environment that lives next to the notebook, 4. the last kernel used anywhere,
  // 5. conda's base environment, 6. whatever comes first.
  return (
    pool.find((candidate) => candidate.envKind === 'venv') ??
    pool.find((candidate) => candidate.id === prefs.lastKernel) ??
    pool.find((candidate) => candidate.envKind === 'conda' && candidate.envName === 'base') ??
    pool[0]
  );
}

/** Selects a kernel. If a different one is running it is shut down; the new one starts lazily. */
export async function selectSpec(next: KernelSpecInfo | null, options: { remember?: string | null } = {}) {
  const previous = spec();
  setSpecSignal(next);
  if (next) {
    setPref('lastKernel', next.id);
    if (options.remember) setPref('kernelByPath', { ...prefs.kernelByPath, [options.remember]: next.id });
  }
  if (previous && next && previous.id === next.id) return;
  if (connection || starting) await shutdownKernel('shutdown');
}

export function specLabel(candidate: KernelSpecInfo | null): string {
  return candidate ? candidate.displayName : 'No Kernel';
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

/** Crisp plots on Retina displays, applied lazily when matplotlib's inline backend loads. */
const LAUNCH_ARGUMENTS = ['--InlineBackend.figure_format=retina'];

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A kernel's ports open before it is ready to work, and iopub subscriptions take effect
 * asynchronously. Keep asking for kernel_info until we have both a reply and iopub traffic.
 */
async function handshake(conn: KernelConnection): Promise<KernelMessage<KernelInfo>> {
  const deadline = Date.now() + 60_000;
  let reply: KernelMessage<KernelInfo> | undefined;
  while (Date.now() < deadline) {
    if (conn.closed) throw new Error('The kernel exited while starting.');
    const request = conn.request('kernel_info_request', {});
    const answered = await Promise.race([request.done.catch(() => undefined), sleep(reply ? 150 : 600)]);
    if (answered) reply = answered as KernelMessage<KernelInfo>;
    else conn.forget(request.msgId);
    if (reply && conn.iopubSeen) return reply;
  }
  throw new Error('The kernel did not respond in time.');
}

let pendingSelection: Promise<unknown> | null = null;

/**
 * Registers kernel discovery that is still under way. Running a cell the instant a notebook
 * opens waits for it instead of failing with "no kernel selected".
 */
export function selectionInProgress(task: Promise<unknown>) {
  pendingSelection = task;
  void task.finally(() => {
    if (pendingSelection === task) pendingSelection = null;
  });
}

/** Returns the live connection, starting the selected kernel first if necessary. */
export async function ensureKernel(): Promise<KernelConnection> {
  if (connection && !connection.closed) return connection;
  if (starting) return starting;
  if (!spec() && pendingSelection) await pendingSelection.catch(() => {});
  if (connection && !connection.closed) return connection;
  if (starting) return starting;
  const chosen = spec();
  if (!chosen) throw new Error('No kernel is selected.');
  if (!chosen.available) throw new Error(`ipykernel is not installed in “${chosen.displayName}”.`);

  const myEpoch = ++epoch;
  batch(() => {
    setStatus('starting');
    setFailure(null);
  });

  const attempt = (async () => {
    let conn: KernelConnection | null = null;
    try {
      const started = await call<{ kernelId: string; interruptMode: string }>('kernel.start', {
        specId: chosen.id,
        cwd: workingDirectory(),
        extraArguments: LAUNCH_ARGUMENTS,
      });
      conn = new KernelConnection(started.kernelId);
      if (myEpoch !== epoch) throw new Error('Kernel start was cancelled.');
      const live = conn;
      live.onExit = (exit) => handleExit(live, exit);
      const reply = await handshake(live);
      if (myEpoch !== epoch) throw new Error('Kernel start was cancelled.');

      interruptMode = started.interruptMode;
      live.onStatus = (state) => {
        if (connection === live && state !== 'starting') setStatus(state);
      };
      live.onComm = (message) => commListeners.forEach((listener) => listener(message));
      live.onUnsolicited = (message) => unsolicitedListeners.forEach((listener) => listener(message));
      connection = live;
      batch(() => {
        setInfo(reply.content);
        setStatus('idle');
        setGeneration((n) => n + 1);
      });
      return live;
    } catch (error) {
      if (conn) {
        const id = conn.kernelId;
        conn.close();
        call('kernel.shutdown', { kernelId: id }).catch(() => {});
      }
      if (myEpoch === epoch) {
        batch(() => {
          setStatus('dead');
          setFailure(error instanceof Error ? error.message : String(error));
        });
      }
      throw error;
    } finally {
      if (myEpoch === epoch) starting = null;
    }
  })();
  starting = attempt;
  return attempt;
}

function handleExit(conn: KernelConnection, exit: KernelExit) {
  if (connection !== conn) return;
  connection = null;
  if (exit.expected) return;
  batch(() => {
    setStatus('dead');
    const log = exit.log.trim();
    setFailure(`The kernel died unexpectedly (exit code ${exit.code}).` + (log ? `\n\n${log.split('\n').slice(-12).join('\n')}` : ''));
  });
  resetListeners.forEach((listener) => listener('died'));
}

export async function shutdownKernel(reason: 'restart' | 'shutdown' = 'shutdown') {
  epoch++;
  starting = null;
  const conn = connection;
  connection = null;
  batch(() => {
    setStatus('none');
    setFailure(null);
  });
  resetListeners.forEach((listener) => listener(reason));
  if (conn) {
    conn.close();
    await call('kernel.shutdown', { kernelId: conn.kernelId }).catch(() => {});
  }
}

export async function restartKernel(): Promise<KernelConnection> {
  await shutdownKernel('restart');
  return ensureKernel();
}

export function interruptKernel() {
  const conn = connection;
  if (!conn) return;
  if (interruptMode === 'message') conn.send('control', 'interrupt_request', {});
  else call('kernel.interrupt', { kernelId: conn.kernelId }).catch(() => {});
}

export function kernelLanguage(): string {
  return (info()?.language_info?.name ?? spec()?.language ?? 'python').toLowerCase();
}
