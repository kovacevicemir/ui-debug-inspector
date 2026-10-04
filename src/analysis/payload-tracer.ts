import { ComponentSnapshot } from '../adapters/types.js';
import { DebugCall } from '../core/types.js';
import { isPlainObject, truncate } from '../core/util.js';

export interface OriginFinding {
  path: string;
  origin: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface ArrayFillMatch {
  propName: string;
  callId: number;
  endpoint: string;
  matchedItems: number;
  confidence: 'high' | 'medium' | 'low';
}

/** Parses a string body that looks like JSON (HttpClient sends serialized strings through XHR). */
export function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

/** The most useful representation of a request payload for a recorded call. */
export function payloadOf(call: DebugCall): unknown {
  if (call.http?.body !== undefined) return call.http.body;
  if (call.http?.serializedBody !== undefined) return parseMaybeJson(call.http.serializedBody);
  return parseMaybeJson(call.requestBody);
}

export function payloadKind(call: DebugCall): 'body' | 'query' | 'none' {
  const payload = payloadOf(call);
  if (payload !== undefined && payload !== null) return 'body';
  if (call.http?.params && Object.keys(call.http.params).length) return 'query';
  return 'none';
}

interface Candidate {
  label: string;
  value: unknown;
}

function isServiceLike(name: string): boolean {
  return /(Service|Store|Facade|Repository|Repo|Manager|Api|Client)$/.test(name);
}

function candidatesFrom(info: ComponentSnapshot): Candidate[] {
  const candidates: Candidate[] = [];
  const push = (label: string, value: unknown) => {
    if (value === undefined || value === null) return;
    candidates.push({ label, value });
  };

  for (const prop of info.props) {
    const isSignal = prop.kind === 'signal';
    push(`${info.name}.${prop.name}${isSignal ? '()' : ''}`, prop.raw);
  }

  // Services injected into the component are plain instance fields, so we can
  // look one level inside them when their name looks like a service.
  for (const prop of info.props) {
    const raw = prop.raw;
    if (!raw || typeof raw !== 'object') continue;
    const ctorName = (raw as { constructor?: { name?: string } }).constructor?.name ?? '';
    if (!isServiceLike(prop.name) && !isServiceLike(ctorName)) continue;
    for (const key of Object.getOwnPropertyNames(raw).slice(0, 60)) {
      const value = (raw as Record<string, unknown>)[key];
      if (typeof value === 'function') {
        if (typeof (value as { set?: unknown }).set === 'function') {
          try {
            push(`${ctorName || prop.name}.${key}()`, (value as () => unknown)());
          } catch {
            /* ignore */
          }
        }
        continue;
      }
      push(`${ctorName || prop.name}.${key}`, value);
    }
  }
  return candidates;
}

/**
 * Answers "where did this payload come from" by matching payload values against
 * component/service state (reference identity first, then name+value heuristics).
 */
export function findPayloadOrigins(payload: unknown, info: ComponentSnapshot): OriginFinding[] {
  if (!isPlainObject(payload)) return [];
  const candidates = candidatesFrom(info);
  const findings: OriginFinding[] = [];
  const searchInside = (prefix: string, value: unknown, depth: number) => {
    if (depth > 2) return;
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${key}` : key;
      const identity = candidates.find((candidate) => candidate.value === entry && entry !== null && typeof entry === 'object');
      if (identity) {
        findings.push({ path, origin: identity.label, confidence: 'high' });
      } else {
        const nameMatch = candidates.find(
          (candidate) =>
            candidate.value === entry &&
            candidate.label.toLowerCase().split('.').pop()?.replace('()', '') === key.toLowerCase(),
        );
        if (nameMatch) {
          findings.push({ path, origin: nameMatch.label, confidence: 'medium' });
        } else if (isPlainObject(entry) || Array.isArray(entry)) {
          if (isPlainObject(entry)) searchInside(path, entry, depth + 1);
          else {
            const arrayMatch = candidates.find((candidate) => candidate.value === entry);
            if (arrayMatch) findings.push({ path, origin: arrayMatch.label, confidence: 'high' });
          }
        } else if (entry !== null && entry !== undefined) {
          const looseMatch = candidates.find(
            (candidate) =>
              candidate.value === entry &&
              /(id|name|user|player|crew|item|amount|quantity|type|target)/i.test(key),
          );
          if (looseMatch) findings.push({ path, origin: looseMatch.label, confidence: 'low' });
        }
      }
    }
  };
  searchInside('', payload, 0);
  return findings.slice(0, 40);
}

/** Best-effort inline TypeScript type for a runtime payload — handy for copy/paste. */
export function jsonToTs(value: unknown, name = 'Payload', depth = 0): string {
  const indent = '  '.repeat(depth);
  const inner = '  '.repeat(depth + 1);
  if (Array.isArray(value)) {
    const item = value.length ? jsonToTs(value[0], name, depth) : 'unknown';
    return `${item}[]`;
  }
  if (isPlainObject(value)) {
    if (depth > 3) return '{ … }';
    const lines = Object.entries(value).map(([key, entry]) => {
      const optional = entry === null || entry === undefined ? '?' : '';
      return `${inner}${key}${optional}: ${describeType(entry, depth + 1)};`;
    });
    return `{\n${lines.join('\n')}\n${indent}}`;
  }
  return describeType(value, depth);
}

function describeType(value: unknown, depth: number): string {
  if (value === null) return 'null';
  if (value === undefined) return 'unknown';
  if (Array.isArray(value)) return jsonToTs(value, 'Item', depth);
  if (isPlainObject(value)) {
    const keys = Object.entries(value);
    if (keys.length > 12 || depth > 3) return 'Record<string, unknown>';
    return jsonToTs(value, 'Value', depth);
  }
  return typeof value;
}

/** Arrays carried by a response body (top level or one level deep, e.g. `{ players: [...] }`). */
export function arraysInResponse(body: unknown): { items: unknown[]; path: string }[] {
  if (Array.isArray(body)) return [{ items: body, path: '' }];
  if (isPlainObject(body)) {
    const out: { items: unknown[]; path: string }[] = [];
    for (const [key, value] of Object.entries(body)) {
      if (Array.isArray(value) && value.length) out.push({ items: value, path: key });
    }
    return out;
  }
  return [];
}

/**
 * Links component array properties to recorded responses so the panel can say
 * "this table was populated by GET /get-ranking (100 items)".
 */
export function matchArraysToResponses(info: ComponentSnapshot, calls: DebugCall[]): ArrayFillMatch[] {
  const matches: ArrayFillMatch[] = [];
  const responseArrays = calls.flatMap((call) => arraysInResponse(call.responseBody).map((entry) => ({ call, ...entry })));

  for (const prop of info.arrays) {
    const items = prop.raw;
    if (!Array.isArray(items) || items.length === 0) continue;
    const keys = isPlainObject(items[0]) ? Object.keys(items[0] as Record<string, unknown>) : [];

    for (const candidate of responseArrays) {
      const body = candidate.items;
      const sameLength = body.length === items.length;
      const bodyKeys = isPlainObject(body[0]) ? Object.keys(body[0] as Record<string, unknown>) : [];
      const keyOverlap =
        keys.length && bodyKeys.length
          ? keys.filter((key) => bodyKeys.includes(key)).length / Math.max(keys.length, bodyKeys.length)
          : 0;
      if (!sameLength && keyOverlap < 0.6) continue;
      matches.push({
        propName: prop.name,
        callId: candidate.call.id,
        endpoint: `${candidate.call.method} ${candidate.call.url}${candidate.path ? ` (body.${candidate.path})` : ''}`,
        matchedItems: body.length,
        confidence: sameLength && keyOverlap > 0.6 ? 'high' : sameLength ? 'medium' : 'low',
      });
    }
  }
  return matches.slice(0, 20);
}

/** Compact call label used in lists. */
export function callLabel(call: DebugCall): string {
  const status = call.status !== undefined ? ` ${call.status}` : '';
  return truncate(`${call.method} ${call.url}${status}`, 140);
}
