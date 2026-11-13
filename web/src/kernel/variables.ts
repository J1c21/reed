// The variables the kernel holds, for the palette's "Variables" list. Asked for silently — the
// probe is not stored in history and leaves nothing behind in the namespace.

import { currentConnection, kernelLanguage } from './kernel';

export interface Variable {
  name: string;
  type: string;
  value: string;
}

const VARIABLES_PROBE = String.raw`
def __reed_vars__():
    import base64, json, types
    shell = get_ipython()
    hidden = set(shell.user_ns_hidden)
    out = []
    for name, value in list(shell.user_ns.items()):
        if name.startswith('_') or name in hidden or name in ('In', 'Out', 'exit', 'quit', 'get_ipython', 'open'):
            continue
        if isinstance(value, (types.ModuleType, types.FunctionType, types.BuiltinFunctionType, type)):
            continue
        kind = type(value).__name__
        try:
            shape = getattr(value, 'shape', None)
            if shape is not None and isinstance(shape, tuple):
                kind += ' ' + ' × '.join(str(n) for n in shape)
            elif hasattr(value, '__len__') and not isinstance(value, str):
                kind += ' (%d)' % len(value)
        except Exception:
            pass
        try:
            text = repr(value)
        except Exception:
            text = '<unprintable>'
        text = ' '.join(text.split())
        out.append({'name': name, 'type': kind, 'value': text[:160]})
        if len(out) >= 300:
            break
    return base64.b64encode(json.dumps(out).encode()).decode()
__reed_r__ = __reed_vars__()
del __reed_vars__
`;

export async function fetchVariables(): Promise<Variable[] | null> {
  const conn = currentConnection();
  if (!conn || conn.closed || kernelLanguage() !== 'python') return null;
  try {
    const reply = await conn.request('execute_request', {
      code: VARIABLES_PROBE,
      silent: true,
      store_history: false,
      user_expressions: { reed: "globals().pop('__reed_r__', '')" },
      allow_stdin: false,
      stop_on_error: false,
    }).done;
    const text: string | undefined = reply.content?.user_expressions?.reed?.data?.['text/plain'];
    if (!text) return [];
    const bytes = Uint8Array.from(atob(text.replace(/^['"]|['"]$/g, '')), (char) => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as Variable[];
  } catch {
    return null;
  }
}
