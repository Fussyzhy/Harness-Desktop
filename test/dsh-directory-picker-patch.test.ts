import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  EXTERNAL_VIEW_READ_UTF16,
  PATCHED_READ_UTF16,
  VULNERABLE_READ_UTF16,
  patchWorkerSource
} = require("../scripts/patch-dsh-directory-picker.cjs") as {
  EXTERNAL_VIEW_READ_UTF16: string;
  PATCHED_READ_UTF16: string;
  VULNERABLE_READ_UTF16: string;
  patchWorkerSource(source: string): string;
};

test("directory-picker patch decodes UTF-16 without an external buffer", () => {
  const source = `before\n${VULNERABLE_READ_UTF16}\nafter`;
  const patched = patchWorkerSource(source);

  assert.equal(patched, `before\n${PATCHED_READ_UTF16}\nafter`);
  assert.match(patched, /koffi\.decode\.string16\(address\)/);
  assert.doesNotMatch(patched, /koffi\.view/);
});

test("directory-picker patch replaces the earlier external-view workaround", () => {
  const source = `before\n${EXTERNAL_VIEW_READ_UTF16}\nafter`;

  assert.equal(
    patchWorkerSource(source),
    `before\n${PATCHED_READ_UTF16}\nafter`
  );
});

test("directory-picker patch is idempotent", () => {
  const source = `before\n${PATCHED_READ_UTF16}\nafter`;

  assert.equal(patchWorkerSource(source), source);
});

test("directory-picker patch fails when the upstream source changes", () => {
  assert.throws(
    () => patchWorkerSource("unexpected worker source"),
    /worker source changed/
  );
});
