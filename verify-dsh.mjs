/**
 * Composition verification against the REAL DSH client module system.
 *
 * `verify-pack.mjs` proves the shipped bundle behaves correctly when a stub
 * loader runs it. This script proves the stronger claim: DSH's own
 * `ClientModuleRegistry` — the service the web profile activates — accepts this
 * package and emits a boot row for it. It imports that service from the
 * installed DSH, points it at an extracted copy of the package through a real
 * `require.resolve` anchor, and asserts:
 *
 *   1. the package composes without a MissingClientBundle / composition error;
 *   2. its graph row is `{ id: <package name>, url: "/plugins/<name>/client.js?rev=…" }`;
 *   3. the row carries no `external` edges (nothing but the shell baseline);
 *   4. `bootInjections()` produces the queue script, the parser preloads, and
 *      the `__DSH_BOOT__` global carrying that row.
 *
 * The DSH installation is discovered from the running environment, so this
 * script SKIPS (exit 0) rather than fails on a machine without DSH.
 *
 * Usage: node scripts/verify-dsh.mjs
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
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

/** Quote one argument for cmd.exe, so no shell is needed to reach npm/tar. */
function quote(argument) {
  return /[\s"^&|<>]/.test(argument) ? `"${argument.replace(/"/g, '""')}"` : argument;
}

function run(command, args, options = {}) {
  if (process.platform !== "win32") return execFileSync(command, args, { ...options, shell: false });
  const line = [command, ...args].map(quote).join(" ");
  return execFileSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", line], {
    ...options,
    shell: false,
    windowsVerbatimArguments: true,
  });
}

/** Locate the installed DSH CLI, or null when it is not present. */
function findDsh() {
  const candidates = [];
  if (process.env.APPDATA !== undefined) {
    candidates.push(join(process.env.APPDATA, "npm", "node_modules", "@deepseek-ai", "dsh"));
  }
  candidates.push(join(process.env.HOME ?? "", "node_modules", "@deepseek-ai", "dsh"));
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "package.json"))) return candidate;
  }
  return null;
}

const dshDir = findDsh();
if (dshDir === null) {
  console.log("verify-dsh: SKIP — no installed @deepseek-ai/dsh found");
  process.exit(0);
}

const modulesEntry = join(dshDir, "node_modules", "@deepseek-ai", "dsh-client-modules", "lib", "index.js");
if (!existsSync(modulesEntry)) {
  console.log(`verify-dsh: SKIP — ${modulesEntry} is missing`);
  process.exit(0);
}

const scratch = mkdtempSync(join(tmpdir(), "dsh-popt-compose-"));
let exitCode = 0;

try {
  console.log(`verify-dsh: composing ${manifest.name}@${manifest.version} with ${dshDir}`);

  // ── a real package directory, reachable through a real resolver ──────────
  const packOutput = run("npm", ["pack", "--pack-destination", scratch, "--silent"], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
  const tarball = join(scratch, packOutput.split(/\r?\n/).pop().trim());
  check("npm pack produced a tarball", existsSync(tarball));

  // The package goes into the anchor's node_modules, so `require.resolve`
  // walks to it exactly as it walks to a profile-installed dependency.
  const anchorDir = join(scratch, "profile");
  const installed = join(anchorDir, "node_modules", manifest.name);
  mkdirSync(installed, { recursive: true });
  run("tar", ["-xzf", tarball, "-C", installed, "--strip-components", "1"], { encoding: "utf8" });

  const anchor = join(anchorDir, "package.json");
  writeFileSync(anchor, "{}\n");
  const require_ = createRequire(anchor);
  const resolved = require_.resolve(`${manifest.name}/package.json`);
  check("the profile-style resolver finds the installed package", resolved.startsWith(installed), resolved);

  // ── the real service, on a real Cordis context ───────────────────────────
  const { ClientModuleRegistry } = await import(pathToFileURL(modulesEntry).href);
  const { Context } = await import(
    pathToFileURL(join(dshDir, "node_modules", "@deepseek-ai", "cordis", "lib", "index.js")).href
  );

  const entryName = manifest.name;
  const loaderEntries = [{ options: { name: entryName }, fiber: {}, disabled: false }];
  const effects = [];
  const registeredRoutes = [];
  const ctx = new Context();
  ctx.baseUrl = anchor;
  // `webServer` and `loader` are the registry's declared injections. Providing
  // them as plain properties keeps the real service's own construction path
  // (its `provide()`, its activation flush, its route registration) intact.
  ctx.webServer = { register: (route) => { registeredRoutes.push(route); return () => {}; } };
  ctx.loader = { entries: () => loaderEntries };
  ctx.effect = (setup) => {
    const dispose = setup();
    effects.push(typeof dispose === "function" ? dispose : () => {});
    return () => {};
  };

  let registry = null;
  try {
    registry = new ClientModuleRegistry(ctx);
  } catch (error) {
    check("the package composes into the client module registry", false, error?.message ?? String(error));
  }

  if (registry !== null) {
    check("the package composes into the client module registry", true);
    check("the registry registers its /plugins bundle route",
      registeredRoutes.some((route) => route.path === "/plugins"), JSON.stringify(registeredRoutes));

    const graph = registry.graph();
    const row = graph.entries.find((entry) => entry.id === entryName);
    check("the graph carries a row for this package", row !== undefined, JSON.stringify(graph.entries.map((e) => e.id)));
    check("the row id is the package name", row?.id === manifest.name);
    check("the row url is the /plugins bundle route with a rev",
      /^\/plugins\/.+\/client\.js\?rev=[0-9a-f]{12}$/.test(row?.url ?? ""), String(row?.url));
    check("the rev matches the shipped bundle's content hash",
      row?.rev === createHash("sha1").update(readFileSync(registry.clientPath(entryName))).digest("hex").slice(0, 12),
      String(row?.rev));
    check("the row declares no external module edges", row?.external === undefined, JSON.stringify(row?.external));
    check("the registry resolves a bundle path for the entry",
      existsSync(registry.clientPath(entryName) ?? ""), String(registry.clientPath(entryName)));

    // ── the boot rows the HTML receives ────────────────────────────────────
    const { bootInjections } = await import(pathToFileURL(modulesEntry).href);
    const rows = bootInjections(graph);
    check("boot rows start with the registration queue script",
      rows[0]?.kind === "script" && /__ModuleLoader__/.test(rows[0]?.text ?? ""));
    check("the boot global carries the composed graph",
      rows.some((row) => row.kind === "global" && row.name === "__DSH_BOOT__"));
    check("the boot graph includes this package's row",
      rows.find((row) => row.name === "__DSH_BOOT__")?.value?.entries?.some((entry) => entry.id === manifest.name) === true);
    // Parser preloads belong to the module-system and runtime packages, which
    // are not part of this synthetic single-entry graph — asserting their
    // absence here documents that, rather than pretending they were composed.
    check("this package is not itself a parser preload",
      rows.every((row) => row.src === undefined || !row.src.includes(entryName)),
      JSON.stringify(rows.map((row) => row.src ?? row.kind)));

    // ── the exact bytes the browser downloads ──────────────────────────────
    const response = { status: 0, headers: null, body: null };
    const res = {
      writeHead(status, headers) {
        response.status = status;
        response.headers = headers ?? null;
      },
      end(body) {
        response.body = body ?? null;
      },
    };
    await registry.serveBundle({ method: "GET", url: row.url }, res);
    check("the bundle route answers 200", response.status === 200, String(response.status));
    check("the bundle is served as JavaScript",
      String(response.headers?.["content-type"] ?? "").startsWith("text/javascript"),
      String(response.headers?.["content-type"]));
    check("the served bytes are the shipped bundle, byte for byte",
      Buffer.isBuffer(response.body) && response.body.equals(readFileSync(registry.clientPath(entryName))));
  }
} catch (error) {
  failures.push(`threw: ${error?.stack ?? error}`);
  console.log(`  FAIL  threw: ${error?.message ?? error}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log("");
if (failures.length === 0) {
  console.log("verify-dsh: all checks passed");
} else {
  console.log(`verify-dsh: ${failures.length} check(s) failed`);
  for (const failure of failures) console.log(`  - ${failure}`);
  exitCode = 1;
}
process.exit(exitCode);
