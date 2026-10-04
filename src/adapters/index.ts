/**
 * Adapter registry: the store asks each adapter in order and uses the first one
 * that both detects its framework and can resolve the hovered element.
 */
import { AngularAdapter } from './angular.js';
import { DomAdapter } from './dom.js';
import { ReactAdapter } from './react.js';
import { InspectAdapter } from './types.js';

export function createAdapters(): InspectAdapter[] {
  return [new AngularAdapter(), new ReactAdapter(), new DomAdapter()];
}

export { AngularAdapter, ReactAdapter, DomAdapter };
export * from './types.js';
