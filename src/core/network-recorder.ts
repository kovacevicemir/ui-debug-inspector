
import { DebugCall, DebugCallKind, DebugCause, HttpMeta } from './types.js';
import { captureStack, guessClassFromStack } from './util.js';
import { ZoneCauseTracker } from './zone-cause.js';

interface XhrMeta {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  stack: string[];
  cause: DebugCause;
  startedAt: number;
  id: number;
}

interface ClientCallMeta {
  method: string;
  url: string;
  stack: string[];
  at: number;
  consumed?: boolean;
}

const MAX_CALLS = 300;
const META_MATCH_WINDOW_MS = 150;

/**
 * Universal runtime recorder for outbound traffic.
 *
 * Patches `XMLHttpRequest` + `fetch` on the prototype/global so it captures
 * everything (HttpClient, raw XHR, third-party libs), plus SignalR hub
 * invocations and the Electron preload bridge when present. Every entry keeps a
 * stack trace and the Zone.js cause, which is what lets the panel answer
 * "which endpoint does this button call, and from where".
 */
/**
 * Universal runtime recorder for outbound traffic.
 *
 * Patches `XMLHttpRequest` + `fetch` on the prototype/global so it captures
 * everything (framework HTTP clients, raw XHR, third-party libs), plus SignalR hub
 * invocations and the Electron preload bridge when present. Framework-specific
 * clients (Angular `HttpClient`, …) can be added through
 * `patchRequestMethod()` and `pushHttpMeta()`.
 */
export class NetworkRecorder {
  private calls: DebugCall[] = [];
  private pendingHttpMeta: HttpMeta[] = [];
  private pendingClientCalls: ClientCallMeta[] = [];
  private listeners = new Set<() => void>();
  private seq = 0;
  private installed = false;
  private readonly maxCalls: number;

  constructor(private readonly causeTracker: ZoneCauseTracker, options: { maxCalls?: number } = {}) {
    this.maxCalls = options.maxCalls ?? MAX_CALLS;
  }

  install(): void {
    if (this.installed) return;
    this.patchXhr();
    this.patchFetch();
    this.patchElectronBridge();
    this.installed = true;
  }

  /**
   * Optional: capture the caller stack at an HTTP client's request entry point
   * (e.g. Angular's `HttpClient.prototype.request`) — by the time the request reaches
   * XHR the original caller frames are gone behind an async boundary.
   */
  patchRequestMethod(proto: { request?: (...args: unknown[]) => unknown }): void {
    const original = proto.request;
    if (typeof original !== 'function' || (original as { __uiDebugPatched?: boolean }).__uiDebugPatched) return;
    const recorder = this;
    const patched = function patchedRequest(this: unknown, method: unknown, url: unknown, ...rest: unknown[]): unknown {
      recorder.pendingClientCalls.push({
        method: String(method ?? 'GET').toUpperCase(),
        url: String(url ?? ''),
        stack: captureStack(2, 30),
        at: performance.now(),
      });
      const pending = recorder.pendingClientCalls;
      if (pending.length > 50) pending.splice(0, pending.length - 50);
      return original.apply(this, [method, url, ...rest]);
    };
    (patched as { __uiDebugPatched?: boolean }).__uiDebugPatched = true;
    proto.request = patched;
  }

  /** Consumes the caller stack captured at `HttpClient.request()` time. */
  private takeClientStack(method: string, url: string): string[] | undefined {
    const match = this.pendingClientCalls.find(
      (entry) =>
        !entry.consumed &&
        entry.method === method.toUpperCase() &&
        (entry.url === url || url.endsWith(entry.url) || entry.url.endsWith(url)),
    );
    if (!match) return undefined;
    match.consumed = true;
    return match.stack;
  }

  /** Called by the dev HttpClient interceptor with richer request metadata. */
  pushHttpMeta(meta: Omit<HttpMeta, 'at' | 'consumed'>): void {
    const clientStack = this.takeClientStack(meta.method, meta.url);
    this.pendingHttpMeta.push({
      ...meta,
      stack: clientStack?.length ? clientStack : meta.stack,
      at: performance.now(),
      consumed: false,
    });
    if (this.pendingHttpMeta.length > 50) this.pendingHttpMeta.splice(0, this.pendingHttpMeta.length - 50);
    // Merge into an already-recorded call when the interceptor runs before the XHR
    // is finalized (usual case), otherwise it gets consumed on XHR completion.
    this.attachPendingHttpMeta();
  }

  getCalls(): DebugCall[] {
    return this.calls;
  }

  getHttpRequests(): DebugCall[] {
    return this.calls.filter((call) => !!call.http);
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  clear(): void {
    this.calls = [];
    this.pendingHttpMeta = [];
    this.pendingClientCalls = [];
    this.notify();
  }

  /** Patches SignalR lazily (only when the app actually uses it). */
  async installSignalR(moduleSpecifier = '@microsoft/signalr'): Promise<void> {
    try {
      // Variable specifier: no hard dependency, no bundler resolution errors.
      const mod = (await import(/* @vite-ignore */ moduleSpecifier)) as unknown as {
        HubConnection?: { prototype: Record<string, unknown> };
      };
      const proto = mod.HubConnection?.prototype as
        | { invoke?: (...args: unknown[]) => unknown; send?: (...args: unknown[]) => unknown }
        | undefined;
      if (!proto) return;
      this.wrapSignalRMethod(proto, 'invoke');
      this.wrapSignalRMethod(proto, 'send');
    } catch {
      /* signalr not available in this build */
    }
  }

  /** Registers a call without patching anything (used by manual instrumentation). */
  recordManual(kind: DebugCallKind, method: string, url: string, extra: Partial<DebugCall> = {}): DebugCall {
    return this.start(kind, method, url, {
      body: undefined,
      stack: captureStack(0),
      cause: this.causeTracker.currentCause(),
      ...extra,
    });
  }

  private wrapSignalRMethod(
    proto: { invoke?: (...args: unknown[]) => unknown; send?: (...args: unknown[]) => unknown },
    name: 'invoke' | 'send',
  ): void {
    const original = proto[name];
    if (typeof original !== 'function' || (original as { __uiDebugPatched?: boolean }).__uiDebugPatched) return;
    const recorder = this;
    const patched = function patchedSignalR(this: unknown, ...args: unknown[]): unknown {
      const target = args[0];
      const payload = args.length > 1 ? args[1] : undefined;
      const call = recorder.start('signalr', name === 'invoke' ? 'HUB→' : 'HUB←', String(target), {
        body: payload,
        stack: captureStack(2),
        cause: recorder.causeTracker.currentCause(),
      });
      const result = original.apply(this, args);
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        const started = call.startedAt;
        void (result as Promise<unknown>).then(
          (value: unknown) => recorder.finish(call.id, { status: 200, body: value, started }),
          (err: unknown) => recorder.finish(call.id, { status: 0, error: String(err), started }),
        );
      } else {
        recorder.finish(call.id, { status: 200, started: call.startedAt });
      }
      return result;
    };
    (patched as { __uiDebugPatched?: boolean }).__uiDebugPatched = true;
    proto[name] = patched;
  }

  private start(
    kind: DebugCallKind,
    method: string,
    url: string,
    meta: { body?: unknown; stack: string[]; cause: DebugCause; id?: number },
  ): DebugCall {
    const call: DebugCall = {
      id: meta.id ?? ++this.seq,
      kind,
      method,
      url,
      startedAt: performance.now(),
      requestBody: meta.body,
      stack: meta.stack,
      cause: meta.cause,
      componentHint: guessClassFromStack(meta.stack),
    };
    this.calls.push(call);
    if (this.calls.length > this.maxCalls) this.calls.splice(0, this.calls.length - this.maxCalls);
    this.attachPendingHttpMeta();
    this.notify();
    return call;
  }

  private finish(
    id: number,
    result: { status?: number; body?: unknown; text?: string; error?: string; started: number },
  ): void {
    const call = this.calls.find((entry) => entry.id === id);
    if (!call) return;
    call.status = result.status;
    call.ok = result.status !== undefined ? result.status >= 200 && result.status < 400 : undefined;
    call.responseBody = result.body;
    call.responseText = result.text;
    call.error = result.error;
    call.durationMs = performance.now() - result.started;
    this.attachPendingHttpMeta();
    this.notify();
  }

  /** Merges interceptor metadata onto the matching XHR record (method + url + close in time). */
  private attachPendingHttpMeta(): void {
    for (const meta of this.pendingHttpMeta) {
      if (meta.consumed) continue;
      const match = [...this.calls]
        .reverse()
        .find(
          (call) =>
            !call.http &&
            call.kind === 'xhr' &&
            call.method.toUpperCase() === meta.method.toUpperCase() &&
            call.url === meta.url &&
            Math.abs(call.startedAt - meta.at) < META_MATCH_WINDOW_MS * 4,
        );
      if (!match) continue;
      meta.consumed = true;
      match.http = meta;
      match.componentHint = guessClassFromStack(meta.stack) ?? match.componentHint;
      match.stack = meta.stack.length ? meta.stack : match.stack;
      if (meta.headers && Object.keys(meta.headers).length) {
        match.requestHeaders = { ...(match.requestHeaders ?? {}), ...meta.headers };
      }
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private patchXhr(): void {
    const recorder = this;
    const proto = XMLHttpRequest.prototype as unknown as {
      open: (...args: unknown[]) => void;
      send: (...args: unknown[]) => void;
      setRequestHeader: (...args: unknown[]) => void;
    };
    const originalOpen = proto.open;
    const originalSend = proto.send;
    const originalSetHeader = proto.setRequestHeader;

    proto.open = function patchedOpen(this: XMLHttpRequest, method: unknown, url: unknown, ...rest: unknown[]): void {
      const meta: XhrMeta = {
        method: String(method ?? 'GET').toUpperCase(),
        url: String(url ?? ''),
        headers: {},
        stack: captureStack(2),
        cause: recorder.causeTracker.currentCause(),
        startedAt: performance.now(),
        id: ++recorder.seq,
      };
      (this as unknown as { __uiDebug?: XhrMeta }).__uiDebug = meta;
      return originalOpen.apply(this, [method, url, ...rest]);
    };

    proto.setRequestHeader = function patchedSetHeader(this: XMLHttpRequest, key: unknown, value: unknown): void {
      const meta = (this as unknown as { __uiDebug?: XhrMeta }).__uiDebug;
      if (meta) meta.headers[String(key)] = String(value);
      return originalSetHeader.apply(this, [key, value]);
    };

    proto.send = function patchedSend(this: XMLHttpRequest, body?: unknown): void {
      const meta: XhrMeta = (this as unknown as { __uiDebug?: XhrMeta }).__uiDebug ?? {
        method: 'GET',
        url: String(this.responseURL ?? ''),
        headers: {},
        stack: captureStack(2),
        cause: recorder.causeTracker.currentCause(),
        startedAt: performance.now(),
        id: ++recorder.seq,
      };

      const call = recorder.start('xhr', meta.method, meta.url, {
        body: body instanceof FormData ? '[FormData]' : body,
        stack: meta.stack,
        cause: meta.cause,
        id: meta.id,
      });
      call.requestHeaders = meta.headers;

      const started = meta.startedAt;
      const onDone = () => {
        let parsed: unknown;
        let text: string | undefined;
        try {
          if (this.responseType === '' || this.responseType === 'text') {
            text = this.responseText;
            if (text) parsed = JSON.parse(text);
          } else if (this.responseType === 'json') {
            parsed = this.response;
          } else {
            text = `[${this.responseType} response]`;
          }
        } catch {
          parsed = undefined;
        }
        recorder.finish(meta.id, { status: this.status, body: parsed, text, started });
      };
      this.addEventListener('load', onDone, { once: true });
      this.addEventListener(
        'error',
        () => recorder.finish(meta.id, { status: 0, error: 'network error', started }),
        { once: true },
      );

      return originalSend.apply(this, [body]);
    };
  }

  private patchFetch(): void {
    const recorder = this;
    const originalFetch = window.fetch?.bind(window);
    if (!originalFetch) return;

    window.fetch = async function patchedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      const call = recorder.start('fetch', method, url, {
        body: init?.body,
        stack: captureStack(2),
        cause: recorder.causeTracker.currentCause(),
      });
      const started = call.startedAt;
      try {
        const response = await originalFetch(input as RequestInfo, init);
        const clone = response.clone();
        void clone
          .text()
          .then((text) => {
            let parsed: unknown;
            try {
              parsed = text ? JSON.parse(text) : undefined;
            } catch {
              parsed = undefined;
            }
            recorder.finish(call.id, { status: response.status, body: parsed, text, started });
          })
          .catch(() => recorder.finish(call.id, { status: response.status, started }));
        return response;
      } catch (err) {
        recorder.finish(call.id, { status: 0, error: String(err), started });
        throw err;
      }
    };
  }

  private patchElectronBridge(): void {
    const recorder = this;
    const bridgeNames = ['electronAPI', 'electron'] as const;
    for (const name of bridgeNames) {
      const bridge = (window as unknown as Record<string, unknown>)[name];
      if (!bridge || typeof bridge !== 'object') continue;
      for (const key of Object.keys(bridge)) {
        const fn = (bridge as Record<string, unknown>)[key];
        if (typeof fn !== 'function') continue;
        (bridge as Record<string, unknown>)[key] = function patchedIpc(this: unknown, ...args: unknown[]): unknown {
          const call = recorder.start('ipc', 'IPC', `${name}.${key}`, {
            body: args.length === 1 ? args[0] : args,
            stack: captureStack(2),
            cause: recorder.causeTracker.currentCause(),
          });
          const result = (fn as (...a: unknown[]) => unknown).apply(this, args);
          recorder.finish(call.id, { status: 200, started: call.startedAt });
          return result;
        };
      }
    }
  }
}
