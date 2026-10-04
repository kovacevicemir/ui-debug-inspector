import { DebugCause, EventLogEntry } from './types.js';
import { elSummary, truncate } from './util.js';

interface ZoneLike {
  current?: ZoneLike | null;
  parent?: ZoneLike | null;
  __uiDebugCause?: DebugCause;
}

interface ZoneTaskLike {
  type?: string;
  source?: string;
  data?: {
    handler?: { name?: string; toString(): string };
    target?: EventTarget;
    eventName?: string;
  };
}

interface ZoneCtor {
  prototype: Record<string, unknown>;
  current?: ZoneLike | null;
}

function getZone(): ZoneCtor | undefined {
  return (globalThis as unknown as { Zone?: ZoneCtor }).Zone;
}

const UNKNOWN_CAUSE: DebugCause = { kind: 'unknown', at: 0 };

/**
 * Derives "what caused this call" from Zone.js task bookkeeping.
 *
 * Angular event handlers run inside a zone task whose `source` looks like
 * `HTMLButtonElement.addEventListener:click`. We tag the task's zone while the
 * handler executes; any XHR/fetch/SignalR call made synchronously inside the
 * handler (or in a child zone task) can then walk up `Zone.current.parent`
 * looking for that tag. This is what makes "which endpoint does this button
 * call" exact instead of a guess.
 */
export class ZoneCauseTracker {
  private installed = false;
  private lastCause: DebugCause | null = null;
  private lastCauseAt = 0;
  private readonly eventLog: EventLogEntry[] = [];

  install(): void {
    if (this.installed) return;
    const Zone = getZone();
    if (!Zone?.prototype) return;

    const proto = Zone.prototype;
    const original = proto['onInvokeTask'] as
      | ((
          this: unknown,
          delegate: { invokeTask: (...args: unknown[]) => unknown },
          current: ZoneLike,
          target: ZoneLike,
          task: ZoneTaskLike,
          applyThis: unknown,
          applyArgs: unknown[],
        ) => unknown)
      | undefined;
    if (typeof original !== 'function') return;

    const self = this;
    proto['onInvokeTask'] = function patchedOnInvokeTask(
      this: unknown,
      delegate: { invokeTask: (...args: unknown[]) => unknown },
      current: ZoneLike,
      target: ZoneLike,
      task: ZoneTaskLike,
      applyThis: unknown,
      applyArgs: unknown[],
    ): unknown {
      const cause = self.causeFromTask(task);
      if (cause) self.logEvent(cause);
      const previous = current?.__uiDebugCause;
      if (cause && current) {
        current.__uiDebugCause = cause;
        self.lastCause = cause;
        self.lastCauseAt = performance.now();
      }
      try {
        return original.call(this, delegate, current, target, task, applyThis, applyArgs);
      } finally {
        if (current) {
          if (previous) current.__uiDebugCause = previous;
          else delete current.__uiDebugCause;
        }
      }
    };

    this.installed = true;
  }

  /** Cause for the currently executing code, or the last known one (marked `stale`). */
  currentCause(): DebugCause {
    const Zone = getZone();
    let zone = Zone?.current ?? null;
    let depth = 0;
    while (zone && depth < 25) {
      const cause = zone.__uiDebugCause;
      if (cause) return { ...cause };
      zone = zone.parent ?? null;
      depth += 1;
    }

    const stale = this.lastCause && performance.now() - this.lastCauseAt < 2500;
    if (stale && this.lastCause) return { ...this.lastCause, stale: true };
    return { ...UNKNOWN_CAUSE, at: performance.now() };
  }

  /** Installs on top of an already-tagged cause without a DOM event (e.g. manual trigger). */
  withCause<T>(cause: DebugCause, fn: () => T): T {
    const Zone = getZone();
    const zone = Zone?.current;
    if (!zone) return fn();
    const previous = zone.__uiDebugCause;
    zone.__uiDebugCause = cause;
    try {
      return fn();
    } finally {
      if (previous) zone.__uiDebugCause = previous;
      else delete zone.__uiDebugCause;
    }
  }

  /** Last N DOM event tasks, newest first — lets the panel name the real handler. */
  getEventLog(): EventLogEntry[] {
    return this.eventLog;
  }

  private logEvent(cause: DebugCause): void {
    this.eventLog.unshift({
      at: cause.at,
      eventName: cause.eventName ?? '?',
      source: cause.source ?? '',
      element: cause.element,
      target: cause.target ?? null,
      handlerName: cause.handlerName,
      handlerSource: cause.handlerSource,
    });
    if (this.eventLog.length > 120) this.eventLog.length = 120;
  }

  private causeFromTask(task: ZoneTaskLike): DebugCause | null {
    if (!task || task.type !== 'eventTask') return null;
    const source = task.source ?? '';
    const data = task.data ?? {};
    const eventName = data.eventName ?? source.split(':').pop();
    const handler = data.handler;
    let handlerSource: string | undefined;
    if (handler) {
      try {
        handlerSource = truncate(String(handler).replace(/\s+/g, ' '), 220);
      } catch {
        handlerSource = undefined;
      }
    }
    return {
      kind: 'event',
      eventName,
      source,
      handlerName: handler?.name,
      handlerSource,
      target: (data.target as Element | undefined) ?? null,
      element: data.target ? elSummary(data.target as Element) : undefined,
      at: performance.now(),
    };
  }
}
