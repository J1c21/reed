// The bridge between the web UI and its native host.
//
// In the app, requests travel through a WKWebView script message handler and events are
// pushed back in batches. During development the very same protocol runs over a WebSocket
// to `reed-dev`, so the UI can be built and inspected in an ordinary browser.

export interface HostInit {
  host: 'app' | 'dev';
  filePath: string | null;
  preferences: Record<string, unknown>;
  titlebarHeight: number;
  trafficLightsWidth: number;
  home: string;
  version: string;
  /** The window is being driven by a script, off screen; nothing should be saved unasked. */
  automated?: boolean;
}

export interface FileStat {
  exists: boolean;
  isDirectory?: boolean;
  size?: number;
  mtime?: number;
  writable?: boolean;
}

type Listener = (payload: any) => void;

declare global {
  interface Window {
    webkit?: { messageHandlers?: { reed?: { postMessage(message: unknown): Promise<unknown> } } };
    __reedReceive?: (batch: string) => void;
  }
}

const listeners = new Map<string, Set<Listener>>();
let callImpl: (method: string, params: unknown) => Promise<any> = () =>
  Promise.reject(new Error('Host is not connected.'));

export let hostKind: 'app' | 'dev' = 'dev';

function dispatch(event: string, payload: unknown) {
  const set = listeners.get(event);
  if (!set) return;
  for (const listener of [...set]) {
    try {
      listener(payload);
    } catch (error) {
      console.error(`[host] listener for ${event} failed`, error);
    }
  }
}

/** Subscribes to a host event. Returns a function that unsubscribes. */
export function on(event: string, listener: Listener): () => void {
  let set = listeners.get(event);
  if (!set) listeners.set(event, (set = new Set()));
  set.add(listener);
  return () => set!.delete(listener);
}

/** Calls a host method. */
export function call<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  return callImpl(method, params);
}

export function emitLocal(event: string, payload: unknown) {
  dispatch(event, payload);
}

export async function connectHost(): Promise<void> {
  const bridge = window.webkit?.messageHandlers?.reed;
  if (bridge) {
    hostKind = 'app';
    callImpl = (method, params) => bridge.postMessage({ method, params });
    window.__reedReceive = (batch) => {
      const events = JSON.parse(batch) as [string, unknown][];
      for (const [event, payload] of events) dispatch(event, payload);
    };
    return;
  }
  hostKind = 'dev';
  await connectDevSocket();
}

function connectDevSocket(): Promise<void> {
  const port = new URLSearchParams(location.search).get('hostPort') ?? '47821';
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    let nextId = 1;
    let opened = false;

    socket.onopen = () => {
      opened = true;
      callImpl = (method, params) =>
        new Promise((res, rej) => {
          const id = nextId++;
          pending.set(id, { resolve: res, reject: rej });
          socket.send(JSON.stringify({ id, method, params }));
        });
      resolve();
    };
    socket.onmessage = (message) => {
      const data = JSON.parse(message.data as string);
      if (typeof data.event === 'string') {
        dispatch(data.event, data.payload);
        return;
      }
      const entry = pending.get(data.id);
      if (!entry) return;
      pending.delete(data.id);
      if (data.error) entry.reject(new Error(data.error.message ?? 'Request failed'));
      else entry.resolve(data.result);
    };
    socket.onclose = () => {
      const error = new Error('The development host disconnected.');
      for (const entry of pending.values()) entry.reject(error);
      pending.clear();
      callImpl = () => Promise.reject(error);
      if (opened) dispatch('host.disconnected', {});
      else reject(new Error(`Cannot reach reed-dev on port ${port}. Start it with: swift run reed-dev`));
    };
  });
}

/** A URL the page can load a local file from (images referenced by markdown cells). */
export function localFileUrl(absolutePath: string): string {
  const encoded = absolutePath.split('/').map(encodeURIComponent).join('/');
  return hostKind === 'app' ? `reed://app/__file__${encoded}` : `/@fs${encoded}`;
}
