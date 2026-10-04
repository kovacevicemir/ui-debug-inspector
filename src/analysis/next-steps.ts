/**
 * "What happens next" — an ordered chain from a hovered control to its effects:
 *
 *   click -> component method -> service methods -> endpoint(s) -> state update -> re-render
 *   click -> link -> route -> target component -> that page's own init calls / endpoints
 *
 * Everything comes from the static index (nothing needs to be clicked), with the
 * runtime-resolved href attached when available.
 */
import { DebugIndex, IndexedClass, IndexedRoute, initEndpoints } from './code-index.js';

export interface NextStep {
  kind: 'click' | 'call' | 'endpoint' | 'state' | 'render' | 'hub' | 'navigate' | 'page' | 'guard';
  label: string;
  detail?: string;
}

/** Matches a link preview such as `/profile/{player.name}` to a route entry. */
export function routeForLink(routes: IndexedRoute[], preview: string): IndexedRoute | null {
  const linkSegments = preview.replace(/^#?\/?/, '').split('/').filter(Boolean);
  if (!linkSegments.length) return null;
  const scored = routes
    .map((route) => {
      const routeSegments = route.path.split('/').filter(Boolean);
      if (!routeSegments.length) return { route, score: 0 };
      if (!/^\{|^:|\{/.test(routeSegments[0]) && routeSegments[0] !== linkSegments[0]) return { route, score: 0 };
      let score = 1;
      for (let index = 0; index < routeSegments.length; index += 1) {
        const routeSegment = routeSegments[index];
        const linkSegment = linkSegments[index];
        if (routeSegment.startsWith(':')) {
          score += linkSegment ? 1 : -1;
          continue;
        }
        if (linkSegment && linkSegment.startsWith('{')) {
          score += 0.5;
          continue;
        }
        if (linkSegment === routeSegment) score += 2;
        else return { route, score: 0 };
      }
      return { route, score };
    })
    .filter((entry) => entry.score > 1)
    .sort((a, b) => b.score - a.score);
  return scored[0]?.route ?? null;
}

interface BuildArgs {
  className: string;
  record: IndexedClass | null;
  handlerNames: string[];
  /** Router destinations declared by the matched binding. */
  links: { label: string; detail: string }[];
  /** Live href lookup used to resolve `{param}` previews to real URLs. */
  resolveHref: (preview: string) => string | undefined;
  index: DebugIndex | null;
}

export function buildNextSteps(args: BuildArgs): NextStep[] {
  const { className, record, handlerNames, links, resolveHref, index } = args;
  const steps: NextStep[] = [];
  const seen = new Set<string>();
  const push = (step: NextStep) => {
    const key = `${step.kind}:${step.label}`;
    if (seen.has(key)) return;
    seen.add(key);
    steps.push(step);
  };

  if (handlerNames.length) {
    push({ kind: 'click', label: `click → ${className}.${handlerNames.join('() / ')}()` });
  }

  for (const handler of handlerNames) {
    const method = record?.methods?.[handler];
    if (!method) continue;
    if (method.doc) push({ kind: 'call', label: method.doc });

    for (const call of method.calls ?? []) {
      push({ kind: 'call', label: `calls ${call.via}` });
      for (const nested of call.chain ?? []) push({ kind: 'call', label: `→ ${nested.via}` });
      for (const endpoint of call.endpoints ?? []) {
        push({
          kind: 'endpoint',
          label: `${endpoint.method} ${endpoint.path}`,
          detail: endpoint.body ? `body ${endpoint.body}` : undefined,
        });
      }
      for (const ret of call.returns ?? []) {
        if (ret.prop) push({ kind: 'render', label: `fills ${ret.prop} → UI re-renders` });
      }
    }

    for (const endpoint of method.endpoints ?? []) {
      push({
        kind: 'endpoint',
        label: `${endpoint.method} ${endpoint.path}`,
        detail: endpoint.body ? `body ${endpoint.body}` : undefined,
      });
    }
    for (const hub of method.hubCalls ?? []) push({ kind: 'hub', label: `hub.${hub.verb}('${hub.target}')` });
    if (method.writes?.length) {
      push({ kind: 'state', label: `updates state: ${method.writes.map((write) => write.prop).join(', ')}` });
    }
    for (const nav of method.navigates ?? []) push({ kind: 'navigate', label: `router.navigate(${nav.target})` });
  }

  const routes = index?.routes ?? [];
  links.forEach((link) => {
    const preview = link.label.replace(/^Navigates to /, '');
    const resolved = resolveHref(preview);
    push({ kind: 'navigate', label: `follows link → ${preview}`, detail: resolved ? `resolves right now to ${resolved}` : link.detail });
    const route = routeForLink(routes, preview);
    if (!route) return;
    push({ kind: 'page', label: `route /${route.path} → ${route.component ?? 'unknown component'}` });
    for (const guard of route.guards) push({ kind: 'guard', label: `guard ${guard} runs first (redirects to / if it blocks)` });
    const target = route.component ? index?.components[route.component] ?? null : null;
    for (const init of initEndpoints(target)) {
      push({
        kind: 'endpoint',
        label: `${route.component}.${init.hook}() → ${init.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`).join(', ')}`,
      });
    }
    for (const hook of ['ngOnInit', 'constructor', 'ngAfterViewInit']) {
      const method = target?.methods?.[hook];
      for (const call of method?.calls ?? []) push({ kind: 'call', label: `${route.component}.${hook}() calls ${call.via}` });
    }
  });

  return steps.slice(0, 20);
}
