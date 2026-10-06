/**
 * Independent verification of the PACKED artifact.
 *
 * `npm test` verifies the working tree. This script verifies what actually
 * ships: it packs the package, extracts the tarball into a scratch directory,
 * and then loads that copy the way DSH does, from the outside in —
 *
 *   1. read the published manifest and assert every promised file is present;
 *   2. read the patch a profile composes, and check it inserts this package;
 *   3. resolve `exports["./client"]` and run it as a classic script through a
 *      stub `window.__ModuleLoader__`, exactly as the browser boot row does;
 *   4. materialize the registered factory with a module table that permits only
 *      `react`, and assert the plugin face the profile calls;
 *   5. apply that face against a fake DOM and slots service, assert it mounts
 *      one stylesheet and one composer entry, then undo both;
 *   6. import the host entry point from the EXTRACTED copy and drive its route
 *      with a fake request, so the shipped bytes are what gets exercised.
 *
 * Usage: node scripts/verify-pack.mjs
 */

import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const failures = [];

function check(label, condition, detail = "") {
  if (condition) {
    console.log(`  ok    ${label}`);
    return true;
  }
  failures.push(`${label}${detail === "" ? "" : ` — ${detail}`}`);
  console.log(`  FAIL  ${label}${detail === "" ? "" : ` — ${detail}`}`);
  return false;
}

/** A DOM just rich enough for the bundle's one `style[data-…]` selector. */
function installFakeDom() {
  class FakeElement {
    constructor(tagName) {
      this.tagName = String(tagName).toUpperCase();
      this.children = [];
      this.parentNode = null;
      this.attributes = new Map();
      this.style = {};
      this._text = "";
    }
    set textContent(value) {
      this._text = value === null || value === undefined ? "" : String(value);
      this.children = [];
    }
    get textContent() {
      return this._text;
    }
    setAttribute(name, value) {
      this.attributes.set(name, String(value));
    }
    getAttribute(name) {
      return this.attributes.has(name) ? this.attributes.get(name) : null;
    }
    removeAttribute(name) {
      this.attributes.delete(name);
    }
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    }
    append(...nodes) {
      for (const node of nodes) this.appendChild(node);
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
      return node === this || this.children.some((child) => child.contains(node));
    }
    addEventListener() {}
    removeEventListener() {}
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

  const documentElement = new FakeElement("html");
  const head = new FakeElement("head");
  documentElement.appendChild(head);

  /** Walk for the first element carrying `attribute`, which is all that is used. */
  const find = (root, attribute) => {
    for (const child of root.children) {
      if (child.getAttribute(attribute) !== null) return child;
      const found = find(child, attribute);
      if (found !== null) return found;
    }
    return null;
  };

  const document = {
    documentElement,
    head,
    body: new FakeElement("body"),
    createElement: (tagName) => new FakeElement(tagName),
    createTextNode: (text) => {
      const node = new FakeElement("#text");
      node.textContent = text;
      return node;
    },
    querySelector: (selector) => {
      const match = /^style\[([^\]=]+)\]$/.exec(selector);
      return match === null ? null : find(documentElement, match[1]);
    },
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    readyState: "complete",
  };

  globalThis.document = document;
  globalThis.window = {
    document,
    innerWidth: 1440,
    innerHeight: 900,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    addEventListener() {},
    removeEventListener() {},
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    setTimeout,
    clearTimeout,
  };
  return document;
}

/** The React surface the bundle uses, with hooks that resolve synchronously. */
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: Symbol("Fragment"),
  useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useRef: (initial) => ({ current: initial }),
  useMemo: (factory) => factory(),
  useCallback: (callback) => callback,
  useSyncExternalStore: (_subscribe, read) => read(),
  memo: (component) => component,
};

/** A POST carrying `body`, as the web server hands it to a route. */
function fakeRequest(body) {
  const request = new EventEmitter();
  request.method = "POST";
  request.destroy = () => {};
  queueMicrotask(() => {
    if (body !== undefined) request.emit("data", body);
    request.emit("end");
  });
  return request;
}

const scratch = mkdtempSync(join(tmpdir(), "dsh-popt-verify-"));

/** Quote one argument for cmd.exe, so no shell is needed to reach npm/tar. */
function quote(argument) {
  return /[\s"^&|<>]/.test(argument) ? `"${argument.replace(/"/g, '""')}"` : argument;
}

/** Run a command, reaching the Windows command shims through cmd.exe explicitly. */
function run(command, args, options = {}) {
  if (process.platform !== "win32") {
    return execFileSync(command, args, { ...options, shell: false });
  }
  const line = [command, ...args].map(quote).join(" ");
  return execFileSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", line], {
    ...options,
    shell: false,
    windowsVerbatimArguments: true,
  });
}

/**
 * Pack into the scratch directory, tolerating one transient failure.
 *
 * `npm pack` writing into the system temp directory is occasionally refused on
 * Windows while an on-access scanner holds the newly created archive (observed
 * once as `Command failed: … npm pack` with no other symptom, and a plain rerun
 * succeeded). Retrying here keeps an outside-in verifier from reporting a red
 * result that says nothing about the package.
 */
function packOnce() {
  return run("npm", ["pack", "--pack-destination", scratch, "--silent"], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
}

function packTarball() {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return packOnce();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

try {
  console.log(`verify-pack: packing ${manifest.name}@${manifest.version}`);
  const packOutput = packTarball();
  const tarball = join(scratch, packOutput.split(/\r?\n/).pop().trim());
  check("npm pack produced a tarball", existsSync(tarball), tarball);
  console.log(`  file  ${tarball}`);

  const extract = join(scratch, "extract");
  mkdirSync(extract, { recursive: true });
  run("tar", ["-xzf", tarball, "-C", extract], { encoding: "utf8" });
  const packageDir = join(extract, "package");
  check("the tarball extracts to package/", existsSync(packageDir));

  // ── 1. the published manifest ────────────────────────────────────────────
  const published = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  check(
    "published name and version match the source manifest",
    published.name === manifest.name && published.version === manifest.version,
  );
  check("published manifest declares the Cordis bundle patch", published.dsh?.bundle?.patch === "./cordis.patch.yml");
  check("published manifest declares the web client platform", published.dsh?.client?.platform === "web");
  check("published manifest is not private", published.private === undefined);
  check(
    "published manifest declares no dependencies",
    ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].every(
      (field) => published[field] === undefined,
    ),
  );

  for (const relative of ["lib/index.js", "lib/client.js", "cordis.patch.yml", "README.md", "LICENSE"]) {
    check(`shipped: ${relative}`, existsSync(join(packageDir, relative)));
  }
  check("the host module of the skin version is not shipped", !existsSync(join(packageDir, "lib/host.js")));

  // ── 2. the patch a profile reads ─────────────────────────────────────────
  // The layer id and the package name are deliberately different: the id names
  // the plugin inside the composition, the name is what pnpm resolves.
  const patch = readFileSync(join(packageDir, published.dsh.bundle.patch), "utf8");
  check("cordis.patch.yml inserts the package by name", new RegExp(`name:\\s*["']?${published.name}\\b`).test(patch));
  check("cordis.patch.yml declares the layer id", /id:\s*["']?prompt-opt\b/.test(patch));
  check("cordis.patch.yml is a well-formed insert layer", /^-\s*insert:/m.test(patch));

  // ── 3. the client half, as a browser boot row ────────────────────────────
  const clientPath = join(packageDir, published.exports["./client"]);
  check("exports[./client] resolves to a shipped file", existsSync(clientPath));
  const bundle = readFileSync(clientPath, "utf8");
  check("the bundle is a classic script, not a module", !/^\s*(?:import|export)\s/m.test(bundle));

  installFakeDom();
  const registrations = [];
  globalThis.window.__ModuleLoader__ = {
    load(record) {
      registrations.push(record);
    },
  };
  // eslint-disable-next-line no-new-func -- evaluating the shipped bundle is the point.
  new Function(bundle)();
  check("the bundle registers exactly one factory", registrations.length === 1, `got ${registrations.length}`);
  const record = registrations[0];
  check("the module-table id equals the package name", record?.id === published.name, String(record?.id));
  check("the record carries a factory", typeof record?.factory === "function");

  const requested = [];
  const moduleTable = new Proxy(
    {},
    {
      get: (_target, specifier) => {
        requested.push(String(specifier));
        if (specifier === "react") return reactStub;
        throw new Error(`client-modules: require("${String(specifier)}") is not in this verification table`);
      },
    },
  );
  const face = record.factory((specifier) => moduleTable[specifier]);
  check("the only module-table request is react", JSON.stringify(requested) === JSON.stringify(["react"]), requested.join(", "));
  check("the face exposes apply()", typeof face?.apply === "function");
  check("the face declares its hard injection", JSON.stringify(face?.inject) === JSON.stringify(["slots"]), String(face?.inject));
  check("exports.default is the same face", face?.default === face);

  // ── 4. apply(), against the services the plugin reads ────────────────────
  const injected = [];
  const registrations2 = [];
  const teardowns = [];
  const slots = {
    inject(name, factory) {
      injected.push(name);
      return factory();
    },
    register(options, component) {
      registrations2.push({ options, component });
      return () => {};
    },
  };
  const context = {
    get: (name) => (name === "slots" ? slots : undefined),
    effect: (setup) => {
      teardowns.push(setup());
      return () => {};
    },
  };

  face.apply(context);
  const styles = globalThis.document.head.children.filter((node) => node.tagName === "STYLE");
  check("apply() adds exactly one stylesheet", styles.length === 1, `got ${styles.length}`);
  check("the stylesheet is tagged with the plugin name", styles[0]?.getAttribute("data-plugin") === "prompt-opt");
  check("the stylesheet carries the panel CSS", /\.dsh-popt-panel\{/.test(styles[0]?.textContent ?? ""));
  check("apply() takes exactly one slot", JSON.stringify(injected) === JSON.stringify(["conversation.input.right"]), injected.join(", "));
  check("apply() registers one composer entry", registrations2.length === 1, `got ${registrations2.length}`);
  check(
    "the entry declares its identity and order",
    registrations2[0]?.options?.id === "prompt-opt" && registrations2[0]?.options?.order === 20,
    JSON.stringify(registrations2[0]?.options ?? null),
  );
  check("apply() registers a teardown", teardowns.length > 0 && teardowns.every((fn) => typeof fn === "function"));

  for (const dispose of teardowns) dispose();
  check("teardown removes the stylesheet", globalThis.document.head.children.every((node) => node.tagName !== "STYLE"));

  // ── 5. the host half, over real ESM, from the extracted copy ─────────────
  const hostEntry = join(packageDir, published.main);
  const host = await import(pathToFileURL(hostEntry).href);
  check("the host entry point exports its face", host.name === "prompt-opt" && typeof host.apply === "function");
  check(
    "the host half declares the services it hard-injects",
    JSON.stringify(host.inject) === JSON.stringify(["webServer", "timer"]),
    String(host.inject),
  );

  const routes = [];
  host.apply({
    logger: { warn: () => {} },
    get: () => undefined,
    timeout: (callback, ms) => setTimeout(callback, ms),
    effect: (setup) => {
      setup();
      return () => {};
    },
    webServer: {
      register: (route) => {
        routes.push(route);
        return () => {};
      },
    },
  });
  check("the host half registers exactly one route", routes.length === 1, `got ${routes.length}`);
  check("the route is the exact path the client half fetches", routes[0]?.path === "/api/prompt-opt/optimize" && routes[0]?.kind === "exact");

  const response = {
    status: null,
    headers: null,
    body: "",
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body ?? "";
      this.done?.();
    },
  };
  const answered = new Promise((settle) => {
    response.done = settle;
  });
  await routes[0].handler(fakeRequest(JSON.stringify({ text: '帮我写一个登录页面，要有记住密码和忘记密码', mode: 'rule' })), response);
  await answered;
  const answer = JSON.parse(response.body);
  check("the route answers 200 with JSON", response.status === 200 && /^application\/json/.test(response.headers["content-type"]));
  check(
    "the rule engine rewrites the prompt without a model",
    answer.ok === true && answer.engine === "rule" && typeof answer.text === "string" && answer.text.length > 0,
    JSON.stringify(answer).slice(0, 120),
  );
} catch (error) {
  failures.push(`threw: ${error?.stack ?? error}`);
  console.log(`  FAIL  threw: ${error?.message ?? error}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log("");
if (failures.length === 0) {
  console.log("verify-pack: all checks passed");
} else {
  console.log(`verify-pack: ${failures.length} check(s) failed`);
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exitCode = 1;
}
