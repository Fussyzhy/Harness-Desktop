import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  SUPPORTED_DSH_VERSION,
  readInstalledDshVersion
} from "../src/dsh-profile.js";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function readPackageJson(): {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
} {
  return JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
}

/**
 * `createWebProfile` only invents a `web` profile while the installed dsh is the
 * release whose template this repository mirrors. A constant that drifted behind
 * the dependency does not fail: it silently turns profile creation off, and a
 * fresh machine then boots with none of the bundled plugins.
 *
 * The mirror is intentionally hand-written (importing dsh's own boot package
 * into this application's dependency graph would drag the whole Loader with it),
 * so these tests are what keeps it honest.
 */
test("the mirrored profile template tracks the pinned dsh release", () => {
  const manifest = readPackageJson();
  const pinned = manifest.dependencies["@deepseek-ai/dsh"];

  assert.equal(pinned, SUPPORTED_DSH_VERSION);
  // A range would let a newer dsh arrive without the template being re-checked.
  assert.match(pinned, /^\d+\.\d+\.\d+/, "the dsh dependency must be pinned exactly");
  assert.ok(
    !pinned.startsWith("^") && !pinned.startsWith("~"),
    "the dsh dependency must not be a range"
  );
});

test("the installed dsh release is the one the profile template was verified against", () => {
  assert.equal(readInstalledDshVersion(), SUPPORTED_DSH_VERSION);
});
