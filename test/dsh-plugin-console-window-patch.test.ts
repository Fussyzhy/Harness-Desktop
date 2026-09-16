import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { PATCH_MARKER, patchPluginSource } = require(
  "../scripts/patch-dsh-plugin-console-window.cjs"
) as {
  PATCH_MARKER: string;
  patchPluginSource(source: string): string;
};

/** The upstream shape that matters: the pnpm forwarder's spawnSync options. */
function upstreamSource(indent = "\t\t\t"): string {
  return [
    '\t\tconst result = spawnSync("pnpm", args.map((argument) => anchorPathSpec(argument, process.cwd())), {',
    "\t\t\tcwd: dir,",
    `${indent}stdio: "inherit",`,
    `${indent}shell: process.platform === "win32"`,
    "\t\t});"
  ].join("\n");
}

test("plugin console-window patch hides the pnpm forwarder", () => {
  const patched = patchPluginSource(upstreamSource());

  assert.ok(patched.includes("windowsHide: true"));
  assert.ok(patched.includes(PATCH_MARKER));
  // The shell stays: it is what resolves pnpm.cmd on Windows.
  assert.ok(patched.includes('shell: process.platform === "win32"'));
  assert.ok(patched.includes('stdio: "inherit"'));
  assert.ok(patched.includes('\t\t\twindowsHide: true, '), "keeps the upstream indentation");
});

test("plugin console-window patch is idempotent", () => {
  const once = patchPluginSource(upstreamSource());
  assert.equal(patchPluginSource(once), once);
});

test("plugin console-window patch fails when the upstream shape changes", () => {
  const withoutShell = '\t\tconst result = spawnSync("pnpm", args, { cwd: dir });';
  assert.throws(
    () => patchPluginSource(withoutShell),
    /expected exactly one pnpm spawnSync options object, found 0/
  );
});

test("plugin console-window patch refuses an ambiguous source", () => {
  const twice = `${upstreamSource()}\n${upstreamSource()}`;
  assert.throws(
    () => patchPluginSource(twice),
    /expected exactly one pnpm spawnSync options object, found 2/
  );
});
