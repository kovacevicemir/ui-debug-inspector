/**
 * The overlay itself: plain DOM inside a shadow root.
 *
 * Framework-neutral by construction — nothing here imports Angular, React or a
 * template compiler. The panel is a dumb renderer over `store.getView()`.
 */
import { InspectorStore, InspectorView } from './store.js';
import { PANEL_CSS } from './panel-css.js';
import { DebugCall } from './types.js';
import { ArrayFillMatch } from '../analysis/payload-tracer.js';
import { payloadOf, findPayloadOrigins, jsonToTs } from '../analysis/payload-tracer.js';
import { safeStringify, shortFrame, msLabel, timeLabel, elSummary } from './util.js';
import { IndexedClass } from '../analysis/code-index.js';

const TABS: { id: InspectorView['tab']; label: string }[] = [
  { id: 'calls', label: 'Calls' },
  { id: 'payload', label: 'Payload' },
  { id: 'summary', label: 'What it is' },
  { id: 'fill', label: 'How filled' },
  { id: 'data', label: 'Data' },
];

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function json(value: unknown): string {
  return esc(safeStringify(value, 6000, 2));
}

export function mountInspectorPanel(store: InspectorStore): () => void {
  const host = document.createElement('div');
  host.setAttribute('data-ui-debug-panel', '');
  host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = PANEL_CSS;
  const root = document.createElement('div');
  root.className = 'ui-debug-root';
  shadow.append(style, root);
  document.body.appendChild(host);

  const position = { x: Math.max(16, window.innerWidth - 640), y: 72 };
  const size = { w: 620, h: 470 };
  let selectedCallId: number | null = null;
  let selectedProp: string | null = null;

  const render = () => {
    const view = store.getView();
    const body = root.querySelector('.ui-debug-body');
    const scrollTop = body ? body.scrollTop : 0;
    root.innerHTML = view.visible ? renderPanel(view) : '';
    const nextBody = root.querySelector('.ui-debug-body');
    if (nextBody) nextBody.scrollTop = scrollTop;
  };

  const renderPanel = (view: InspectorView): string => {
    const panel = document.createElement('div'); // width/height via style below
    void panel;
    return `
      <div class="ui-debug-panel" style="left:${position.x}px;top:${position.y}px;width:${size.w}px;height:${size.h}px">
        <header class="ui-debug-header" data-drag="move">
          <div class="headline">
            <span class="dot ${view.enabled ? 'on' : ''}"></span>
            <strong>${esc(view.targetLabel || 'Nothing pinned')}</strong>
            <span class="tag">${esc(view.framework)}</span>
            ${
              view.predicted
                ? `<span class="tag ok">${esc(
                    view.predicted.entry.kind === 'link'
                      ? 'link'
                      : `${view.predicted.entry.event}:${view.predicted.entry.handlers[0] || view.predicted.entry.expression}`,
                  )}</span>`
                : ''
            }
            ${
              view.predicted && view.predictedLocation
                ? `<span class="tag">inner ${esc(view.predictedLocation)}</span>`
                : view.predicted
                  ? `<span class="tag ${view.predicted.confidence !== 'high' ? 'warn' : ''}">${esc(view.predicted.confidence)} confidence</span>`
                  : ''
            }
            ${view.armed ? '<span class="tag warn">capturing</span>' : ''}
          </div>
          <button class="icon" title="Close (Esc)" data-action="close">✕</button>
        </header>
        <nav class="ui-debug-tabs">
          ${TABS.map(
            (tab) => `<button class="${view.tab === tab.id ? 'active' : ''}" data-tab="${tab.id}">${tab.label}</button>`,
          ).join('')}
        </nav>
        <div class="ui-debug-body">${renderTab(view)}</div>
        ${view.hint ? `<div class="ui-debug-hint">${esc(view.hint)}</div>` : ''}
        <div class="ui-debug-resize" data-drag="resize" title="Resize"></div>
      </div>`;
  };

  const renderTab = (view: InspectorView): string => {
    switch (view.tab) {
      case 'calls':
        return renderCalls(view);
      case 'payload':
        return renderPayload(view);
      case 'summary':
        return renderSummary(view);
      case 'fill':
        return renderFill(view);
      case 'data':
        return renderData(view);
      default:
        return '';
    }
  };

  // ── Calls ───────────────────────────────────────────────────────────────
  const renderCalls = (view: InspectorView): string => {
    const indexNote =
      view.indexStatus === 'missing'
        ? `<p class="empty">Static code index missing — run <code>ui-debug-index-angular</code> to get predicted endpoints.</p>`
        : view.indexStatus === 'loading'
          ? '<p class="empty">Loading code index…</p>'
          : '';

    const predicted = view.predicted
      ? `<div class="call predicted">
          <div class="call-head">
            <span class="tag ok">${esc(view.predicted.entry.kind === 'link' ? 'link' : view.predicted.entry.event)}</span>
            <code>${esc(view.predicted.entry.expression)}</code>
            <span class="muted">${esc(view.record?.file ?? '')}${view.record ? `:${view.predicted.entry.line}` : ''}</span>
          </div>
          ${
            view.predictedLocation
              ? `<div class="call-meta"><span class="tag">found on ${esc(view.predictedLocation)}</span><span class="muted">the hovered node has no binding — this inner element is what acts</span></div>`
              : ''
          }
          ${
            view.predictedLinks.length
              ? view.predictedLinks
                  .map(
                    (link) =>
                      `<div class="endpoint"><span class="tag ok">navigate</span><code class="path">${esc(link.label)}</code><span class="muted">${esc(link.detail)}</span></div>`,
                  )
                  .join('')
              : ''
          }
          ${
            view.predictedEndpoints.length === 0 && view.predictedLinks.length === 0
              ? `<p class="empty">No HTTP call or navigation reachable from this handler — local state only.${
                  view.predicted.entry.handlers.length ? ` Chain: ${esc(view.predicted.entry.handlers.join(', '))}` : ''
                }</p>`
              : ''
          }
          ${view.predictedEndpoints
            .map(
              (endpoint) =>
                `<div class="endpoint"><span class="method">${esc(endpoint.method)}</span><code class="path">${esc(endpoint.path)}</code>${
                  endpoint.body ? `<span class="muted">body: ${esc(endpoint.body)}</span>` : ''
                }</div>`,
            )
            .join('')}
          ${
            view.handlerChain.length
              ? `<details open><summary>call chain</summary>${view.handlerChain
                  .map((step) => `<div class="chain-step">${esc(step)}</div>`)
                  .join('')}</details>`
              : ''
          }
        </div>`
      : `<p class="empty">No template binding matched this element or anything inside it. Hover the actual control, or use “Arm capture” below to see what a real click triggers.</p>`;

    return `
      ${indexNote}
      <h4>Will call (from source)</h4>
      ${predicted}
      <div class="toolbar">
        <button class="primary ${view.armed ? 'armed' : ''}" data-action="arm">${view.armed ? 'CAPTURING — click the element now' : 'Arm capture (3 s)'}</button>
        <button data-action="clear">Clear recorded</button>
        <span class="muted">${view.recentCalls.length} calls recorded</span>
      </div>
      <h4>Confirmed this session (${view.causedCalls.length})</h4>
      ${
        view.causedCalls.length === 0
          ? '<p class="empty">Nothing observed yet. Ctrl+click the element (safe, blocked) or “Arm capture”, then click it for real.</p>'
          : view.causedCalls.map((call) => renderCall(store, call)).join('')
      }
      ${
        view.armedCalls.length
          ? `<h4>Captured while armed (${view.armedCalls.length})</h4>${view.armedCalls.map((call) => renderCall(store, call, true)).join('')}`
          : ''
      }
      ${
        view.relatedCalls.length
          ? `<details><summary>Related (weak — same service in stack) (${view.relatedCalls.length})</summary>${view.relatedCalls
              .map((call) => renderCompactCall(store, call))
              .join('')}</details>`
          : ''
      }
      ${
        view.unattributedCalls.length
          ? `<details><summary>Background traffic, unrelated (${view.unattributedCalls.length})</summary>${view.unattributedCalls
              .map((call) => renderCompactCall(store, call))
              .join('')}</details>`
          : ''
      }`;
  };

  const renderCall = (view: InspectorStore, call: DebugCall, compact = false): string => {
    const attribution = view.attributionOf(call);
    const stack = call.stack.map(shortFrame).filter((frame) => !/chunk-|\.angular\/cache|node_modules/.test(frame)).slice(0, 12);
    return `<div class="call" data-call="${call.id}">
      <div class="call-head">
        <span class="method">${esc(call.method)}</span>
        <span class="path">${esc(pathOf(call))}</span>
        <span class="status ${statusClass(call)}">${esc(call.status ?? '…')}</span>
        <span class="muted">${msLabel(call.durationMs)}</span>
        ${attribution ? `<span class="tag ok">${esc(attributionLabel(attribution))}</span>` : ''}
      </div>
      ${
        compact
          ? ''
          : `<div class="call-meta">
              ${call.cause.eventName ? `<span class="tag">on ${esc(call.cause.eventName)}${call.cause.stale ? ' (async)' : ''}</span>` : ''}
              ${call.cause.element ? `<span class="muted">target ${esc(call.cause.element)}</span>` : ''}
              ${call.componentHint ? `<span class="tag">${esc(call.componentHint)}</span>` : ''}
              <span class="muted">${timeLabel(call.startedAt)}</span>
            </div>
            ${call.cause.handlerSource ? `<pre class="code inline">${esc(call.cause.handlerSource)}</pre>` : ''}
            ${stack.length ? `<details><summary>stack (${stack.length} frames)</summary><pre class="code">${stack.map((frame) => `<div>${esc(frame)}</div>`).join('')}</pre></details>` : ''}`
      }
    </div>`;
  };

  const renderCompactCall = (view: InspectorStore, call: DebugCall): string =>
    `<div class="call compact" data-call="${call.id}">
      <span class="method">${esc(call.method)}</span>
      <span class="path">${esc(pathOf(call))}</span>
      <span class="status ${statusClass(call)}">${esc(call.status ?? '…')}</span>
      <span class="muted">${msLabel(call.durationMs)}</span>
      ${view.attributionOf(call) ? '' : ''}
    </div>`;

  // ── Payload ─────────────────────────────────────────────────────────────
  const renderPayload = (view: InspectorView): string => {
    const call = view.causedCalls.find((entry) => entry.id === selectedCallId) ?? null;
    if (call) {
      const origins = view.snapshot ? findPayloadOrigins(payloadOf(call), view.snapshot) : [];
      const params = Object.entries(call.http?.params ?? {});
      const headers = Object.entries(call.http?.headers ?? {});
      return `
        <div class="payload-head">
          <span class="method">${esc(call.method)}</span>
          <code class="path">${esc(call.url)}</code>
          <span class="status ${statusClass(call)}">${esc(call.status ?? '…')}</span>
          <button class="icon" title="Copy payload JSON" data-action="copy-payload" data-call="${call.id}">⧉</button>
        </div>
        ${params.length ? `<h4>Query params</h4><table class="grid">${params.map(([key, value]) => `<tr><td class="name">${esc(key)}</td><td class="preview">${esc(value)}</td></tr>`).join('')}</table>` : ''}
        <h4>Request body (sent)</h4>
        <pre class="code">${json(payloadOf(call))}</pre>
        <p class="muted">TypeScript shape inferred at runtime:</p>
        <pre class="code">${esc(jsonToTs(payloadOf(call), 'Payload'))}</pre>
        <h4>Where this payload came from</h4>
        ${
          origins.length === 0
            ? '<p class="empty">No field matched component/service state by identity — it is built inline in the service.</p>'
            : `<table class="grid">${origins
                .map(
                  (origin) =>
                    `<tr><td class="name">${esc(origin.path)}</td><td class="kind"><span class="tag ${origin.confidence === 'high' ? 'ok' : ''}">${esc(origin.confidence)}</span></td><td class="preview">${esc(origin.origin)}</td></tr>`,
                )
                .join('')}</table>`
        }
        ${
          headers.length
            ? `<details><summary>Request headers (secrets masked)</summary><table class="grid">${headers
                .map(([key, value]) => `<tr><td class="name">${esc(key)}</td><td class="preview">${esc(value)}</td></tr>`)
                .join('')}</table></details>`
            : ''
        }
        <h4>Response</h4>
        ${call.responseBody !== undefined ? `<pre class="code">${esc(jsonToTs(call.responseBody, 'Response', 1))}</pre>` : ''}
        <details><summary>Raw response</summary><pre class="code">${json(call.responseBody ?? call.responseText)}</pre></details>
        <h4>Who sent it (stack)</h4>
        <pre class="code">${call.stack
          .map(shortFrame)
          .filter((frame) => !/chunk-|node_modules/.test(frame))
          .slice(0, 12)
          .map((frame) => `<div>${esc(frame)}</div>`)
          .join('')}</pre>`;
    }

    if (view.predictedEndpoints.length || view.predictedLinks.length) {
      return `
        <h4>Expected payload (from source, nothing sent yet)</h4>
        ${view.predictedEndpoints
          .map(
            (endpoint) => `<div class="call predicted">
              <div class="call-head"><code class="path">${esc(`${endpoint.method} ${endpoint.path}`)}</code></div>
              <div class="call-meta"><span class="muted">${esc(view.predicted?.entry.handlers.join(', ') ?? '')}${
                endpoint.source ? ` → ${esc(endpoint.source)}` : ''
              }</span></div>
              ${endpoint.body ? `<pre class="code">body = ${esc(endpoint.body)}</pre>` : '<p class="empty">No request body — path/query params only.</p>'}
            </div>`,
          )
          .join('')}
        ${view.predictedLinks
          .map((link) => `<div class="call predicted"><div class="call-head"><code class="path">${esc(link.label)}</code></div><div class="call-meta"><span class="muted">${esc(link.detail)}</span></div></div>`)
          .join('')}
        <p class="muted">Ctrl+click the element (blocked, safe) or use “Arm capture” to see the real payload with values.</p>`;
    }
    return '<p class="empty">Nothing selected and no endpoint predicted for this element. Open the Calls tab.</p>';
  };

  // ── What it is ──────────────────────────────────────────────────────────
  const renderSummary = (view: InspectorView): string => `
    <h4>This exact element</h4>
    <ul class="list"><li class="description">${esc(view.hoveredSummary)}</li></ul>
    ${renderChainList(view.rowIdentity)}
    ${
      view.linkActions.length
        ? `<h4>Links inside (resolved)</h4>${view.linkActions
            .map(
              (action) =>
                `<div class="endpoint"><span class="tag ok">link</span><code class="path">${esc(action.label)}</code>${
                  action.detail ? `<span class="muted">${esc(action.detail)}</span>` : ''
                }</div>`,
            )
            .join('')}`
        : ''
    }
    ${
      view.clickableActions.length
        ? `<h4>Clickables inside (no href)</h4>${view.clickableActions
            .map(
              (action) =>
                `<div class="endpoint"><span class="tag">${esc(action.confidence)}</span>${esc(action.label)}<span class="muted">${esc(action.detail ?? '')}</span></div>`,
            )
            .join('')}`
        : ''
    }
    <h4>What happens next</h4>
    ${
      view.nextSteps.length === 0
        ? '<p class="empty">No effect found: no handler, no router link, no endpoint reachable from this element.</p>'
        : `<ol class="chain-list">${view.nextSteps
            .map(
              (step) =>
                `<li><span class="tag step-${esc(step.kind)}">${esc(step.kind)}</span><span class="chain-label">${esc(step.label)}</span>${
                  step.detail ? `<div class="muted chain-detail">${esc(step.detail)}</div>` : ''
                }</li>`,
            )
            .join('')}</ol>`
    }
    <h4>What this does</h4>
    ${
      view.handlerDescription.length === 0
        ? '<p class="empty">No template handler matched — it is probably a passive/display element.</p>'
        : `<ul class="list description">${view.handlerDescription.map((line) => `<li>${esc(line)}</li>`).join('')}</ul>`
    }
    <h4>Role &amp; wiring (from source)</h4>
    <ul class="list">${view.summaryLines.map((line) => `<li>${esc(line)}</li>`).join('')}</ul>
    ${
      view.record
        ? `<h4>Methods on ${esc(view.record.selector || 'component')}</h4>
           <table class="grid">${view.recordMethods
             .map(
               (method) =>
                 `<tr><td class="name">${esc(method.name)}</td><td class="kind"><span class="tag">${method.line}</span></td><td class="preview">${
                   method.doc ? `<div>${esc(method.doc)}</div>` : ''
                 }<div>${esc(method.endpoints.length ? method.endpoints.join(' · ') : '—')}</div></td></tr>`,
             )
             .join('')}</table>`
        : ''
    }
    ${
      view.handlerEntries.length
        ? `<h4>Handlers actually executed here</h4>${view.handlerEntries
            .map(
              (entry) =>
                `<div class="handler"><div class="call-meta"><span class="tag ok">on ${esc(entry.eventName)}</span><span class="muted">${timeLabel(
                  entry.at,
                )}</span></div>${entry.handlerSource ? `<pre class="code inline">${esc(entry.handlerSource)}</pre>` : ''}</div>`,
            )
            .join('')}`
        : ''
    }`;

  // ── How filled ──────────────────────────────────────────────────────────
  const renderFill = (view: InspectorView): string => {
    const fill = view.fill;
    if (!fill) return '<p class="empty">No target pinned.</p>';
    return `
      <h4>Where this data comes from</h4>
      ${
        view.dataChain.length === 0
          ? '<p class="empty">Nothing rendered here yet — no rows to trace.</p>'
          : renderChainList(view.dataChain)
      }
      <h4>Container</h4>
      <dl class="kv"><dt>Element</dt><dd>${esc(fill.container)}</dd><dt>Rows</dt><dd>${fill.rowCount} <span class="muted">(${esc(fill.rowSelector)})</span></dd></dl>
      <h4>Response → array matches (heuristic)</h4>
      ${
        view.arrayFills.length === 0
          ? '<p class="empty">No recorded response matches the component arrays by shape/length.</p>'
          : `<ul class="list">${view.arrayFills
              .map(
                (match: ArrayFillMatch) =>
                  `<li><span class="tag ${match.confidence === 'high' ? 'ok' : 'warn'}">${esc(match.confidence)}</span><code>${esc(
                    match.endpoint,
                  )}</code> → <code>${esc(match.propName)}</code> <span class="muted">(${match.matchedItems} items)</span></li>`,
              )
              .join('')}</ul>`
      }
      ${fill.notes.length ? `<h4>Notes</h4><ul class="list">${fill.notes.map((note) => `<li>${esc(note)}</li>`).join('')}</ul>` : ''}`;
  };

  // ── Data ────────────────────────────────────────────────────────────────
  const renderData = (view: InspectorView): string => {
    const snapshot = view.snapshot;
    if (!snapshot) return '<p class="empty">No target pinned.</p>';
    const { state, services } = store.propNotes(snapshot);
    const propRow = (prop: (typeof state)[number]) => {
      const notes =
        prop.kind !== 'service' && Array.isArray(prop.raw)
          ? store.describeField(prop.name).map((note) => `<div class="muted provenance">${esc(note)}</div>`).join('')
          : '';
      const expandable = prop.raw !== undefined && (Array.isArray(prop.raw) || (prop.raw && typeof prop.raw === 'object'));
      return `<tr>
        <td class="name">${esc(prop.name)}</td>
        <td class="kind"><span class="tag">${esc(prop.kind)}</span></td>
        <td class="preview">${esc(prop.type)} — ${esc(prop.preview)}${notes}
          ${expandable ? `<button class="icon" data-prop="${esc(prop.name)}">${selectedProp === prop.name ? '▾' : '▸'}</button>` : ''}
          ${selectedProp === prop.name ? `<pre class="code">${json(prop.raw)}</pre>` : ''}
        </td>
      </tr>`;
    };
    return `
      ${snapshot.file ? `<p class="muted">${esc(snapshot.file)}</p>` : ''}
      ${snapshot.inputs.length ? `<h4>${snapshot.framework === 'react' ? 'Props' : '@Inputs'}</h4><table class="grid">${snapshot.inputs.map((input) => `<tr><td class="name">${esc(input.name)}</td><td class="preview">${esc(input.value)}</td></tr>`).join('')}</table>` : ''}
      ${snapshot.outputs.length ? `<h4>${snapshot.framework === 'react' ? 'Handlers' : '@Outputs'}</h4><table class="grid">${snapshot.outputs.map((output) => `<tr><td class="preview" colspan="2">${esc(output)}</td></tr>`).join('')}</table>` : ''}
      <h4>State (${state.length})</h4>
      <table class="grid">${state.map(propRow).join('')}</table>
      ${services.length ? `<h4>Services / refs (${services.length})</h4><ul class="list">${services.map((prop) => `<li><code>${esc(prop.name)}</code> <span class="muted">${esc(prop.type)}</span></li>`).join('')}</ul>` : ''}
      ${snapshot.children.length ? `<h4>Components in this subtree</h4><ul class="list">${snapshot.children.map((child) => `<li><code>${esc(child.name)}</code> <span class="muted">on ${esc(child.on)}</span></li>`).join('')}</ul>` : ''}`;
  };

  const renderChainList = (steps: { label: string; detail?: string; confidence: 'high' | 'medium' | 'low' }[]): string => {
    if (!steps.length) return '';
    return `<ol class="chain-list">${steps
      .map(
        (step) =>
          `<li><span class="tag ${step.confidence === 'high' ? 'ok' : step.confidence === 'medium' ? 'warn' : ''}">${esc(step.confidence)}</span><span class="chain-label">${esc(
            step.label,
          )}</span>${step.detail ? `<div class="muted chain-detail">${esc(step.detail)}</div>` : ''}</li>`,
      )
      .join('')}</ol>`;
  };

  // ── interaction ─────────────────────────────────────────────────────────
  shadow.addEventListener('click', (event) => {
    const target = event.target as Element | null;
    if (!target) return;
    const tab = target.closest('[data-tab]') as HTMLElement | null;
    if (tab?.dataset['tab']) {
      store.setTab(tab.dataset['tab'] as InspectorView['tab']);
      return;
    }
    const action = target.closest('[data-action]') as HTMLElement | null;
    const actionName = action?.dataset['action'];
    if (actionName === 'close') {
      selectedCallId = null;
      store.close();
      return;
    }
    if (actionName === 'arm') {
      store.armCapture();
      return;
    }
    if (actionName === 'clear') {
      store.clearCalls();
      return;
    }
    if (actionName === 'copy-payload') {
      const call = store.calls.find((entry) => String(entry.id) === action?.dataset['call']);
      if (call) {
        void navigator.clipboard?.writeText(safeStringify(payloadOf(call), 20000, 2));
        store.setHint('Copied payload JSON');
      }
      return;
    }
    const prop = target.closest('[data-prop]') as HTMLElement | null;
    if (prop?.dataset['prop']) {
      selectedProp = selectedProp === prop.dataset['prop'] ? null : (prop.dataset['prop'] ?? null);
      render();
      return;
    }
    const callRow = target.closest('[data-call]') as HTMLElement | null;
    if (callRow?.dataset['call']) {
      selectedCallId = Number(callRow.dataset['call']);
      store.setTab('payload');
    }
  });

  let drag: { mode: 'move' | 'resize'; startX: number; startY: number; x: number; y: number; w: number; h: number } | null =
    null;
  shadow.addEventListener('mousedown', (rawEvent: Event) => {
    const event = rawEvent as MouseEvent;
    const target = event.target as Element | null;
    const handle = target?.closest('[data-drag]') as HTMLElement | null;
    if (!handle) return;
    if (handle.dataset['drag'] === 'move' && (event.target as Element).closest('[data-action]')) return;
    event.preventDefault();
    drag = {
      mode: handle.dataset['drag'] === 'resize' ? 'resize' : 'move',
      startX: event.clientX,
      startY: event.clientY,
      x: position.x,
      y: position.y,
      w: size.w,
      h: size.h,
    };
  });
  const onMove = (event: MouseEvent) => {
    if (!drag) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (drag.mode === 'move') {
      position.x = Math.max(0, drag.x + dx);
      position.y = Math.max(0, drag.y + dy);
    } else {
      size.w = Math.max(380, drag.w + dx);
      size.h = Math.max(240, drag.h + dy);
    }
    const panel = root.querySelector('.ui-debug-panel') as HTMLElement | null;
    if (panel) {
      panel.style.left = `${position.x}px`;
      panel.style.top = `${position.y}px`;
      panel.style.width = `${size.w}px`;
      panel.style.height = `${size.h}px`;
    }
  };
  const onUp = () => {
    drag = null;
  };
  window.addEventListener('mousemove', onMove, true);
  window.addEventListener('mouseup', onUp, true);

  const unsubscribe = store.subscribe(render);
  render();

  return () => {
    unsubscribe();
    window.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('mouseup', onUp, true);
    host.remove();
  };
}

function pathOf(call: DebugCall): string {
  try {
    return new URL(call.url, location.origin).pathname + (new URL(call.url, location.origin).search || '');
  } catch {
    return call.url;
  }
}

function statusClass(call: DebugCall): string {
  if (call.error) return 'err';
  if (call.status === undefined) return 'pending';
  if (call.status >= 400) return 'err';
  if (call.status >= 300) return 'warn';
  return 'ok';
}

function attributionLabel(attribution: string): string {
  switch (attribution) {
    case 'dom':
      return 'caused by this element';
    case 'handler':
      return 'handler match';
    case 'endpoint':
      return 'predicted endpoint';
    case 'service':
      return 'shared service (weak)';
    default:
      return attribution;
  }
}

export { elSummary, IndexedClass };
