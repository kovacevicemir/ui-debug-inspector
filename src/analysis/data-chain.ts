/**
 * Traces where the data rendered by a table/list comes from.
 *
 * Chain: DOM rows -> bound array/input -> component field (or service field it
 * aliases) -> method that writes it -> HTTP endpoint -> recorded response.
 *
 * Every step is labelled with a confidence so the panel never pretends to know
 * more than it does.
 */
import { DebugCall, InspectTarget } from '../core/types.js';
import { ComponentSnapshot } from '../adapters/types.js';
import { DebugIndex, IndexedClass, chainClassNames } from './code-index.js';

import { isPlainObject, truncate } from '../core/util.js';
import { arraysInResponse } from './payload-tracer.js';

export interface ChainStep {
  label: string;
  detail?: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface Candidate {
  /** e.g. `RankingPageComponent.players` or `PlayerStatsRankingService.rankingSignal()` */
  label: string;
  ownerClass: string;
  propName: string;
  kind: 'prop' | 'signal' | 'input' | 'service' | 'getter';
  value: unknown;
}

function readSignal(value: unknown): unknown {
  try {
    return (value as () => unknown)();
  } catch {
    return undefined;
  }
}

function isSignal(value: unknown): boolean {
  return (
    typeof value === 'function' &&
    typeof (value as { set?: unknown }).set === 'function' &&
    typeof (value as { update?: unknown }).update === 'function'
  );
}

function isServiceLike(name: string): boolean {
  return /(Service|Store|Facade|Repository|Repo|Manager|Api|Client)$/.test(name);
}

/** Every array/signal/input the component (or its injected services) could be feeding the rows with. */
export function collectCandidates(info: ComponentSnapshot, target: InspectTarget): Candidate[] {
  const out: Candidate[] = [];
  const className = info.name;

  for (const prop of info.props) {
    if (Array.isArray(prop.raw)) {
      out.push({
        label: `${className}.${prop.name}`,
        ownerClass: className,
        propName: prop.name,
        kind: prop.kind === 'getter' ? 'getter' : 'prop',
        value: prop.raw,
      });
    }
  }
  for (const prop of info.signals) {
    const value = readSignal(prop.raw);
    if (Array.isArray(value)) {
      out.push({ label: `${className}.${prop.name}()`, ownerClass: className, propName: prop.name, kind: 'signal', value });
    }
  }
  for (const input of info.inputs) {
    if (Array.isArray(input.raw)) {
      out.push({ label: `${className}@Input ${input.name}`, ownerClass: className, propName: input.name, kind: 'input', value: input.raw });
    }
  }

  // Injected services hold their own caches — the real source of a table in most pages.
  for (const prop of info.props) {
    const raw = prop.raw;
    if (!raw || typeof raw !== 'object') continue;
    const ctorName = (raw as { constructor?: { name?: string } }).constructor?.name ?? '';
    const serviceName = (ctorName || prop.name).replace(/^[_$]+/, '');
    if (!isServiceLike(serviceName) && !isServiceLike(prop.name)) continue;
    for (const key of Object.getOwnPropertyNames(raw).slice(0, 80)) {
      const value = (raw as Record<string, unknown>)[key];
      if (Array.isArray(value)) {
        out.push({ label: `${serviceName}.${key}`, ownerClass: serviceName, propName: key, kind: 'service', value });
        continue;
      }
      if (isSignal(value)) {
        const read = readSignal(value);
        if (Array.isArray(read)) {
          out.push({ label: `${serviceName}.${key}()`, ownerClass: serviceName, propName: key, kind: 'service', value: read });
        }
      }
    }
  }

  void target;
  return out;
}

/** Identifiers inside an item that we can look for in the rendered row text. */
export function itemIdentifiers(item: unknown): string[] {
  if (!isPlainObject(item)) return [String(item).slice(0, 24)];
  const keys = ['name', 'username', 'nickname', 'title', 'label', 'crewName', 'itemName', 'className', 'id'];
  const values: string[] = [];
  for (const key of keys) {
    const value = (item as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.length > 1) values.push(value);
    if (typeof value === 'number') values.push(String(value));
  }
  return values.slice(0, 4);
}

function rowText(container: Element): string {
  return (container.textContent ?? '').replace(/\s+/g, ' ').slice(0, 6000);
}

function deriveFromServiceMethod(
  index: DebugIndex | null,
  serviceName: string,
  methodName: string,
  depth: number,
  seen: Set<string>,
): ChainStep[] {
  const record: IndexedClass | undefined = index?.services[serviceName] ?? index?.components[serviceName];
  const member = record?.methods?.[methodName];
  if (!record || !member) return [];
  const steps: ChainStep[] = [];
  if (member.doc) steps.push({ label: member.doc, confidence: 'high' });
  for (const endpoint of member.endpoints ?? []) {
    steps.push({
      label: `${endpoint.method} ${endpoint.path}`,
      detail: endpoint.body ? `body ${endpoint.body}` : undefined,
      confidence: 'high',
    });
  }
  // The value usually lives in the field this method returns (service signals).
  for (const ret of member.returns ?? []) {
    if (ret.service || !ret.prop) continue;
    steps.push(...deriveSteps(index, serviceName, ret.prop, depth + 1, seen));
  }
  return steps;
}

/**
 * Follows a field back to its origin: getter -> service method -> service field
 * -> method that writes it -> endpoint. This is the "why is this table full".
 */
function deriveSteps(
  index: DebugIndex | null,
  ownerClass: string,
  propName: string,
  depth = 0,
  seen: Set<string> = new Set(),
): ChainStep[] {
  const key = `${ownerClass}.${propName}`;
  if (!index || seen.has(key) || depth > 5) return [];
  seen.add(key);

  const record: IndexedClass | undefined = index.components[ownerClass] ?? index.services[ownerClass];
  if (!record) return [];
  const steps: ChainStep[] = [];
  const member = record.methods?.[propName];

  if (member?.kind === 'getter') {
    steps.push({ label: `Derived from ${ownerClass}.${propName}()`, detail: member.doc ?? undefined, confidence: 'high' });
    for (const call of member.calls ?? []) {
      steps.push({ label: `via ${call.via}`, confidence: 'high' });
      for (const endpoint of call.endpoints ?? []) {
        steps.push({ label: `${endpoint.method} ${endpoint.path}`, detail: endpoint.body ? `body ${endpoint.body}` : undefined, confidence: 'high' });
      }
      const [serviceName, methodRaw] = call.via.split('.');
      if (serviceName && methodRaw) {
        steps.push(...deriveFromServiceMethod(index, serviceName, methodRaw.replace('()', ''), depth + 1, seen));
      }
    }
    for (const ret of member.returns ?? []) {
      if (ret.service && ret.prop) steps.push(...deriveSteps(index, ret.service, ret.prop, depth + 1, seen));
      else if (ret.prop) steps.push(...deriveSteps(index, ownerClass, ret.prop, depth + 1, seen));
    }
    if (steps.length) return steps;
  }

  const alias = record.fieldOrigins?.[propName];
  if (alias) {
    steps.push({ label: `Aliases ${alias.via}`, detail: alias.init ?? undefined, confidence: 'high' });
  }

  for (const fill of (record.fills?.[propName] ?? []).slice(0, 3)) {
    steps.push({
      label: `Written by ${ownerClass}.${fill.method}()${fill.line ? ` (line ${fill.line})` : ''}`,
      detail: fill.doc ?? undefined,
      confidence: 'high',
    });
    for (const endpoint of fill.endpoints ?? []) {
      steps.push({
        label: `${endpoint.method} ${endpoint.path}`,
        detail: endpoint.body ? `body ${endpoint.body}` : undefined,
        confidence: 'high',
      });
    }
    for (const call of fill.chain ?? []) steps.push({ label: `via ${call.via}`, confidence: 'high' });
  }

  // Service field (`items = this.svc.itemsSignal`) — keep walking through it.
  for (const aliasEntry of record.fields?.filter((field) => field.name === propName) ?? []) {
    void aliasEntry;
  }
  if (alias) {
    const [serviceName, fieldRaw] = alias.via.split('.');
    if (serviceName && fieldRaw) steps.push(...deriveSteps(index, serviceName, fieldRaw.replace('()', ''), depth + 1, seen));
  }

  return steps;
}

export function traceDataChain(
  target: InspectTarget,
  info: ComponentSnapshot,
  index: DebugIndex | null,
  calls: DebugCall[],
  rowCount: number,
  containerLabel: string,
  /** Adapter hook: the exact array bound to the rendered list, when known. */
  boundArray?: (element: Element) => { value: unknown; host: string } | null,
): ChainStep[] {
  const steps: ChainStep[] = [];
  steps.push({ label: `Renders ${rowCount} row(s)`, detail: containerLabel, confidence: 'high' });

  const candidates = collectCandidates(info, target);
  const literal = (() => {
    try {
      return boundArray?.(target.element) ?? null;
    } catch {
      return null;
    }
  })();
  const domText = rowText(target.hostElement);

  const scored = candidates
    .map((candidate) => {
      const items = candidate.value as unknown[];
      let score = 0;
      const sample = items.slice(0, 12);
      const hits = sample.filter((item) => itemIdentifiers(item).some((id) => id.length > 1 && domText.includes(id))).length;
      if (sample.length) score += (hits / sample.length) * 6;
      if (items.length === rowCount && rowCount > 0) score += 3;
      if (literal && candidate.value === literal.value) score += 8;
      if (new RegExp(candidate.propName, 'i').test(domText.slice(0, 200)) || candidate.label.toLowerCase().includes('row')) score += 0.5;
      return { candidate, score };
    })
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (literal) {
    const literalMatch = scored.find((entry) => entry.candidate.value === literal.value);
    if (literalMatch) {
      steps.push({
        label: `Table bound to ${literal.host}`,
        detail: `exact reference match: ${literalMatch.candidate.label}`,
        confidence: 'high',
      });
    } else {
      steps.push({ label: `Table bound to ${literal.host}`, detail: 'array not found on this component (passed from a parent?)', confidence: 'medium' });
    }
  }

  if (!best || best.score < 2) {
    steps.push({
      label: 'No matching array/signal found on this component or its services',
      detail: rowCount
        ? 'rows are probably rendered from a parent-provided input, a template-local collection, or a canvas/virtual list'
        : 'nothing rendered yet',
      confidence: 'low',
    });
    return steps;
  }

  const confidence: ChainStep['confidence'] = best.score >= 8 ? 'high' : best.score >= 4 ? 'medium' : 'low';
  steps.push({
    label: `Data source: ${best.candidate.label} (${best.candidate.kind}, ${(best.candidate.value as unknown[]).length} items)`,
    detail: `sample: ${truncate(JSON.stringify((best.candidate.value as unknown[])[0] ?? null), 160)}`,
    confidence,
  });

  const ownerRecord = index?.components[best.candidate.ownerClass] ?? index?.services[best.candidate.ownerClass];
  if (best.candidate.kind === 'input') {
    steps.push({
      label: 'Rows come in as an @Input from the parent component',
      detail: `parent sets [${best.candidate.propName}] — hover the parent element to see who fills it`,
      confidence: 'high',
    });
  }
  steps.push(...deriveSteps(index, best.candidate.ownerClass, best.candidate.propName));
  if (!ownerRecord) {
    steps.push({ label: `${best.candidate.ownerClass} is not in the code index`, confidence: 'low' });
  }

  // Which recorded response produced this array (top level or `{ items: [...] }`).
  const responseMatch = calls
    .flatMap((call) => arraysInResponse(call.responseBody).map((entry) => ({ call, ...entry })))
    .find((entry) => rowCount > 0 && entry.items.length === rowCount);
  if (responseMatch) {
    steps.push({
      label: `Matches response ${responseMatch.call.method} ${responseMatch.call.url}${responseMatch.path ? ` (body.${responseMatch.path})` : ''}`,
      detail: `${responseMatch.items.length} items · ${Math.round(responseMatch.call.durationMs ?? 0)} ms`,
      confidence: confidence === 'high' ? 'high' : 'medium',
    });
  }

  return steps;
}
