// A connection to one running kernel, speaking the Jupyter messaging protocol.
// https://jupyter-client.readthedocs.io/en/stable/messaging.html

import { call, on } from '../host';
import { uuid } from '../util/misc';

export type Channel = 'shell' | 'iopub' | 'stdin' | 'control';

export interface Header {
  msg_id: string;
  msg_type: string;
  session: string;
  username: string;
  date: string;
  version: string;
}

export interface KernelMessage<T = any> {
  channel: Channel;
  header: Header;
  parent_header: Partial<Header>;
  metadata: Record<string, any>;
  content: T;
  buffers?: string[];
}

export interface RequestHandlers {
  onIOPub?: (message: KernelMessage) => void;
  onStdin?: (message: KernelMessage) => void;
  onReply?: (message: KernelMessage) => void;
}

export interface KernelExit {
  code: number;
  crashed: boolean;
  expected: boolean;
  log: string;
}

interface Pending {
  handlers: RequestHandlers;
  resolve: (reply: KernelMessage) => void;
  reject: (error: Error) => void;
  reply?: KernelMessage;
  idle: boolean;
  waitForIdle: boolean;
}

export class KernelDiedError extends Error {
  constructor(message = 'The kernel died.') {
    super(message);
    this.name = 'KernelDiedError';
  }
}

export class KernelConnection {
  readonly session = uuid();
  /** True once anything has arrived on iopub — the subscription is live. */
  iopubSeen = false;
  closed = false;

  /** Kernel-wide busy/idle state, whoever caused it. */
  onStatus?: (state: 'starting' | 'idle' | 'busy') => void;
  /** comm_open / comm_msg / comm_close traffic. */
  onComm?: (message: KernelMessage) => void;
  /** iopub messages that do not belong to one of our pending requests. */
  onUnsolicited?: (message: KernelMessage) => void;
  onExit?: (info: KernelExit) => void;

  private pending = new Map<string, Pending>();
  private subscriptions: (() => void)[];

  constructor(readonly kernelId: string) {
    this.subscriptions = [
      on('kernel.message', (message) => {
        if (message.kernelId === kernelId) this.receive(message);
      }),
      on('kernel.exit', (info) => {
        if (info.kernelId === kernelId) this.exited(info);
      }),
    ];
  }

  send(
    channel: Channel,
    type: string,
    content: unknown,
    options: { msgId?: string; parent?: Partial<Header>; metadata?: Record<string, unknown>; buffers?: string[] } = {},
  ): string {
    const header: Header = {
      msg_id: options.msgId ?? uuid(),
      msg_type: type,
      session: this.session,
      username: 'sumi',
      date: new Date().toISOString(),
      version: '5.3',
    };
    if (!this.closed) {
      call('kernel.send', {
        kernelId: this.kernelId,
        channel,
        header: JSON.stringify(header),
        parent_header: JSON.stringify(options.parent ?? {}),
        metadata: JSON.stringify(options.metadata ?? {}),
        content: JSON.stringify(content),
        buffers: options.buffers,
      }).catch((error) => console.warn('[kernel] send failed', error));
    }
    return header.msg_id;
  }

  /**
   * Sends a request and resolves with its reply. With `waitForIdle`, resolution also waits for
   * the kernel to report idle for this request — the only reliable sign that all of an
   * execution's output has been published.
   */
  request(
    type: string,
    content: unknown,
    handlers: RequestHandlers = {},
    options: { channel?: Channel; waitForIdle?: boolean } = {},
  ): { msgId: string; done: Promise<KernelMessage> } {
    const msgId = uuid();
    const done = new Promise<KernelMessage>((resolve, reject) => {
      if (this.closed) {
        reject(new KernelDiedError());
        return;
      }
      this.pending.set(msgId, { handlers, resolve, reject, idle: false, waitForIdle: options.waitForIdle ?? false });
    });
    this.send(options.channel ?? 'shell', type, content, { msgId });
    return { msgId, done };
  }

  /** Stops waiting for a request (its late messages are then treated as unsolicited). */
  forget(msgId: string) {
    this.pending.delete(msgId);
  }

  private receive(message: KernelMessage) {
    const type = message.header.msg_type;
    const parentId = message.parent_header?.msg_id;
    const pending = parentId ? this.pending.get(parentId) : undefined;

    switch (message.channel) {
      case 'iopub': {
        this.iopubSeen = true;
        if (type === 'status') this.onStatus?.(message.content.execution_state);
        if (type === 'comm_open' || type === 'comm_msg' || type === 'comm_close') this.onComm?.(message);
        if (pending) {
          pending.handlers.onIOPub?.(message);
          if (type === 'status' && message.content.execution_state === 'idle') {
            pending.idle = true;
            this.settle(parentId!, pending);
          }
        } else {
          this.onUnsolicited?.(message);
        }
        break;
      }
      case 'stdin':
        pending?.handlers.onStdin?.(message);
        break;
      default:
        if (pending && type.endsWith('_reply')) {
          pending.reply = message;
          pending.handlers.onReply?.(message);
          this.settle(parentId!, pending);
        }
    }
  }

  private settle(msgId: string, pending: Pending) {
    if (!pending.reply || (pending.waitForIdle && !pending.idle)) return;
    this.pending.delete(msgId);
    pending.resolve(pending.reply);
  }

  private exited(info: KernelExit) {
    this.close(new KernelDiedError(info.expected ? 'The kernel was shut down.' : 'The kernel died.'));
    this.onExit?.(info);
  }

  close(reason: Error = new KernelDiedError('The kernel connection was closed.')) {
    if (this.closed) return;
    this.closed = true;
    for (const unsubscribe of this.subscriptions) unsubscribe();
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const pending of waiting) pending.reject(reason);
  }
}
