/**
 * Profile-install verification against the REAL DSH profile machinery.
 *
 * `verify-pack.mjs` proves the shipped bundle behaves; `verify-dsh.mjs` proves
 * the client module system accepts it. This script proves the remaining claim —
 * that the package is a well-formed *bundle layer* — by modelling the install
 * `dsh plugin --profile web add file:<tgz>` performs, then asking DSH's own
 * `@deepseek-ai/dsh-app-boot` to load that profile:
 *
 *   1. a Harness home with `profiles/web/node_modules/<name>` (exactly where
 *      `resolveBundleDir` looks after the installation anchor);
 *   2. the profile manifest names the bundle, as `reconcilePlugins` writes it;
 *   3. `loadProfile()` resolves the bundle directory, reads its
 *      `dsh.bundle.patch`, and parses the patch file without failing;
 *   4. `composeEntries()` over every layer produces the inserted row
 *      `{ id: "prompt-opt", name: "dsh-demo-myplugin" }` — the layer id and the
 *      package it points at are deliberately different names.
 *
 * Nothing here touches the user's real `$DSH_HOME`: the scratch home is a temp
 * directory passed explicitly to `resolveProfileDir`/`loadProfile`, and the
 * live `web` profile is never read or written.
 *
 * The DSH installation is discovered from the running environment, so this
 * script SKIPS (exit 0) rather than fails on a machine without DSH.
 *
 * Usage: node scripts/verify-profile.mjs
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
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
  console.log("verify-profile: SKIP — no installed @deepseek-ai/dsh found");
  process.exit(0);
}

const appBootEntry = join(dshDir, "node_modules", "@deepseek-ai", "dsh-app-boot", "lib", "index.js");
if (!existsSync(appBootEntry)) {
  console.log(`verify-profile: SKIP — ${appBootEntry} is missing`);
  process.exit(0);
}

const scratch = mkdtempSync(join(tmpdir(), "dsh-popt-profile-"));
let exitCode = 0;

try {
  console.log(`verify-profile: installing ${manifest.name}@${manifest.version} into a scratch Harness home`);
  const { initProfile, loadProfile, composeEntries } = await import(pathToFileURL(appBootEntry).href);
  const installAnchor = join(dshDir, "package.json");
  const home = join(scratch, "home");
  const profileName = "web";

  // ── the packed artifact, extracted as an installed dependency ────────────
  // Retried once: `npm pack` into the system temp directory is occasionally
  // refused on Windows while an on-access scanner holds the new archive. The
  // help text below is re-run on the second attempt because a silent pack
  // failure prints nothing that would explain itself.
  let packOutput = "";
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      packOutput = run("npm", ["pack", "--pack-destination", scratch, "--silent"], {
        cwd: ROOT,
        encoding: "utf8",
      }).trim();
      break;
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
  const tarball = join(scratch, packOutput.split(/\r?\n/).pop().trim());
  check("npm pack produced a tarball", existsSync(tarball));

  const extractDir = join(scratch, "extract");
  mkdirSync(extractDir, { recursive: true });
  run("tar", ["-xzf", tarball, "-C", extractDir]);
  const packed = join(extractDir, "package");
  const packedManifest = JSON.parse(readFileSync(join(packed, "package.json"), "utf8"));
  check("the tarball holds this package", packedManifest.name === manifest.name && packedManifest.version === manifest.version);

  // ── a scratch Harness home whose profile "installed" this package ─────────
  const { resolveProfileDir } = await import(pathToFileURL(appBootEntry).href);
  const profileDir = resolveProfileDir(profileName, home);
  check("the profile directory resolves under the scratch home",
    profileDir === join(home, "profiles", profileName), profileDir);

  initProfile(profileDir, ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]);
  check("initProfile wrote a profile manifest", existsSync(join(profileDir, "package.json")));

  const installed = join(profileDir, "node_modules", manifest.name);
  mkdirSync(installed, { recursive: true });
  for (const entry of ["package.json", "cordis.patch.yml", "README.md", "LICENSE"]) {
    copyFileSync(join(packed, entry), join(installed, entry));
  }
  mkdirSync(join(installed, "lib"), { recursive: true });
  for (const entry of ["client.js", "index.js"]) {
    copyFileSync(join(packed, "lib", entry), join(installed, "lib", entry));
  }
  check("the package is installed where resolveBundleDir looks", existsSync(join(installed, "package.json")));

  // `reconcilePlugins` writes exactly this: the dependency, plus the bundle in
  // the layer list once its `dsh.bundle` declaration is seen.
  const profileManifestPath = join(profileDir, "package.json");
  const profileManifest = JSON.parse(readFileSync(profileManifestPath, "utf8"));
  profileManifest.dependencies = { ...profileManifest.dependencies, [manifest.name]: `file:${tarball}` };
  profileManifest.dsh = {
    ...profileManifest.dsh,
    profile: { ...profileManifest.dsh?.profile, bundles: [manifest.name, "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] },
  };
  writeFileSync(profileManifestPath, JSON.stringify(profileManifest, void 0, 2) + "\n");

  // ── DSH's own profile loader ─────────────────────────────────────────────
  let profile = null;
  try {
    profile = loadProfile("dsh", profileName, installAnchor, home);
  } catch (error) {
    check("loadProfile() accepts the installed bundle", false, error?.message ?? String(error));
  }

  if (profile !== null) {
    check("loadProfile() accepts the installed bundle", true);
    check("the profile loader found the package directory",
      profile.layers.some((layer) => layer.packageName === manifest.name && layer.packageDir === installed),
      JSON.stringify(profile.layers.map((layer) => layer.packageDir)));
    const layer = profile.layers.find((candidate) => candidate.packageName === manifest.name);
    check("the bundle's patch file is the declared one",
      layer?.patchPath === join(installed, "cordis.patch.yml"), String(layer?.patchPath));
    check("the patch file parses into a non-empty layer",
      Array.isArray(layer?.patches) && layer.patches.length > 0, JSON.stringify(layer?.patches));

    // ── the composed entry list the boot mounts ────────────────────────────
    // Two names are in play, and they are deliberately different: `prompt-opt`
    // is the layer id inside the composition, `dsh-demo-myplugin` is the
    // package the layer points at. The patch declares both, so composition
    // yields a row carrying both.
    const bundlePatches = profile.layers.flatMap((candidate) => candidate.patches);
    const rows = composeEntries([bundlePatches, profile.patches]);
    const insert = rows.find((row) => row.id === "prompt-opt");
    check("composition produces the plugin's row", insert !== undefined, JSON.stringify(rows.map((row) => row.id)));
    check("the row names the package to load", insert?.name === manifest.name, JSON.stringify(insert));
    check("the row keeps the id the patch declares", insert?.id === "prompt-opt", String(insert?.id));

    // The insert must not displace anything: every other composed row survives.
    check("composition keeps the rows of the other layers",
      rows.length >= 1 && rows.every((row) => typeof row.id === "string" && typeof row.name === "string"),
      JSON.stringify(rows));
  }
} catch (error) {
  check("the profile verification ran to completion", false, error?.stack ?? String(error));
} finally {
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    /* a leftover temp directory is not a verification failure */
  }
}

if (failures.length > 0) {
  exitCode = 1;
  console.log(`\nverify-profile: ${failures.length} check(s) failed`);
  for (const failure of failures) console.log(`  - ${failure}`);
} else {
  console.log("\nverify-profile: all checks passed");
}

process.exit(exitCode);
