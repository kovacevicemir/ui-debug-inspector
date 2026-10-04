/**
 * Runtime records produced by the recorder (framework independent).
 */
export type { FrameworkId, InspectTarget, ComponentSnapshot, PropInfo, InspectAdapter, ChainEntry } from '../adapters/types.js';

export type DebugCallKind = 'xhr' | 'fetch' | 'http' | 'signalr' | 'ipc';

/** What (probably) caused a runtime call. */
export interface DebugCause {
  kind: 'event' | 'task' | 'unknown';
  eventName?: string;
  handlerName?: string;
  /** Source of the bound handler when the framework exposes it. */
  handlerSource?: string;
  /** Human readable element summary, e.g. `button.btn.color-blue#equip`. */
  element?: string;
  /** Live DOM reference of the event target (may be detached later). */
  target?: Element | null;
  /** Zone task source string, e.g. `HTMLButtonElement.addEventListener:click`. */
  source?: string;
  at: number;
  /** True when attribution comes from a previous task (async / delayed call). */
  stale?: boolean;
}

/** Recorded DOM event (used to show which handler ran for a click). */
export interface EventLogEntry {
  at: number;
  eventName: string;
  source: string;
  element?: string;
  target?: Element | null;
  handlerName?: string;
  handlerSource?: string;
}

/** Rich metadata attached by the HTTP interceptor / HttpClient patch. */
export interface HttpMeta {
  method: string;
  url: string;
  serializedBody?: unknown;
  body?: unknown;
  params?: Record<string, string>;
  headers?: Record<string, string>;
  responseType?: string;
  stack: string[];
  at: number;
  consumed?: boolean;
}

export interface DebugCall {
  id: number;
  kind: DebugCallKind;
  method: string;
  url: string;
  status?: number;
  ok?: boolean;
  startedAt: number;
  durationMs?: number;
  requestBody?: unknown;
  requestHeaders?: Record<string, string>;
  responseBody?: unknown;
  responseText?: string;
  error?: string;
  stack: string[];
  cause: DebugCause;
  /** Class/function name inferred from the captured stack. */
  componentHint?: string;
  /** Merged metadata when this call went through a framework HTTP client. */
  http?: HttpMeta;
}
