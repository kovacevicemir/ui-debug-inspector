/**
 * Turns indexed source facts into plain-language "what this does" lines.
 *
 * Uses the method's own JSDoc when it exists; otherwise derives a sentence from
 * the resolved call chain, endpoints, state writes, navigation and storage
 * access — so hovering a button explains itself even in undecorated code.
 */
import { IndexedClass, IndexedMethod } from './code-index.js';

export function describeMethod(record: IndexedClass | null, methodName: string, className?: string): string[] {
  const method = record?.methods?.[methodName];
  if (!method) return [];
  const lines: string[] = [];
  if (method.doc) lines.push(method.doc);

  const parts: string[] = [];
  const endpointLabels = method.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}${endpoint.body ? ` (body ${endpoint.body})` : ''}`);
  const calls = (method.calls ?? []).map((call) => call.via);

  if (calls.length) parts.push(`calls ${calls.join(', ')}`);
  if (endpointLabels.length) parts.push(`sends ${endpointLabels.join(', ')}`);
  const hub = (method.hubCalls ?? []).map((entry) => `hub ${entry.verb}('${entry.target}')`);
  if (hub.length) parts.push(hub.join(', '));
  if (method.writes?.length) parts.push(`updates state: ${method.writes.map((write) => write.prop).join(', ')}`);
  if (method.navigates?.length) parts.push(`navigates to ${method.navigates.map((entry) => entry.target).join(', ')}`);
  const storage = method.storageOps ?? [];
  if (storage.length) parts.push(`touches localStorage: ${storage.map((entry) => `${entry.op}(${entry.key})`).join(', ')}`);

  if (parts.length) {
    const subject = className ? `${className}.${methodName}()` : `${methodName}()`;
    lines.push(`${subject} → ${parts.join('; ')}.`);
  } else if (!method.doc) {
    lines.push('Pure local state / no side effects detected for this method.');
  }
  return lines;
}

/** Provenance lines for one state field of a component or service. */
export function describeField(record: IndexedClass | null, propName: string, className?: string): string[] {
  if (!record) return [];
  const lines: string[] = [];
  const field = record.fields?.find((entry) => entry.name === propName);
  if (field?.doc) lines.push(field.doc);
  if (field?.init) lines.push(`Initialised as ${field.init}`);

  const alias = record.fieldOrigins?.[propName];
  if (alias) lines.push(`Holds (aliases) ${alias.via}`);

  for (const fill of (record.fills?.[propName] ?? []).slice(0, 4)) {
    const where = `${className ?? ''}${className ? '.' : ''}${fill.method}()`.replace(/^\./, '');
    const endpoints = (fill.endpoints ?? []).map((endpoint) => `${endpoint.method} ${endpoint.path}`).join(', ');
    lines.push(`Written by ${where}${fill.line ? ` (line ${fill.line})` : ''}${endpoints ? ` → ${endpoints}` : ''}`);
    if (fill.doc) lines.push(`  ${fill.doc}`);
    for (const call of fill.chain ?? []) lines.push(`  via ${call.via}`);
  }
  if (!lines.length) lines.push('No indexed writer — value comes from a runtime callback, an @Input, or a template expression.');
  return lines;
}

export function methodIsInteresting(method: IndexedMethod | undefined): boolean {
  if (!method) return false;
  return !!(method.doc || method.endpoints?.length || method.calls?.length || method.writes?.length || method.navigates?.length);
}
