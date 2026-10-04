/**
 * Fallback adapter: no framework hooks, only DOM facts.
 *
 * The panel still works (element identity, links inside, calls attributed by DOM
 * event + stack), it just cannot read component state.
 */
import { ComponentSnapshot, InspectAdapter, InspectTarget } from './types.js';
import { elSummary } from '../core/util.js';

const SERVICE_NAME = /(Service|Store|Facade|Repository|Repo|Manager|Api|Client)$/;

export class DomAdapter implements InspectAdapter {
  readonly id = 'dom' as const;

  detect(): boolean {
    return true;
  }

  findTarget(element: Element): InspectTarget | null {
    if (!element) return null;
    const host = this.nearestHost(element);
    return {
      element,
      hostElement: host,
      framework: 'dom',
      name: describeName(host),
      selector: host.tagName.toLowerCase(),
      chain: this.chain(element),
      climbed: host !== element,
      pinnedAt: Date.now(),
      handle: host,
    };
  }

  snapshot(target: InspectTarget): ComponentSnapshot {
    return {
      framework: 'dom',
      name: target.name,
      selector: target.selector,
      props: [],
      inputs: [],
      outputs: [],
      children: this.childrenIn(target.hostElement),
      arrays: [],
      signals: [],
      observables: [],
      notes: [
        'No framework adapter detected on this page — showing DOM facts only (element identity, links, recorded calls).',
      ],
    };
  }

  childrenIn(root: Element): { name: string; on: string }[] {
    const out: { name: string; on: string }[] = [];
    const seen = new Set<string>();
    for (const child of Array.from(root.querySelectorAll('*')).slice(0, 60)) {
      const tag = child.tagName.toLowerCase();
      if (!tag.includes('-') && !child.hasAttribute('data-component')) continue;
      const name = describeName(child);
      const key = `${name}@${elSummary(child)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name, on: elSummary(child) });
    }
    return out.slice(0, 20);
  }

  boundArray(): { value: unknown; host: string } | null {
    return null;
  }

  /** Nearest ancestor that looks like a component root (custom element or data-component). */
  private nearestHost(element: Element): Element {
    let node: Element | null = element;
    let depth = 0;
    while (node && depth < 20) {
      const tag = node.tagName.toLowerCase();
      if (node.hasAttribute('data-component') || tag.includes('-')) return node;
      node = node.parentElement;
      depth += 1;
    }
    return element;
  }

  private chain(element: Element): { name: string; selector: string; element: Element }[] {
    const out: { name: string; selector: string; element: Element }[] = [];
    let node: Element | null = element;
    let depth = 0;
    while (node && depth < 20) {
      const tag = node.tagName.toLowerCase();
      if (tag.includes('-') || node.hasAttribute('data-component')) {
        out.push({ name: describeName(node), selector: tag, element: node });
      }
      node = node.parentElement;
      depth += 1;
    }
    return out;
  }
}

function describeName(element: Element): string {
  const explicit = element.getAttribute('data-component');
  if (explicit) return explicit;
  const tag = element.tagName.toLowerCase();
  if (tag.includes('-')) {
    return tag
      .split('-')
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join('');
  }
  const id = element.id ? `#${element.id}` : '';
  const cls = typeof element.className === 'string' && element.className ? `.${element.className.split(/\s+/)[0]}` : '';
  return `${tag}${id}${cls}`;
}

export { SERVICE_NAME as SERVICE_LIKE_NAME };
