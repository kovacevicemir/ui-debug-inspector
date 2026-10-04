/**
 * Framework-neutral install/uninstall entry point.
 *
 * Usage (any framework):
 *   import { installUiDebugInspector } from 'ui-debug-inspector';
 *   installUiDebugInspector();               // Ctrl+Shift+D, Ctrl+hover
 *
 * Optional code index (Angular AST indexer output) enables endpoint prediction:
 *   installUiDebugInspector({ index: debugIndexJson });
 *   installUiDebugInspector({ indexUrl: '/debug-index.json' });
 */
import { DebugIndex, setDebugIndex } from './analysis/code-index.js';
import { InspectAdapter } from './adapters/types.js';
import { createAdapters } from './adapters/index.js';
import { InspectorStore, StoreOptions } from './core/store.js';
import { mountInspectorPanel } from './core/panel.js';

export interface InstallOptions extends StoreOptions {
  /** Pre-loaded code index (from `ui-debug-index-angular`). */
  index?: DebugIndex | null;
  /** URL to fetch a code index from, when not inlined. */
  indexUrl?: string;
  /** Force a specific adapter instead of auto-detecting. */
  framework?: 'angular' | 'react' | 'dom' | 'auto';
  /** Start enabled (default true outside production builds). */
  startEnabled?: boolean;
  /** Called after install, useful for wiring your own console handle. */
  onReady?: (store: InspectorStore) => void;
  /** Expose the store as `window.uiDebug` for console poking. Default true. */
  exposeGlobal?: boolean;
}

export interface InspectorHandle {
  store: InspectorStore;
  adapters: InspectAdapter[];
  uninstall(): void;
}

let current: InspectorHandle | null = null;

export function installUiDebugInspector(options: InstallOptions = {}): InspectorHandle {
  if (current) return current;
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    throw new Error('[ui-debug-inspector] requires a browser environment');
  }

  if (options.index) setDebugIndex(options.index);

  const adapters =
    options.framework && options.framework !== 'auto'
      ? createAdapters().filter((adapter) => adapter.id === options.framework)
      : createAdapters();

  const store = new InspectorStore(adapters, options);
  const unmount = mountInspectorPanel(store);
  store.install();

  const enabled = options.startEnabled ?? window.localStorage.getItem('ui-debug-inspector-disabled') !== '1';
  if (enabled) store.toggleEnabled(true);

  if (options.indexUrl && !options.index) {
    void fetch(options.indexUrl)
      .then((response) => (response.ok ? response.json() : null))
      .then((json) => {
        if (json) setDebugIndex(json as DebugIndex);
        store.refresh();
      })
      .catch(() => undefined);
  }

  current = {
    store,
    adapters,
    uninstall() {
      unmount();
      store.uninstall();
      current = null;
    },
  };
  if (options.exposeGlobal !== false) {
    (window as unknown as Record<string, unknown>)['uiDebug'] = store;
  }
  options.onReady?.(store);
  return current;
}

export function getInspector(): InspectorHandle | null {
  return current;
}

export function isInstalled(): boolean {
  return current !== null;
}

export type { DebugIndex, IndexedClass, IndexedElementHandler, IndexedRoute } from './analysis/code-index.js';
export { setDebugIndex, loadDebugIndex } from './analysis/code-index.js';
export type { DebugCall, DebugCause, EventLogEntry, HttpMeta } from './core/types.js';
export type { InspectTarget, ComponentSnapshot, PropInfo, InspectAdapter } from './adapters/types.js';
export { InspectorStore } from './core/store.js';
