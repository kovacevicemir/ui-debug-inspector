/**
 * Angular adapter.
 *
 * Uses the dev-mode `window.ng` API (`ng.getComponent`, `ng.getDirectives`) plus
 * the `__ngContext__` handle to read component instances, ancestors, inputs and
 * live state. Works with Angular 14+ in development builds.
 */
import { AnyComponent, ComponentSnapshot, InspectAdapter, InspectTarget, PropInfo } from './types.js';
import { elSummary, isPlainObject, truncate } from '../core/util.js';

interface NgApi {
  getComponent?(el: Element): Record<string, unknown> | null;
  getOwningComponent?(el: Element): Record<string, unknown> | null;
  getDirectives?(el: Element): Record<string, unknown>[];
}

const SERVICE_LIKE = /(Service|Store|Facade|Repository|Repo|Manager|Api|Client)$/;

function ng(): NgApi | undefined {
  return typeof window === 'undefined' ? undefined : (window as unknown as { ng?: NgApi }).ng;
}

export function angularClassName(component: AnyComponent | null): string {
  const ctor = component?.constructor as { name?: string } | undefined;
  return (ctor?.name ?? 'UnknownComponent').replace(/^[_$]+/, '');
}

export function angularSelector(component: AnyComponent | null): string {
  if (!component) return '';
  const ctor = component.constructor as {
    ɵcmp?: { selectors?: unknown[][] };
    ɵdir?: { selectors?: unknown[][] };
  };
  const selectors = ctor.ɵcmp?.selectors ?? ctor.ɵdir?.selectors;
  if (!selectors?.length) return '';
  return selectors
    .map((tuple) => (tuple as unknown[]).map((part) => (Array.isArray(part) ? part.join('=') : String(part))).join(''))
    .join(',');
}

export class AngularAdapter implements InspectAdapter {
  readonly id = 'angular' as const;

  detect(): boolean {
    const api = ng();
    if (typeof api?.getComponent === 'function') return true;
    return typeof document !== 'undefined' && !!document.querySelector('[ng-version]');
  }

  findTarget(element: Element): InspectTarget | null {
    const directHost = this.findHost(element);
    if (!directHost) return null;

    const chain = this.chain(directHost);
    let hostElement: Element = directHost;
    let component = this.componentAt(directHost);
    let climbed = hostElement !== element;

    if (component && isPrimitive(component)) {
      for (const entry of chain) {
        const candidate = this.componentAt(entry.element);
        if (candidate && !isPrimitive(candidate)) {
          hostElement = entry.element;
          component = candidate;
          climbed = true;
          break;
        }
      }
    }

    const index = chain.findIndex((entry) => entry.element === hostElement);
    return {
      element,
      hostElement,
      framework: 'angular',
      name: angularClassName(component),
      selector: angularSelector(component),
      chain: index >= 0 ? chain.slice(index) : chain,
      climbed,
      pinnedAt: Date.now(),
      handle: component,
    };
  }

  snapshot(target: InspectTarget): ComponentSnapshot {
    const component = (target.handle ?? this.componentAt(target.hostElement)) as AnyComponent | null;
    const snapshot: ComponentSnapshot = {
      framework: 'angular',
      name: angularClassName(component),
      selector: angularSelector(component),
      props: [],
      inputs: [],
      outputs: [],
      children: this.childrenIn(target.hostElement),
      arrays: [],
      signals: [],
      observables: [],
      notes: [],
    };
    if (!component) {
      snapshot.notes.push('Angular dev API not available — run a development build (`ng serve`) for state introspection.');
      return snapshot;
    }

    const ctor = component.constructor as {
      ɵcmp?: { inputs?: Record<string, string>; outputs?: Record<string, string> };
      ɵdir?: { inputs?: Record<string, string>; outputs?: Record<string, string> };
    };
    const inputMap = ctor.ɵcmp?.inputs ?? ctor.ɵdir?.inputs ?? {};
    const outputMap = ctor.ɵcmp?.outputs ?? ctor.ɵdir?.outputs ?? {};

    for (const [templateName, propName] of Object.entries(inputMap)) {
      const raw = readValue(component[propName]);
      snapshot.inputs.push({ name: templateName, value: previewOf(raw), raw });
    }
    snapshot.outputs = Object.entries(outputMap).map(([templateName, propName]) => `${templateName} → ${propName}()`);

    for (const name of Object.getOwnPropertyNames(component)) {
      if (name === 'constructor' || name.startsWith('ɵ') || name === '__ngContext__') continue;
      const raw = readValue(component[name]);
      snapshot.props.push(describeProp(name, raw));
    }

    // Prototype getters (`get players() { … }`) — how most pages expose service signals.
    const proto = Object.getPrototypeOf(component) as object | null;
    for (const name of Object.getOwnPropertyNames(proto ?? {})) {
      if (name === 'constructor' || name.startsWith('ɵ')) continue;
      const descriptor = Object.getOwnPropertyDescriptor(proto as object, name);
      if (!descriptor?.get) continue;
      let value: unknown = '(unreadable)';
      try {
        value = descriptor.get.call(component);
      } catch {
        /* getter threw */
      }
      snapshot.props.push({ ...describeProp(name, value), kind: 'getter' });
    }

    snapshot.arrays = snapshot.props.filter(
      (prop) => prop.kind === 'array' || ((prop.kind === 'getter' || prop.kind === 'signal') && Array.isArray(prop.raw)),
    );
    snapshot.signals = snapshot.props.filter((prop) => prop.kind === 'signal');
    snapshot.observables = snapshot.props.filter((prop) => prop.kind === 'observable' || prop.kind === 'emitter');
    return snapshot;
  }

  childrenIn(root: Element): { name: string; on: string }[] {
    const api = ng();
    if (!api?.getDirectives) return [];
    const out: { name: string; on: string }[] = [];
    const seen = new Set<string>();
    const visit = (element: Element, depth: number) => {
      if (depth > 4) return;
      try {
        for (const directive of api.getDirectives?.(element) ?? []) {
          const name = angularClassName(directive as AnyComponent);
          const key = `${name}@${elSummary(element)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ name, on: elSummary(element) });
        }
      } catch {
        /* ignore */
      }
      for (const child of Array.from(element.children).slice(0, 12)) visit(child, depth + 1);
    };
    visit(root, 0);
    return out.slice(0, 40);
  }

  /** PrimeNG `p-table [value]`, `*ngFor` (NgForOf.ngForOf) and similar bindings on the rendered rows. */
  boundArray(element: Element): { value: unknown; host: string } | null {
    const api = ng();
    if (!api?.getDirectives) return null;
    const scope = element.closest(
      'p-table, p-listbox, p-dropdown, p-multiselect, p-treetable, p-orderlist, p-picklist, table, tbody, ul, ol',
    ) as Element | null;
    const targets = [scope, element, element.parentElement, element.parentElement?.parentElement].filter(
      Boolean,
    ) as Element[];
    for (const candidate of targets) {
      try {
        for (const directive of api.getDirectives?.(candidate) ?? []) {
          const record = directive as Record<string, unknown>;
          const klass = angularClassName(directive as AnyComponent);
          // p-table / dropdown style
          const value = record['value'];
          if (Array.isArray(value)) return { value, host: `${klass}.value` };
          // *ngFor
          const ngForOf = record['ngForOf'];
          if (Array.isArray(ngForOf)) return { value: ngForOf, host: `${klass}.ngForOf` };
        }
      } catch {
        /* ignore */
      }
    }
    return null;
  }

  componentAt(element: Element | null): AnyComponent | null {
    if (!element) return null;
    const api = ng();
    if (!api?.getComponent) return null;
    try {
      return (api.getComponent(element) as AnyComponent) ?? null;
    } catch {
      return null;
    }
  }

  private findHost(element: Element | null): Element | null {
    let node: Element | null = element;
    let depth = 0;
    while (node && depth < 40) {
      if (this.componentAt(node)) return node;
      node = node.parentElement;
      depth += 1;
    }
    return null;
  }

  private chain(element: Element): { name: string; selector: string; element: Element }[] {
    const out: { name: string; selector: string; element: Element }[] = [];
    let node: Element | null = element;
    let depth = 0;
    while (node && depth < 60) {
      const component = this.componentAt(node);
      if (component) out.push({ name: angularClassName(component), selector: angularSelector(component), element: node });
      node = node.parentElement;
      depth += 1;
    }
    return out;
  }
}

/** Component that exposes nothing useful to debug (dumb wrapper). */
function isPrimitive(component: AnyComponent): boolean {
  const ctor = component.constructor as {
    ɵcmp?: { inputs?: Record<string, unknown>; outputs?: Record<string, unknown> };
  };
  const inputs = Object.keys(ctor.ɵcmp?.inputs ?? {}).length;
  const outputs = Object.keys(ctor.ɵcmp?.outputs ?? {}).length;
  if (inputs + outputs > 0) return false;
  const own = Object.getOwnPropertyNames(component).filter(
    (name) => name !== 'constructor' && !name.startsWith('ɵ') && name !== '__ngContext__',
  );
  return own.length <= 4;
}

function isSignal(value: unknown): boolean {
  return (
    typeof value === 'function' &&
    typeof (value as { set?: unknown }).set === 'function' &&
    typeof (value as { update?: unknown }).update === 'function'
  );
}

function isObservable(value: unknown): boolean {
  return !!value && typeof value === 'object' && typeof (value as { subscribe?: unknown }).subscribe === 'function';
}

function readValue(value: unknown): unknown {
  if (!isSignal(value)) return value;
  try {
    return (value as () => unknown)();
  } catch {
    return '(signal unreadable)';
  }
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return `Array<${value.length ? typeOf(value[0]) : 'unknown'}>`;
  if (isSignal(value)) return 'Signal';
  if (value instanceof Date) return 'Date';
  if (value instanceof Map) return 'Map';
  if (value instanceof Set) return 'Set';
  return (value as { constructor?: { name?: string } }).constructor?.name ?? typeof value;
}

function previewOf(value: unknown): string {
  if (typeof value === 'string') return truncate(value, 160);
  if (typeof value === 'function') return `ƒ ${(value as { name?: string }).name || 'anonymous'}()`;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return `${value.length} items`;
  if (isObservable(value)) return `Observable (${typeOf(value)})`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    return `{ ${keys.slice(0, 4).join(', ')}${keys.length > 4 ? `, +${keys.length - 4}` : ''} }`;
  }
  if (value && typeof value === 'object') {
    const name = (value as { constructor?: { name?: string } }).constructor?.name ?? 'Object';
    const keys = Object.getOwnPropertyNames(value).filter((key) => !/^(http|_|ɵ|injector|destroyRef)/i.test(key));
    return `${name.replace(/^[_$]+/, '')} { ${keys.slice(0, 5).join(', ')}${keys.length > 5 ? `, +${keys.length - 5}` : ''} }`;
  }
  return String(value);
}

function describeProp(name: string, value: unknown): PropInfo {
  let kind: PropInfo['kind'] = 'value';
  if (isSignal(value)) kind = 'signal';
  else if (Array.isArray(value)) kind = 'array';
  else if (isObservable(value)) kind = 'emitter';
  else if (value instanceof Map) kind = 'map';
  else if (value instanceof Set) kind = 'set';
  else if (value && typeof value === 'object' && SERVICE_LIKE.test(((value as { constructor?: { name?: string } }).constructor?.name ?? '').replace(/^[_$]+/, ''))) {
    kind = 'service';
  } else if (isPlainObject(value)) kind = 'object';
  return { name, kind, type: typeOf(value), preview: previewOf(value), raw: value };
}
