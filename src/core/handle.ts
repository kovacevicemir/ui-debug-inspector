/**
 * Shared handle so framework entries can reach the running inspector.
 */
import { InspectorHandle } from '../index.js';

let handle: InspectorHandle | null = null;

export function setInspectorHandle(next: InspectorHandle | null): void {
  handle = next;
}

export function inspectorHandle(): InspectorHandle | null {
  return handle;
}
