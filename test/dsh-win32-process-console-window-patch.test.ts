import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  CREATE_PROCESS_FLAGS,
  PATCHED_CREATE_PROCESS_FLAGS,
  patchCreateProcessSource
} = require("../scripts/patch-dsh-win32-process-console-window.cjs") as {
  CREATE_PROCESS_FLAGS: string;
  PATCHED_CREATE_PROCESS_FLAGS: string;
  patchCreateProcessSource(source: string): string;
};

test("console-window patch adds CREATE_NO_WINDOW to the ordinary command spawn", () => {
  const source = `before\n${CREATE_PROCESS_FLAGS}\nafter`;
  const patched = patchCreateProcessSource(source);

  assert.equal(patched, `before\n${PATCHED_CREATE_PROCESS_FLAGS}\nafter`);
  // CREATE_NO_WINDOW must ride the same dwCreationFlags argument, after CREATE_SUSPENDED.
  assert.ok(patched.includes("1028 | 0x08000000"));
  assert.ok(patched.includes("CREATE_NO_WINDOW"));
});

test("console-window patch leaves the restricted sandbox tokens alone", () => {
  // The ACL sandbox creates restricted-token processes with CreateProcessAsUserW; adding
  // CREATE_NO_WINDOW there kills them with STATUS_DLL_INIT_FAILED, so those calls keep
  // their own flags and must not match this anchor.
  const restricted = `api.createProcessAsUserW(options.token, null, commandLine, null, null, 1, creationFlags, null, options.cwd, startupInfo, processInfo)`;
  assert.throws(
    () => patchCreateProcessSource(restricted),
    /expected exactly one ordinary CreateProcessW call, found 0/
  );
});

test("console-window patch is idempotent", () => {
  const source = `before\n${PATCHED_CREATE_PROCESS_FLAGS}\nafter`;
  assert.equal(patchCreateProcessSource(source), source);
});

test("console-window patch fails when the upstream source changes", () => {
  assert.throws(
    () => patchCreateProcessSource("null, null, 1, 1028, environment and again null, null, 1, 1028, environment"),
    /expected exactly one ordinary CreateProcessW call, found 2/
  );
});
