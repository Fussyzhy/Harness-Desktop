import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * The peer-range helper behind an install's compatibility step.
 *
 * A packaged Harness Desktop ships no npm and no corepack, so the one semver
 * question this application has to answer by itself — "does the version a
 * plugin resolves satisfy the range the plugin declared?" — is answered in
 * `plugins/dsh-plugin-manager/dsh/plugin-peers.js`. The expectations below were
 * read off `semver@7.8.5`, the version this repository's tree carries, so a
 * regression here cannot hide behind a hand-written idea of prerelease
 * ordering.
 */

const PROJECT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PEERS_PATH = path.join(
  PROJECT_ROOT,
  "plugins",
  "dsh-plugin-manager",
  "dsh",
  "plugin-peers.js"
);

interface PeerVerdict {
  name: string;
  range: string;
  resolved: string | null;
  status: string;
  spec?: string;
  skipped?: string;
}

interface PeerModule {
  satisfies(version: string, range: string): boolean | undefined;
  compareVersions(left: string, right: string): number | undefined;
  specPackageName(spec: string): string | undefined;
  planPeerRepairs(options: {
    pluginDir?: string;
    manifest?: unknown;
    resolvePeer?: (name: string) => string | undefined;
  }): { name: string; peers: PeerVerdict[]; repairs: string[] };
  auditableSpecNames(specs: string[], modulesDir: string): string[];
}

let cached: Promise<PeerModule> | undefined;

/** Load the shipped module the way the host half does, without a build step. */
function loadPeers(): Promise<PeerModule> {
  cached ??= import(pathToFileURL(PEERS_PATH).href) as Promise<PeerModule>;
  return cached;
}

test("the range grammar follows semver", async () => {
  const peers = await loadPeers();

  const cases: [string, string, boolean][] = [
    // The real case: a plugin built against the `0.1.0-rc` line is not
    // satisfied by the line this application runs.
    ["0.1.6-alpha.1", "^0.1.0-rc.6", false],
    ["0.1.0-rc.8", "^0.1.0-rc.6", true],
    ["0.1.6-alpha.1", "^0.1.5-alpha.1", false],
    ["0.1.1-rc.1", "^0.1.0-rc.7 || ^0.1.1-rc.2 || ^0.1.2-alpha.2", false],
    ["0.1.0-rc.8", "^0.1.0-rc.6 || ^0.1.6-alpha.1", true],
    // A prerelease never satisfies a range that does not name one, `*` included.
    ["0.1.6-alpha.1", "*", false],
    ["0.1.6-alpha.1", "", false],
    ["1.2.3", "*", true],
    ["0.1.6-alpha.1", ">=0.1.1-rc.1", false],
    ["0.1.0-rc.8", ">=0.1.1-rc.1", false],
    ["0.1.6-alpha.1", "0.1.5-alpha.1", false],
    ["0.1.5-alpha.1", "0.1.5-alpha.1", true],
    // Partial versions and the plain operators.
    ["1.2.3", "^1.2", true],
    ["2.0.0", "^1.2", false],
    ["1.2.0", "~1.2", true],
    ["3.18.2", "^3.18.0", true],
    ["4.0.2", "^4.0.1", true],
    ["18.2.0", "^18.2.0", true],
    ["1.2.3", "1.2", true],
    ["1.3.0", "1.2", false],
    ["2.0.0", ">1.0.0 <2.0.0", false],
    ["1.5.0", ">=1.0.0 <2.0.0", true]
  ];

  for (const [version, range, expected] of cases) {
    assert.equal(
      peers.satisfies(version, range),
      expected,
      `${version} against ${JSON.stringify(range)}`
    );
  }
});

test("an unsupported range is reported as unknown, never as a mismatch", async () => {
  const peers = await loadPeers();

  // A hyphen range is outside the supported grammar. Answering `false` would
  // send the plugin's peer to the registry on the strength of a guess.
  assert.equal(peers.satisfies("1.2.3", "1.2.3 - 2.0.0"), undefined);
  assert.equal(peers.satisfies("not-a-version", "^1.0.0"), undefined);
});

test("versions order the way semver orders them", async () => {
  const peers = await loadPeers();

  assert.equal(peers.compareVersions("1.2.3", "1.2.4"), -1);
  assert.equal(peers.compareVersions("1.2.3", "1.2.3"), 0);
  // A prerelease ranks below its own release, and above the previous one.
  assert.equal(peers.compareVersions("1.2.3-rc.1", "1.2.3"), -1);
  assert.equal(peers.compareVersions("1.2.3-rc.10", "1.2.3-rc.2"), 1);
  assert.equal(peers.compareVersions("1.2.3-alpha.1", "1.2.3-beta.1"), -1);
  assert.equal(peers.compareVersions("1.2.3-alpha", "1.2.3-alpha.1"), -1);
  assert.equal(peers.compareVersions("garbage", "1.2.3"), undefined);
});

test("only a registry spec has a package name the audit can trust", async () => {
  const peers = await loadPeers();

  assert.equal(peers.specPackageName("dsh-free-search"), "dsh-free-search");
  assert.equal(peers.specPackageName("dsh-live2d-pets@0.2.2"), "dsh-live2d-pets");
  assert.equal(
    peers.specPackageName("@a9i5k4/dsh-draw-gacha@^1.0.0"),
    "@a9i5k4/dsh-draw-gacha"
  );

  // Everything whose installed name pnpm decides: an alias, a path, a tarball,
  // a git host. These are installed, just not audited.
  for (const spec of [
    "link:../pet",
    "file:./pet.tgz",
    "npm:other-package@1.0.0",
    "https://example.test/pet.tgz",
    "github:user/repo",
    "../pet",
    "-not-a-spec"
  ]) {
    assert.equal(peers.specPackageName(spec), undefined, spec);
  }
});

test("a peer the installation does not satisfy becomes a companion spec", async () => {
  const peers = await loadPeers();

  const plan = peers.planPeerRepairs({
    manifest: {
      name: "dsh-live2d-pets",
      peerDependencies: {
        "@deepseek-ai/dsh-settings": "^0.1.0-rc.6",
        "@deepseek-ai/cordis": "^4.0.1"
      }
    },
    resolvePeer: (name) =>
      name === "@deepseek-ai/cordis" ? "4.0.2" : "0.1.6-alpha.1"
  });

  assert.equal(plan.name, "dsh-live2d-pets");
  assert.deepEqual(plan.repairs, ["@deepseek-ai/dsh-settings@^0.1.0-rc.6"]);
  assert.deepEqual(
    plan.peers.map((peer) => [peer.name, peer.resolved, peer.status]),
    [
      ["@deepseek-ai/dsh-settings", "0.1.6-alpha.1", "mismatch"],
      ["@deepseek-ai/cordis", "4.0.2", "ok"]
    ]
  );
});

test("a peer that resolves nowhere is repaired from its declared range", async () => {
  const peers = await loadPeers();

  const plan = peers.planPeerRepairs({
    manifest: {
      name: "dsh-live2d-pets",
      peerDependencies: {
        "@deepseek-ai/dsh-client-runtime": "^0.1.0-rc.6",
        react: "^18.2.0"
      }
    },
    resolvePeer: () => undefined
  });

  assert.deepEqual(plan.repairs, [
    "@deepseek-ai/dsh-client-runtime@^0.1.0-rc.6",
    "react@^18.2.0"
  ]);
  assert.deepEqual(
    plan.peers.map((peer) => peer.status),
    ["missing", "missing"]
  );
});

test("nothing is forwarded for a wildcard, an optional peer, or an unknown range", async () => {
  const peers = await loadPeers();

  const wildcard = peers.planPeerRepairs({
    manifest: { name: "a", peerDependencies: { "@deepseek-ai/dsh-client-runtime": "*" } },
    resolvePeer: () => undefined
  });
  assert.deepEqual(wildcard.repairs, []);
  assert.equal(wildcard.peers[0]?.skipped, "wildcard");

  // `optional` means "if something provides it, it has to match" — installing
  // it would add a dependency the plugin never asked to carry.
  const optional = peers.planPeerRepairs({
    manifest: {
      name: "b",
      peerDependencies: { react: "^18.2.0" },
      peerDependenciesMeta: { react: { optional: true } }
    },
    resolvePeer: () => undefined
  });
  assert.deepEqual(optional.peers, []);
  assert.deepEqual(optional.repairs, []);

  const unknown = peers.planPeerRepairs({
    manifest: { name: "c", peerDependencies: { left: "1.2.3 - 2.0.0" } },
    resolvePeer: () => "1.5.0"
  });
  assert.equal(unknown.peers[0]?.status, "unknown");
  assert.deepEqual(unknown.repairs, []);

  const none = peers.planPeerRepairs({ manifest: { name: "d" } });
  assert.deepEqual(none, { name: "d", peers: [], repairs: [] });
});

test("only installed plugins named by a plain registry spec are audited", async (t) => {
  const peers = await loadPeers();
  const modulesDir = mkdtempSync(path.join(tmpdir(), "harness-desktop-peers-"));
  t.after(() => {
    rmSync(modulesDir, { recursive: true, force: true });
  });

  const write = (name: string, manifest: Record<string, unknown>): void => {
    const dir = path.join(modulesDir, ...name.split("/"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "package.json"), JSON.stringify(manifest));
  };

  write("@hellosz/dsh-pets", {
    name: "@hellosz/dsh-pets",
    version: "0.2.2",
    peerDependencies: { "@deepseek-ai/dsh-settings": "^0.1.0-rc.6" }
  });
  write("plain-library", { name: "plain-library", version: "1.0.0" });

  assert.deepEqual(
    peers.auditableSpecNames(
      ["@hellosz/dsh-pets@0.2.2", "@hellosz/dsh-pets", "plain-library", "missing-package"],
      modulesDir
    ),
    ["@hellosz/dsh-pets"]
  );
});
