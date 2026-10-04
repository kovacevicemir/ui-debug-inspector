/**
 * Framework-neutral state and logic behind the overlay.
 *
 * The panel is a dumb renderer: it asks for `getView()` and calls the mutators.
 * Everything framework specific lives behind an `InspectAdapter`.
 */
import {
  DebugCall,
  EventLogEntry,
  InspectTarget,
  ComponentSnapshot,
  InspectAdapter,
  PropInfo,
} from './types.js';
import { ZoneCauseTracker } from './zone-cause.js';
import { NetworkRecorder } from './network-recorder.js';
import { elPreview, elSummary } from './util.js';
import {
  DebugIndex,
  EndpointRef,
  IndexedClass,
  PredictedHandler,
  callMatchesEndpoints,
  chainClassNames,
  endpointsForHandler,
  findRepeatedItem,
  getDebugIndex,
  handlerNamesFromCause,
  initEndpoints,
  linksOf,
  loadDebugIndex,
  matchElementHandler,
  matchHandlerInSubtree,
  relatedServiceNames,
} from '../analysis/code-index.js';
import { ArrayFillMatch, matchArraysToResponses } from '../analysis/payload-tracer.js';
import { ChainStep, traceDataChain } from '../analysis/data-chain.js';
import { describeField, describeMethod } from '../analysis/describe-method.js';
import { ElementAction, describeClickables, describeLinks, describeRowIdentity, hoveredElementSummary } from '../analysis/element-actions.js';
import { NextStep, buildNextSteps } from '../analysis/next-steps.js';
import { FillInfo, describeFill } from '../analysis/fill.js';
import { HighlightOverlay } from './highlight.js';

export type DebugTabId = 'calls' | 'payload' | 'summary' | 'fill' | 'data';
export type Attribution = 'dom' | 'handler' | 'endpoint' | 'service';
export type Listener = () => void;

export interface StoreOptions {
  hoverDwellMs?: number;
  armWindowMs?: number;
  /** Max recorded calls kept in memory. */
  maxCalls?: number;
}

export interface RecordMethodInfo {
  name: string;
  line: number;
  doc: string | null;
  endpoints: string[];
}

export interface InspectorView {
  enabled: boolean;
  visible: boolean;
  armed: boolean;
  tab: DebugTabId;
  hint: string;
  indexStatus: 'loading' | 'ready' | 'missing';
  framework: string;
  targetLabel: string;
  hoveredSummary: string;
  snapshot: ComponentSnapshot | null;
  record: IndexedClass | null;
  recordMethods: RecordMethodInfo[];
  predicted: PredictedHandler | null;
  predictedLocation: string | null;
  predictedEndpoints: EndpointRef[];
  predictedLinks: { label: string; detail: string }[];
  handlerDescription: string[];
  handlerChain: string[];
  nextSteps: NextStep[];
  rowIdentity: ElementAction[];
  linkActions: ElementAction[];
  clickableActions: ElementAction[];
  summaryLines: string[];
  fill: FillInfo | null;
  dataChain: ChainStep[];
  arrayFills: ArrayFillMatch[];
  causedCalls: DebugCall[];
  relatedCalls: DebugCall[];
  unattributedCalls: DebugCall[];
  armedCalls: DebugCall[];
  recentCalls: DebugCall[];
  handlerEntries: EventLogEntry[];
}

export class InspectorStore {
  readonly zoneCause = new ZoneCauseTracker();
  readonly recorder: NetworkRecorder;

  private readonly adapters: InspectAdapter[];
  private readonly dwellMs: number;
  private readonly armWindowMs: number;
  private readonly highlight = new HighlightOverlay();
  private readonly listeners = new Set<Listener>();
  private readonly armedCallIds = new Set<number>();
  private armedOnce = false;
  private dwellTimer?: ReturnType<typeof setTimeout>;
  private armTimer?: ReturnType<typeof setTimeout>;
  private installed = false;

  private _enabled = false;
  private _visible = false;
  private _armed = false;
  private _tab: DebugTabId = 'calls';
  private _hint = '';
  private _target: InspectTarget | null = null;
  private _indexStatus: 'loading' | 'ready' | 'missing' = 'loading';

  constructor(adapters: InspectAdapter[], options: StoreOptions = {}) {
    this.adapters = adapters;
    this.dwellMs = options.hoverDwellMs ?? 420;
    this.armWindowMs = options.armWindowMs ?? 3000;
    this.recorder = new NetworkRecorder(this.zoneCause, { maxCalls: options.maxCalls ?? 300 });
    this.recorder.onChange(() => this.emit());
  }

  // ── lifecycle ──────────────────────────────────────────────────────────
  install(): void {
    if (this.installed || typeof window === 'undefined') return;
    this.installed = true;
    this.zoneCause.install();
    this.recorder.install();
    if (typeof document !== 'undefined') {
      document.addEventListener('keydown', this.onKeyDown, true);
      document.addEventListener('mousemove', this.onMouseMove, true);
      document.addEventListener('click', this.onClick, true);
      window.addEventListener('scroll', () => this.highlight.reposition(), true);
      window.addEventListener('resize', () => this.highlight.reposition(), true);
    }
    void loadDebugIndex().then((index) => {
      this._indexStatus = index ? 'ready' : 'missing';
      this.emit();
    });
  }

  uninstall(): void {
    if (typeof document !== 'undefined') {
      document.removeEventListener('keydown', this.onKeyDown, true);
      document.removeEventListener('mousemove', this.onMouseMove, true);
      document.removeEventListener('click', this.onClick, true);
    }
    this.highlight.destroy();
    this.installed = false;
  }

  // ── subscriptions ──────────────────────────────────────────────────────
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  refresh(): void {
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  // ── mutators ───────────────────────────────────────────────────────────
  toggleEnabled(force?: boolean): void {
    this._enabled = force ?? !this._enabled;
    this._hint = this._enabled ? 'UI Debug ON — Ctrl+hover an element (Ctrl+click to pin)' : '';
    if (!this._enabled) this.close();
    this.emit();
  }

  setTab(tab: DebugTabId): void {
    this._tab = tab;
    this.emit();
  }

  pin(target: InspectTarget): void {
    this._target = target;
    this._visible = true;
    this.highlight.show(target.element, this.describeQuick(target.element));
    this.emit();
  }

  close(): void {
    this._visible = false;
    this._armed = false;
    if (this.armTimer) clearTimeout(this.armTimer);
    this.highlight.hide();
    this.emit();
  }

  clearCalls(): void {
    this.recorder.clear();
    this.armedCallIds.clear();
    this.armedOnce = false;
    this.emit();
  }

  armCapture(): void {
    const calls = this.recorder.getCalls();
    const lastId = calls.length ? calls[calls.length - 1].id : 0;
    this.recordedAtArm = lastId;
    this.armedOnce = true;
    this._armed = true;
    if (this.armTimer) clearTimeout(this.armTimer);
    this.armTimer = setTimeout(() => {
      this._armed = false;
      this.emit();
    }, this.armWindowMs);
    this.emit();
  }

  setHint(hint: string, clearAfterMs = 1400): void {
    this._hint = hint;
    this.emit();
    if (clearAfterMs > 0) {
      setTimeout(() => {
        if (this._hint === hint) {
          this._hint = '';
          this.emit();
        }
      }, clearAfterMs);
    }
  }

  private recordedAtArm = 0;

  // ── raw accessors ──────────────────────────────────────────────────────
  get enabled(): boolean {
    return this._enabled;
  }

  get visible(): boolean {
    return this._visible;
  }

  get armed(): boolean {
    return this._armed;
  }

  get tab(): DebugTabId {
    return this._tab;
  }

  get target(): InspectTarget | null {
    return this._target;
  }

  get index(): DebugIndex | null {
    return getDebugIndex();
  }

  get calls(): DebugCall[] {
    return this.recorder.getCalls();
  }

  /** Adapter that owns the pinned target. */
  private adapterFor(target: InspectTarget | null): InspectAdapter | null {
    if (!target) return null;
    return this.adapters.find((adapter) => adapter.id === target.framework) ?? this.adapters[0] ?? null;
  }

  snapshot(): ComponentSnapshot | null {
    const target = this._target;
    const adapter = this.adapterFor(target);
    if (!target || !adapter) return null;
    try {
      return adapter.snapshot(target);
    } catch {
      return null;
    }
  }

  record(): IndexedClass | null {
    const index = this.index;
    const target = this._target;
    if (!index || !target) return null;
    const key = target.name.replace(/^[_$]+/, '');
    const all = { ...index.components, ...index.services };
    const direct = all[key];
    if (direct) return direct;
    const found = Object.keys(all).find(
      (name) => name.replace(/^[_$]+/, '') === key || name.endsWith(key) || key.endsWith(name),
    );
    return found ? all[found] : null;
  }

  // ── derived: prediction ────────────────────────────────────────────────
  predicted(): PredictedHandler | null {
    const target = this._target;
    const record = this.record();
    if (!target || !record) return null;
    const direct = matchElementHandler(record, target.element);
    if (direct) return direct;
    return matchHandlerInSubtree(record, target.element)?.predicted ?? null;
  }

  predictedLocation(): string | null {
    const target = this._target;
    const record = this.record();
    if (!target || !record) return null;
    if (matchElementHandler(record, target.element)) return null;
    const nested = matchHandlerInSubtree(record, target.element);
    if (!nested) return null;
    return nested.scope === 'item' ? `${elSummary(nested.node)} — inside the row/item` : elSummary(nested.node);
  }

  predictedEndpoints(): EndpointRef[] {
    const record = this.record();
    const predicted = this.predicted();
    if (!record || !predicted) return [];
    const seen = new Set<string>();
    const out: EndpointRef[] = [];
    for (const handler of predicted.entry.handlers) {
      for (const endpoint of endpointsForHandler(record, handler).endpoints) {
        const key = `${endpoint.method} ${endpoint.path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(endpoint);
      }
    }
    return out;
  }

  predictedLinks(): { label: string; detail: string }[] {
    const predicted = this.predicted();
    return predicted ? linksOf(predicted.entry) : [];
  }

  handlerChain(): string[] {
    const record = this.record();
    const predicted = this.predicted();
    if (!record || !predicted) return [];
    const steps: string[] = [];
    const walk = (chain: IndexedClass['methods'][string]['calls'] | undefined, prefix: string, depth: number) => {
      if (!chain?.length || depth > 3) return;
      for (const entry of chain) {
        steps.push(`${prefix}${entry.via}`);
        for (const endpoint of entry.endpoints) {
          steps.push(`${prefix}  ↳ ${endpoint.method} ${endpoint.path}${endpoint.body ? ` body ${endpoint.body}` : ''}`);
        }
        walk(entry.chain, `${prefix}  `, depth + 1);
      }
    };
    for (const handler of predicted.entry.handlers) {
      const method = record.methods?.[handler];
      if (!method) continue;
      steps.push(`${record.selector || this._target?.name}.${handler}()  (${record.file}:${method.line})`);
      for (const endpoint of method.endpoints ?? []) {
        steps.push(`  ↳ ${endpoint.method} ${endpoint.path}${endpoint.body ? ` body ${endpoint.body}` : ''}`);
      }
      walk(method.calls, '  ', 0);
      for (const hub of method.hubCalls ?? []) steps.push(`  ↳ hub.${hub.verb}('${hub.target}')`);
    }
    return steps;
  }

  handlerDescription(): string[] {
    const record = this.record();
    const predicted = this.predicted();
    if (!record || !predicted) return [];
    const name = this._target?.name;
    const lines = predicted.entry.handlers.flatMap((handler) => describeMethod(record, handler, name));
    const links = this.predictedLinks();
    if (!lines.length && links.length) {
      const targets = links.map((link) => link.label.replace(/^Navigates to /, ''));
      lines.push(`Clicking navigates to ${targets.join(' | ')} (template: ${predicted.entry.expression}).`);
      const resolved = this.linkActions().map((action) => action.label.replace(/^Click → /, ''));
      if (resolved.length) lines.push(`Resolved for this element right now: ${resolved.join(', ')}.`);
    }
    return lines;
  }

  nextSteps(): NextStep[] {
    const target = this._target;
    if (!target) return [];
    const hrefs = this.linkActions().map((action) => action.label.replace(/^Click → /, ''));
    return buildNextSteps({
      className: target.name,
      record: this.record(),
      handlerNames: this.predicted()?.entry.handlers ?? [],
      links: this.predictedLinks(),
      resolveHref: (preview) => {
        const staticPart = preview.split('{')[0];
        return hrefs.find((href) => staticPart.length > 1 && href.includes(staticPart)) ?? hrefs[0];
      },
      index: this.index,
    });
  }

  // ── derived: element level ─────────────────────────────────────────────
  hoveredSummary(): string {
    return this._target ? hoveredElementSummary(this._target) : '';
  }

  rowIdentity(): ElementAction[] {
    const target = this._target;
    const snapshot = this.snapshot();
    return target && snapshot ? describeRowIdentity(target, snapshot) : [];
  }

  linkActions(): ElementAction[] {
    return this._target ? describeLinks(this._target) : [];
  }

  clickableActions(): ElementAction[] {
    return this._target ? describeClickables(this._target) : [];
  }

  summaryLines(): string[] {
    const target = this._target;
    const record = this.record();
    const snapshot = this.snapshot();
    if (!target) return [];
    const lines: string[] = [];

    if (record?.doc) lines.push(record.doc);
    lines.push(
      `${target.name}${record?.selector || target.selector ? ` — <${record?.selector || target.selector}>` : ''}${record ? ` — ${record.file}` : ''}`,
    );
    const predicted = this.predicted();
    const handlerMethod = predicted?.entry.handlers?.[0] ? record?.methods?.[predicted.entry.handlers[0]] : undefined;
    if (predicted) {
      lines.push(
        `This element: <${predicted.entry.tag}> (${predicted.entry.event}) → ${predicted.entry.expression}` +
          `${handlerMethod ? ` (${record?.file}:${handlerMethod.line})` : ''}`,
      );
    } else if (this._indexStatus === 'ready') {
      if (this.linkActions().length || this.clickableActions().length) {
        lines.push('The hovered node itself has no binding — the link/button listed above is what acts on click.');
      } else {
        lines.push('No click/keyboard binding found in the template for this element or its children — display-only.');
      }
    }

    const services = Object.entries(record?.services ?? {});
    if (services.length) lines.push(`Injects: ${services.map(([prop, type]) => `${prop}: ${type}`).join(', ')}`);

    const endpoints = this.predictedEndpoints();
    if (endpoints.length) {
      lines.push(`Calls when used: ${endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`).join(', ')}`);
    }
    const init = initEndpoints(record);
    if (init.length) {
      lines.push(
        `Calls on create: ${init
          .map((entry) => `${entry.hook} → ${entry.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`).join(', ')}`)
          .join(' | ')}`,
      );
    }
    const hub = handlerMethod?.hubCalls ?? [];
    if (hub.length) lines.push(`Hub calls: ${hub.map((entry) => `${entry.verb}('${entry.target}')`).join(', ')}`);

    if (snapshot) {
      if (snapshot.inputs.length) lines.push(`Inputs/props: ${snapshot.inputs.map((input) => input.name).join(', ')}`);
      if (snapshot.outputs.length) lines.push(`Outputs: ${snapshot.outputs.map((output) => output.split(' ')[0]).join(', ')}`);
      for (const note of snapshot.notes) lines.push(note);
      const fill = this.fill();
      if (fill && fill.rowCount) lines.push(`Renders ${fill.rowCount} row(s) in ${fill.container}.`);
    }
    return lines;
  }

  recordMethods(): RecordMethodInfo[] {
    const record = this.record();
    if (!record) return [];
    return Object.entries(record.methods ?? {})
      .map(([name, method]) => ({
        name,
        line: method.line,
        doc: method.doc ?? null,
        endpoints: (method.endpoints ?? []).map(
          (endpoint) => `${endpoint.method} ${endpoint.path}${endpoint.body ? ` body ${endpoint.body}` : ''}`,
        ),
      }))
      .sort((a, b) => a.line - b.line)
      .slice(0, 60);
  }

  // ── derived: data ──────────────────────────────────────────────────────
  fill(): FillInfo | null {
    const target = this._target;
    const snapshot = this.snapshot();
    const adapter = this.adapterFor(target);
    if (!target || !snapshot || !adapter) return null;
    return describeFill(target, snapshot, adapter);
  }

  dataChain(): ChainStep[] {
    const target = this._target;
    const snapshot = this.snapshot();
    const adapter = this.adapterFor(target);
    if (!target || !snapshot || !adapter) return [];
    const fill = this.fill();
    return traceDataChain(target, snapshot, this.index, this.calls, fill?.rowCount ?? 0, fill?.container ?? '', (element) =>
      adapter.boundArray(element),
    );
  }

  arrayFills(): ArrayFillMatch[] {
    const snapshot = this.snapshot();
    return snapshot ? matchArraysToResponses(snapshot, this.calls) : [];
  }

  describeField(propName: string): string[] {
    return describeField(this.record(), propName, this._target?.name);
  }

  propNotes(snapshot: ComponentSnapshot | null): { state: PropInfo[]; services: PropInfo[] } {
    const props = snapshot?.props ?? [];
    return {
      state: props.filter((prop) => prop.kind !== 'service'),
      services: props.filter((prop) => prop.kind === 'service'),
    };
  }

  // ── derived: calls ─────────────────────────────────────────────────────
  attributionOf(call: DebugCall): Attribution | null {
    const target = this._target;
    if (!target) return null;
    const causeElement = call.cause.target ?? null;
    if (causeElement) {
      if (
        causeElement === target.element ||
        target.element.contains(causeElement) ||
        causeElement.contains(target.element) ||
        target.hostElement.contains(causeElement) ||
        causeElement.contains(target.hostElement)
      ) {
        return 'dom';
      }
    }
    const handlerNames = this.predicted()?.entry.handlers ?? [];
    if (handlerNames.length && handlerNamesFromCause(call).some((name) => handlerNames.includes(name))) return 'handler';

    const predictedEndpoints = this.predictedEndpoints();
    if (predictedEndpoints.length && callMatchesEndpoints(call, predictedEndpoints)) return 'endpoint';

    const related = this.relatedClasses();
    if (related.length) {
      const frames = call.stack.join('\n');
      if (related.some((name) => name && frames.includes(name))) return 'service';
    }
    return null;
  }

  private relatedClasses(): string[] {
    const record = this.record();
    const target = this._target;
    const handlerNames = this.predicted()?.entry.handlers ?? [];
    return [
      ...(target?.chain.map((entry) => entry.name) ?? []),
      ...relatedServiceNames(record, handlerNames),
      ...handlerNames.flatMap((handler) => chainClassNames(record?.methods?.[handler]?.calls)),
    ].filter(Boolean);
  }

  causedCalls(): DebugCall[] {
    if (!this._target) return [];
    return this.calls
      .filter((call) => {
        const attribution = this.attributionOf(call);
        return attribution === 'dom' || attribution === 'handler' || attribution === 'endpoint';
      })
      .reverse();
  }

  relatedCalls(): DebugCall[] {
    if (!this._target) return [];
    return this.calls.filter((call) => this.attributionOf(call) === 'service').reverse();
  }

  unattributedCalls(): DebugCall[] {
    if (!this._target) return [];
    const attributed = new Set([...this.causedCalls(), ...this.relatedCalls()].map((call) => call.id));
    return this.calls.filter((call) => !attributed.has(call.id)).reverse();
  }

  armedCalls(): DebugCall[] {
    if (!this.armedOnce && !this._armed) return [];
    return this.calls.filter((call) => call.id > this.recordedAtArm).reverse();
  }

  recentCalls(): DebugCall[] {
    return [...this.calls].reverse();
  }

  handlerEntries(): EventLogEntry[] {
    const target = this._target;
    if (!target) return [];
    return this.zoneCause.getEventLog().filter((entry) => {
      const element = entry.target;
      if (!element) return false;
      return (
        element === target.element ||
        element === target.hostElement ||
        target.hostElement.contains(element) ||
        element.contains(target.element)
      );
    });
  }

  // ── view for the panel ────────────────────────────────────────────────
  getView(): InspectorView {
    const target = this._target;
    const snapshot = this.snapshot();
    return {
      enabled: this._enabled,
      visible: this._visible,
      armed: this._armed,
      tab: this._tab,
      hint: this._hint,
      indexStatus: this._indexStatus,
      framework: target?.framework ?? (this.adapters[0]?.id ?? 'dom'),
      targetLabel: target ? `${target.name}${target.selector ? ` <${target.selector}>` : ''}` : '',
      hoveredSummary: this.hoveredSummary(),
      snapshot,
      record: this.record(),
      recordMethods: this.recordMethods(),
      predicted: this.predicted(),
      predictedLocation: this.predictedLocation(),
      predictedEndpoints: this.predictedEndpoints(),
      predictedLinks: this.predictedLinks(),
      handlerDescription: this.handlerDescription(),
      handlerChain: this.handlerChain(),
      nextSteps: this.nextSteps(),
      rowIdentity: this.rowIdentity(),
      linkActions: this.linkActions(),
      clickableActions: this.clickableActions(),
      summaryLines: this.summaryLines(),
      fill: this.fill(),
      dataChain: this.dataChain(),
      arrayFills: this.arrayFills(),
      causedCalls: this.causedCalls(),
      relatedCalls: this.relatedCalls(),
      unattributedCalls: this.unattributedCalls(),
      armedCalls: this.armedCalls(),
      recentCalls: this.recentCalls(),
      handlerEntries: this.handlerEntries(),
    };
  }

  // ── interaction ────────────────────────────────────────────────────────
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && this._visible) {
      this.close();
      return;
    }
    if (event.ctrlKey && event.shiftKey && (event.key === 'D' || event.key === 'd')) {
      event.preventDefault();
      event.stopPropagation();
      this.toggleEnabled();
    }
  };

  private readonly onMouseMove = (event: MouseEvent): void => {
    if (!this._enabled) return;
    const element = this.elementUnder(event);
    if (!element) return;
    if (!event.ctrlKey) {
      this.highlight.hide();
      if (this.dwellTimer) clearTimeout(this.dwellTimer);
      return;
    }
    this.highlight.show(element, this.describeQuick(element));
    if (this.dwellTimer) clearTimeout(this.dwellTimer);
    this.dwellTimer = setTimeout(() => {
      const target = this.findTarget(element);
      if (target) this.pin(target);
    }, this.dwellMs);
  };

  private readonly onClick = (event: MouseEvent): void => {
    if (!this._enabled) return;
    if (!event.ctrlKey && !event.metaKey) return;
    if (this._armed) return; // capture mode: let the real click through
    const element = this.elementUnder(event);
    if (!element) return;
    const target = this.findTarget(element);
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    this.pin(target);
  };

  findTarget(element: Element): InspectTarget | null {
    for (const adapter of this.adapters) {
      try {
        if (!adapter.detect()) continue;
        const target = adapter.findTarget(element);
        if (target) return target;
      } catch {
        /* adapter failed on this element, try the next one */
      }
    }
    return null;
  }

  private describeQuick(element: Element): string {
    const target = this.findTarget(element);
    if (!target) return `${elSummary(element)} ${elPreview(element, 30)}`;
    const suffix = target.climbed ? ` ← climbed from ${elSummary(element)}` : '';
    return `${target.name}${target.selector ? ` <${target.selector}>` : ''}${suffix}`;
  }

  private elementUnder(event: MouseEvent): Element | null {
    const element = document.elementFromPoint(event.clientX, event.clientY);
    if (!element || element.closest('[data-ui-debug-panel]')) return null;
    return element;
  }
}

/** Helper for adapters: is this element repeated among its siblings? */
export { findRepeatedItem };
