/**
 * Guards that must hold for this package to stay installable by anyone who
 * clones the repository — no install step, no network, no assumptions about
 * the developer's machine.
 *
 * `npm test` already proves the behaviour; these checks cover the packaging
 * rules around it, so a fork or a CI run on a clean checkout fails loudly
 * instead of quietly producing a package DSH cannot load.
 *
 * Run with `node scripts/ci-guards.mjs` (or `npm run guards`). Exits 0 when
 * every guard holds, 1 with the failing guard named otherwise.
 */

import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root: this file lives in `<root>/scripts/`. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const failures = [];
const pass = (message) => console.log(`ci-guards: ok   ${message}`);
const fail = (message) => {
  failures.push(message);
  console.error(`ci-guards: FAIL ${message}`);
};

const read = (relative) => readFileSync(join(ROOT, relative), "utf8");
const manifest = JSON.parse(read("package.json"));

// ── 1. Dependency-free ──────────────────────────────────────────────────────
// DSH installs a plugin package from a tarball or a git checkout and does not
// run an install step for it, so a dependency here would be a plugin that
// fails to load on someone else's machine.
{
  const before = failures.length;
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    const names = Object.keys(manifest[field] ?? {});
    if (names.length > 0) fail(`${field} must stay empty, found ${names.join(", ")}`);
  }
  for (const lock of ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"]) {
    if (existsSync(join(ROOT, lock))) fail(`${lock} must not be committed; this package installs nothing`);
  }
  if (failures.length === before) pass("dependency-free: no dependency fields, no lockfiles");
}

// ── 2. One identity across the package, the patch and the bundle ────────────
// DSH keys the client module table by the package name, so these three names
// disagreeing is the failure that produces a plugin that loads but never runs.
{
  const before = failures.length;
  const bundle = read(manifest.exports["./client"]);
  const registration = bundle.match(/__ModuleLoader__\.load\(\{\s*id:\s*"([^"]+)"/);
  if (registration === null) {
    fail(`${manifest.exports["./client"]} contains no __ModuleLoader__.load({ id: … }) registration`);
  } else if (registration[1] !== manifest.name) {
    fail(`bundle module id "${registration[1]}" != package name "${manifest.name}"`);
  }

  // The patch row carries two names that mean different things: `name` is the
  // package DSH imports, `id` is the row id every other layer and every user
  // patch addresses this plugin by. Renaming either one is a breaking change,
  // so both are asserted here — a row id that silently drifts leaves a plugin
  // that loads but that nothing downstream can reach.
  const patch = read(manifest.dsh.bundle.patch);
  if (!new RegExp(`name:\\s*["']?${manifest.name}\\b`).test(patch)) {
    fail(`${manifest.dsh.bundle.patch} does not insert the package "${manifest.name}"`);
  }
  if (!/id:\s*["']?prompt-opt\b/.test(patch)) {
    fail(`${manifest.dsh.bundle.patch} does not insert the layer id "prompt-opt"`);
  }
  if (failures.length === before) {
    pass(`identity: package and bundle id "${manifest.name}", patch id "prompt-opt"`);
  }
}

// ── 3. Everything the manifest promises is actually in the repository ───────
{
  const before = failures.length;
  if (manifest.private === true) fail("private must not be true; this package is published and installed by name");
  if (manifest.type !== "module") fail(`type must be "module", found ${JSON.stringify(manifest.type)}`);
  if (!existsSync(join(ROOT, manifest.main))) fail(`main ${manifest.main} does not exist`);

  for (const [key, target] of Object.entries(manifest.exports ?? {})) {
    if (typeof target === "string" && !existsSync(join(ROOT, target))) {
      fail(`exports["${key}"] -> ${target} does not exist`);
    }
  }

  for (const entry of manifest.files ?? []) {
    const path = join(ROOT, entry);
    if (!existsSync(path)) {
      fail(`files entry "${entry}" does not exist`);
      continue;
    }
    // A directory entry must ship something, or the tarball silently loses it.
    if (statSync(path).isDirectory() && readdirSync(path).length === 0) {
      fail(`files entry "${entry}" is an empty directory`);
    }
  }
  if (failures.length === before) pass("manifest: every promised path exists, package is publishable");
}

// ── 4. The committed bundle is the output of the committed source ───────────
// `npm test` does this too; running it here means a CI job that only runs
// `node scripts/ci-guards.mjs` still cannot ship a stale artifact.
try {
  const { checkAll } = await import("./build.mjs");
  const bytes = checkAll();
  pass(`lib/ is the output of src/ (${bytes} bytes)`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

// ── 5. The two halves still agree on the route ──────────────────────────────
// The browser half fetches a path the host half registers. Both read it from
// src/endpoint.js, so the only way they can drift is if someone hard-codes one
// of them — which is exactly what this guard refuses.
{
  const before = failures.length;
  const declared = read("src/endpoint.js").match(/OPTIMIZE_PATH\s*=\s*["']([^"']+)["']/);
  if (declared === null) {
    fail("src/endpoint.js declares no OPTIMIZE_PATH");
  } else {
    const path = declared[1];
    const host = read(manifest.main);
    const client = read(manifest.exports["./client"]);
    for (const quote of ["'", '"', "`"]) {
      if (host.includes(`${quote}${path}${quote}`) && client.includes(`${quote}${path}${quote}`)) {
        pass(`route: both halves use "${path}"`);
        break;
      }
    }
    if (!host.includes(path)) fail(`the host half no longer registers "${path}"`);
    if (!client.includes(path)) fail(`the client bundle no longer fetches "${path}"`);
  }
}

// ── Report ─────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`\nci-guards: ${failures.length} guard(s) failed`);
  process.exit(1);
}
console.log("\nci-guards: all guards passed");
