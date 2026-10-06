/**
 * Shape checks on the generated client bundle.
 *
 * The bundle is what the profile actually loads, so these run it the way the
 * module loader does — as a classic script that registers a factory — and then
 * materialize that factory against a small fake DOM and a fake `slots` service.
 * Nothing here reads `src/`: the point is to test the artifact that ships.
 *
 * The first test is the anti-drift one: `lib/client.js` must be exactly what
 * `src/` builds, so a hand edit to the generated file cannot survive `npm test`.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildAll } from '../scripts/build.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = join(ROOT, 'lib', 'client.js');
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

/** The bundle is a classic script: it writes to `window`, so give it one. */
globalThis.window = globalThis.window ?? {};

/** Minimal element: enough tree, style and attribute surface for the plugin. */
class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.style = {};
    this.dataset = {};
    this.textContent = '';
    this.innerHTML = '';
    this.listeners = new Map();
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  appendChild(child) {
    if (child.parentNode !== null) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  append(...nodes) {
    for (const node of nodes) this.appendChild(node);
  }

  insertBefore(child, before) {
    if (child.parentNode !== null) child.parentNode.removeChild(child);
    const index = before === undefined || before === null ? this.children.length : this.children.indexOf(before);
    child.parentNode = this;
    this.children.splice(index < 0 ? this.children.length : index, 0, child);
    return child;
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  remove() {
    if (this.parentNode !== null) this.parentNode.removeChild(this);
  }

  contains(node) {
    if (node === this) return true;
    return this.children.some((child) => child.contains(node));
  }

  addEventListener(type, handler) {
    this.listeners.set(type, handler);
  }

  removeEventListener(type) {
    this.listeners.delete(type);
  }

  getBoundingClientRect() {
    return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }

  querySelector() {
    return null;
  }

  querySelectorAll() {
    return [];
  }
}

/** Walk a tree looking for the first element carrying `attribute`. */
function findByAttribute(root, attribute) {
  for (const child of root.children) {
    if (child.getAttribute(attribute) !== null) return child;
    const found = findByAttribute(child, attribute);
    if (found !== null) return found;
  }
  return null;
}

/** The bundle uses exactly one selector shape: `style[data-…]`. */
function installFakeDom() {
  const head = new FakeElement('head');
  const body = new FakeElement('body');
  const documentElement = new FakeElement('html');

  const document = {
    documentElement,
    head,
    body,
    createElement: (tag) => new FakeElement(tag),
    createTextNode: (text) => ({ textContent: String(text) }),
    getElementById: () => null,
    querySelector: (selector) => {
      const matched = /^style\[([^\]=]+)\]$/.exec(selector);
      if (matched === null) throw new Error(`unexpected selector in the bundle: ${selector}`);
      return findByAttribute(head, matched[1]);
    },
    querySelectorAll: () => [],
    addEventListener: () => {},
  };

  globalThis.document = document;
  globalThis.window = globalThis.window ?? {};
  Object.assign(globalThis.window, {
    innerWidth: 1440,
    innerHeight: 900,
    matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    addEventListener: () => {},
    removeEventListener: () => {},
  });

  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  };
  globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);

  return { document, head };
}

/**
 * A `React` stub good enough to render the entry by hand.
 *
 * `useState` is stateful on purpose: the hooks are called in a fixed order on
 * every render, so a per-component slot store gives real behaviour across
 * renders — which is what lets the tests below click a button and read what the
 * next render shows, without pulling React into the package. A function used as
 * an element type is rendered in place, so `createElement(PromptOptView, …)`
 * yields the element tree rather than an opaque node.
 */
function createReactStub() {
  const stores = new WeakMap();
  let rendering = null;

  function storeFor(component) {
    if (!stores.has(component)) stores.set(component, { state: new Map(), slot: 0 });
    return stores.get(component);
  }

  function renderInPlace(component, props) {
    const previous = rendering;
    const store = storeFor(component);
    store.slot = 0;
    rendering = store;
    try {
      return component(props);
    } finally {
      rendering = previous;
    }
  }

  return {
    reset() {
      // Nothing to clear: state lives per component, so the next render reads
      // back exactly what the previous one wrote.
    },
    createElement: (type, props, ...children) => (typeof type === 'function'
      ? renderInPlace(type, props)
      : { type, props: props ?? {}, children }),
    renderInPlace,
    Fragment: Symbol('Fragment'),
    useState: (initial) => {
      const store = rendering;
      if (store === null) throw new Error('useState was called outside a render');
      const key = store.slot;
      store.slot += 1;
      if (!store.state.has(key)) store.state.set(key, typeof initial === 'function' ? initial() : initial);
      return [
        store.state.get(key),
        (next) => {
          store.state.set(key, typeof next === 'function' ? next(store.state.get(key)) : next);
        },
      ];
    },
    useEffect: () => {},
    useLayoutEffect: () => {},
    useRef: (initial) => ({ current: initial }),
    useMemo: (factory) => factory(),
    useCallback: (callback) => callback,
    useSyncExternalStore: (_subscribe, read) => read(),
    memo: (component) => component,
  };
}

const reactStub = createReactStub();

/**
 * Render a component the way the shell would.
 *
 * The entry is wrapped in an arrow in `apply()`, so re-rendering it is what
 * happens on the next state change; hook slots reset per call, state persists.
 */
function render(component, props) {
  return reactStub.renderInPlace(component, props);
}

/** Run the bundle as a classic script and capture its single registration. */
function registerFactory() {
  const registrations = [];
  globalThis.window.__ModuleLoader__ = {
    load: (record) => {
      registrations.push(record);
    },
  };
  // eslint-disable-next-line no-new-func -- the loader runs the bundle exactly this way.
  new Function(readFileSync(BUNDLE, 'utf8'))();
  assert.equal(registrations.length, 1, 'the bundle must register exactly one factory');
  return registrations[0];
}

/** Materialize the factory, recording every module-table request. */
function materialize(factory) {
  const requested = [];
  const face = factory((specifier) => {
    requested.push(specifier);
    if (specifier === 'react') return reactStub;
    throw new Error(`the bundle requested an unexpected module: ${specifier}`);
  });
  return { face, requested };
}

test('lib/client.js is exactly what src/ builds', () => {
  const artifacts = buildAll();
  const expected = artifacts.get(BUNDLE);
  assert.ok(expected !== undefined, 'buildAll must produce lib/client.js');
  assert.equal(readFileSync(BUNDLE, 'utf8'), expected, 'lib/client.js is out of date; run `npm run build`');
});

test('the bundle registers one factory whose id is the package name', () => {
  const record = registerFactory();
  assert.equal(typeof record.factory, 'function');
  assert.equal(record.id, MANIFEST.name, 'the module-table key must be the package name');
});

test('the factory requests react and nothing else', () => {
  const { requested } = materialize(registerFactory().factory);
  assert.deepEqual(requested, ['react']);
});

test('the module face is { inject, apply, default }', () => {
  const { face } = materialize(registerFactory().factory);
  assert.equal(typeof face.apply, 'function');
  assert.deepEqual(face.inject, ['slots']);
  assert.deepEqual(Object.keys(face).sort(), ['apply', 'default', 'inject']);
  assert.equal(face.default, face, '`default` must be the same face, for the interop shape');
});

test('apply() contributes one stylesheet and one composer entry, and undoes both', () => {
  const { document, head } = installFakeDom();
  const { face } = materialize(registerFactory().factory);

  const injected = [];
  const registered = [];
  const slots = {
    inject: (name, contribute) => {
      injected.push(name);
      return contribute();
    },
    register: (options, component) => {
      registered.push({ options, component });
      return () => {};
    },
  };

  const disposers = [];
  const context = {
    get: (name) => (name === 'slots' ? slots : undefined),
    effect: (setup) => {
      const dispose = setup();
      disposers.push(typeof dispose === 'function' ? dispose : () => {});
      return () => {};
    },
  };

  face.apply(context);

  const styles = head.children.filter((child) => child.tagName === 'STYLE');
  assert.equal(styles.length, 1, 'exactly one stylesheet element');
  assert.equal(styles[0].getAttribute('data-plugin'), 'prompt-opt');
  assert.equal(styles[0].getAttribute('data-dsh-popt-css'), '');
  assert.match(styles[0].textContent, /\.dsh-popt-panel\{/);

  assert.deepEqual(injected, ['conversation.input.right']);
  assert.equal(registered.length, 1);
  assert.deepEqual(registered[0].options, {
    name: 'conversation.input.right',
    id: 'prompt-opt',
    order: 20,
    label: '优化提示词',
  });
  assert.equal(typeof registered[0].component, 'function');

  // Re-applying must not stack a second stylesheet.
  face.apply(context);
  assert.equal(head.children.filter((child) => child.tagName === 'STYLE').length, 1);

  for (const dispose of disposers) dispose();
  assert.equal(findByAttribute(document.head, 'data-dsh-popt-css'), null, 'teardown removes the stylesheet');
});

test('apply() is inert when the shell has no slots service', () => {
  installFakeDom();
  const { face } = materialize(registerFactory().factory);
  const context = {
    get: () => undefined,
    effect: () => {
      throw new Error('apply must not register an effect without the service');
    },
  };
  assert.equal(face.apply(context), undefined);
  assert.equal(findByAttribute(globalThis.document.head, 'data-dsh-popt-css'), null);
});

/** Walk a rendered element tree and collect the nodes matching `predicate`. */
function collect(tree, predicate, found = []) {
  if (Array.isArray(tree)) {
    for (const child of tree) collect(child, predicate, found);
    return found;
  }
  if (tree === null || typeof tree !== 'object') return found;
  if (predicate(tree)) found.push(tree);
  collect(tree.children ?? [], predicate, found);
  return found;
}

/** Find one button by a class it carries among others (`dsh-popt-chip active`). */
function buttonByClass(tree, className) {
  const [found] = collect(tree, (node) => node.type === 'button' && String(node.props?.className ?? '').split(/\s+/).includes(className));
  return found;
}

test('the entry posts the prompt to the path the host half registers', () => {
  installFakeDom();
  const { face } = materialize(registerFactory().factory);

  const registered = [];
  const slots = {
    inject: (_name, contribute) => contribute(),
    register: (options, component) => {
      registered.push(component);
      return () => {};
    },
  };
  const context = {
    get: (name) => (name === 'slots' ? slots : undefined),
    effect: (setup) => {
      setup();
      return () => {};
    },
  };
  face.apply(context);
  assert.equal(registered.length, 1);

  const calls = [];
  globalThis.fetch = (url, options) => {
    calls.push({ url, options });
    return Promise.resolve({ json: async () => ({ ok: true, text: '改写结果', engine: 'rule' }) });
  };

  // Render once with the composer's own props, then click the sparkle trigger.
  const tree = render(registered[0], { input: { draft: '帮我写一个登录页面', phase: 'plain' }, inputActions: { setDraft: () => {} } });
  const trigger = buttonByClass(tree, 'dsh-popt-trigger');
  assert.ok(trigger !== undefined, 'the entry renders its trigger button');
  assert.equal(trigger.props.title, '优化提示词');
  trigger.props.onClick();

  assert.equal(calls.length, 1, 'clicking the trigger issues exactly one request');
  assert.equal(calls[0].url, '/api/prompt-opt/optimize', 'the client and the route share one path');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].options.body), { text: '帮我写一个登录页面', mode: 'auto' });
});

test('the panel opens on the first click and the mode chips choose the engine', () => {
  installFakeDom();
  const { face } = materialize(registerFactory().factory);

  const registered = [];
  const slots = {
    inject: (_name, contribute) => contribute(),
    register: (_options, component) => {
      registered.push(component);
      return () => {};
    },
  };
  face.apply({
    get: (name) => (name === 'slots' ? slots : undefined),
    effect: (setup) => {
      setup();
      return () => {};
    },
  });

  const calls = [];
  globalThis.fetch = (url, options) => {
    calls.push({ url, options });
    return Promise.resolve({ json: async () => ({ ok: true, text: '改写后的提示词' }) });
  };

  const props = { input: { draft: '写点什么', phase: 'plain' }, inputActions: { setDraft: () => {} } };
  const first = render(registered[0], props);
  assert.equal(first.props.className, 'dsh-popt-wrap');
  assert.equal(
    collect(first, (node) => node.props?.className === 'dsh-popt-panel').length,
    0,
    'the panel stays closed until the user asks for it',
  );

  const trigger = buttonByClass(first, 'dsh-popt-trigger');
  assert.equal(trigger.props.title, '优化提示词');
  trigger.props.onClick();
  assert.deepEqual(JSON.parse(calls[0].options.body), { text: '写点什么', mode: 'auto' });

  // The click set `open`, so the next render is the one that shows the panel.
  const second = render(registered[0], props);
  const chip = buttonByClass(second, 'dsh-popt-chip');
  assert.ok(chip !== undefined, 'the open panel offers the mode chips');
  assert.equal(chip.children[0], '智能优化', 'the first chip is the default the trigger already posted');
  const [, rule] = collect(second, (node) => node.type === 'button' && String(node.props?.className ?? '').includes('dsh-popt-chip'));
  rule.props.onClick();
  assert.deepEqual(JSON.parse(calls[1].options.body), { text: '写点什么', mode: 'rule' });
});
