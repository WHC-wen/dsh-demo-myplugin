/**
 * Build `lib/` from `src/`.
 *
 * The generated artifacts and what must stay true about them:
 *
 *  - `lib/client.js` — the browser-half bundle, which DeepSeek Harness's client
 *    module system executes as a classic script. Such a bundle may only
 *    register a factory (`window.__ModuleLoader__.load({ id, factory })`); the
 *    factory is materialized later and receives the synchronous `require` bound
 *    to the platform module table. `factory` must therefore be self-contained:
 *    its only permitted request is a platform specifier, and every relative
 *    import has to be inlined at build time.
 *  - `lib/index.js` — the entry point the profile resolves (`exports["."]`),
 *    re-exporting the host half with an explicit `./host.js` specifier.
 *  - `lib/host.js` — the host half: one same-origin route, with every relative
 *    import from `src/` inlined into the one flat module the package ships.
 *
 * Read against `src/`, which is the only place anyone should edit:
 *
 *  - `src/client.js`  — the bundle's entry point (factory shape, top to bottom).
 *  - `src/view.js`, `src/styles.js` — the React half and its stylesheet.
 *  - `src/host.js`    — the route, the rule engine and the model polish.
 *  - `src/endpoint.js` — the path and request shape both halves share, so the
 *    browser and the host cannot drift apart.
 *  - `src/index.js`   — the host half's entry point, re-exporting `src/host.js`.
 *
 * The transform is a bundle-and-wrap, not a transpile: module bodies travel
 * byte for byte, imports become either `require` calls (platform specifiers) or
 * inlined sibling bodies (relative specifiers), and the result is indented one
 * level inside the registration IIFE. An unsupported construct is a hard error
 * rather than a silent omission — a bundle that quietly dropped an import would
 * register a factory that throws at materialization, which is the class of
 * failure this script exists to make impossible.
 *
 * `tests/client-contract.test.mjs` and `tests/host-contract.test.mjs` assert
 * the committed artifacts are exactly what this script emits, so a manual edit
 * to `lib/` cannot survive `npm test`.
 *
 * Usage: node scripts/build.mjs [--check]
 *   --check  verify `lib/` is up to date and exit non-zero when it is not
 *            (writes nothing); used by `npm test`.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const OUT = join(ROOT, "lib");

const CLIENT_ENTRY = join(SRC, "client.js");
const CLIENT_OUTPUT = join(OUT, "client.js");
const HOST_ENTRY = join(SRC, "index.js");
const HOST_OUTPUT = join(OUT, "index.js");

/**
 * Parse one ES module into its import statements and its body.
 *
 * Only the leading import block is read; imports below it are a hard error,
 * because hoisting them silently would change evaluation order. Comments and
 * blank lines are trivia: kept in the saved body (they document the module),
 * ignored when walking the header.
 *
 * @param {string} path absolute path of the module being parsed.
 * @returns {{ lines: string[], imports: object[], body: string[] }} parsed module.
 */
function parseModule(path) {  const text = readFileSync(path, "utf8");
  const lines = text.split("\n");
  const imports = [];

  let i = 0;
  /** True while the reader is anywhere above the module body. */
  let inHeader = true;

  for (; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();

    if (inHeader) {
      if (trimmed === "" || trimmed.startsWith("//")) continue;
      if (trimmed.startsWith("/*")) {
        while (i < lines.length && !lines[i].includes("*/")) i += 1;
        continue;
      }
      if (trimmed.startsWith("import ")) {
        imports.push(parseImport(trimmed, path));
        continue;
      }
      inHeader = false;
    }

    if (trimmed.startsWith("import ")) {
      throw new Error(
        `scripts/build.mjs: ${relative(ROOT, path)} has an import below its first declaration (line ${i + 1}): ${trimmed}`,
      );
    }
    break;
  }

  return { lines, imports, body: lines.slice(i) };
}

/**
 * Parse one import statement.
 *
 * @param {string} statement the trimmed statement.
 * @param {string} path the module it came from, for error messages.
 * @returns {{ specifier: string, bindings: object[]|null, namespace: string|null, local: string|null }} descriptors.
 */
function parseImport(statement, path) {
  const where = relative(ROOT, path);

  const sideEffect = /^import\s+["']([^"']+)["'];?$/.exec(statement);
  if (sideEffect !== null) {
    throw new Error(
      `scripts/build.mjs: ${where} has the side-effect import "${sideEffect[1]}"; a bundle cannot replay it at script-parse time`,
    );
  }

  const clause = /^import\s+([\s\S]+?)\s+from\s+["']([^"']+)["'];?$/.exec(statement);
  if (clause === null) {
    throw new Error(`scripts/build.mjs: unsupported import form in ${where}: ${statement}`);
  }

  const specifier = clause[2];
  const head = clause[1].trim();

  if (head.startsWith("{")) {
    const bindings = head
      .slice(1, -1)
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "")
      .map((entry) => {
        const aliased = /^(\S+)\s+as\s+(\S+)$/.exec(entry);
        return aliased === null ? { imported: entry, local: entry } : { imported: aliased[1], local: aliased[2] };
      });
    if (bindings.length === 0) {
      throw new Error(`scripts/build.mjs: empty named import in ${where}: ${statement}`);
    }
    return { specifier, bindings, namespace: null, local: null };
  }

  const namespace = /^\*\s+as\s+(\S+)$/.exec(head);
  if (namespace !== null) {
    return { specifier, bindings: null, namespace: namespace[1], local: null };
  }

  throw new Error(`scripts/build.mjs: unsupported import clause in ${where}: ${statement}`);
}

/** True when a specifier points at a sibling module rather than the platform. */
function isRelative(specifier) {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

/** The declaration an `export const|let|var|function|class` line introduces. */
const EXPORTED_DECLARATION = /^export\s+(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/;

/**
 * Name every binding a module's own `export` declarations introduce.
 *
 * These are the names a relative import can pull out of the module once it is
 * inlined, so this is exactly the table `emitModule` validates imports against.
 *
 * @param {string[]} lines the module's body lines.
 * @returns {Set<string>} declared names.
 */
function findDeclarations(lines) {
  const names = new Set();
  for (const line of lines) {
    const matched = EXPORTED_DECLARATION.exec(line.trim());
    if (matched !== null) names.add(matched[1]);
  }
  return names;
}

/**
 * Drop the `export` keyword from declarations, which are the only export form
 * this package uses.
 *
 * An inlined bundle has one scope: leaving `export` on a statement would be a
 * syntax error there, so the keyword is removed and the binding is validated at
 * the import site instead. Any other export form is a hard error, because
 * silently dropping it would change what a module exposes.
 *
 * @param {string} text the module's source.
 * @param {string} where the module's path, for error messages.
 * @returns {string} the same text, with declaration exports unexported.
 */
function stripExportKeywords(text, where) {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("export default")) {
      throw new Error(`scripts/build.mjs: ${where} uses \`export default\`; the bundle face is assembled by the build`);
    }
    if (trimmed.startsWith("export *") || trimmed.startsWith("export {")) {
      throw new Error(`scripts/build.mjs: ${where} uses a non-declaration export; only declared exports are supported`);
    }
    if (trimmed.startsWith("export ") && EXPORTED_DECLARATION.exec(trimmed) === null) {
      throw new Error(`scripts/build.mjs: ${where} has an unsupported export: ${trimmed}`);
    }
  }
  return text.replace(/^(\s*)export\s+(?=(?:async\s+)?(?:const|let|var|function|class)\s)/gm, "$1");
}

/**
 * Resolve a relative specifier against the module that imported it.
 *
 * @param {string} specifier the import specifier.
 * @param {string} path the importing module's absolute path.
 * @returns {string} the absolute path of the imported module.
 */
function resolveSibling(specifier, path) {
  const base = resolve(dirname(path), specifier);
  return base.endsWith(".js") ? base : `${base}.js`;
}

/**
 * Emit a module and everything it imports, as factory-body lines.
 *
 * Platform imports become `require` declarations in one prologue; relative
 * imports are inlined, because the bundle cannot resolve files. Every inlined
 * module lands in `state.directory`, which the bundle assembler flattens ahead
 * of the entry body — a shared sibling (`src/endpoint.js`, imported by both
 * halves of the client) is therefore emitted exactly once, and the bundle's
 * single factory scope holds one copy of it. Lines carry no indentation of
 * their own; the caller indents the whole bundle once.
 *
 * @param {string} path absolute path of the module to emit.
 * @param {object} state `{ directory: Map<string, object> }`.
 * @returns {{ prelude: string[], body: string[], exports: Set<string> }} this
 *   module's own lines — dependencies live in the directory, not in `body`.
 */
function emitModule(path, state) {
  const key = resolve(path);

  if (state.directory.has(key)) return { prelude: [], body: [], exports: state.directory.get(key).exports };
  const parsed = parseModule(path);
  const prelude = [];
  const body = [];
  const trailer = [];
  const exported = new Set();
  let declarations = false;

  for (const statement of parsed.imports) {
    if (isRelative(statement.specifier)) {
      if (statement.namespace !== null) {
        throw new Error(
          `scripts/build.mjs: ${relative(ROOT, path)} cannot inline "${statement.specifier}" through a namespace import; a bundle inline shares the factory's single scope`,
        );
      }
      const siblingPath = resolveSibling(statement.specifier, path);
      const sibling = emitModule(siblingPath, state);
      for (const { imported } of statement.bindings) {
        if (!sibling.exports.has(imported)) {
          throw new Error(
            `scripts/build.mjs: ${relative(ROOT, path)} imports "${imported}" from "${statement.specifier}", which does not declare it; an inlined bundle has no module scope to fall back on`,
          );
        }
      }
      prelude.push(...sibling.prelude);
      continue;
    }

    if (statement.namespace !== null) {
      prelude.push(`const ${statement.namespace} = require(${JSON.stringify(statement.specifier)});`);
      continue;
    }

    const bindings = statement.bindings
      .map(({ imported, local }) => (imported === local ? imported : `${imported}: ${local}`))
      .join(", ");
    prelude.push(`const { ${bindings} } = require(${JSON.stringify(statement.specifier)});`);
    declarations = true;
  }

  // A module with platform imports but no `const` before its first statement
  // would be hoisted next to those imports; keep them apart.
  if (declarations) prelude.push("");

  for (const name of findDeclarations(parsed.body)) exported.add(name);

  if (path === CLIENT_ENTRY) {
    if (exported.size === 0) {
      throw new Error(`scripts/build.mjs: ${relative(ROOT, path)} exports nothing; the bundle face would be empty`);
    }
    // The face is written as one object literal rather than a statement per
    // export: DSH materializes the client half and reads `apply`/`inject`
    // directly off it, so the members have to land on `module.exports` itself,
    // and naming them here keeps the registration readable. A namespace level
    // would leave the plugin loaded but inert.
    const face = [...exported].map((name) => `${JSON.stringify(name)}: ${name}`).join(", ");
    trailer.push("", `Object.assign(module.exports, { ${face} });`, "exports.default = module.exports;");
  }

  state.directory.set(key, { path, imports: parsed.imports, prelude, body: [...parsed.body, ...trailer], exports: exported });
  return { prelude, body, exports: exported };
}

/**
 * Flatten the inlined directory ahead of a module's own body.
 *
 * Every other module's declarations disappear from the face on purpose — their
 * bodies share the factory's single scope, and only the entry point's exports
 * reach the profile. Ordering is the module's own imports first, so a
 * declaration always precedes the code that reads it; a module reached twice is
 * written once.
 *
 * @param {object} state `{ seen: Set<string>, directory: Map<string, object> }`.
 * @param {string} path the module being assembled.
 * @param {Set<string>} written resolved keys already written.
 * @returns {string[]} flattened lines, dependencies first.
 */
function flattenDirectory(state, path, written) {
  const entry = state.directory.get(resolve(path));
  if (entry === undefined || written.has(resolve(path))) return [];
  written.add(resolve(path));

  const lines = [];
  for (const statement of (entry.imports ?? [])) {
    if (isRelative(statement.specifier)) {
      lines.push(...flattenDirectory(state, resolveSibling(statement.specifier, entry.path), written));
    }
  }
  lines.push("", `// ── inlined from ${relative(ROOT, entry.path)} ──`, ...entry.body);
  return lines;
}
/**
 * Bundle a module into a `window.__ModuleLoader__.load` registration.
 *
 * The body is indented one level, to the factory's own depth; the wrapper lines
 * around it are the shape every client bundle in this profile shares.
 *
 * @param {string} entry absolute path of the entry point.
 * @param {string} id the package name; the module-table key and the loader id.
 * @returns {string} the bundle's contents.
 */
export function buildBundle(entry, id) {
  const state = { directory: new Map() };
  const { prelude, body } = emitModule(entry, state);

  // Inlined siblings first, dependency-first, then the entry's own body. The
  // order is what makes one flat scope read like a module: every declaration
  // precedes the code that references it.
  const inlined = flattenDirectory(state, entry, new Set());
  const stripped = stripExportKeywords([...inlined, ...body].join("\n"), relative(ROOT, entry));
  const indent = (line) => (line.trim() === "" ? "" : `\t\t${line}`);
  const indented = stripped.split("\n").map(indent).join("\n").replace(/\s+$/, "");

  return [
    "window.__ModuleLoader__.load({",
    `\tid: ${JSON.stringify(id)},`,
    "\tfactory: (require) => {",
    "\t\tvar module = { exports: {} };",
    "\t\tvar exports = module.exports;",
    '\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
    "",
    ...prelude.map(indent),
    indented,
    "",
    "\t\treturn module.exports;",
    "\t},",
    "});",
    "",
  ].join("\n");
}

/**
 * Emit the host entry point, with explicit sibling specifiers.
 *
 * The entry point only re-exports the host module, so the rewrite is a naming
 * exercise: each relative re-export becomes an `export … from "./host.js"` in
 * its place, with the `.js` extension a published package should not have to
 * guess at. The specifier is kept as a re-export rather than split into an
 * import plus an export because the host half is a `type: module` package:
 * `require` does not exist there, and re-exporting needs no local binding.
 *
 * A platform specifier anywhere in the host half is a hard error — the host
 * process is the profile's own, and the browser half's runtime must never be
 * pulled into it.
 *
 * @param {string} entry absolute path of the host entry point.
 * @returns {{ contents: string, siblings: Map<string, string|null> }} the module and its siblings.
 */
export function buildHost(entry) {
  const where = relative(ROOT, entry);
  const parsed = parseModule(entry);
  const exported = new Set();
  const body = [];

  for (const statement of parsed.imports) {
    if (!isRelative(statement.specifier)) {
      throw new Error(
        `scripts/build.mjs: ${where} imports the platform specifier "${statement.specifier}"; the host half must not depend on it`,
      );
    }
    throw new Error(
      `scripts/build.mjs: ${where} imports "${statement.specifier}"; the host entry point re-exports instead, so the generated entry stays a flat module`,
    );
  }

  for (const line of parsed.body) {
    const matched = /^export\s*\{([^}]*)\}\s*from\s*["']([^"']+)["'];?$/i.exec(line.trim());
    if (matched === null) {
      body.push(line);
      continue;
    }
    if (!isRelative(matched[2])) {
      throw new Error(
        `scripts/build.mjs: ${where} re-exports the platform specifier "${matched[2]}"; the host half must not depend on it`,
      );
    }
    const names = matched[1]
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name !== "");
    if (names.length === 0) {
      throw new Error(`scripts/build.mjs: ${where} has an empty re-export: ${line.trim()}`);
    }
    const sibling = resolveSibling(matched[2], entry);
    const siblingPath = relative(ROOT, sibling);
    const declared = findDeclarations(readFileSync(sibling, "utf8").split("\n"));
    for (const name of names) {
      if (!declared.has(name)) {
        throw new Error(
          `scripts/build.mjs: ${where} re-exports "${name}" from "${matched[2]}", which does not declare it`,
        );
      }
      exported.add(name);
    }
    body.push("", `// ── inlined from ${siblingPath.replaceAll("\\", "/")} ──`);
    body.push(...collectHostModules(sibling));
  }

  if (exported.size === 0) {
    throw new Error(`scripts/build.mjs: ${where} re-exports nothing; the generated entry would be empty`);
  }

  const text = stripExportKeywords(body.join("\n"), where)
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\s+/, "")
    .replace(/\s+$/, "");
  return `${text}\n\nexport { ${[...exported].join(", ")} };\n`;
}

/**
 * Collect a host module and everything it imports, as flat ESM lines.
 *
 * The host half ships as a single `lib/host.js`: Cordis loads it in the
 * profile's own Node process, where a relative `import "./endpoint.js"` would
 * cost a second copy of the shared contract for no benefit, and where a
 * misplaced specifier is a load-time failure. Inlining keeps the published
 * package to one host file while the source stays split by responsibility.
 *
 * The walk is depth-first and dependency-first, so every binding a module's
 * body references is declared above it. A module reached twice is emitted once;
 * a module that cannot complete its own imports is a hard error, because the
 * flat output has no module scope to fall back on.
 *
 * @param {string} path absolute path of the module to collect.
 * @param {Set<string>} [seen] absolute paths already collected.
 * @returns {string[]} the module's lines, preceded by its dependencies'.
 */
function collectHostModules(path, seen = new Set()) {
  const key = resolve(path);
  if (seen.has(key)) return [];
  seen.add(key);

  const where = relative(ROOT, path);
  const parsed = parseModule(path);
  const lines = [];

  for (const statement of parsed.imports) {
    if (!isRelative(statement.specifier)) {
      throw new Error(
        `scripts/build.mjs: ${where} imports the platform specifier "${statement.specifier}"; the host half must not depend on it`,
      );
    }
    if (statement.namespace !== null) {
      throw new Error(
        `scripts/build.mjs: ${where} imports "${statement.specifier}" as a namespace; the flat host module has no module scope`,
      );
    }
    const sibling = resolveSibling(statement.specifier, path);
    const siblingPath = relative(ROOT, sibling);
    const declared = findDeclarations(readFileSync(sibling, "utf8").split("\n"));
    for (const { imported } of statement.bindings) {
      if (!declared.has(imported)) {
        throw new Error(
          `scripts/build.mjs: ${where} imports "${imported}" from "${statement.specifier}", which does not declare it; the flat host module has no module scope to fall back on`,
        );
      }
    }
    lines.push("", `// ── inlined from ${siblingPath.replaceAll("\\", "/")} ──`, ...collectHostModules(sibling, seen));
  }

  return [...lines, "", ...parsed.body];
}

/** Read the package name from the manifest, the bundle's single identity source. */
function packageId() {
  const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  if (typeof manifest.name !== "string" || manifest.name === "") {
    throw new Error("scripts/build.mjs: package.json has no name");
  }
  return manifest.name;
}

/** Build every artifact into a `path → contents` map, without writing. */
export function buildAll() {
  const id = packageId();
  const artifacts = new Map();

  artifacts.set(CLIENT_OUTPUT, buildBundle(CLIENT_ENTRY, id));
  artifacts.set(HOST_OUTPUT, buildHost(HOST_ENTRY));

  return artifacts;
}

/**
 * Verify every committed artifact against a fresh build.
 *
 * @param {Map<string, string>} [artifacts] a build to compare, for reuse by callers.
 * @throws when an artifact is missing or stale.
 */
export function checkAll(artifacts = buildAll()) {
  for (const [path, contents] of artifacts) {
    let current = null;
    try {
      current = readFileSync(path, "utf8");
    } catch {
      throw new Error(`scripts/build.mjs: ${relative(ROOT, path)} is missing; run \`npm run build\``);
    }
    if (current !== contents) {
      throw new Error(`scripts/build.mjs: ${relative(ROOT, path)} is out of date with src/; run \`npm run build\``);
    }
  }
  return [...artifacts.values()].reduce((total, contents) => total + Buffer.byteLength(contents, "utf8"), 0);
}

/** Write every artifact to disk. */
export function writeAll(artifacts = buildAll()) {
  mkdirSync(OUT, { recursive: true });
  for (const [path, contents] of artifacts) {
    writeFileSync(path, contents, "utf8");
    console.log(`build: wrote ${relative(ROOT, path)} (${Buffer.byteLength(contents, "utf8")} bytes)`);
  }
  return artifacts;
}

// Importing this module (the tests do, to compare against a fresh build) must
// not touch the working tree, so the build only runs when it is the entry point.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  if (process.argv.includes("--check")) {
    console.log(`build: lib/ is up to date with src/ (${checkAll()} bytes)`);
  } else {
    writeAll();
  }
}
