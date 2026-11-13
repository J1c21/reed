// ipywidgets, the light way.
//
// Jupyter widgets are a pair: a model living in the kernel and a view in the front end, kept
// in sync over a "comm". Instead of loading the (large) reference JavaScript implementation,
// Reed keeps the models' state here and renders the common widgets natively — so a progress
// bar or a slider looks like part of the app, and costs nothing until one is used.

import { createSignal } from 'solid-js';
import { createStore, type SetStoreFunction } from 'solid-js/store';
import { nextOutputKey, type Output } from '../notebook/nbformat';
import type { KernelMessage } from './connection';
import { currentConnection, onComm, onKernelReset } from './kernel';

export interface WidgetModel {
  id: string;
  state: Record<string, any>;
  set: SetStoreFunction<Record<string, any>>;
  /** Output widgets: a pending clear_output(wait=True). */
  clearOnNext: boolean;
}

const models = new Map<string, WidgetModel>();
/** Output widgets currently capturing, by the msg_id whose output they collect. */
const captures = new Map<string, WidgetModel>();
const [revision, setRevision] = createSignal(0);

/** Reactive lookup: re-evaluates when models come and go. */
export function widgetModel(id: string | undefined | null): WidgetModel | undefined {
  revision();
  return id ? models.get(id) : undefined;
}

export function modelRef(value: unknown): string | null {
  return typeof value === 'string' && value.startsWith('IPY_MODEL_') ? value.slice('IPY_MODEL_'.length) : null;
}

function syncCapture(model: WidgetModel, previous: string | undefined) {
  if (model.state._model_name !== 'OutputModel') return;
  if (previous && captures.get(previous) === model) captures.delete(previous);
  const current: string | undefined = model.state.msg_id;
  if (current) captures.set(current, model);
}

onComm((message) => {
  const content = message.content ?? {};
  const id: string | undefined = content.comm_id;
  if (!id) return;
  switch (message.header.msg_type) {
    case 'comm_open': {
      if (content.target_name !== 'jupyter.widget') return;
      const initial = { ...(content.data?.state ?? {}) };
      if (Array.isArray(initial.outputs)) initial.outputs = initial.outputs.map(adoptOutput);
      const [state, set] = createStore<Record<string, any>>(initial);
      const model: WidgetModel = { id, state, set, clearOnNext: false };
      models.set(id, model);
      syncCapture(model, undefined);
      setRevision((n) => n + 1);
      break;
    }
    case 'comm_msg': {
      const model = models.get(id);
      const data = content.data ?? {};
      if (!model || (data.method !== 'update' && data.method !== 'echo_update') || !data.state) return;
      const previous: string | undefined = model.state.msg_id;
      const patch = { ...data.state };
      if (Array.isArray(patch.outputs)) patch.outputs = patch.outputs.map(adoptOutput);
      model.set(patch);
      if ('msg_id' in patch) syncCapture(model, previous);
      break;
    }
    case 'comm_close': {
      const model = models.get(id);
      if (!model) return;
      if (model.state.msg_id) captures.delete(model.state.msg_id);
      models.delete(id);
      setRevision((n) => n + 1);
      break;
    }
  }
});

onKernelReset(() => {
  models.clear();
  captures.clear();
  setRevision((n) => n + 1);
});

function adoptOutput(raw: any): Output {
  const output = { ...raw, _key: nextOutputKey() };
  if (output.output_type === 'stream' && Array.isArray(output.text)) output.text = output.text.join('');
  return output as Output;
}

/**
 * Output widgets (`with out:`, `interact`) collect whatever is published under a particular
 * request. Returns true when the message was diverted into one of them.
 */
export function captureOutput(message: KernelMessage): boolean {
  const parent = message.parent_header?.msg_id;
  const model = parent ? captures.get(parent) : undefined;
  if (!model) return false;
  const content = message.content ?? {};
  const outputs: Output[] = model.state.outputs ?? [];
  const begin = (): Output[] => {
    if (!model.clearOnNext) return outputs;
    model.clearOnNext = false;
    return [];
  };

  switch (message.header.msg_type) {
    case 'clear_output':
      if (content.wait) model.clearOnNext = true;
      else model.set('outputs', []);
      return true;
    case 'stream': {
      const current = begin();
      const last = current[current.length - 1];
      const text = String(content.text ?? '');
      if (last && last.output_type === 'stream' && last.name === content.name && current === outputs) {
        (model.set as any)('outputs', current.length - 1, 'text', (previous: string) => previous + text);
      } else {
        model.set('outputs', [...current, { _key: nextOutputKey(), output_type: 'stream', name: content.name ?? 'stdout', text }]);
      }
      return true;
    }
    case 'display_data':
    case 'execute_result':
      model.set('outputs', [
        ...begin(),
        {
          _key: nextOutputKey(),
          output_type: message.header.msg_type,
          data: content.data ?? {},
          metadata: content.metadata ?? {},
          ...(content.transient?.display_id ? { _displayId: content.transient.display_id } : {}),
        } as Output,
      ]);
      return true;
    case 'error':
      model.set('outputs', [
        ...begin(),
        {
          _key: nextOutputKey(),
          output_type: 'error',
          ename: String(content.ename ?? ''),
          evalue: String(content.evalue ?? ''),
          traceback: Array.isArray(content.traceback) ? content.traceback : [],
        },
      ]);
      return true;
    default:
      return false;
  }
}

/** Applies a change made in the UI and tells the kernel about it. */
export function updateWidget(model: WidgetModel, patch: Record<string, unknown>) {
  model.set(patch);
  currentConnection()?.send('shell', 'comm_msg', {
    comm_id: model.id,
    data: { method: 'update', state: patch, buffer_paths: [] },
  });
}

export function sendWidgetEvent(model: WidgetModel, content: Record<string, unknown>) {
  currentConnection()?.send('shell', 'comm_msg', {
    comm_id: model.id,
    data: { method: 'custom', content },
  });
}
