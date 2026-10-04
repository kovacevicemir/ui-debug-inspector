/**
 * React adapter.
 *
 * Reads the fiber tree straight off the DOM node (`__reactFiber$…` keys) to find
 * the owning component, its props and its hook state. No React import needed, so
 * it works with any React 16.8+ app (dev or prod build).
 *
 * Known limit: React does not keep hook variable names, so state entries are
 * reported as `state #1`, `state #2`, … in hook order.
 */
import { ComponentSnapshot, InspectAdapter, InspectTarget, PropInfo } from './types.js';
import { elSummary, isPlainObject, truncate } from '../core/util.js';

interface Fiber {
  tag: number;
  type: unknown;
  elementType?: unknown;
  return: Fiber | null;
  child: Fiber | null;
  sibling: Fiber | null;
  memoizedProps?: Record<string, unknown>;
  memoizedState?: unknown;
  stateNode?: unknown;
  _debugSource?: { fileName?: string; lineNumber?: number };
  _debugOwner?: Fiber | null;
}

interface HookNode {
  memoizedState?: unknown;
  queue?: { dispatch?: unknown } | null;
  next?: HookNode | null;
}

const FUNCTION_TAGS = new Set([0, 1, 11, 14, 15]); // function, class, forwardRef, memo, simpleMemo
const HOST_TAG = 5;

function fiberKey(element: Element): string | null {
  for (const key of Object.keys(element)) {
    if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) return key;
  }
  return null;
}

function fiberOf(element: Element | null): Fiber | null {
  if (!element) return null;
  const key = fiberKey(element);
  if (!key) return null;
  return ((element as unknown as Record<string, unknown>)[key] as Fiber) ?? null;
}

function componentName(fiber: Fiber | null): string {
  if (!fiber) return '';
  const type = (fiber.type ?? fiber.elementType) as
    | { displayName?: string; name?: string; render?: { displayName?: string; name?: string }; type?: unknown }
    | string
    | undefined;
  if (typeof type === 'string') return type;
  if (!type) return 'Anonymous';
  if (type.displayName) return stripDecorators(type.displayName);
  if (type.name) return stripDecorators(type.name);
  if (type.render) return stripDecorators(type.render.displayName ?? type.render.name ?? 'ForwardRef');
  const inner = type.type as { displayName?: string; name?: string } | undefined;
  if (inner) return stripDecorators(inner.displayName ?? inner.name ?? 'Memo');
  return 'Anonymous';
}

function stripDecorators(name: string): string {
  // Dev builds often wrap classes/components; keep the readable part.
  return name.replace(/^[_$]+|_+$/g, '').replace(/\$/g, '') || 'Anonymous';
}

function owningFiber(from: Fiber | null): Fiber | null {
  let node = from;
  let depth = 0;
  while (node && depth < 60) {
    if (FUNCTION_TAGS.has(node.tag)) return node;
    node = node.return;
    depth += 1;
  }
  return null;
}

export class ReactAdapter implements InspectAdapter {
  readonly id = 'react' as const;

  detect(): boolean {
    if (typeof document === 'undefined') return false;
    const root = document.body ?? document.documentElement;
    for (const element of [root, ...Array.from(root.querySelectorAll('*')).slice(0, 30)]) {
      if (fiberKey(element)) return true;
    }
    return false;
  }

  findTarget(element: Element): InspectTarget | null {
    const hostFiber = fiberOf(element);
    if (!hostFiber) return null;
    const owner = owningFiber(hostFiber);
    if (!owner) return null;

    const chain = this.chain(owner);
    const hostElement = hostFiber.stateNode instanceof Element ? hostFiber.stateNode : element;
    return {
      element,
      hostElement: hostElement ?? element,
      framework: 'react',
      name: componentName(owner),
      selector: componentName(owner),
      chain,
      climbed: hostElement !== element,
      pinnedAt: Date.now(),
      handle: owner,
    };
  }

  snapshot(target: InspectTarget): ComponentSnapshot {
    const fiber = (target.handle as Fiber | null) ?? owningFiber(fiberOf(target.hostElement));
    const snapshot: ComponentSnapshot = {
      framework: 'react',
      name: componentName(fiber),
      selector: componentName(fiber),
      props: [],
      inputs: [],
      outputs: [],
      children: this.childrenIn(target.hostElement),
      arrays: [],
      signals: [],
      observables: [],
      notes: [],
    };
    if (!fiber) {
      snapshot.notes.push('No React fiber found for this element.');
      return snapshot;
    }

    const source = fiber._debugSource;
    if (source?.fileName) snapshot.file = `${source.fileName}${source.lineNumber ? `:${source.lineNumber}` : ''}`;

    const props = { ...(fiber.memoizedProps ?? {}) };
    delete props['children'];
    for (const [name, value] of Object.entries(props)) {
      snapshot.inputs.push({ name, value: previewOf(value), raw: value });
      if (/^on[A-Z]/.test(name) && typeof value === 'function') {
        snapshot.outputs.push(`${name}()`);
        continue;
      }
      snapshot.props.push(describeProp(`props.${name}`, value));
    }

    const hooks = readHooks(fiber);
    hooks.forEach((hook, index) => {
      const label = hook.kind === 'state' ? `state #${hook.stateIndex}` : `${hook.kind} #${index}`;
      const prop = describeProp(label, hook.value);
      if (hook.kind === 'ref') prop.kind = 'object';
      if (hook.kind === 'state' && prop.kind === 'object') prop.kind = 'object';
      prop.name = label;
      snapshot.props.push(prop);
    });

    snapshot.arrays = snapshot.props.filter((prop) => Array.isArray(prop.raw));
    snapshot.observables = [];
    snapshot.signals = [];
    snapshot.notes.push(
      `React fiber introspection: ${hooks.filter((hook) => hook.kind === 'state').length} state hook(s), ${
        Object.keys(props).length
      } prop(s)${source?.lineNumber ? `, declared at ${source.fileName}:${source.lineNumber}` : ''}.`,
    );
    return snapshot;
  }

  childrenIn(root: Element): { name: string; on: string }[] {
    const out: { name: string; on: string }[] = [];
    const seen = new Set<string>();
    for (const element of [root, ...Array.from(root.querySelectorAll('*')).slice(0, 60)]) {
      const owner = owningFiber(fiberOf(element));
      if (!owner) continue;
      const name = componentName(owner);
      const key = `${name}@${elSummary(element)}`;
      if (seen.has(key) || !name) continue;
      seen.add(key);
      out.push({ name, on: elSummary(element) });
    }
    return out.slice(0, 30);
  }

  /** Looks through this fiber and its ancestors for an array prop or state hook matching the rows. */
  boundArray(element: Element): { value: unknown; host: string } | null {
    const container = (element.closest('table, tbody, ul, ol, [role="list"], [role="table"]') ?? element) as Element;
    const rows = container.querySelectorAll(
      ':scope > tr, :scope > li, :scope > option, :scope > tbody > tr, :scope > [role="row"]',
    ).length;

    let fiber = owningFiber(fiberOf(element));
    let depth = 0;
    while (fiber && depth < 8) {
      const name = componentName(fiber);
      // 1) array props (`<Table items={rows} />`)
      const props = { ...(fiber.memoizedProps ?? {}) };
      delete props['children'];
      for (const [propName, value] of Object.entries(props)) {
        if (!Array.isArray(value)) continue;
        if (rows > 0 && value.length !== rows) continue;
        return { value, host: `${name}.${propName}` };
      }
      // 2) array state hooks (`const [rows, setRows] = useState([])` in a parent)
      const stateArrays = readHooks(fiber).filter((hook) => hook.kind === 'state' && Array.isArray(hook.value));
      for (const hook of stateArrays) {
        const value = hook.value as unknown[];
        if (rows > 0 && value.length !== rows) continue;
        return { value, host: `${name}.state #${hook.stateIndex}` };
      }
      fiber = owningFiber(fiber.return);
      depth += 1;
    }
    return null;
  }

  private chain(from: Fiber | null): { name: string; selector: string; element: Element }[] {
    const out: { name: string; selector: string; element: Element }[] = [];
    let fiber = from;
    let depth = 0;
    while (fiber && depth < 40) {
      if (FUNCTION_TAGS.has(fiber.tag)) {
        const name = componentName(fiber);
        const element = hostElementOf(fiber);
        if (element && name) out.push({ name, selector: name, element });
      }
      fiber = fiber.return;
      depth += 1;
    }
    return out;
  }
}

function hostElementOf(fiber: Fiber): Element | null {
  if (fiber.stateNode instanceof Element) return fiber.stateNode;
  let child = fiber.child;
  let depth = 0;
  while (child && depth < 20) {
    if (child.stateNode instanceof Element) return child.stateNode;
    child = child.child ?? child.sibling;
    depth += 1;
  }
  return null;
}

interface HookInfo {
  kind: 'state' | 'effect' | 'ref' | 'memo' | 'context';
  value: unknown;
  stateIndex: number;
}

/** Walks the hook linked list and classifies each entry by shape. */
export function readHooks(fiber: Fiber): HookInfo[] {
  const out: HookInfo[] = [];
  let node = fiber.memoizedState as HookNode | null;
  let stateIndex = 0;
  let depth = 0;
  while (node && typeof node === 'object' && depth < 64) {
    const value = (node as HookNode).memoizedState;
    const queue = (node as HookNode).queue;
    if (queue && typeof queue.dispatch === 'function') {
      stateIndex += 1;
      out.push({ kind: 'state', value, stateIndex });
    } else if (value && typeof value === 'object' && ('create' in (value as object) || 'destroy' in (value as object))) {
      out.push({ kind: 'effect', value: undefined, stateIndex });
    } else if (value && typeof value === 'object' && 'current' in (value as object)) {
      out.push({ kind: 'ref', value: (value as { current: unknown }).current, stateIndex });
    } else {
      out.push({ kind: 'memo', value, stateIndex });
    }
    node = (node as HookNode).next ?? null;
    depth += 1;
  }
  return out;
}

function isObservable(value: unknown): boolean {
  return !!value && typeof value === 'object' && typeof (value as { subscribe?: unknown }).subscribe === 'function';
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return `Array<${value.length ? typeOf(value[0]) : 'unknown'}>`;
  if (value instanceof Date) return 'Date';
  if (value instanceof Map) return 'Map';
  if (value instanceof Set) return 'Set';
  if (typeof value === 'function') return (value as { name?: string }).name || 'function';
  return (value as { constructor?: { name?: string } }).constructor?.name ?? typeof value;
}

function previewOf(value: unknown): string {
  if (typeof value === 'string') return truncate(value, 160);
  if (typeof value === 'function') return `ƒ ${(value as { name?: string }).name || 'anonymous'}()`;
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (value === null || value === undefined) return String(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return `${value.length} items`;
  if (isObservable(value)) return `Observable (${typeOf(value)})`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    return `{ ${keys.slice(0, 4).join(', ')}${keys.length > 4 ? `, +${keys.length - 4}` : ''} }`;
  }
  if (value instanceof Element) return `[Element ${elSummary(value)}]`;
  const name = (value as { constructor?: { name?: string } }).constructor?.name ?? 'Object';
  return name.replace(/^[_$]+/, '') || typeof value;
}

function describeProp(name: string, value: unknown): PropInfo {
  let kind: PropInfo['kind'] = 'value';
  if (Array.isArray(value)) kind = 'array';
  else if (isObservable(value)) kind = 'observable';
  else if (value instanceof Map) kind = 'map';
  else if (value instanceof Set) kind = 'set';
  else if (isPlainObject(value)) kind = 'object';
  return { name, kind, type: typeOf(value), preview: previewOf(value), raw: value };
}
