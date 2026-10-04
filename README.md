<div align="center">

# 🔎 ui-debug-inspector

**Hold `Ctrl` and hover anything in your app — it tells you what that element calls, what the call does, where its data comes from and what payload it sends.**

No framework lock-in, no build step, zero runtime dependencies. One script tag, one hook, or one provider.

[![license: MIT](https://img.shields.io/badge/license-MIT-22d3ee.svg?style=flat-square)](LICENSE)
[![dependencies: none](https://img.shields.io/badge/runtime%20deps-0-4ade80.svg?style=flat-square)](#)
[![frameworks: Angular · React · vanilla](https://img.shields.io/badge/Angular%20%C2%B7%20React%20%C2%B7%20vanilla-works%20anywhere-8b5cf6.svg?style=flat-square)](#quick-start)
[![bundle: ~77 kB min](https://img.shields.io/badge/script%20bundle-77%20kB%20min-f59e0b.svg?style=flat-square)](#script-tag-one-liner)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg?style=flat-square)](tsconfig.json)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-ff69b4.svg?style=flat-square)](#)

<img src="https://img.shields.io/badge/Ctrl%2BShift%2BD-toggle-0f172a?style=for-the-badge" /> <img src="https://img.shields.io/badge/Ctrl%2Bhover-inspect-0e7490?style=for-the-badge" /> <img src="https://img.shields.io/badge/Ctrl%2Bclick-pin-155e75?style=for-the-badge" /> <img src="https://img.shields.io/badge/Esc-close-334155?style=for-the-badge" />

</div>

---

## 🍝 The problem

You are staring at a button and you have no idea:

- which endpoint it hits,
- which service method builds that request,
- where the numbers in that table actually come from,
- what payload it will send and where those values were assembled,
- what happens *after* the click (navigation → next page → its own calls).

DevTools shows you traffic but not **intent**: it cannot tell you that *that* `<td>` renders `players[2]`, or that the row links to `/profile/{player.name}`, or that this tab button refetches `GET /get-ranking` through `RankingService.setFilters()`.

This tool answers all of it from the DOM + your runtime + (optionally) a static code index — **without clicking anything**.

---

## ✨ What the panel shows

### Hovering one cell of a ranking table

```
THIS EXACT ELEMENT
  cell of item 3/100 <td.px-4.py-2.text-center> — "3"
  high   Inside item 3 of 100 (<tr> in <tbody>) — the hovered <td> is one cell of it
  high   Renders RankingPageComponent.players[2] (matches this row)
         {"name":"2MG","characterClass":"Monster","level":38,"crewName":"Razor Pack","globalRank":3}
LINKS INSIDE (RESOLVED)
  link   Click → #/profile/2MG      <a> "2MG" — in item 3 of 100
  link   Click → #/crew?crewName=Razor%20Pack

WHAT HAPPENS NEXT
  click     follows link → /profile/{player.name}
            resolves right now to #/profile/2MG
  page      route /profile/:nickname → ProfilePageComponent
  guard     guard authGuard runs first (redirects to / if it blocks)
  endpoint  ProfilePageComponent.ngOnInit() → GET /get-user-by-username?username=${username},
                                               GET /get-all-active-skills?userName=${playerName}
  call      ProfilePageComponent.ngOnInit() calls PlayerProfileServiceService.getUserByUsernameOverview()

WHAT THIS DOES
  Clicking navigates to /profile/{player.name} (template: '/profile/' + player.name).
  Resolved for this element right now: #/profile/2MG, #/crew?crewName=Razor%20Pack.
```

### Hovering a logout button

```
WILL CALL (FROM SOURCE)
  click  logout()            pages/app.component.html:255
  POST /auth/logout          body: { refreshToken }

WHAT HAPPENS NEXT
  click     click → AppComponent.logout()
  call      calls AuthService.logout()
  endpoint  POST /auth/logout   body { refreshToken }
  state     updates state: connectedNotificationUser, outwarXsession
```

### Hovering a table (the data provenance chain)

```
WHERE THIS DATA COMES FROM
  high  Renders 100 row(s)          tbody.text-sm.text-gray-100
  high  Data source: RankingPageComponent.players (getter, 100 items)
  high  Derived from RankingPageComponent.players()
  high  via RankingService.getPlayers()
  high  Written by RankingService.loadRankings() (line 54)
  high  GET /get-ranking            body { params }
  high  Matches response GET /get-ranking?page=1&pageSize=100 (body.users) · 100 items · 91 ms
```

Plus, for anything you actually click: the recorded request/response, its payload, inferred TypeScript shape, **where each payload field came from** (identity-matched against component/service state), and which template handler ran (`() => ctx.logout($event)`).

---

## 🚀 Quick start

### Script tag (one-liner, any stack)

```html
<script src="node_modules/ui-debug-inspector/dist/global.js" data-auto></script>
```

`data-auto` installs immediately; `data-index="/debug-index.json"` also loads a code index. Prefer explicit? `installUiDebugInspector()` is on `window`. Minified build: `dist/global.min.js`.

### React

```tsx
import { UiDebugInspector } from 'ui-debug-inspector/react';

createRoot(el).render(
  <>
    <App />
    <UiDebugInspector indexUrl="/debug-index.json" /> {/* renders nothing, just installs */}
  </>,
);
```

Hook flavour: `useUiDebugInspector()` inside any component. Imperative: `installReactUiDebugInspector()`.

### Angular

```ts
// app.config.ts — standalone bootstrap
import { provideUiDebugInspector, uiDebugHttpInterceptor } from 'ui-debug-inspector/angular';
import { environment } from './environments/environment';

export const appConfig: ApplicationConfig = {
  providers: [
    provideHttpClient(withInterceptors([correlationIdInterceptor, authInterceptor, uiDebugHttpInterceptor()])),
    ...(environment.production ? [] : [provideUiDebugInspector({ indexUrl: '/debug-index.json' })]),
  ],
};
```

Component flavour (drop it in your root template):

```html
<ui-debug-inspector [options]="{ indexUrl: '/debug-index.json' }" />
```

### Anything else (Vue, Svelte, Lit, plain JS)

```js
import { installUiDebugInspector } from 'ui-debug-inspector';
installUiDebugInspector();               // auto-detects the adapter
```

---

## 🧠 How it works

```
                 ┌──────────────────────── you hover an element ────────────────────────┐
                 │                                                                     │
   DOM ──▶ framework adapter ──▶ ComponentSnapshot ──┐                                │
   (element, ancestors, links)   (props, state, arrays, children)                     │
                                                     ▼                                │
   runtime recorder ──▶ ring buffer of calls ──▶ attribution ──▶ panel tabs ◀─────────┘
   (XHR, fetch, HttpClient,    (stack + payload +     (dom / handler /
    SignalR, Electron IPC)      zone cause)            endpoint / weak)
                                                     ▲
   static code index ──▶ template bindings, call chains, endpoints, routes
```

| Piece | What it does |
| --- | --- |
| 🎯 **Adapters** | `AngularAdapter` (`ng.getComponent` + `__ngContext__`), `ReactAdapter` (fiber tree: props + hook state), `DomAdapter` (fallback, `data-component` aware). The core only talks to the adapter interface. |
| 📡 **Recorder** | Patches `XMLHttpRequest`, `fetch`, `HttpClient.prototype.request`, SignalR hub methods and the Electron preload bridge at install time; keeps a ring buffer with stacks, payloads and responses. |
| ⚡ **Zone causality** | Tags the Zone.js task of each DOM event, so a request fired inside a click handler is attributed to *that* element — including the real handler source. Without Zone.js it falls back to short-lived event attribution. |
| 🧩 **Static code index** | Optional. `ui-debug-index-angular` AST-parses your components/services: template bindings (`(click)`, `[routerLink]`), call chains through injected services, endpoints + bodies, state writes, getters, `return this.x` links, localStorage access and the route table. This is what makes prediction work *before* a click. |
| 🖼️ **Panel** | Plain DOM inside a **shadow root** — styled in isolation, no CSS leakage, no framework rendering, draggable/resizable. |

### Attribution is always honest

Every link between an element and a call is labelled:

| Label | Meaning |
| --- | --- |
| `caused by this element` | the call ran inside a DOM event whose target is this element (strongest) |
| `handler match` | the running handler matches the indexed template binding |
| `predicted endpoint` | the URL matches an endpoint the indexed handler is known to call |
| `shared service (weak)` | only a shared service class appears in the stack |

Unrelated traffic is quarantined in a collapsed *“Background traffic, unrelated”* list — the panel never mixes it into the answer.

---

## 🗂️ Tabs

| Tab | Answers |
| --- | --- |
| **Calls** | *Will call (from source)* — endpoints, function chain or router destination predicted before any click (and where the binding was found if it lives on an inner element). *Confirmed this session* — calls actually attributed to this element. `Arm capture` records the next real click for 3 s. |
| **Payload** | Request body, query params, inferred TS shape, secrets masked headers, and **where each field came from** (reference-matched against component/service state). Shows the payload the source *will* send while nothing is recorded yet. |
| **What it is** | *This exact element* (row/item identity, resolved links, clickables), *What happens next* (click → method → service → endpoint → state → route → target page calls), the plain-language description (JSDoc or derived), role/wiring, indexed methods, handlers actually executed. |
| **How filled** | Provenance chain for rendered rows: `rows → bound array/prop/hook → service signal → writing method → endpoint → matching response`. |
| **Data** | Props/inputs/outputs, live state and hook values, services listed separately (never JSON-dumped), per-field provenance notes, expandable values. |

---

## ⚙️ Options

```ts
installUiDebugInspector({
  index: debugIndexJson,      // pre-loaded code index
  indexUrl: '/debug-index.json',
  framework: 'auto',          // 'angular' | 'react' | 'dom' | 'auto'
  startEnabled: true,         // default: true unless disabled in localStorage
  exposeGlobal: true,         // window.uiDebug for console poking
  hoverDwellMs: 420,          // Ctrl+hover time before the panel pins
  armWindowMs: 3000,          // "Arm capture" window
  maxCalls: 300,              // recorder ring buffer size
});
```

Console handle: `uiDebug.setTab('fill')`, `uiDebug.calls`, `uiDebug.calledCalls?.()`, `uiDebug.recorder.getCalls()`, `uiDebug.toggleEnabled(false)`.
Disable auto-start: `localStorage['ui-debug-inspector-disabled'] = '1'`.

---

## 🧾 Code index (optional, Angular only today)

```bash
npx ui-debug-index-angular --src src/app --routes src/app/app.routes.ts --out src/debug-index.json
```

Then either serve it (`ui-debug-inspector/dist/global.js` + `data-index`, or `indexUrl` in React/Angular) or inline the JSON (`installUiDebugInspector({ index })`).

Without an index everything still works — the panel just cannot predict calls before they happen, and says so.

---

## ⌨️ Hotkeys

| Keys | Action |
| --- | --- |
| `Ctrl+Shift+D` | toggle the inspector |
| `Ctrl` + hover | highlight, then pin after ~0.4 s |
| `Ctrl` + click | pin instantly (the click is swallowed, nothing is triggered) |
| `✕` / `Esc` | close the panel |
| drag header / corner | move / resize (hover is ignored underneath the panel) |

---

## 🧪 Local development

```bash
npm install
npm run build          # tsc -> dist (ESM + types) + dist/global.js (IIFE)
node dev/serve.mjs     # http://localhost:4321/dev/harness.html
                       #  …/dev/harness-global.html   (script-tag one-liner)
                       #  …/dev/harness-react.html    (React fiber adapter)
                       #  …/dev/harness-angular.html  (Angular adapter, window.ng mocked)
```

The harnesses are plain HTML pages (one React via import map) used to verify the panel without an app.

---

## ⚠️ Limitations (deliberate, not hidden)

- **Prod builds:** `ng.getComponent`/`ng.getDirectives` only exist in Angular dev builds; React fiber reading works in prod but hook names are lost (state is `state #1`, `state #2`, …). Without dev APIs the panel degrades to DOM + recorded calls and says so.
- **Static prediction** needs the code index and only understands direct patterns (`this.service.method()`, `this.http.get(...)`, `this.localHelper()`); dynamic URLs (`${endpoint.path}`) and indirect service aliases are shown as-is.
- **Payload origins** are found by reference identity plus name heuristics — labelled `high`/`medium`/`low`, never asserted.
- **No React code index yet** (JSX AST scan) — roadmap. Runtime props/hook introspection already works.
- Hover is ignored under the panel itself (it is fixed-position; drag it away or close it).

---

## 🗺️ Roadmap

- [ ] `ui-debug-index-react` (JSX AST scan) for pre-click endpoint prediction in React
- [ ] Vue and Svelte adapters (devtools hooks instead of fibers)
- [ ] Timeline view of calls per interaction
- [ ] Export a session (calls + element + chain) as JSON/Markdown for bug reports

---

<div align="center">

**MIT** · built for people who are tired of guessing which button hit which endpoint.

</div>
