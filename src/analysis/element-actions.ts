/**
 * Describes the *exact* hovered element, not just its component.
 *
 * Hovering one row of a ranking table should say "row 3 of 100, renders
 * players[2], clicking it opens /profile/laffy" — not "RankingPageComponent has
 * 5 injected services".
 */
import { InspectTarget } from '../core/types.js';
import { ComponentSnapshot } from '../adapters/types.js';
import { findRepeatedItem } from './code-index.js';
import { collectCandidates, itemIdentifiers } from './data-chain.js';
import { elSummary, truncate } from '../core/util.js';

export interface ElementAction {
  label: string;
  detail?: string;
  confidence: 'high' | 'medium' | 'low';
}

function subtreeNodes(element: Element, limit = 60): Element[] {
  return [element, ...Array.from(element.querySelectorAll('*')).slice(0, limit)];
}

function scopeRoot(element: Element, scan: (root: Element) => boolean): { root: Element; scope: 'self' | 'item'; repeated: { index: number; count: number } | null } | null {
  if (scan(element)) return { root: element, scope: 'self', repeated: null };
  const repeated = findRepeatedItem(element);
  if (repeated && repeated.item !== element && scan(repeated.item)) {
    return { root: repeated.item, scope: 'item', repeated };
  }
  return null;
}

/** Real destinations available inside the hovered element (resolved href values). */
export function describeLinks(target: InspectTarget): ElementAction[] {
  const collect = (root: Element) =>
    subtreeNodes(root)
      .filter((node) => node.tagName === 'A' && node.getAttribute('href') && !(node.getAttribute('href') ?? '').startsWith('javascript'))
      .slice(0, 8);

  const scope = scopeRoot(target.element, (root) => collect(root).length > 0);
  if (!scope) return [];
  const where = scope.scope === 'item' && scope.repeated ? `in item ${scope.repeated.index + 1} of ${scope.repeated.count}` : '';

  return collect(scope.root).map((node) => {
    const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
    return {
      label: `Click → ${node.getAttribute('href')}`,
      detail: `<a> ${text ? `"${truncate(text, 40)}"` : ''} ${elSummary(node)}${where ? ` — ${where}` : ''}`,
      confidence: 'high' as const,
    };
  });
}

/** Non-link clickable descendants (buttons, [routerLink]-less handlers). */
export function describeClickables(target: InspectTarget): ElementAction[] {
  const collect = (root: Element) =>
    subtreeNodes(root)
      .filter((node) => {
        const tag = node.tagName.toLowerCase();
        if (tag !== 'button' && tag !== 'input' && tag !== 'app-universal-button') return false;
        if (tag === 'input' && (node.getAttribute('type') ?? '') !== 'submit') return false;
        if (node.closest('a[href]')) return false;
        return true;
      })
      .slice(0, 8);

  const scope = scopeRoot(target.element, (root) => collect(root).length > 0);
  if (!scope) return [];
  return collect(scope.root).map((node) => {
    const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
    return {
      label: `Button "${truncate(text || node.getAttribute('aria-label') || '', 40)}"`,
      detail: elSummary(node),
      confidence: 'medium' as const,
    };
  });
}

const ITEM_TAGS = new Set(['tr', 'li', 'option', 'article', 'section', 'div']);

/**
 * Row/item identity: which repeated element this is and which array item it renders.
 */
export function describeRowIdentity(target: InspectTarget, info: ComponentSnapshot): ElementAction[] {
  const element = target.element;
  const repeated = findRepeatedItem(element);
  if (!repeated) return [];

  const { item, index, count } = repeated;
  const isSelf = item === element;
  const itemTag = item.tagName.toLowerCase();
  const containerTag = item.parentElement?.tagName.toLowerCase() ?? '?';
  const text = (item.textContent ?? '').replace(/\s+/g, ' ');

  const actions: ElementAction[] = [
    isSelf
      ? {
          label: `Item ${index + 1} of ${count} in a repeated list (<${itemTag}> inside <${containerTag}>)`,
          detail: 'every sibling is rendered by the same template block',
          confidence: 'high',
        }
      : {
          label: `Inside item ${index + 1} of ${count} (<${itemTag}> in <${containerTag}>) — the hovered <${element.tagName.toLowerCase()}> is one cell of it`,
          detail: 'bindings live on the item, not on individual cells',
          confidence: 'high',
        },
  ];

  // Prefer the array that actually lines up with this row: same length as the
  // rendered list and the item sitting at the same index.
  const candidates = collectCandidates(info, target);
  let best: { label: string; itemIndex: number; value: unknown; score: number } | null = null;
  for (const candidate of candidates) {
    const items = candidate.value as unknown[];
    const hits = items.reduce<number>(
      (count, entry) =>
        count +
        (itemIdentifiers(entry).some((identifier) => identifier.length > 1 && text.includes(identifier)) ? 1 : 0),
      0,
    );
    if (!hits) continue;
    const itemIndex = items.findIndex((entry) =>
      itemIdentifiers(entry).some((identifier) => identifier.length > 1 && text.includes(identifier)),
    );
    const score =
      hits +
      (items.length === repeated.count ? 5 : 0) +
      (itemIndex === repeated.index ? 5 : 0);
    if (!best || score > best.score) best = { label: candidate.label, itemIndex, value: items[itemIndex], score };
  }

  if (best) {
    actions.push({
      label: `Renders ${best.label}[${best.itemIndex}]${repeated.index === best.itemIndex ? ' (matches this row)' : ''}`,
      detail: truncate(JSON.stringify(best.value), 220),
      confidence: repeated.index === best.itemIndex ? 'high' : 'medium',
    });
  } else {
    actions.push({
      label: 'Could not match this item to a known array item',
      detail: 'content may come from a nested component or a virtual/canvas list',
      confidence: 'low',
    });
  }
  return actions;
}

/** One-line answer for "what is this exact element". */
export function hoveredElementSummary(target: InspectTarget): string {
  const element = target.element;
  const tag = element.tagName.toLowerCase();
  const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
  const cls = typeof element.className === 'string' ? element.className.split(/\s+/).slice(0, 3).join('.') : '';
  const repeated = findRepeatedItem(element);
  const kind =
    repeated && repeated.item === element
      ? 'row/item'
      : tag === 'a'
        ? 'link'
        : tag === 'button'
          ? 'button'
          : repeated
            ? `cell of item ${repeated.index + 1}/${repeated.count}`
            : 'element';
  return `${kind} <${tag}${cls ? `.${cls}` : ''}>${text ? ` — "${truncate(text, 60)}"` : ''}`;
}
