// Generates the static UI-debug index consumed by the inspector overlay.
//
//   npx ui-debug-index-angular --src src/app --routes src/app/app.routes.ts \
//                              --out src/debug-index.json
//
// Defaults: --src src/app  --routes <src>/app.routes.ts  --out src/debug-index.json
//
// Why: the inspector must answer "what does this button call / why" BEFORE any
// click happens. Runtime introspection alone cannot do that (Angular does not
// expose template bindings on DOM nodes), so we resolve it from source:
//
//   element with (click)="logout()"
//     -> AppComponent.logout()
//     -> this.authService.logout()
//     -> AuthService.logout()
//     -> POST /auth/logout  body { refreshToken }
//
// Everything is syntax-only (ts.createSourceFile) to keep it fast.
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

function parseArgs(argv) {
  const args = { src: 'src/app', routes: null, out: 'src/debug-index.json', quiet: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--src' || arg === '-s') args.src = argv[++index];
    else if (arg === '--routes' || arg === '-r') args.routes = argv[++index];
    else if (arg === '--out' || arg === '-o') args.out = argv[++index];
    else if (arg === '--quiet' || arg === '-q') args.quiet = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(
        [
          'ui-debug-index-angular — build the static code index for the UI debug inspector',
          '',
          'Usage: ui-debug-index-angular [--src <dir>] [--routes <file>] [--out <file>] [--quiet]',
          '',
          '  --src    directory to scan for components/services (default: src/app)',
          '  --routes app.routes.ts to parse for link -> page resolution (default: <src>/app.routes.ts)',
          '  --out    output JSON path (default: src/debug-index.json)',
        ].join('\n'),
      );
      process.exit(0);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const appRoot = path.resolve(process.cwd(), args.src);
const routesFile = path.resolve(process.cwd(), args.routes ?? path.join(args.src, 'app.routes.ts'));
const outputPath = path.resolve(process.cwd(), args.out);

if (!fs.existsSync(appRoot)) {
  console.error(`[debug-index] source directory not found: ${appRoot}`);
  process.exit(1);
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'request'];
const SKIP_DIRS = new Set(['generated', 'models', 'node_modules', 'debug']);

/** Strips `environment.baseUrl` / hubUrl so paths read like real endpoints. */
function normalizeUrl(raw) {
  let out = raw.trim();
  out = out.replace(/^[`'"]|[`'"]$/g, '');
  out = out.replace(/\$\{\s*environment\.baseUrl\s*\}/g, '');
  out = out.replace(/\$\{\s*environment\.hubUrl\s*\}/g, '/notification-hub');
  out = out.replace(/environment\.baseUrl\s*\+\s*/g, '');
  out = out.replace(/^['"]|['"]$/g, '');
  out = out.replace(/\$\{([^}]+)\}/g, '${$1}');
  return out || raw;
}

/** Splits a call's argument list, skipping nested strings/templates/brackets. */
function splitArgs(text, openIndex) {
  const args = [];
  let depth = 1;
  let current = '';
  let i = openIndex + 1;
  while (i < text.length && depth > 0) {
    const char = text[i];
    if (char === '`' || char === "'" || char === '"') {
      const quote = char;
      current += char;
      i += 1;
      while (i < text.length) {
        const inner = text[i];
        if (inner === '\\') {
          current += inner + (text[i + 1] ?? '');
          i += 2;
          continue;
        }
        current += inner;
        i += 1;
        if (inner === quote) break;
      }
      continue;
    }
    if (char === '(' || char === '[' || char === '{') depth += 1;
    if (char === ')' || char === ']' || char === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
    if (char === ',' && depth === 1) {
      args.push(current.trim());
      current = '';
      i += 1;
      continue;
    }
    current += char;
    i += 1;
  }
  if (current.trim()) args.push(current.trim());
  return { args, end: i };
}

/** Skips `<T, U>` generics so `this.http.get<Foo>(url)` parses like `this.http.get(url)`. */
function skipGenerics(text, index) {
  if (text[index] !== '<') return index;
  let depth = 0;
  for (let i = index; i < text.length; i += 1) {
    if (text[i] === '<') depth += 1;
    else if (text[i] === '>') {
      depth -= 1;
      if (depth === 0) return i + 1;
    } else if (text[i] === '(' || text[i] === ';' || text[i] === '{') return index;
  }
  return index;
}

function stringLiteralValue(raw) {
  if (!raw) return null;
  return /^(`[^`]*`|'[^']*'|"[^"]*")$/.test(raw.trim()) ? raw.trim() : null;
}

/** Raw calls found in a method body. */
function scanBody(text) {
  const endpoints = [];
  const calls = [];
  const hubCalls = [];

  // Local `const url = \`...\`` aliases so indirect url args still resolve.
  const locals = new Map();
  for (const entry of text.matchAll(/\bconst\s+([\w$]+)\s*=\s*(`[^`]*`|'[^']*'|"[^"]*")\s*;/g)) {
    locals.set(entry[1], entry[2]);
  }

  const callRe = /this\s*\.\s*([\w$]+)\s*\.\s*(get|post|put|patch|delete|head|options|request)\b/g;
  let match;
  while ((match = callRe.exec(text)) !== null) {
    const [full, prop, verb] = match;
    if (!/^(http|httpClient|_http)$/i.test(prop)) continue;

    const cursor = skipGenerics(text, match.index + full.length);
    if (text[cursor] !== '(') continue;
    const { args } = splitArgs(text, cursor);
    if (!args.length) continue;

    let method = verb.toUpperCase();
    let urlArg = args[0];
    let bodyArg = args[1] ?? null;
    if (verb === 'request') {
      method = String(stringLiteralValue(args[0]) ?? args[0]).replace(/[`'"]/g, '').toUpperCase();
      urlArg = args[1];
      bodyArg = args[2] ?? null;
    }

    let urlRaw = stringLiteralValue(urlArg);
    if (!urlRaw && locals.has(urlArg.trim())) urlRaw = locals.get(urlArg.trim());
    if (!urlRaw) continue; // dynamic url we cannot resolve statically

    endpoints.push({
      method,
      path: normalizeUrl(urlRaw),
      body: bodyArg && !/^(undefined|null)$/.test(bodyArg) ? bodyArg.slice(0, 160) : null,
      source: `this.${prop}.${verb}()`,
    });
  }

  const serviceCallRe = /this\s*\.\s*([\w$]+)\s*\.\s*([\w$]+)\s*\(/g;
  while ((match = serviceCallRe.exec(text)) !== null) {
    const [, prop, method] = match;
    if (/^(http|httpClient|_http)$/i.test(prop)) continue;
    if (HTTP_METHODS.includes(method)) continue;
    if (['set', 'update', 'pipe', 'subscribe', 'then', 'catch', 'map', 'tap'].includes(method)) continue;
    calls.push({ prop, method });
  }

  // Local helper calls: `this.loadRankings()` — these carry most page-level chains.
  const localCallRe = /this\.([\w$]+)\s*\(/g;
  while ((match = localCallRe.exec(text)) !== null) {
    calls.push({ prop: 'this', method: match[1] });
  }

  const hubRe = /\.(invoke|send|stream)\s*\(\s*['"]([^'"]+)['"]/g;
  while ((match = hubRe.exec(text)) !== null) {
    hubCalls.push({ verb: match[1], target: match[2] });
  }

  // State writes — what this method puts INTO component state (provenance chain).
  const writes = [];
  const seenWrites = new Set();
  const pushWrite = (prop, kind) => {
    const key = `${kind}:${prop}`;
    if (seenWrites.has(key)) return;
    seenWrites.add(key);
    writes.push({ prop, kind });
  };
  for (const entry of text.matchAll(/this\.([\w$]+)\s*=(?!=)\s*/g)) {
    const before = text[entry.index - 1] ?? '';
    if (before === '!' || before === '<' || before === '>' || before === '=') continue;
    pushWrite(entry[1], 'assign');
  }
  for (const entry of text.matchAll(/this\.([\w$]+)\s*\.\s*(set|update)\s*\(/g)) {
    pushWrite(entry[1], entry[2]);
  }

  // Navigation targets (explains "and then it sends you to …").
  const navigates = [];
  for (const entry of text.matchAll(/this\.\s*router\s*\.\s*navigate(?:ByUrl)?\s*\(\s*(\[[^\]]*\]|`[^`]*`|'[^']*'|"[^"]*")/g)) {
    navigates.push({ target: entry[1].replace(/\s+/g, ' ').slice(0, 80) });
  }

  // Browser storage access (often the real origin of a payload field).
  const storageOps = [];
  for (const entry of text.matchAll(/localStorage\.\s*(getItem|setItem|removeItem)\s*\(\s*([^)]*)\)/g)) {
    storageOps.push({ op: entry[1], key: entry[2].replace(/\s+/g, ' ').slice(0, 80) });
  }

  // What the method hands back (`return this.x` / `return this.svc.y()`), which is how
  // getters and services expose their state.
  const returns = [];
  for (const entry of text.matchAll(/return\s+this\.\s*([\w$]+)\s*(\(\))?\s*;/g)) {
    returns.push({ prop: entry[1], call: !!entry[2] });
  }
  for (const entry of text.matchAll(/return\s+this\.\s*([\w$]+)\s*\.\s*([\w$]+)\s*(\(\))?\s*;/g)) {
    returns.push({ service: entry[1], prop: entry[2], call: !!entry[3] });
  }

  return { endpoints, calls, hubCalls, writes, navigates, storageOps, returns };
}

function jsDocOf(node) {
  const docs = node.jsDoc;
  if (!docs || !docs.length) return null;
  const text = docs
    .map((doc) => doc.comment ?? '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text || null;
}

function decoratorName(node, sf) {
  const decorators = ts.canHaveDecorators(node) ? ts.getDecorators(node) ?? [] : [];
  for (const decorator of decorators) {
    const expr = decorator.expression;
    const name = ts.isCallExpression(expr) ? expr.expression.getText(sf) : expr.getText(sf);
    if (['Component', 'Directive', 'Pipe', 'Injectable'].includes(name)) return { name, call: expr };
  }
  return null;
}

function objectPropFromDecorator(callNode, propName) {
  if (!ts.isCallExpression(callNode)) return null;
  const [arg] = callNode.arguments;
  if (!arg || !ts.isObjectLiteralExpression(arg)) return null;
  for (const prop of arg.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const name = prop.name && ts.isIdentifier(prop.name) ? prop.name.text : prop.name?.getText();
    if (name !== propName) continue;
    const init = prop.initializer;
    if (ts.isStringLiteral(init)) return init.text;
    if (ts.isNoSubstitutionTemplateLiteral(init)) return init.text;
    if (ts.isArrayLiteralExpression(init)) {
      return init.elements.map((element) => (ts.isStringLiteral(element) ? element.text : element.getText())).filter(Boolean);
    }
  }
  return null;
}

/** Extracts `(click)="logout()"` style bindings plus the element's text/labels. */
const VOID_TAGS = new Set(['input', 'img', 'br', 'hr', 'meta', 'link', 'source', 'area', 'base', 'col', 'embed', 'param', 'track', 'wbr']);

/**
 * Text of an element's own content — stops at the matching closing tag instead of
 * bleeding into the following siblings (which used to mis-attribute bindings).
 */
function innerTextOf(template, startIndex, tag) {
  if (VOID_TAGS.has(tag)) return { text: '', dynamic: false };
  const openRe = new RegExp(`<${tag}\\b`, 'gi');
  const closeRe = new RegExp(`</${tag}>`, 'gi');
  let depth = 1;
  let cursor = startIndex;
  let end = -1;
  while (depth > 0) {
    openRe.lastIndex = cursor;
    closeRe.lastIndex = cursor;
    const nextOpen = openRe.exec(template);
    const nextClose = closeRe.exec(template);
    if (!nextClose) break;
    if (nextOpen && nextOpen.index < nextClose.index) {
      depth += 1;
      cursor = openRe.lastIndex;
    } else {
      depth -= 1;
      end = nextClose.index;
      cursor = closeRe.lastIndex;
    }
  }
  const inner = end >= 0 ? template.slice(startIndex, end) : '';
  const dynamic = /\{\{/.test(inner);
  const text = inner
    .replace(/<[^>]*>/g, ' ')
    .replace(/\{\{[^}]*\}\}/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return { text, dynamic };
}

/** Turns `'/profile/' + player.name` into a readable `/profile/{player.name}`. */
function linkPreview(expression) {
  const literals = [...expression.matchAll(/'([^']*)'|"([^"]*)"|`([^`]*)`/g)].map((entry) => entry[1] ?? entry[2] ?? entry[3]);
  const base = literals.join('');
  const identifiers = [...expression.matchAll(/\b([a-z_]\w*\.\w+)\b/g)].map((entry) => entry[1]);
  const dynamic = identifiers.length ? `{${[...new Set(identifiers)].join(', ')}}` : /\{\{/.test(expression) ? '{…}' : '';
  return ((base || expression.trim()).slice(0, 120) + dynamic).slice(0, 140);
}

/** Extracts `(click)="logout()"` style bindings, router links and the element's text/labels. */
function elementHandlersFromTemplate(template) {
  const out = [];
  const tagRe = /<([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)\/?>/g;
  let match;
  while ((match = tagRe.exec(template)) !== null) {
    const [full, tag, attrs] = match;
    const attr = (name) => {
      const found = new RegExp(`${name}\\s*=\\s*"([^"]*)"`).exec(attrs);
      return found ? found[1] : null;
    };
    const after = template.slice(match.index + full.length);
    void after;
    const { text, dynamic } = innerTextOf(template, match.index + full.length, tag.toLowerCase());

    // Router/native navigation bindings: what happens when a row/link is clicked.
    const links = [];
    for (const name of ['routerLink', 'href']) {
      const expression = attr(`\\[${name}\\]`) ?? attr(name);
      if (!expression) continue;
      links.push({ attr: name, expression: expression.trim().slice(0, 160), preview: linkPreview(expression) });
    }
    const queryParams = attr('\\[queryParams\\]') ?? attr('queryParams');

    const bindingRe = /\((\w+)\)\s*=\s*"([^"]*)"/g;
    let binding;
    let emitted = false;
    while ((binding = bindingRe.exec(attrs)) !== null) {
      const [, event, expression] = binding;
      out.push({
        kind: 'event',
        tag: tag.toLowerCase(),
        event,
        expression: expression.trim().slice(0, 160),
        handlers: [...expression.matchAll(/([\w$]+)\s*\(/g)].map((entry) => entry[1]),
        text,
        dynamicText: dynamic,
        links,
        queryParams: queryParams ? queryParams.trim().slice(0, 120) : null,
        id: attr('id'),
        classAttr: attr('class'),
        ariaLabel: attr('aria-label') ?? attr('title') ?? attr('placeholder'),
        line: template.slice(0, match.index).split('\n').length,
      });
      emitted = true;
    }

    // Link-only elements (`<a [routerLink]="...">`) matter just as much: they are
    // what a table row does when clicked.
    if (!emitted && links.length) {
      out.push({
        kind: 'link',
        tag: tag.toLowerCase(),
        event: 'click',
        expression: links.map((link) => link.expression).join(' | '),
        handlers: [],
        text,
        dynamicText: dynamic,
        links,
        queryParams: queryParams ? queryParams.trim().slice(0, 120) : null,
        id: attr('id'),
        classAttr: attr('class'),
        ariaLabel: attr('aria-label') ?? attr('title') ?? attr('placeholder'),
        line: template.slice(0, match.index).split('\n').length,
      });
    }
  }
  return out;
}

function collectFromFile(filePath) {
  const source = fs.readFileSync(filePath, 'utf8');
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const classes = [];

  sf.forEachChild((node) => {
    if (!ts.isClassDeclaration(node) || !node.name) return;
    const decorator = decoratorName(node, sf);
    if (!decorator) return;

    const className = node.name.text;
    const services = {};
    const methods = {};
    const fields = [];
    let templateUrl = objectPropFromDecorator(decorator.call, 'templateUrl');
    const inlineTemplate = objectPropFromDecorator(decorator.call, 'template');
    const selector = objectPropFromDecorator(decorator.call, 'selector');

    for (const member of node.members) {
      if (ts.isConstructorDeclaration(member)) {
        for (const parameter of member.parameters) {
          const typeText = parameter.type?.getText(sf);
          if (!typeText || !/^[A-Z]/.test(typeText)) continue;
          const paramName = ts.isIdentifier(parameter.name) ? parameter.name.text : parameter.name.getText(sf);
          services[paramName] = typeText.split('<')[0].trim();
        }
      }
      if (ts.isPropertyDeclaration(member) && member.name) {
        const fieldName = ts.isIdentifier(member.name) ? member.name.text : member.name.getText(sf);
        fields.push({
          name: fieldName,
          type: member.type?.getText(sf) ?? null,
          // Initializer source tells us where the value comes from (`this.svc.itemsSignal`).
          init: member.initializer ? member.initializer.getText(sf).slice(0, 200) : null,
          doc: jsDocOf(member),
        });
      }
      if (ts.isMethodDeclaration(member) && member.name) {
        const methodName = ts.isIdentifier(member.name) ? member.name.text : member.name.getText(sf);
        const bodyText = member.getText(sf);
        methods[methodName] = {
          ...scanBody(bodyText),
          kind: 'method',
          doc: jsDocOf(member),
          line: sf.getLineAndCharacterOfPosition(member.getStart(sf)).line + 1,
        };
      }
      // Getters are how pages expose service signals (`get players() { return svc.getPlayers()(); }`).
      if (ts.isGetAccessorDeclaration(member) && member.name) {
        const getterName = ts.isIdentifier(member.name) ? member.name.text : member.name.getText(sf);
        methods[getterName] = {
          ...scanBody(member.getText(sf)),
          kind: 'getter',
          doc: jsDocOf(member),
          line: sf.getLineAndCharacterOfPosition(member.getStart(sf)).line + 1,
        };
      }
    }

    // Class-level (decorator) service injection is not used in this codebase, but
    // `inject()` calls inside field initializers are: capture them too.
    const sourceOfClass = node.getText(sf);
    for (const entry of sourceOfClass.matchAll(/(?:private|public|protected|readonly|\s)+([\w$]+)\s*=\s*inject\(\s*([\w$]+)\s*\)/g)) {
      services[entry[1]] = entry[2];
    }

    let template = null;
    if (typeof inlineTemplate === 'string') template = inlineTemplate;
    else if (typeof templateUrl === 'string') {
      const resolved = path.resolve(path.dirname(filePath), templateUrl);
      if (fs.existsSync(resolved)) template = fs.readFileSync(resolved, 'utf8');
    }

    classes.push({
      className,
      kind: decorator.name,
      selector: typeof selector === 'string' ? selector : null,
      doc: jsDocOf(node),
      relativeFile: path.relative(appRoot, filePath).replace(/\\/g, '/'),
      services,
      methods,
      fields,
      elementHandlers: template ? elementHandlersFromTemplate(template) : [],
    });
  });

  return classes;
}

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') && !entry.name.endsWith('.d.ts')) files.push(full);
  }
  return files;
}

const rawClasses = walk(appRoot).flatMap((file) => {
  try {
    return collectFromFile(file);
  } catch (error) {
    console.warn(`[debug-index] skipped ${path.relative(appRoot, file)}: ${error.message}`);
    return [];
  }
});

const byName = new Map(rawClasses.map((entry) => [entry.className, entry]));

/** Route table -> component, so a link prediction can continue into the target page. */
function collectRoutes() {
  if (!fs.existsSync(routesFile)) return [];
  const text = fs.readFileSync(routesFile, 'utf8');
  const routes = [];
  for (const block of text.matchAll(/\{([^{}]*)\}/g)) {
    const body = block[1];
    const pathMatch = /path\s*:\s*'([^']*)'/.exec(body);
    if (!pathMatch) continue;
    const componentMatch = /component\s*:\s*([A-Za-z_$][\w$]*)/.exec(body);
    const guardMatch = /canActivate\s*:\s*\[([^\]]*)\]/.exec(body);
    routes.push({
      path: pathMatch[1],
      component: componentMatch ? componentMatch[1] : null,
      guards: guardMatch
        ? guardMatch[1]
            .split(',')
            .map((entry) => entry.trim())
            .filter(Boolean)
        : [],
    });
  }
  return routes;
}

/** Resolves a method to endpoints recursively through injected services. */
function resolveMethod(owner, methodName, depth = 0, seen = new Set()) {
  const key = `${owner.className}.${methodName}`;
  if (seen.has(key) || depth > 4) return { endpoints: [], chain: [], hubCalls: [], returns: [] };
  seen.add(key);

  const method = owner.methods?.[methodName];
  if (!method) return { endpoints: [], chain: [], hubCalls: [], returns: [] };

  const endpoints = [...method.endpoints];
  const chain = [];
  const hubCalls = [...(method.hubCalls ?? [])];
  const returns = [...(method.returns ?? [])];

  // `this.signal.asReadonly()` / `this.signal()` means "returns this field", not a service call.
  for (const ret of method.returns ?? []) {
    if (ret.service && !owner.services?.[ret.service]) {
      ret.prop = ret.service;
      ret.via = ret.call ? 'call' : 'field';
      ret.service = undefined;
    }
  }

  for (const call of method.calls) {
    const serviceName = owner.services?.[call.prop];
    if (!serviceName) continue;
    const service = byName.get(serviceName);
    if (!service) continue;
    const nested = resolveMethod(service, call.method, depth + 1, seen);
    // Keep the link even when the nested call issues no request: it may return a
    // service signal that is filled elsewhere (that is the useful provenance).
    if (nested.endpoints.length || nested.chain.length || nested.hubCalls.length || nested.returns.length) {
      chain.push({
        via: `${serviceName}.${call.method}()`,
        endpoints: nested.endpoints,
        chain: nested.chain,
        hubCalls: nested.hubCalls,
        returns: nested.returns,
      });
      endpoints.push(...nested.endpoints);
      hubCalls.push(...nested.hubCalls);
    }
  }

  // Local helper calls inside the same class (this.buildPayload(), this.refresh()).
  for (const call of method.calls) {
    if (owner.services?.[call.prop]) continue;
    if (call.prop !== 'this') continue;
    const nested = resolveMethod(owner, call.method, depth + 1, seen);
    endpoints.push(...nested.endpoints);
    hubCalls.push(...nested.hubCalls);
    if (nested.chain.length) chain.push(...nested.chain);
  }

  return { endpoints, chain, hubCalls, returns };
}

const services = {};
const components = {};

for (const entry of rawClasses) {
  const resolvedMethods = {};
  for (const methodName of Object.keys(entry.methods ?? {})) {
    const resolved = resolveMethod(entry, methodName);
    resolvedMethods[methodName] = {
      line: entry.methods[methodName].line,
      kind: entry.methods[methodName].kind ?? 'method',
      doc: entry.methods[methodName].doc ?? null,
      returns: entry.methods[methodName].returns ?? [],
      endpoints: dedupe(resolved.endpoints),
      calls: resolved.chain,
      hubCalls: dedupeObjects(resolved.hubCalls, (item) => `${item.verb}:${item.target}`),
      navigates: entry.methods[methodName].navigates ?? [],
      storageOps: entry.methods[methodName].storageOps ?? [],
      writes: entry.methods[methodName].writes ?? [],
      payloadHint: entry.methods[methodName].endpoints.find((endpoint) => endpoint.body)?.body ?? null,
    };
  }

  // Per-state-field provenance: which methods write a field and what they call.
  // This is what turns "this table" into "filled by ngOnInit -> GET /ranking".
  const fills = {};
  for (const [methodName, raw] of Object.entries(entry.methods ?? {})) {
    for (const write of raw.writes ?? []) {
      if (!fills[write.prop]) fills[write.prop] = [];
      fills[write.prop].push({
        method: methodName,
        kind: write.kind,
        line: raw.line,
        doc: raw.doc ?? null,
        endpoints: resolvedMethods[methodName].endpoints,
        chain: resolvedMethods[methodName].calls,
      });
    }
  }

  // Field initializers reveal aliases of service state (`items = this.svc.itemsSignal`).
  const fieldOrigins = {};
  for (const field of entry.fields ?? []) {
    if (!field.init) continue;
    const match = /this\.\s*([\w$]+)\s*\.\s*([\w$]+)/.exec(field.init);
    if (!match) continue;
    const serviceName = entry.services?.[match[1]];
    if (!serviceName) continue;
    fieldOrigins[field.name] = { via: `${serviceName}.${match[2]}`, init: field.init };
  }

  const record = {
    file: entry.relativeFile,
    doc: entry.doc,
    selector: entry.selector,
    services: entry.services,
    methods: resolvedMethods,
    fields: entry.fields ?? [],
    getters: Object.keys(resolvedMethods).filter((name) => resolvedMethods[name].kind === 'getter'),
    fills,
    fieldOrigins,
    elementHandlers: entry.elementHandlers,
  };

  if (entry.kind === 'Component' || entry.kind === 'Directive') components[entry.className] = record;
  else services[entry.className] = record;
}

function dedupe(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.method} ${item.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeObjects(items, keyOf) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyOf(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const index = { services, components, routes: collectRoutes() };

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(index, null, 1)}\n`, 'utf8');

const endpointCount = new Set(
  [...Object.values(components), ...Object.values(services)].flatMap((record) =>
    Object.values(record.methods).flatMap((method) => method.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`)),
  ),
).size;

console.log(
  `[debug-index] ${Object.keys(components).length} components, ${Object.keys(services).length} services, ${endpointCount} endpoints -> ${path.relative(process.cwd(), outputPath)}`,
);
