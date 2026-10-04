/**
 * The contracts every framework adapter implements.
 *
 * The core (recorder, panel, analysis) only ever talks to these types, which is
 * what keeps the tool usable from Angular, React or plain DOM.
 */

export type FrameworkId = 'angular' | 'react' | 'dom';

/** Loose component instance handle used by adapters. */
export type AnyComponent = Record<string, any>;

export interface PropInfo {
  name: string;
  kind: 'value' | 'signal' | 'observable' | 'emitter' | 'array' | 'getter' | 'object' | 'map' | 'set' | 'service' | 'hook';
  type: string;
  preview: string;
  /** Raw value, kept in memory for payload-origin matching. Never serialized to the DOM. */
  raw?: unknown;
}

export interface ChainEntry {
  name: string;
  selector: string;
  element: Element;
}

export interface InspectTarget {
  /** Element under the cursor at inspect time. */
  element: Element;
  /** Nearest ancestor element owned by a component. */
  hostElement: Element;
  framework: FrameworkId;
  /** Component name (`RankingPageComponent`, `RankingTable`). */
  name: string;
  /** Angular selector, React display name or `div` for plain DOM. */
  selector: string;
  /** Component ancestors, innermost first. */
  chain: ChainEntry[];
  /** True when the hovered element is not itself the component root. */
  climbed: boolean;
  pinnedAt: number;
  /** Adapter-private handle (Angular component instance, React fiber, …). */
  handle?: unknown;
}

/** Framework-independent view of "the thing that owns this element". */
export interface ComponentSnapshot {
  framework: FrameworkId;
  name: string;
  selector: string;
  file?: string;
  props: PropInfo[];
  inputs: { name: string; value: string; raw?: unknown }[];
  outputs: string[];
  /** Directives/child components found in the rendered subtree. */
  children: { name: string; on: string }[];
  arrays: PropInfo[];
  signals: PropInfo[];
  observables: PropInfo[];
  /** Free-form extra facts the adapter can supply (React: hook list, memo deps…). */
  notes: string[];
}

export interface InspectAdapter {
  id: FrameworkId;
  /** Cheap runtime probe: is this framework present on the page? */
  detect(): boolean;
  /** Resolve the hovered element to a component, climbing if needed. */
  findTarget(element: Element): InspectTarget | null;
  /** Live state/props/inputs of the resolved component. */
  snapshot(target: InspectTarget): ComponentSnapshot;
  /** Rendered child components/directives, for "what renders this". */
  childrenIn(root: Element): { name: string; on: string }[];
  /** The array/prop that literally feeds a list rendered under `element`, when known. */
  boundArray(element: Element): { value: unknown; host: string } | null;
}
