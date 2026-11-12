// Running cells: the queue, turning kernel messages into outputs, and reactivity.

import { batch, createSignal } from 'solid-js';
import { analyzeSources, dependents, resetAnalysisCache, type DepNode } from '../kernel/analysis';
import type { KernelConnection, KernelMessage } from '../kernel/connection';
import {
  currentConnection,
  ensureKernel,
  interruptKernel,
  kernel,
  kernelLanguage,
  onKernelReset,
  onUnsolicited,
  restartKernel,
} from '../kernel/kernel';
import { captureOutput } from '../kernel/widgets';
import { prefs } from '../state/prefs';
import { surfaces } from '../state/surfaces';
import { nextOutputKey, type Output, type RichOutput } from './nbformat';
import { cellById, cellIndex, insertCell, notebook, setSource, touch, type Cell } from './store';

interface Job {
  cell: Cell;
  /** Queued because an upstream cell ran, not because the user asked. */
  reactive: boolean;
}

const queue: Job[] = [];
let pumping = false;
let current: Cell | null = null;
let lastReset: 'restart' | 'died' | 'shutdown' | null = null;

/** Executions of the current kernel session, so late output finds its cell. */
const cellByRequest = new Map<string, Cell>();
/** Cells holding outputs published with a display_id. */
const displays = new Map<string, Set<Cell>>();

const [busyCount, setBusyCount] = createSignal(0);
const [runningCell, setRunningCell] = createSignal<Cell | null>(null);
const [notice, setNotice] = createSignal<{ kind: 'error' | 'info'; text: string } | null>(null);

export const execution = { busyCount, runningCell, notice };
export { setNotice };

function refreshBusy() {
  setBusyCount(queue.length + (current ? 1 : 0));
}

// ── Outputs ─────────────────────────────────────────────────────────────────

function pushOutput(cell: Cell, output: Output) {
  (cell.set as any)('outputs', cell.state.outputs.length, output);
  if (output._displayId) {
    let holders = displays.get(output._displayId);
    if (!holders) displays.set(output._displayId, (holders = new Set()));
    holders.add(cell);
  }
}

function appendStream(cell: Cell, name: string, text: string) {
  const outputs = cell.state.outputs;
  const last = outputs[outputs.length - 1];
  if (last && last.output_type === 'stream' && last.name === name) {
    (cell.set as any)('outputs', outputs.length - 1, 'text', (previous: string) => previous + text);
  } else {
    pushOutput(cell, { _key: nextOutputKey(), output_type: 'stream', name, text });
  }
}

function updateDisplay(content: any) {
  const id: string | undefined = content?.transient?.display_id;
  if (!id) return;
  for (const cell of displays.get(id) ?? []) {
    cell.state.outputs.forEach((output, i) => {
      if (output._displayId !== id) return;
      (cell.set as any)('outputs', i, { data: content.data ?? {}, metadata: content.metadata ?? {} });
    });
  }
}

/** Applies one execution's messages to a cell. */
class OutputSink {
  private clearOnNext = false;

  constructor(
    private cell: Cell,
    private conn: KernelConnection,
  ) {}

  /** Called before anything is added: drops what the previous run left behind. */
  begin() {
    if (this.cell.state.pendingClear || this.clearOnNext) {
      this.cell.set({ outputs: [], pendingClear: false });
      this.clearOnNext = false;
    }
  }

  iopub(message: KernelMessage) {
    // Output widgets (`with out:`, `interact`) claim what is printed under their request.
    if (captureOutput(message)) return;
    const content = message.content;
    switch (message.header.msg_type) {
      case 'stream':
        this.begin();
        appendStream(this.cell, content.name ?? 'stdout', String(content.text ?? ''));
        break;
      case 'display_data':
      case 'execute_result': {
        this.begin();
        const output: RichOutput = {
          _key: nextOutputKey(),
          output_type: message.header.msg_type,
          data: content.data ?? {},
          metadata: content.metadata ?? {},
        };
        if (output.output_type === 'execute_result') output.execution_count = content.execution_count ?? null;
        if (content.transient?.display_id) output._displayId = content.transient.display_id;
        pushOutput(this.cell, output);
        break;
      }
      case 'error':
        this.begin();
        pushOutput(this.cell, {
          _key: nextOutputKey(),
          output_type: 'error',
          ename: String(content.ename ?? ''),
          evalue: String(content.evalue ?? ''),
          traceback: Array.isArray(content.traceback) ? content.traceback : [],
        });
        break;
      case 'update_display_data':
        updateDisplay(content);
        break;
      case 'clear_output':
        if (content.wait) this.clearOnNext = true;
        else this.cell.set({ outputs: [], pendingClear: false });
        break;
      default:
        return;
    }
    touch();
  }

  stdin(message: KernelMessage) {
    if (message.header.msg_type !== 'input_request') return;
    this.begin();
    const prompt = String(message.content.prompt ?? '');
    const password = !!message.content.password;
    this.cell.set('inputRequest', {
      prompt,
      password,
      submit: (value: string) => {
        this.conn.send('stdin', 'input_reply', { value }, { parent: message.header });
        batch(() => {
          appendStream(this.cell, 'stdout', `${prompt}${password ? '•'.repeat(Math.min(value.length, 12)) : value}\n`);
          this.cell.set('inputRequest', null);
        });
        touch();
      },
    });
  }

  /** `%load`, `obj?` and friends ask the front end to do something via reply payloads. */
  payloads(reply: KernelMessage) {
    for (const payload of reply.content?.payload ?? []) {
      if (payload.source === 'page' && payload.data) {
        this.begin();
        pushOutput(this.cell, { _key: nextOutputKey(), output_type: 'display_data', data: payload.data, metadata: {} });
      } else if (payload.source === 'set_next_input' && typeof payload.text === 'string') {
        if (payload.replace) setSource(this.cell, payload.text);
        else insertCell(cellIndex(this.cell) + 1, 'code', payload.text);
      }
    }
  }
}

// Output that arrives after its cell finished (threads, async callbacks, timers).
onUnsolicited((message) => {
  if (captureOutput(message)) return;
  const type = message.header.msg_type;
  if (type === 'update_display_data') {
    updateDisplay(message.content);
    touch();
    return;
  }
  if (type !== 'stream' && type !== 'display_data' && type !== 'error' && type !== 'execute_result') return;
  const cell = cellByRequest.get(message.parent_header?.msg_id ?? '');
  const conn = currentConnection();
  if (!cell || !conn || !cellById(cell.id)) return;
  new OutputSink(cell, conn).iopub(message);
});

// ── The queue ───────────────────────────────────────────────────────────────

/** Queues cells for execution. Markdown cells are simply rendered. */
export function runCells(targets: Cell[], options: { reactive?: boolean } = {}) {
  batch(() => {
    for (const cell of targets) {
      if (!cell.isCode) {
        if (cell.state.editing) cell.set('editing', false);
        continue;
      }
      if (cell.state.run !== 'idle') continue;
      if (!cell.state.source.trim()) {
        if (cell.state.outputs.length || cell.state.execution_count !== null) {
          cell.set({ outputs: [], execution_count: null, pendingClear: false });
          touch();
        }
        continue;
      }
      cell.set('run', 'queued');
      queue.push({ cell, reactive: options.reactive ?? false });
    }
    refreshBusy();
  });
  void pump();
}

function abortQueue() {
  batch(() => {
    for (const job of queue) {
      if (job.cell.state.run === 'queued') job.cell.set('run', 'idle');
    }
    queue.length = 0;
    refreshBusy();
  });
}

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (queue.length) {
      const job = queue.shift()!;
      const ok = await execute(job);
      if (!ok) abortQueue();
    }
  } finally {
    pumping = false;
    current = null;
    batch(() => {
      setRunningCell(null);
      refreshBusy();
    });
  }
}

async function execute(job: Job): Promise<boolean> {
  const cell = job.cell;
  if (!cellById(cell.id)) return true; // deleted while queued

  let conn: KernelConnection;
  try {
    lastReset = null;
    conn = await ensureKernel();
  } catch (error) {
    cell.set('run', 'idle');
    if (!kernel.spec()) {
      // Nothing to run the code with: say so and offer the choices there are.
      setNotice({
        kind: 'error',
        text: kernel.specs().length
          ? 'Choose a kernel to run this notebook.'
          : 'No Jupyter kernel was found. Install one with:  pip install ipykernel',
      });
      surfaces.setPalette('kernels');
    } else if (lastReset === null && kernel.status() !== 'dead') {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
    }
    return false;
  }
  if (cell.state.run !== 'queued') return true; // cancelled while the kernel was starting

  const code = cell.state.source;
  const started = performance.now();
  current = cell;
  batch(() => {
    cell.set({
      run: 'running',
      runStarted: Date.now(),
      pendingClear: cell.state.outputs.length > 0,
      inputRequest: null,
      stale: false,
      staleReason: '',
    });
    setRunningCell(cell);
    refreshBusy();
  });

  const sink = new OutputSink(cell, conn);
  const request = conn.request(
    'execute_request',
    { code, silent: false, store_history: true, user_expressions: {}, allow_stdin: true, stop_on_error: true },
    { onIOPub: (message) => sink.iopub(message), onStdin: (message) => sink.stdin(message) },
    { waitForIdle: true },
  );
  cellByRequest.set(request.msgId, cell);

  let reply: KernelMessage | null = null;
  try {
    reply = await request.done;
  } catch {
    reply = null;
  }

  const status: 'ok' | 'error' | 'aborted' = reply ? (reply.content.status ?? 'ok') : 'aborted';
  batch(() => {
    if (reply) {
      sink.payloads(reply);
    } else if (lastReset === 'died') {
      sink.begin();
      pushOutput(cell, {
        _key: nextOutputKey(),
        output_type: 'error',
        ename: 'KernelDied',
        evalue: 'The kernel died while running this cell.',
        traceback: [],
      });
    }
    // Nothing was printed this time: whatever the previous run left behind is now out of date.
    if (cell.state.pendingClear) cell.set({ outputs: [], pendingClear: false });
    cell.set({
      run: 'idle',
      execution_count: reply ? (reply.content.execution_count ?? cell.state.execution_count) : cell.state.execution_count,
      lastDuration: performance.now() - started,
      lastStatus: status,
      ranSource: reply ? code : null,
      inputRequest: null,
    });
    current = null;
    refreshBusy();
  });
  touch();

  if (!reply) return false;
  if (status === 'ok' && !job.reactive) await propagate(cell, conn);
  return status === 'ok';
}

// ── Reactivity ──────────────────────────────────────────────────────────────

async function dependencyNodes(conn: KernelConnection): Promise<DepNode[]> {
  const codeCells = notebook.cells().filter((cell) => cell.isCode);
  const deps = await analyzeSources(conn, codeCells.map((cell) => cell.state.source));
  return codeCells.map((cell, i) => ({ id: cell.id, deps: deps[i] }));
}

/** After a cell ran: re-run what depends on it (reactive mode) or mark it stale. */
async function propagate(root: Cell, conn: KernelConnection) {
  if (kernelLanguage() !== 'python' || conn.closed) return;
  let affected;
  try {
    affected = dependents(await dependencyNodes(conn), root.id);
  } catch {
    return;
  }
  if (!affected.length) return;

  if (prefs.reactive) {
    const targets = affected.map((entry) => cellById(entry.id)).filter((cell): cell is Cell => !!cell && cell.state.run === 'idle');
    runCells(targets, { reactive: true });
    return;
  }
  batch(() => {
    for (const entry of affected) {
      const cell = cellById(entry.id);
      // Only cells that ran in this session hold state that can be out of date.
      if (!cell || cell.state.lastStatus === null || cell.state.run !== 'idle') continue;
      cell.set({ stale: true, staleReason: entry.name });
    }
  });
}

export function staleCells(): Cell[] {
  return notebook.cells().filter((cell) => cell.isCode && cell.state.stale);
}

// ── Commands ────────────────────────────────────────────────────────────────

export function interrupt() {
  abortQueue();
  interruptKernel();
}

/** Stops one cell: dequeues it if it is waiting, interrupts the kernel if it is running. */
export function stopCell(cell: Cell) {
  if (cell.state.run === 'queued') {
    const position = queue.findIndex((job) => job.cell === cell);
    if (position >= 0) queue.splice(position, 1);
    batch(() => {
      cell.set('run', 'idle');
      refreshBusy();
    });
  } else if (cell.state.run === 'running') {
    interrupt();
  }
}

export function isBusy(): boolean {
  return busyCount() > 0;
}

export async function restartAndRun(targets: () => Cell[]) {
  await restartKernel();
  runCells(targets());
}

onKernelReset((reason) => {
  lastReset = reason;
  abortQueue();
  cellByRequest.clear();
  displays.clear();
  resetAnalysisCache();
  batch(() => {
    for (const cell of notebook.cells()) {
      if (!cell.isCode) continue;
      cell.set({
        run: cell.state.run === 'running' ? 'running' : 'idle',
        stale: false,
        staleReason: '',
        lastStatus: null,
        lastDuration: null,
        ranSource: null,
        inputRequest: null,
      });
    }
  });
});
