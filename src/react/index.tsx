/**
 * React entry point.
 *
 *   // main.tsx — covers the whole tree, including modals/portals
 *   import { UiDebugInspector } from 'ui-debug-inspector/react';
 *   createRoot(el).render(
 *     <>
 *       <App />
 *       <UiDebugInspector indexUrl="/debug-index.json" />
 *     </>,
 *   );
 *
 *   // or hook form, inside any component
 *   useUiDebugInspector({ startEnabled: true });
 *
 * The component renders nothing; it installs the overlay (a shadow-DOM widget
 * appended to <body>) while mounted and tears it down on unmount.
 */
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { InspectorHandle, InstallOptions, installUiDebugInspector } from '../index.js';
import { setInspectorHandle } from '../core/handle.js';

export interface ReactInstallOptions extends InstallOptions {
  /** Expose the store as `window.uiDebug` for console poking. Default true. */
  exposeGlobal?: boolean;
}

export function installReactUiDebugInspector(options: ReactInstallOptions = {}): InspectorHandle {
  const handle = installUiDebugInspector({ framework: 'react', ...options });
  if (options.exposeGlobal !== false) {
    (window as unknown as Record<string, unknown>)['uiDebug'] = handle.store;
  }
  setInspectorHandle(handle);
  return handle;
}

/** Imperative lifecycle hook: installs on mount, uninstalls on unmount. */
export function useUiDebugInspector(options: ReactInstallOptions = {}): InspectorHandle | null {
  const ref = useRef<InspectorHandle | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    if (ref.current) return;
    ref.current = installReactUiDebugInspector(optionsRef.current);
    return () => {
      ref.current?.uninstall();
      ref.current = null;
    };
  }, []);

  return ref.current;
}

/**
 * Render-nothing component. Put it next to your app root so it also covers
 * portals, dialogs and route transitions.
 */
export function UiDebugInspector(props: ReactInstallOptions & { children?: ReactNode }): ReactNode {
  useUiDebugInspector(props);
  return props.children ?? null;
}

export type { InspectorHandle, InstallOptions };
