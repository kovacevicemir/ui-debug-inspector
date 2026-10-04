/** Small formatting helpers shared by the debug inspector. */

const SKIP_PROPS = new Set([
  'constructor',
  '__proto__',
  '__ngContext__',
  'ngOnChanges',
  'ngOnInit',
  'ngDoCheck',
  'ngAfterContentInit',
  'ngAfterContentChecked',
  'ngAfterViewInit',
  'ngAfterViewChecked',
  'ngOnDestroy',
]);

export function isSkippedProp(name: string): boolean {
  return SKIP_PROPS.has(name) || name.startsWith('ɵ');
}

export function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

/** `button#id.a.b` style short element description. */
export function elSummary(el: Element | null | undefined): string {
  if (!el) return '(no element)';
  const tag = el.tagName ? el.tagName.toLowerCase() : '?';
  const id = el.id ? `#${el.id}` : '';
  const cls =
    typeof el.className === 'string' && el.className
      ? `.${el.className.trim().split(/\s+/).slice(0, 4).join('.')}`
      : '';
  return `${tag}${id}${cls}`;
}

export function elPreview(el: Element | null | undefined, max = 40): string {
  const text = (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
  return text ? `"${truncate(text, max)}"` : '';
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Bounded JSON stringify that survives circular structures and huge payloads. */
export function safeStringify(value: unknown, maxLen = 8000, indent = 2): string {
  const seen = new WeakSet<object>();
  let out: string;
  try {
    out = JSON.stringify(
      value,
      (_key, val) => {
        if (typeof val === 'bigint') return `${val.toString()}n`;
        if (typeof val === 'function') return `[Function ${val.name || 'anonymous'}]`;
        if (val instanceof Element) return `[Element ${elSummary(val)}]`;
        if (val && typeof val === 'object') {
          if (seen.has(val as object)) return '[Circular]';
          seen.add(val as object);
        }
        return val;
      },
      indent,
    ) ?? String(value);
  } catch (err) {
    out = `(unserializable: ${err instanceof Error ? err.message : String(err)})`;
  }
  return truncate(out, maxLen);
}

/** Capture a cleaned stack trace (drops the Error line and this helper's own frames). */
export function captureStack(skip = 3, limit = 40): string[] {
  const stack = new Error().stack;
  if (!stack) return [];
  const lines = stack
    .split('\n')
    .slice(1)
    .map((line) => line.trim().replace(/^at\s+/, ''))
    .filter((line) => line.length > 0);
  return lines.slice(skip, skip + limit);
}

/** Best-effort class name for a stack trace (first frame that looks like an app class). */
export function guessClassFromStack(stack: string[]): string | undefined {
  for (const frame of stack) {
    const fnMatch = /^([A-Z][A-Za-z0-9_$]*)\.([A-Za-z0-9_$]+)\s*\(/.exec(frame);
    if (fnMatch) return fnMatch[1];
    const fileMatch = /\/([a-z0-9-_.]+)\.(?:service|component|directive|pipe|guard|resolver)\.ts/i.exec(frame);
    if (fileMatch) {
      return fileMatch[1]
        .split(/[-_.]/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join('');
    }
  }
  return undefined;
}

/** Strips the dev-server origin so stacks stay readable in the panel. */
export function shortFrame(frame: string): string {
  return frame
    .replace(/https?:\/\/[^/]+\//g, '')
    .replace(/^\s*at\s+/, '');
}

export function msLabel(ms: number | undefined): string {
  if (ms === undefined || Number.isNaN(ms)) return '—';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

export function timeLabel(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}
