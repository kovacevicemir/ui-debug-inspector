/**
 * Angular entry point.
 *
 * Two ways in — pick whichever fits your app root:
 *
 *   // app.config.ts (standalone bootstrap)
 *   export const appConfig: ApplicationConfig = {
 *     providers: [
 *       ...(!environment.production ? [provideUiDebugInspector({ indexUrl: '/debug-index.json' })] : []),
 *     ],
 *   };
 *
 *   // app.component.ts (template)
 *   <ui-debug-inspector [options]="{ index: debugIndex }" />
 *
 * Both run outside production builds and only add listeners when called.
 */
import { ApplicationConfig, Component, ENVIRONMENT_INITIALIZER, EnvironmentProviders, Input, inject, makeEnvironmentProviders } from '@angular/core';
import { HttpClient, HttpInterceptorFn } from '@angular/common/http';
import { InspectorHandle, InstallOptions, installUiDebugInspector } from '../index.js';
import { inspectorHandle, setInspectorHandle } from '../core/handle.js';

export interface AngularInstallOptions extends InstallOptions {
  /**
   * Capture the caller stack at `HttpClient.request()` time (recommended: this is what
   * makes "which service method sent this" possible).
   */
  patchHttpClient?: boolean;
  /** Expose the store as `window.uiDebug` for console poking. Default true. */
  exposeGlobal?: boolean;
}

let installed: InspectorHandle | null = null;

/** Imperative install (call from a bootstrap effect / main.ts). */
export function installAngularUiDebugInspector(options: AngularInstallOptions = {}): InspectorHandle {
  if (installed) return installed;
  const handle = installUiDebugInspector({ framework: 'angular', ...options });
  if (options.patchHttpClient !== false) {
    try {
      handle.store.recorder.patchRequestMethod(HttpClient.prototype as unknown as { request?: (...args: unknown[]) => unknown });
    } catch {
      /* HttpClient not available — XHR/fetch patching still applies */
    }
  }
  try {
    void handle.store.recorder.installSignalR();
  } catch {
    /* signalr is optional */
  }
  if (options.exposeGlobal !== false) {
    (window as unknown as Record<string, unknown>)['uiDebug'] = handle.store;
  }
  installed = handle;
  setInspectorHandle(handle);
  return handle;
}

/** Provider form: installs the inspector when the app environment is initialized. */
export function provideUiDebugInspector(options: AngularInstallOptions = {}): EnvironmentProviders {
  return makeEnvironmentProviders([
    {
      provide: ENVIRONMENT_INITIALIZER,
      multi: true,
      useValue: () => installAngularUiDebugInspector(options),
    },
  ]);
}

/**
 * Optional HttpClient interceptor that records the original (unserialized) body,
 * query params, masking headers and the accurate caller stack.
 */
export function uiDebugHttpInterceptor(): HttpInterceptorFn {
  return (req, next) => {
    const handle = inspectorHandle();
    if (!handle) return next(req);
    const recorder = handle.store.recorder;

    let serializedBody: unknown;
    try {
      serializedBody = req.serializeBody();
    } catch {
      serializedBody = undefined;
    }

    let body: unknown = req.body;
    if (typeof body === 'string' && body.trim().startsWith('{')) {
      try {
        body = JSON.parse(body);
      } catch {
        /* keep the raw string */
      }
    }

    const params: Record<string, string> = {};
    for (const key of req.params.keys()) {
      const values = req.params.getAll(key);
      if (values) params[key] = values.join(',');
    }

    const headers: Record<string, string> = {};
    for (const key of req.headers.keys()) {
      const value = req.headers.get(key);
      if (value === null) continue;
      headers[key] = /authorization|cookie|token/i.test(key) ? `${value.slice(0, 12)}…` : value;
    }

    recorder.pushHttpMeta({
      method: req.method,
      url: req.urlWithParams,
      body,
      serializedBody,
      params,
      headers,
      responseType: req.responseType,
      stack: captureStack(2, 30),
    });
    return next(req);
  };
}

function captureStack(skip = 2, limit = 30): string[] {
  const stack = new Error().stack;
  if (!stack) return [];
  return stack
    .split('\n')
    .slice(1)
    .map((line) => line.trim().replace(/^at\s+/, ''))
    .filter(Boolean)
    .slice(skip, skip + limit);
}

/**
 * Drop-in component variant:
 *
 *   <ui-debug-inspector [options]="{ indexUrl: '/debug-index.json' }" />
 *
 * Renders nothing; it just installs the overlay while it is in the tree.
 */
@Component({
  selector: 'ui-debug-inspector',
  standalone: true,
  template: '',
})
export class UiDebugInspectorComponent {
  @Input() options: AngularInstallOptions = {};

  constructor() {
    installAngularUiDebugInspector(this.options);
  }
}

export type { InspectorHandle, InstallOptions };
export { inject };

/** Convenience: spread into an ApplicationConfig providers array. */
export function uiDebugProviders(options: AngularInstallOptions = {}): ApplicationConfig['providers'] {
  return [provideUiDebugInspector(options)];
}
