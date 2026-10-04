/**
 * Runtime access to the build-time code index (scripts/generate-debug-index.mjs).
 *
 * This is what lets the inspector answer "what does this button call, and why"
 * BEFORE the user clicks anything: element -> template handler -> component
 * method -> injected service methods -> concrete HTTP endpoints.
 */
import { DebugCall } from '../core/types.js';

export interface EndpointRef {
  method: string;
  path: string;
  body?: string | null;
  source?: string;
}

export interface IndexedCallChain {
  via: string;
  endpoints: EndpointRef[];
  chain: IndexedCallChain[];
  hubCalls: { verb: string; target: string }[];
  /** Fields the called method hands back (service signals etc.). */
  returns?: { prop?: string; service?: string; call?: boolean }[];
}

export interface IndexedWrite {
  prop: string;
  kind: 'assign' | 'set' | 'update';
}

export interface IndexedMethod {
  line: number;
  /** `getter` for `get x() { ... }` accessors. */
  kind?: 'method' | 'getter';
  /** JSDoc of the method, when the author wrote one. */
  doc?: string | null;
  /** What the method hands back (`return this.field`, `return this.svc.field()`). */
  returns?: { prop?: string; service?: string; call?: boolean; via?: string }[];
  endpoints: EndpointRef[];
  calls: IndexedCallChain[];
  hubCalls: { verb: string; target: string }[];
  /** Router navigations performed by the method. */
  navigates?: { target: string }[];
  /** localStorage operations (often the true origin of a payload value). */
  storageOps?: { op: string; key: string }[];
  /** State fields this method writes. */
  writes?: IndexedWrite[];
  payloadHint: string | null;
}

export interface IndexedField {
  name: string;
  type: string | null;
  init: string | null;
  doc: string | null;
}

/** A method that writes a state field, plus everything it calls while doing so. */
export interface IndexedFill {
  method: string;
  kind: IndexedWrite['kind'];
  line: number;
  doc: string | null;
  endpoints: EndpointRef[];
  chain: IndexedCallChain[];
}

export interface IndexedElementHandler {
  /** `event` for `(click)="…"`, `link` for `<a [routerLink]="…">`. */
  kind?: 'event' | 'link';
  tag: string;
  event: string;
  expression: string;
  handlers: string[];
  /** Router/native link bindings — what a row does when clicked. */
  links?: { attr: string; expression: string; preview: string }[];
  queryParams?: string | null;
  /** `true` when the element's visible text comes from interpolation. */
  dynamicText?: boolean;
  text: string;
  id: string | null;
  classAttr: string | null;
  ariaLabel: string | null;
  line: number;
}

export interface IndexedClass {
  file: string;
  doc: string | null;
  selector: string | null;
  services: Record<string, string>;
  methods: Record<string, IndexedMethod>;
  fields?: IndexedField[];
  /** Names of accessor properties on the class. */
  getters?: string[];
  /** field name -> methods that write it (provenance). */
  fills?: Record<string, IndexedFill[]>;
  /** field name -> service field it aliases. */
  fieldOrigins?: Record<string, { via: string; init: string }>;
  elementHandlers: IndexedElementHandler[];
}

export interface DebugIndex {
  services: Record<string, IndexedClass>;
  components: Record<string, IndexedClass>;
  /** Router table: path -> component (+ guards). Lets link predictions continue into the target page. */
  routes?: IndexedRoute[];
}

export interface IndexedRoute {
  path: string;
  component: string | null;
  guards: string[];
}

export interface PredictedHandler {
  entry: IndexedElementHandler;
  confidence: 'high' | 'medium' | 'low';
  score: number;
  /** Other bindings with a near-identical score (ambiguous markup). */
  alternatives?: IndexedElementHandler[];
}

let cached: DebugIndex | null = null;

/** Provide an index directly (bundled JSON import, fetch result, global). */
export function setDebugIndex(index: DebugIndex | null): void {
  cached = index;
}

/**
 * Resolves the code index.
 *
 * Order: whatever was passed to `installUiDebugInspector({ index })`, then a global
 * `window.__UI_DEBUG_INDEX__` (handy for script-tag setups), otherwise nothing — the
 * panel degrades to runtime-only facts.
 */
export async function loadDebugIndex(): Promise<DebugIndex | null> {
  if (cached) return cached;
  const globalIndex = (globalThis as unknown as { __UI_DEBUG_INDEX__?: DebugIndex }).__UI_DEBUG_INDEX__;
  if (globalIndex) {
    cached = globalIndex;
    return cached;
  }
  return null;
}

export function getDebugIndex(): DebugIndex | null {
  return cached;
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function tokens(value: string | null | undefined): string[] {
  return normalizeText(value)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2);
}

function classTokens(value: string | null | undefined): string[] {
  return (value ?? '').split(/\s+/).filter(Boolean);
}

/**
 * Scores how likely a template binding belongs to the given element.
 * `directOnly` requires the element itself to carry the binding tag (subtree scans).
 */
function scoreEntry(entry: IndexedElementHandler, element: Element, directOnly: boolean): { score: number; candidate: Element | null } {
  const candidate = directOnly
    ? element.tagName.toLowerCase() === entry.tag
      ? element
      : null
    : ((element.closest(entry.tag) ?? (element.tagName.toLowerCase() === entry.tag ? element : null)) as Element | null);
  if (!candidate) return { score: 0, candidate: null };

  const isSubmitControl = (node: Element | null): boolean =>
    !!node &&
    ((node.tagName === 'BUTTON' && (node.getAttribute('type') ?? 'submit') === 'submit') ||
      (node.tagName === 'INPUT' && node.getAttribute('type') === 'submit'));

  let score = 3; // tag match
  if (isSubmitControl(element) && (entry.event === 'ngSubmit' || entry.event === 'submit') && candidate.tagName === 'FORM') {
    score += 8;
  }
  if ((entry.event === 'click' || entry.kind === 'link') && element !== candidate && candidate.contains(element)) {
    score += 2;
  }
  if (entry.id && candidate.id && entry.id === candidate.id) score += 6;
  const label = candidate.getAttribute('aria-label') ?? candidate.getAttribute('title') ?? '';
  if (entry.ariaLabel && label && normalizeText(entry.ariaLabel) === normalizeText(label)) score += 4;

  const elementTokens = new Set(tokens(candidate.textContent));
  const entryTokens = tokens(entry.text);
  const entryFlat = normalizeText(entry.text).replace(/\s+/g, '');
  const nodeFlat = normalizeText(candidate.textContent).replace(/\s+/g, '');
  const elementClasses = new Set(classTokens(candidate.className));
  const overlapClasses = classTokens(entry.classAttr).filter((token) => elementClasses.has(token)).length;

  if (entryFlat) {
    // Substring comparison survives markup splits (`<i>groups</i>Crews`).
    if (nodeFlat && (nodeFlat === entryFlat || nodeFlat.includes(entryFlat))) score += 6;
    else if (nodeFlat.length > 2 && entryFlat.includes(nodeFlat)) score += 4;
    else if (entryTokens.length && elementTokens.size) {
      const overlap = entryTokens.filter((token) => elementTokens.has(token)).length;
      score += (overlap / entryTokens.length) * 6;
    }
  } else if (entry.dynamicText && overlapClasses) {
    // Text comes from interpolation (`{{ page }}`) — fall back to the class evidence.
    score += 4;
  } else if (nodeFlat) {
    // No template text to compare against but the element shows text: weaker.
    score -= 2;
  }

  score += Math.min(overlapClasses, 3);

  return { score, candidate };
}

/**
 * Finds the template binding that most likely produced the hovered element.
 *
 * Angular does not expose template bindings on DOM nodes, so we match the static
 * template entry (tag + visible text + id/class/label) against the live element,
 * preferring the closest ancestor of the entry's tag (`app-universal-button` for a
 * `<button>` rendered inside it).
 */
export function matchElementHandler(record: IndexedClass | null, element: Element): PredictedHandler | null {
  if (!record?.elementHandlers?.length) return null;
  const ranked = record.elementHandlers
    .map((entry) => ({ entry, score: scoreEntry(entry, element, false).score }))
    .sort((a, b) => b.score - a.score);
  return pickBest(ranked);
}

const ITEM_TAGS = new Set(['tr', 'li', 'option', 'article', 'section', 'div', 'mat-option', 'p-selectitem', 'app-universal-button']);

function isItemTag(element: Element): boolean {
  const tag = element.tagName.toLowerCase();
  return ITEM_TAGS.has(tag) || tag.startsWith('app-');
}

/**
 * Nearest ancestor (or self) that is one item of a repeated list.
 * Lets a hover anywhere in a table row be treated as "the row".
 */
export function findRepeatedItem(element: Element): { item: Element; index: number; count: number } | null {
  let node: Element | null = element;
  let depth = 0;
  while (node && depth < 8) {
    const parent: Element | null = node.parentElement;
    const siblingTag: string = node.tagName;
    const siblings = parent ? Array.from(parent.children).filter((child) => child.tagName === siblingTag) : [];
    if (isItemTag(node) && siblings.length >= 2) {
      return { item: node, index: siblings.indexOf(node), count: siblings.length };
    }
    node = parent;
    depth += 1;
  }
  return null;
}

/**
 * Same, but looking at the element's descendants too.
 *
 * This is what makes hovering a table *row* useful: the binding lives on an inner
 * `<a [routerLink]>` or `<button (click)>`, not on the `<tr>` itself. If the hovered
 * node has no actionable descendant (e.g. the rank cell) the whole repeated item
 * (the row) is inspected instead.
 */
export function matchHandlerInSubtree(
  record: IndexedClass | null,
  element: Element,
): { predicted: PredictedHandler; node: Element; scope: 'self' | 'item' } | null {
  if (!record?.elementHandlers?.length) return null;

  const scan = (root: Element): { predicted: PredictedHandler; node: Element; scope: 'self' | 'item' } | null => {
    const nodes: Element[] = [root, ...Array.from(root.querySelectorAll('*')).slice(0, 80)];
    const found: { predicted: PredictedHandler; node: Element; score: number }[] = [];
    for (const node of nodes) {
      const ranked = record.elementHandlers
        .map((entry) => ({ entry, score: scoreEntry(entry, node, true).score }))
        .sort((a, b) => b.score - a.score);
      const best = pickBest(ranked);
      if (best) found.push({ predicted: best, node, score: best.score });
    }
    if (!found.length) return null;
    const winner = found.sort((a, b) => b.score - a.score)[0];
    return { predicted: winner.predicted, node: winner.node, scope: 'self' };
  };

  const direct = scan(element);
  if (direct) return direct;

  const repeated = findRepeatedItem(element);
  if (repeated && repeated.item !== element) {
    const fromItem = scan(repeated.item);
    if (fromItem) return { ...fromItem, scope: 'item' };
  }
  return null;
}

function pickBest(ranked: { entry: IndexedElementHandler; score: number }[]): PredictedHandler | null {
  const best = ranked[0];
  if (!best) return null;
  const runnerUp = ranked[1];
  const runnerUpScore = runnerUp?.score ?? 0;
  if (best.score < 3) {
    const sameTag = ranked.filter((item) => item.score > 0).length;
    if (sameTag !== 1) return null;
    return { entry: best.entry, confidence: 'low', score: best.score };
  }
  // A near-tie means two template bindings look identical (e.g. duplicated markup in
  // hidden tabs) — say so instead of pretending to know which one is live.
  const ambiguous = !!runnerUp && runnerUpScore > 0 && best.score - runnerUpScore < 1;
  const confidence: PredictedHandler['confidence'] = ambiguous
    ? 'low'
    : best.score >= 9 || best.score - runnerUpScore >= 4
      ? 'high'
      : best.score >= 6
        ? 'medium'
        : 'low';
  return {
    entry: best.entry,
    confidence,
    score: Math.round(best.score * 10) / 10,
    alternatives: ambiguous ? ranked.slice(1, 4).map((item) => item.entry).filter((entry) => entry.expression !== best.entry.expression) : undefined,
  };
}

/** Router destinations declared by a matched binding (exact previews from the template). */
export function linksOf(entry: IndexedElementHandler): { label: string; detail: string }[] {
  return (entry.links ?? []).map((link) => ({
    label: `Navigates to ${link.preview}${entry.queryParams ? ` with ${entry.queryParams}` : ''}`,
    detail: `[${link.attr}]="${link.expression}" (template line ${entry.line})`,
  }));
}

/** All endpoints reachable from one component method, flattened with their call chain. */
export function endpointsForHandler(record: IndexedClass | null, handlerName: string): { endpoints: EndpointRef[]; chain: IndexedCallChain[] } {
  const method = record?.methods?.[handlerName];
  if (!method) return { endpoints: [], chain: [] };
  return { endpoints: method.endpoints ?? [], chain: method.calls ?? [] };
}

/** Endpoints fired when the component is created (constructor + lifecycle hooks). */
export function initEndpoints(record: IndexedClass | null): { hook: string; endpoints: EndpointRef[] }[] {
  if (!record) return [];
  const hooks = ['ngOnInit', 'constructor', 'ngAfterViewInit', 'ngOnChanges'];
  return hooks
    .filter((hook) => record.methods?.[hook]?.endpoints?.length)
    .map((hook) => ({ hook, endpoints: record.methods[hook].endpoints }));
}

/** Class name behind a `Service.method()` chain label. */
export function chainClassNames(chain: IndexedCallChain[] | undefined): string[] {
  if (!chain?.length) return [];
  return chain.flatMap((entry) => [entry.via.split('.')[0], ...chainClassNames(entry.chain)]);
}

/** Service class names a component method reaches (used for stack-based attribution). */
export function relatedServiceNames(record: IndexedClass | null, handlerNames: string[]): string[] {
  const names = new Set<string>(Object.values(record?.services ?? {}));
  for (const handler of handlerNames) {
    for (const name of chainClassNames(record?.methods?.[handler]?.calls)) names.add(name);
  }
  return [...names];
}

/** Human readable "METHOD /path" list, deduped. */
export function formatEndpoints(endpoints: EndpointRef[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const endpoint of endpoints) {
    const label = `${endpoint.method} ${endpoint.path}${endpoint.body ? ` — body: ${endpoint.body}` : ''}`;
    if (seen.has(label)) continue;
    seen.add(label);
    out.push(label);
  }
  return out;
}

/** Does this recorded call belong to the given endpoints/methods? */
export function callMatchesEndpoints(call: DebugCall, endpoints: EndpointRef[]): boolean {
  return endpoints.some((endpoint) => {
    if (call.method.toUpperCase() !== endpoint.method.toUpperCase()) return false;
    const path = endpoint.path.split('?')[0];
    return call.url.includes(path);
  });
}

/** Handler names referenced by a recorded call's captured DOM cause. */
export function handlerNamesFromCause(call: DebugCall): string[] {
  const source = call.cause.handlerSource ?? '';
  return [...source.matchAll(/([\w$]+)\s*\(/g)].map((entry) => entry[1]);
}
