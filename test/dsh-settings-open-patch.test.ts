import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  NATIVE_COMMAND_RUNNER_OPTIONS,
  PATCHED_NATIVE_COMMAND_RUNNER_OPTIONS,
  PATCHED_SETTINGS_OPEN_TRY_BLOCK,
  SETTINGS_OPEN_TRY_BLOCK,
  patchNativeCommandSource,
  patchSettingsClientSource
} = require("../scripts/patch-dsh-settings-open.cjs") as {
  NATIVE_COMMAND_RUNNER_OPTIONS: string;
  PATCHED_NATIVE_COMMAND_RUNNER_OPTIONS: string;
  PATCHED_SETTINGS_OPEN_TRY_BLOCK: string;
  SETTINGS_OPEN_TRY_BLOCK: string;
  patchNativeCommandSource(source: string): string;
  patchSettingsClientSource(source: string): string;
};

test("settings client patch surfaces a rejected open operation", () => {
  const source = `before\n${SETTINGS_OPEN_TRY_BLOCK}\nafter`;
  const patched = patchSettingsClientSource(source);

  assert.equal(patched, `before\n${PATCHED_SETTINGS_OPEN_TRY_BLOCK}\nafter`);
  assert.match(patched, /catch \(error\)/);
  assert.match(patched, /state\.error = error instanceof Error/);
});

test("settings client patch is idempotent", () => {
  const source = `before\n${PATCHED_SETTINGS_OPEN_TRY_BLOCK}\nafter`;
  assert.equal(patchSettingsClientSource(source), source);
});

test("settings client patch fails when the upstream source changes", () => {
  assert.throws(
    () => patchSettingsClientSource("unexpected settings client source"),
    /settings open source changed/
  );
});

test("native command patch removes Electron Node mode from desktop commands", () => {
  const source = `before\n${NATIVE_COMMAND_RUNNER_OPTIONS}\nafter`;
  const patched = patchNativeCommandSource(source);

  assert.equal(
    patched,
    `before\n${PATCHED_NATIVE_COMMAND_RUNNER_OPTIONS}\nafter`
  );
  assert.match(patched, /ELECTRON_RUN_AS_NODE/);
});

test("native command patch is idempotent", () => {
  const source = `before\n${PATCHED_NATIVE_COMMAND_RUNNER_OPTIONS}\nafter`;
  assert.equal(patchNativeCommandSource(source), source);
});

test("native command patch fails when the upstream source changes", () => {
  assert.throws(
    () => patchNativeCommandSource("unexpected native command source"),
    /command runner source changed/
  );
});
