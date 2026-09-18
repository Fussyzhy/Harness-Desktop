import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildModlensConfigArgs,
  describeModlensDoctor,
  normalizeModlensChanges,
  resolveModlensCliCandidates,
  runModlensCli
} from "../src/modlens-cli.js";

function makeTempDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(path.join(tmpdir(), "harness-desktop-modlens-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** A dsh home whose `web` profile carries the plugin's CLI. */
function createHomeWithProfileCopy(t: { after: (fn: () => void) => void }): {
  home: string;
  cliPath: string;
} {
  const home = makeTempDir(t);
  const cliPath = path.join(
    home,
    "profiles",
    "web",
    "node_modules",
    "@liustack",
    "modlens",
    "dist",
    "main.js"
  );
  mkdirSync(path.dirname(cliPath), { recursive: true });
  writeFileSync(cliPath, "// probe");
  return { home, cliPath };
}

test("the settings window tries the copy that is actually running first", (t) => {
  const { home, cliPath } = createHomeWithProfileCopy(t);
  const dir = makeTempDir(t);
  const manifestPath = path.join(dir, "node_modules", "@liustack", "modlens", "package.json");
  const bundled = path.join(path.dirname(manifestPath), "dist", "main.js");
  mkdirSync(path.dirname(bundled), { recursive: true });
  writeFileSync(manifestPath, "{}");
  writeFileSync(bundled, "// probe");

  // The profile copy is the version dsh mounts, so its key set is the one the
  // running plugin reads; the bundled copy is the fallback that has its own
  // dependencies beside it.
  assert.deepEqual(
    resolveModlensCliCandidates({
      home,
      requireFn: { resolve: () => manifestPath }
    }),
    [cliPath, bundled]
  );
});

test("the settings window falls back to this package's own copy", (t) => {
  const dir = makeTempDir(t);
  const manifestPath = path.join(dir, "node_modules", "@liustack", "modlens", "package.json");
  const cliPath = path.join(path.dirname(manifestPath), "dist", "main.js");
  mkdirSync(path.dirname(cliPath), { recursive: true });
  writeFileSync(manifestPath, "{}");
  writeFileSync(cliPath, "// probe");

  // A profile this application did not prepare (an unsupported dsh release
  // skips setup entirely) must still let the page open.
  assert.deepEqual(
    resolveModlensCliCandidates({
      home: path.join(dir, "empty-home"),
      requireFn: { resolve: () => manifestPath }
    }),
    [cliPath]
  );
});

test("the settings window reports a plugin it cannot find", (t) => {
  const dir = makeTempDir(t);

  assert.deepEqual(
    resolveModlensCliCandidates({
      home: path.join(dir, "empty-home"),
      requireFn: {
        resolve: () => {
          throw new Error("MODULE_NOT_FOUND");
        }
      }
    }),
    []
  );
});

test("a secret is written through stdin instead of the command line", () => {
  // A key on the command line is visible to every process on the machine, which
  // is the reason the plugin prompts for it without echo.
  assert.deepEqual(
    buildModlensConfigArgs({ key: "openai.apiKey", value: "sk-live", secret: true }),
    ["config", "set", "openai.apiKey"]
  );
  assert.deepEqual(buildModlensConfigArgs({ key: "openai.model", value: "gpt-4o" }), [
    "config",
    "set",
    "openai.model",
    "gpt-4o"
  ]);
  // An empty argument is how the CLI is told to clear a setting; a secret with
  // no value has nothing to send, so it stays off the command line too.
  assert.deepEqual(buildModlensConfigArgs({ key: "proxy", value: "" }), [
    "config",
    "set",
    "proxy",
    ""
  ]);
  assert.deepEqual(buildModlensConfigArgs({ key: "openai.apiKey", value: "", secret: true }), [
    "config",
    "set",
    "openai.apiKey"
  ]);
});

test("the renderer cannot hand the CLI a flag", () => {
  // Whatever arrives over IPC becomes an argument of a spawned process, so the
  // shape is checked here: nothing that could be read as an option gets through.
  assert.deepEqual(
    normalizeModlensChanges([
      { key: "provider", value: "gemini-api" },
      { key: "--version", value: "x" },
      { key: "openai.model", value: "--help" },
      { key: "bad key", value: "x" },
      { key: "", value: "x" },
      { key: 42, value: "x" },
      null,
      { key: "reuse.claude", value: "true" }
    ]),
    [
      { key: "provider", value: "gemini-api", secret: false },
      { key: "reuse.claude", value: "true", secret: false }
    ]
  );

  assert.deepEqual(normalizeModlensChanges("not an array"), []);
  assert.deepEqual(
    normalizeModlensChanges([{ key: "openai.extraBody", value: "x".repeat(5000) }]),
    []
  );
});

test("a run hands the secret to the CLI on stdin and leaves it off the argv", async (t) => {
  const dir = makeTempDir(t);
  const stub = path.join(dir, "stub.cjs");
  // Stands in for the plugin's CLI: it reports exactly what it was started with.
  writeFileSync(
    stub,
    [
      'let input = "";',
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", (chunk) => { input += chunk; });',
      'process.stdin.on("end", () => {',
      '  process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), stdin: input.trim() }));',
      "});"
    ].join("\n")
  );

  const secret = await runModlensCli(buildModlensConfigArgs({ key: "openai.apiKey", value: "sk-live-123", secret: true }), {
    cliPath: stub,
    electronPath: process.execPath,
    secret: "sk-live-123"
  });
  const seen = JSON.parse(secret.output) as { argv: string[]; stdin: string };
  // The whole point of the stdin path: a process list on the same machine would
  // otherwise show the credential.
  assert.deepEqual(seen.argv, ["config", "set", "openai.apiKey"]);
  assert.equal(seen.stdin, "sk-live-123");

  const plain = await runModlensCli(buildModlensConfigArgs({ key: "openai.model", value: "gpt-4o" }), {
    cliPath: stub,
    electronPath: process.execPath
  });
  const plainSeen = JSON.parse(plain.output) as { argv: string[]; stdin: string };
  assert.deepEqual(plainSeen.argv, ["config", "set", "openai.model", "gpt-4o"]);
  assert.equal(plainSeen.stdin, "");
  assert.equal(plain.code, 0);
});

test("a doctor report is read into the shape the page renders", () => {
  const report = describeModlensDoctor(
    JSON.stringify({
      node: { version: "v22.23.1", minimum: "22.19", meetsMinimum: true },
      nodeSqlite: { available: true },
      config: { path: "C:\\Users\\me\\.modlens\\config.json", exists: true },
      selection: { provider: "gemini-api", source: "config" },
      providers: [
        {
          name: "gemini-api",
          kind: "api",
          ready: true,
          status: "ready",
          settings: [
            { field: "apiKey", present: true, source: "file" },
            { field: "model", present: false, source: "missing" }
          ]
        },
        { name: "claude-cli", kind: "subprocess", ready: false, status: "missing", detail: "claude not on PATH", fix: "install claude" }
      ],
      cooldown: { enabled: true },
      reuse: { decisions: { claude: "granted", codex: "not asked" } }
    })
  );

  assert.equal(report?.configPath, "C:\\Users\\me\\.modlens\\config.json");
  assert.equal(report?.selection, "gemini-api");
  assert.equal(report?.nodeMeetsMinimum, true);
  assert.equal(report?.cooldownEnabled, true);
  assert.deepEqual(report?.providers, [
    {
      name: "gemini-api",
      kind: "api",
      ready: true,
      status: "ready",
      detail: undefined,
      fix: undefined,
      // Whether a field is already set is what lets the form say "leave it
      // blank to keep it" instead of asking for a secret the CLI never returns.
      settings: [
        { field: "apiKey", present: true },
        { field: "model", present: false }
      ]
    },
    {
      name: "claude-cli",
      kind: "subprocess",
      ready: false,
      status: "missing",
      detail: "claude not on PATH",
      fix: "install claude",
      settings: []
    }
  ]);
  assert.deepEqual(report?.reuse, [
    { harness: "claude", decision: "granted" },
    { harness: "codex", decision: "not asked" }
  ]);
});

test("an unreadable doctor report leaves the page with nothing to render rather than failing it", () => {
  // The report belongs to the plugin: a release that renames a field must leave
  // the page usable instead of throwing on the way in.
  assert.equal(describeModlensDoctor("not json"), undefined);
  assert.equal(describeModlensDoctor("[]"), undefined);
  assert.deepEqual(describeModlensDoctor("{}"), {
    nodeVersion: undefined,
    nodeMeetsMinimum: undefined,
    nodeSqlite: undefined,
    configPath: undefined,
    selection: undefined,
    providers: [],
    cooldownEnabled: undefined,
    reuse: []
  });
  assert.equal(describeModlensDoctor(JSON.stringify({ providers: [null, { name: 7 }] }))?.providers.length, 0);
});
