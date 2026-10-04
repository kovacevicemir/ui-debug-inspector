/**
 * Script-tag entry: bundles to `dist/global.js` (IIFE).
 *
 *   <script src="…/ui-debug-inspector/dist/global.js" data-auto></script>
 *   <!-- or -->
 *   <script src="…/ui-debug-inspector/dist/global.js"></script>
 *   <script>installUiDebugInspector()</script>
 */
import { InspectorHandle, InstallOptions, installUiDebugInspector } from './index.js';

declare global {
  interface Window {
    installUiDebugInspector?: (options?: InstallOptions) => InspectorHandle;
    uiDebug?: unknown;
  }
}

window.installUiDebugInspector = installUiDebugInspector;

// `<script src="global.js" data-auto>` installs immediately.
if (typeof document !== 'undefined') {
  const script = document.currentScript as HTMLScriptElement | null;
  if (script?.hasAttribute('data-auto')) {
    const indexUrl = script.getAttribute('data-index') ?? undefined;
    installUiDebugInspector({ indexUrl });
  }
}

export { installUiDebugInspector };
export type { InstallOptions, InspectorHandle };
export default installUiDebugInspector;
