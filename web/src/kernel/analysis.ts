// Static dependency analysis for reactive execution.
//
// To know which cells depend on which, we need each cell's definitions and references. The
// only thing that knows Python's scoping rules exactly is Python, so the analysis runs inside
// the kernel itself (silently, leaving nothing behind) using `symtable` and `ast`, after
// IPython has translated magics and shell escapes into ordinary code.

import type { KernelConnection } from './connection';

export interface CellDeps {
  defs: string[];
  refs: string[];
}

const ANALYZER = String.raw`
def __sumi__(payload):
    import ast, base64, json, re, symtable
    try:
        shell = get_ipython()
    except NameError:
        shell = None

    class Order(ast.NodeVisitor):
        """Walks module-level code in evaluation order, recording whether each name is first
        read or first written. Nested scopes are left to symtable."""
        def __init__(self):
            self.first = {}
        def note(self, name, kind):
            self.first.setdefault(name, kind)
        def visit_Name(self, node):
            self.note(node.id, 'store' if isinstance(node.ctx, ast.Store) else 'load')
        def visit_Assign(self, node):
            self.visit(node.value)
            for target in node.targets:
                self.visit(target)
        def visit_AugAssign(self, node):
            self.visit(node.value)
            if isinstance(node.target, ast.Name):
                self.note(node.target.id, 'load')
            else:
                self.visit(node.target)
        def visit_AnnAssign(self, node):
            if node.value is not None:
                self.visit(node.value)
            self.visit(node.target)
        def visit_NamedExpr(self, node):
            self.visit(node.value)
            self.visit(node.target)
        def visit_For(self, node):
            self.visit(node.iter)
            self.visit(node.target)
            for child in node.body + node.orelse:
                self.visit(child)
        visit_AsyncFor = visit_For
        def scope(self, node):
            for decorator in getattr(node, 'decorator_list', []):
                self.visit(decorator)
            arguments = getattr(node, 'args', None)
            if isinstance(arguments, ast.arguments):
                for default in list(arguments.defaults) + [d for d in arguments.kw_defaults if d is not None]:
                    self.visit(default)
            for base in getattr(node, 'bases', []):
                self.visit(base)
            for keyword in getattr(node, 'keywords', []):
                self.visit(keyword.value)
            name = getattr(node, 'name', None)
            if name:
                self.note(name, 'store')
        visit_FunctionDef = visit_AsyncFunctionDef = visit_ClassDef = visit_Lambda = scope
        def comprehension(self, node):
            self.visit(node.generators[0].iter)
        visit_ListComp = visit_SetComp = visit_DictComp = visit_GeneratorExp = comprehension
        def visit_Import(self, node):
            for alias in node.names:
                self.note((alias.asname or alias.name).split('.')[0], 'store')
        def visit_ImportFrom(self, node):
            for alias in node.names:
                self.note(alias.asname or alias.name, 'store')
        def visit_ExceptHandler(self, node):
            if node.type is not None:
                self.visit(node.type)
            if node.name:
                self.note(node.name, 'store')
            for child in node.body:
                self.visit(child)

    def analyze(source):
        lines = source.split('\n')
        if source.startswith('%%'):
            magic = lines[0][2:].split(' ')[0].strip()
            if magic not in ('time', 'timeit', 'capture', 'prun'):
                return {'d': [], 'r': []}
            lines = lines[1:]
        source = '\n'.join(re.sub(r'^(\s*)%time\s+', r'\1', line) for line in lines)
        code = shell.transform_cell(source) if shell is not None else source
        table = symtable.symtable(code, '<cell>', 'exec')
        order = Order()
        order.visit(ast.parse(code))
        defs, loads, late = set(), set(), set()
        for symbol in table.get_symbols():
            name = symbol.get_name()
            if symbol.is_assigned() or symbol.is_imported():
                defs.add(name)
            if symbol.is_referenced():
                loads.add(name)
        def nested(scope):
            for child in scope.get_children():
                for symbol in child.get_symbols():
                    if symbol.is_global():
                        if symbol.is_assigned():
                            defs.add(symbol.get_name())
                        if symbol.is_referenced():
                            late.add(symbol.get_name())
                nested(child)
        nested(table)
        refs = {name for name in loads if name not in defs or order.first.get(name) == 'load'}
        refs |= {name for name in late if name not in defs}
        refs.discard('get_ipython')
        return {'d': sorted(defs), 'r': sorted(refs)}

    out = []
    for source in json.loads(payload):
        try:
            out.append(analyze(source))
        except Exception:
            out.append(None)
    return base64.b64encode(json.dumps(out).encode()).decode()
`;

const cache = new Map<string, CellDeps | null>();

export function resetAnalysisCache() {
  cache.clear();
}

/**
 * Returns definitions and references for each source, asking the kernel only about sources
 * it has not analysed before. `null` marks a source that could not be analysed.
 */
export async function analyzeSources(conn: KernelConnection, sources: string[]): Promise<(CellDeps | null)[]> {
  const missing = [...new Set(sources.filter((source) => !cache.has(source)))];
  if (missing.length) {
    // JSON.stringify of a JSON string is also a valid Python string literal.
    const literal = JSON.stringify(JSON.stringify(missing));
    const code = `${ANALYZER}\n__sumi_r__ = __sumi__(${literal})\ndel __sumi__\n`;
    try {
      const reply = await conn.request('execute_request', {
        code,
        silent: true,
        store_history: false,
        user_expressions: { sumi: "globals().pop('__sumi_r__', '')" },
        allow_stdin: false,
        stop_on_error: false,
      }).done;
      const text: string | undefined = reply.content?.user_expressions?.sumi?.data?.['text/plain'];
      if (reply.content?.status === 'ok' && text) {
        const results = JSON.parse(atob(text.replace(/^['"]|['"]$/g, ''))) as ({ d: string[]; r: string[] } | null)[];
        missing.forEach((source, i) => {
          const result = results[i];
          cache.set(source, result ? { defs: result.d, refs: result.r } : null);
        });
      }
    } catch {
      /* the kernel went away; treat everything as unknown */
    }
  }
  return sources.map((source) => cache.get(source) ?? null);
}

export interface DepNode {
  id: string;
  deps: CellDeps | null;
}

export interface Dependent {
  id: string;
  /** The name through which the dependency flows, and the cell that provides it. */
  name: string;
  provider: string;
}

/**
 * Cells that (transitively) depend on `rootId`, in an order safe to execute.
 *
 * Unlike marimo, Jupyter notebooks may bind the same name in several cells. A reference
 * resolves to the nearest definition above it in the document — the way a notebook reads —
 * falling back to the nearest one below.
 */
export function dependents(nodes: DepNode[], rootId: string): Dependent[] {
  const position = new Map(nodes.map((node, i) => [node.id, i]));
  const definers = new Map<string, number[]>();
  nodes.forEach((node, i) => {
    for (const name of node.deps?.defs ?? []) {
      let list = definers.get(name);
      if (!list) definers.set(name, (list = []));
      list.push(i);
    }
  });

  // edges[provider] = cells reading something it defines
  const edges = new Map<string, { to: string; name: string }[]>();
  nodes.forEach((node, i) => {
    for (const name of node.deps?.refs ?? []) {
      const candidates = definers.get(name);
      if (!candidates) continue;
      let provider = -1;
      for (const candidate of candidates) {
        if (candidate < i) provider = candidate;
        else if (candidate > i && provider < 0) {
          provider = candidate;
          break;
        }
      }
      if (provider < 0) continue;
      const from = nodes[provider].id;
      let list = edges.get(from);
      if (!list) edges.set(from, (list = []));
      list.push({ to: node.id, name });
    }
  });

  // Everything reachable from the root.
  const reached = new Map<string, Dependent>();
  const stack = [rootId];
  while (stack.length) {
    const from = stack.pop()!;
    for (const edge of edges.get(from) ?? []) {
      if (edge.to === rootId || reached.has(edge.to)) continue;
      reached.set(edge.to, { id: edge.to, name: edge.name, provider: from });
      stack.push(edge.to);
    }
  }
  if (reached.size === 0) return [];

  // Topological order within the reached set; ties and cycles fall back to document order.
  const indegree = new Map<string, number>([...reached.keys()].map((id) => [id, 0]));
  for (const id of reached.keys()) {
    for (const edge of edges.get(id) ?? []) {
      if (indegree.has(edge.to) && edge.to !== id) indegree.set(edge.to, indegree.get(edge.to)! + 1);
    }
  }
  const byPosition = (a: string, b: string) => position.get(a)! - position.get(b)!;
  const remaining = new Set(reached.keys());
  const ordered: Dependent[] = [];
  while (remaining.size) {
    const ready = [...remaining].filter((id) => indegree.get(id) === 0).sort(byPosition);
    const next = ready[0] ?? [...remaining].sort(byPosition)[0];
    remaining.delete(next);
    ordered.push(reached.get(next)!);
    for (const edge of edges.get(next) ?? []) {
      if (remaining.has(edge.to)) indegree.set(edge.to, indegree.get(edge.to)! - 1);
    }
  }
  return ordered;
}
