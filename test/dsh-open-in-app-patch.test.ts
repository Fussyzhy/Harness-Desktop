import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  BUNDLED_LAUNCH_ENV_BLOCK,
  PATCHED_BUNDLED_LAUNCH_ENV_BLOCK,
  PATCHED_SOURCE_LAUNCH_ENV_BLOCK,
  SOURCE_LAUNCH_ENV_BLOCK,
  patchEntrySource,
  patchResolverSource
} = require("../scripts/patch-dsh-open-in-app.cjs") as {
  BUNDLED_LAUNCH_ENV_BLOCK: string;
  PATCHED_BUNDLED_LAUNCH_ENV_BLOCK: string;
  PATCHED_SOURCE_LAUNCH_ENV_BLOCK: string;
  SOURCE_LAUNCH_ENV_BLOCK: string;
  patchEntrySource(source: string): string;
  patchResolverSource(source: string): string;
};

test("bundled entry patch drops Electron Node mode from the launched app", () => {
  const source = `before\n${BUNDLED_LAUNCH_ENV_BLOCK}\nafter`;
  const patched = patchEntrySource(source);

  assert.equal(patched, `before\n${PATCHED_BUNDLED_LAUNCH_ENV_BLOCK}\nafter`);
  assert.match(patched, /ELECTRON_RUN_AS_NODE/);
  // The adapter's own entries must still merge after the scrubbed parent base,
  // because GitHub Desktop asks for ELECTRON_RUN_AS_NODE deliberately.
  assert.ok(
    patched.indexOf("...options.env") >
      patched.indexOf("ELECTRON_RUN_AS_NODE")
  );
});

test("bundled entry patch is idempotent", () => {
  const source = `before\n${PATCHED_BUNDLED_LAUNCH_ENV_BLOCK}\nafter`;
  assert.equal(patchEntrySource(source), source);
});

test("bundled entry patch fails when the upstream source changes", () => {
  assert.throws(
    () => patchEntrySource("unexpected open-in-app entry source"),
    /lib\/index\.js launch environment changed/
  );
});

test("readable resolver patch drops Electron Node mode from the launched app", () => {
  const source = `before\n${SOURCE_LAUNCH_ENV_BLOCK}\nafter`;
  const patched = patchResolverSource(source);

  assert.equal(patched, `before\n${PATCHED_SOURCE_LAUNCH_ENV_BLOCK}\nafter`);
  assert.match(patched, /ELECTRON_RUN_AS_NODE/);
  assert.ok(
    patched.indexOf("...options.env,") >
      patched.indexOf("ELECTRON_RUN_AS_NODE")
  );
});

test("readable resolver patch is idempotent", () => {
  const source = `before\n${PATCHED_SOURCE_LAUNCH_ENV_BLOCK}\nafter`;
  assert.equal(patchResolverSource(source), source);
});

test("readable resolver patch fails when the upstream source changes", () => {
  assert.throws(
    () => patchResolverSource("unexpected open-in-app resolver source"),
    /lib\/types\/resolver\.js launch environment changed/
  );
});
