/**
 * Peer-dependency compatibility for the plugins a profile installed.
 *
 * Plugins are installed with `auto-install-peers=false` (see the shell's
 * `src/dsh-profile.ts`), because the framework packages a plugin peers on are
 * published as a prerelease line whose `latest` tag is stale: letting pnpm fill
 * a missing peer from the registry can abort the whole install with
 * `ERR_PNPM_FETCH_404`. The plugin then resolves that peer from whatever the
 * running installation provides, which is a *different API line* — and a plugin
 * whose host half imports a name the installation no longer exports cannot be
 * mounted at all. That is a boot failure, not a warning.
 *
 * The repair is the same install made explicit: the plugin's own declared range
 * is the version range its author built and tested against, so the profile asks
 * pnpm for that range. It is always a range, never `latest`, so a stale
 * dist-tag cannot be picked; and a peer that already resolves to a satisfying
 * version is left untouched, so nothing is duplicated that does not have to be.
 *
 * `satisfies` below is deliberately self-contained: the packaged application
 * ships neither npm nor corepack, and a peer range is the one semver question
 * this package has to answer on its own.
 *
 * @module @harness-desktop/dsh-plugin-manager/plugin-peers
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

/** Version shapes plugins publish: `1.2.3`, `1.2.3-rc.1`, `v1.2.3+build`. */
const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** One comparator: an operator (absent means `=`) plus a version or `x` parts. */
const COMPARATOR = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/;

/** A range part that means "anything at all". */
const ANY = /^(?:x|X|\*|)$/;

/**
 * Parse a version into its comparable parts.
 * @param value - the version text.
 * @returns the parts, or `undefined` when the text is not a version.
 */
export function parseVersion(value) {
  if (typeof value !== "string") {
    return undefined;
  }

  const match = VERSION.exec(value.trim());
  if (match === null) {
    return undefined;
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split(".")
  };
}

/**
 * Compare two prerelease identifier lists the way semver does: numeric
 * identifiers compare numerically, alphanumeric ones lexically, a shorter list
 * wins when every shared identifier is equal, and no prerelease at all ranks
 * above any prerelease.
 */
function comparePrerelease(left, right) {
  if (left.length === 0 && right.length === 0) {
    return 0;
  }
  if (left.length === 0) {
    return 1;
  }
  if (right.length === 0) {
    return -1;
  }

  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined) {
      return -1;
    }
    if (b === undefined) {
      return 1;
    }
    if (a === b) {
      continue;
    }

    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) {
      return Number(a) < Number(b) ? -1 : 1;
    }
    if (aNumeric !== bNumeric) {
      // Numeric identifiers always rank below alphanumeric ones.
      return aNumeric ? -1 : 1;
    }
    return a < b ? -1 : 1;
  }

  return 0;
}

/**
 * Compare two versions.
 * @param left - left version text.
 * @param right - right version text.
 * @returns -1, 0, or 1; `undefined` when either side is not a version.
 */
export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (a === undefined || b === undefined) {
    return undefined;
  }

  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) {
      return a[key] < b[key] ? -1 : 1;
    }
  }

  return comparePrerelease(a.prerelease, b.prerelease);
}

/** The same version with its prerelease and build metadata dropped. */
function releaseOf(version) {
  return `${version.major}.${version.minor}.${version.patch}`;
}

/** The exclusive upper bound of a `^` range, partial versions included. */
function caretUpper(version) {
  const minor = version.minor ?? 0;
  const patch = version.patch ?? 0;
  if (version.major > 0) {
    return { major: version.major + 1, minor: 0, patch: 0 };
  }
  // `^0` stays below 1.0.0, `^0.0` below 0.1.0, and `^0.0.3` below 0.0.4.
  if (version.minor === undefined) {
    return { major: 1, minor: 0, patch: 0 };
  }
  if (minor > 0) {
    return { major: 0, minor: minor + 1, patch: 0 };
  }
  if (version.patch === undefined) {
    return { major: 0, minor: 1, patch: 0 };
  }
  return { major: 0, minor: 0, patch: patch + 1 };
}

/** The exclusive upper bound of a `~` range, partial versions included. */
function tildeUpper(version) {
  return version.minor === undefined
    ? { major: version.major + 1, minor: 0, patch: 0 }
    : { major: version.major, minor: version.minor + 1, patch: 0 };
}

/** Build the comparator list one `op version` head expands to. */
function expand(operator, parts) {
  const { major, prerelease } = parts;
  const minor = parts.minor ?? 0;
  const patch = parts.patch ?? 0;
  const full = `${major}.${minor}.${patch}`;
  const hasPrerelease = prerelease !== undefined && prerelease.length > 0;
  const lower = `${full}${hasPrerelease ? `-${prerelease.join(".")}` : ""}`;

  if (operator === undefined || operator === "=") {
    // A partial version is a range in npm's grammar: `1.2` means `1.2.x`.
    if (parts.minor === undefined) {
      return [
        { op: ">=", version: `${major}.0.0` },
        { op: "<", version: `${major + 1}.0.0` }
      ];
    }
    if (parts.patch === undefined) {
      return [
        { op: ">=", version: `${major}.${minor}.0` },
        { op: "<", version: `${major}.${minor + 1}.0` }
      ];
    }
    return [{ op: "=", version: lower }];
  }

  if (operator === "^") {
    const upper = caretUpper(parts);
    return [
      { op: ">=", version: lower },
      { op: "<", version: `${upper.major}.${upper.minor}.${upper.patch}` }
    ];
  }

  if (operator === "~") {
    const upper = tildeUpper(parts);
    return [
      { op: ">=", version: lower },
      { op: "<", version: `${upper.major}.${upper.minor}.${upper.patch}` }
    ];
  }

  return [{ op: operator, version: lower }];
}

/** Parse one space-separated comparator of a range part. */
function parseComparator(text) {
  const match = COMPARATOR.exec(text);
  if (match === null) {
    return undefined;
  }

  let body = match[2].trim();
  if (ANY.test(body)) {
    return { parts: [{ op: "*" }] };
  }

  // The prerelease is split off before the dot split: it may itself contain
  // dots, and `1.2.3-rc.1` is one prerelease rather than a fourth number.
  let prerelease;
  const dash = body.indexOf("-");
  if (dash !== -1) {
    prerelease = body.slice(dash + 1);
    body = body.slice(0, dash);
    if (prerelease.length === 0) {
      return undefined;
    }
  }

  const numbers = [];
  let wildcard = false;
  for (const piece of body.split(".")) {
    if (wildcard) {
      break;
    }
    if (ANY.test(piece)) {
      wildcard = true;
      continue;
    }
    if (!/^\d+$/.test(piece)) {
      return undefined;
    }
    numbers.push(Number(piece));
  }

  if (wildcard && prerelease !== undefined) {
    return undefined;
  }
  if (numbers.length === 0) {
    return { parts: [{ op: "*" }] };
  }

  return {
    parts: expand(match[1], {
      major: numbers[0],
      minor: numbers[1],
      patch: numbers[2],
      prerelease: prerelease === undefined ? [] : prerelease.split(".")
    })
  };
}

/** Whether one comparator holds for `version`. */
function testComparator(comparator, version) {
  if (comparator.op === "*") {
    return true;
  }

  const order = compareVersions(version, comparator.version);
  if (order === undefined) {
    return undefined;
  }

  switch (comparator.op) {
    case "=":
      return order === 0;
    case ">":
      return order > 0;
    case ">=":
      return order >= 0;
    case "<":
      return order < 0;
    case "<=":
      return order <= 0;
    default:
      return undefined;
  }
}

/**
 * Whether `version` satisfies `range`.
 *
 * The range grammar covers what published plugins actually declare in
 * `peerDependencies`: `*`, exact, partial (`1.2`), `^`, `~`, the ordering
 * operators, and `||` unions of those. A prerelease version only satisfies a
 * comparator set when one of its comparators carries a prerelease for the same
 * major/minor/patch triple, which is semver's documented rule and the reason a
 * plugin built against `0.1.0-rc.6` is not satisfied by `0.1.6-alpha.1`.
 *
 * @param version - the version that is installed.
 * @param range - the range that was declared.
 * @returns `true`/`false`, or `undefined` when the range is not understood
 *   (the caller must then leave the plugin alone rather than guess).
 */
export function satisfies(version, range) {
  const parsed = parseVersion(version);
  if (parsed === undefined) {
    return undefined;
  }

  const text = typeof range === "string" ? range.trim() : "";
  if (ANY.test(text)) {
    return parsed.prerelease.length === 0;
  }

  for (const part of text.split("||")) {
    const comparators = [];
    let understood = true;
    for (const token of part.trim().split(/\s+/)) {
      if (token.length === 0) {
        continue;
      }
      const parsedComparator = parseComparator(token);
      if (parsedComparator === undefined) {
        understood = false;
        break;
      }
      comparators.push(...parsedComparator.parts);
    }

    if (!understood) {
      return undefined;
    }
    if (comparators.length === 0) {
      continue;
    }

    // A prerelease may only be judged by a comparator that shares its triple.
    if (parsed.prerelease.length > 0) {
      const allows = comparators.some((comparator) => {
        if (comparator.op === "*" || comparator.version === undefined) {
          return false;
        }
        const bound = parseVersion(comparator.version);
        return (
          bound !== undefined &&
          bound.prerelease.length > 0 &&
          bound.major === parsed.major &&
          bound.minor === parsed.minor &&
          bound.patch === parsed.patch
        );
      });
      if (!allows) {
        continue;
      }
    }

    let holds = true;
    for (const comparator of comparators) {
      const result = testComparator(comparator, version);
      if (result === undefined) {
        return undefined;
      }
      if (!result) {
        holds = false;
        break;
      }
    }

    if (holds) {
      return true;
    }
  }

  return false;
}

/**
 * The package name a command-line spec installs, when that is knowable.
 *
 * `link:`/`file:`/tarball/git specs (and `npm:` aliases) install under a name
 * only pnpm knows, so they answer `undefined` and are simply not audited.
 *
 * @param spec - one spec exactly as the user typed it.
 * @returns the registry package name, or `undefined`.
 */
export function specPackageName(spec) {
  if (typeof spec !== "string") {
    return undefined;
  }

  const text = spec.trim();
  // A leading dash is a flag wherever it appears, never a package name.
  if (text.length === 0 || text.startsWith("-") || text.includes(":")) {
    return undefined;
  }

  let name = text;
  if (text.startsWith("@")) {
    const parts = text.split("/");
    if (parts.length < 2 || parts[0].length < 2) {
      return undefined;
    }
    name = `${parts[0]}/${parts[1].split("@")[0]}`;
  } else {
    if (text.includes("/") || text.includes("\\")) {
      return undefined;
    }
    name = text.split("@")[0];
  }

  return /^(@[a-z0-9-._~]+\/)?[a-z0-9-._~]+$/i.test(name) && name.length > 0
    ? name
    : undefined;
}

/** Read a package manifest, or `undefined` when it is missing or malformed. */
function readManifest(directory) {
  try {
    const parsed = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The package directory a resolved entry point belongs to.
 *
 * `exports` maps hide `package.json` behind a subpath many packages do not
 * publish, so the version is read by walking up from the resolved entry to the
 * directory whose manifest names the peer.
 */
function packageDirOfResolved(entryPath, packageName) {
  let directory = entryPath;
  for (let depth = 0; depth < 8; depth += 1) {
    directory = join(directory, "..");
    const manifest = readManifest(directory);
    if (manifest === undefined) {
      continue;
    }
    if (manifest.name === packageName) {
      return directory;
    }
  }
  return undefined;
}

/**
 * The version a plugin's own module resolution reaches for `packageName`.
 * @param pluginDir - the installed plugin directory.
 * @param packageName - the peer package name.
 * @returns the resolved version, or `undefined` when it does not resolve.
 */
export function resolvedPeerVersion(pluginDir, packageName) {
  let entryPath;
  try {
    const require = createRequire(join(pluginDir, "package.json"));
    entryPath = require.resolve(packageName);
  } catch {
    return undefined;
  }

  const directory = packageDirOfResolved(entryPath, packageName);
  if (directory === undefined) {
    return undefined;
  }

  const manifest = readManifest(directory);
  return typeof manifest?.version === "string" ? manifest.version : undefined;
}

/**
 * Audit one installed plugin's peer dependencies and plan the repairs.
 *
 * @param options.pluginDir - the installed plugin directory.
 * @param options.manifest - the plugin manifest; read from `pluginDir` when absent.
 * @param options.resolvePeer - `(name) => version | undefined`, injectable for tests.
 * @returns the per-peer verdicts and the companion specs that would repair them.
 */
export function planPeerRepairs({ pluginDir, manifest, resolvePeer } = {}) {
  const pluginManifest = manifest ?? (pluginDir === undefined ? undefined : readManifest(pluginDir));
  const name = typeof pluginManifest?.name === "string" ? pluginManifest.name : "";
  const peers = pluginManifest?.peerDependencies;
  const meta = pluginManifest?.peerDependenciesMeta;

  const verdicts = [];
  const repairs = [];
  if (typeof peers !== "object" || peers === null) {
    return { name, peers: verdicts, repairs };
  }

  const resolve =
    typeof resolvePeer === "function"
      ? resolvePeer
      : (packageName) => resolvedPeerVersion(pluginDir, packageName);

  for (const [packageName, declared] of Object.entries(peers)) {
    if (typeof declared !== "string") {
      continue;
    }
    if (meta?.[packageName]?.optional === true) {
      continue;
    }

    const resolved = resolve(packageName);
    const verdict = satisfies(resolved ?? "", declared);
    const status =
      resolved === undefined
        ? "missing"
        : verdict === false
          ? "mismatch"
          : verdict === undefined
            ? "unknown"
            : "ok";

    // Only a *range* may be forwarded: `*` (and a bare name) would ask the
    // registry for `latest`, which is the stale dist-tag this whole mechanism
    // exists to avoid.
    const wildcard = ANY.test(declared.trim());
    const spec = status === "missing" || status === "mismatch"
      ? wildcard
        ? undefined
        : `${packageName}@${declared.trim()}`
      : undefined;

    if (spec !== undefined && !repairs.includes(spec)) {
      repairs.push(spec);
    }

    verdicts.push({
      name: packageName,
      range: declared.trim(),
      resolved: resolved ?? null,
      status,
      ...(spec === undefined ? {} : { spec }),
      ...(wildcard && status !== "ok" ? { skipped: "wildcard" } : {})
    });
  }

  return { name, peers: verdicts, repairs };
}

/**
 * The installed plugins a command-line spec could have touched.
 *
 * @param specs - the specs of one `add`.
 * @param modulesDir - the profile's `node_modules`.
 * @returns the names that exist there and declare at least one peer.
 */
export function auditableSpecNames(specs, modulesDir) {
  const names = [];
  for (const spec of specs) {
    const name = specPackageName(spec);
    if (name === undefined || names.includes(name)) {
      continue;
    }
    if (!existsSync(join(modulesDir, name, "package.json"))) {
      continue;
    }
    const manifest = readManifest(join(modulesDir, name));
    if (typeof manifest?.peerDependencies === "object" && manifest.peerDependencies !== null) {
      names.push(name);
    }
  }
  return names;
}
