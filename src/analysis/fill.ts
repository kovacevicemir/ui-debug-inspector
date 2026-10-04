/**
 * "How is this list/table filled" — neutral version.
 *
 * Uses the adapter's `boundArray` (PrimeNG `[value]`, React list props, …) when it
 * can name the exact array, and falls back to scoring the component's own arrays
 * against the rendered text.
 */
import { ComponentSnapshot, InspectAdapter, InspectTarget } from '../adapters/types.js';
import { elSummary } from '../core/util.js';

export interface FillInfo {
  container: string;
  rowCount: number;
  rowSelector: string;
  fillFrom: string[];
  notes: string[];
}

const ROW_TAGS = new Set(['TR', 'LI', 'OPTION', 'ARTICLE', 'DT', 'DD']);

function rowElements(container: Element): Element[] {
  return Array.from(container.children).filter(
    (child) => ROW_TAGS.has(child.tagName) || child.hasAttribute('data-p-selectable-row') || child.hasAttribute('role'),
  );
}

export function describeFill(target: InspectTarget, snapshot: ComponentSnapshot, adapter: InspectAdapter): FillInfo {
  // Look for the list/table the element belongs to: inside it, or in an ancestor
  // (React rows live in a table owned by a parent component).
  const scopeCandidates: Element[] = [
    target.element.closest('table, tbody, ul, ol, [role="table"], [role="list"], [data-list]'),
    target.element,
    target.hostElement,
    ...(
      [
        target.hostElement.parentElement,
        target.hostElement.parentElement?.parentElement,
        target.hostElement.parentElement?.parentElement?.parentElement,
      ] as (Element | null)[]
    ).map((element) => element?.closest('table, tbody, ul, ol, [role="table"], [role="list"], [data-list]') ?? null),
  ].filter(Boolean) as Element[];

  let container: Element | null = null;
  let rowSelector = '';

  for (const scope of scopeCandidates) {
    const candidates = [
      scope,
      ...Array.from(scope.querySelectorAll('table, tbody, ul, ol, [role="table"], [role="list"], [data-list]')),
    ];
    for (const candidate of candidates) {
      const rows = rowElements(candidate);
      const nestedRows = candidate.matches('table, tbody')
        ? Array.from(candidate.querySelectorAll(':scope > tr'))
        : [];
      const count = rows.length || nestedRows.length;
      if (count > 0) {
        container = candidate;
        rowSelector = (rows[0] ?? nestedRows[0])?.tagName.toLowerCase() ?? 'row';
        break;
      }
    }
    if (container) break;
  }

  const notes: string[] = [];
  const fillFrom: string[] = [];

  const bound = (() => {
    try {
      return adapter.boundArray(target.element);
    } catch {
      return null;
    }
  })();

  if (container) {
    const firstRow = container.matches('table, tbody')
      ? container.querySelector(':scope > tr')
      : rowElements(container)[0] ?? container.children[0];
    if (firstRow) {
      for (const child of adapter.childrenIn(firstRow)) {
        notes.push(`Row rendered by ${child.name} on ${child.on}`);
      }
    }
    if (bound) notes.push(`Bound array: ${bound.host}`);
  } else {
    notes.push(
      'No list/table rows found under this element — nothing rendered yet, or it uses a canvas/virtual list.',
    );
  }

  for (const prop of snapshot.arrays) {
    fillFrom.push(`${snapshot.name}.${prop.name} (${prop.type}, ${prop.preview})`);
  }
  for (const prop of snapshot.signals) {
    if (Array.isArray(prop.raw)) fillFrom.push(`${snapshot.name}.${prop.name}() ${prop.type} (${prop.preview})`);
  }
  for (const input of snapshot.inputs) {
    if (/items|rows|data|value|list|options/i.test(input.name)) {
      fillFrom.push(`${input.name} = ${input.value}`);
    }
  }

  const rowCount = container
    ? container.querySelectorAll(':scope > tr, :scope > li, :scope > option, :scope > tbody > tr, :scope > [role="row"]').length
    : 0;

  return {
    container: container ? elSummary(container) : '(none)',
    rowCount,
    rowSelector: rowSelector || '—',
    fillFrom,
    notes,
  };
}
