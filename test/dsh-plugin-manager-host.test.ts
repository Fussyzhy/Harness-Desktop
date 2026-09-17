import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PLUGIN_MANAGER_ENV_KEYS } from "../src/dsh-plugins.js";

/**
 * The plugin manager's host half, driven directly.
 *
 * Its route can install arbitrary code, so the fence in front of it is security
 * relevant, and the card is only rendered for the namespace this half registers
 * — neither is visible to a test that reads the source. Everything below calls
 * the real handler, with the real module loaded from a real profile copy; only
 * the package-manager run itself is left to `verify:plugins`, which needs a
 * process to spawn.
 */

const PROJECT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_DIR = path.join(PROJECT_ROOT, "plugins", "dsh-plugin-manager");
/** The name dsh mounts, straight from the manifest that declares it. */
const PACKAGE_NAME = (
  JSON.parse(readFileSync(path.join(PLUGIN_DIR, "package.json"), "utf8")) as {
    name: string;
  }
).name;
const ROUTE_PATH = "/harness-desktop/plugins";
const NAMESPACE = "harness-desktop-plugins";

const ENV_KEYS = Object.values(PLUGIN_MANAGER_ENV_KEYS);

interface Route {
  kind: string;
  path: string;
  handler: (request: unknown, response: unknown) => void | Promise<void>;
}

interface FakeResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  writeHead(status: number, headers?: Record<string, string>): FakeResponse;
  end(chunk?: string): void;
}

function createResponse(): FakeResponse {
  const response: FakeResponse = {
    statusCode: 0,
    headers: {},
    body: "",
    writeHead(status, headers) {
      response.statusCode = status;
      Object.assign(response.headers, headers ?? {});
      return response;
    },
    end(chunk) {
      if (chunk !== undefined) {
        response.body += chunk;
      }
    }
  };
  return response;
}

/** A request the handler can read headers from and drain a body out of. */
function createRequest(options: {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  rawBody?: string;
}): Readable & { method: string; headers: Record<string, string> } {
  const chunks =
    options.rawBody !== undefined
      ? [Buffer.from(options.rawBody)]
      : options.body === undefined
        ? []
        : [Buffer.from(JSON.stringify(options.body))];
  const request = Readable.from(chunks) as Readable & {
    method: string;
    headers: Record<string, string>;
  };
  request.method = options.method ?? "GET";
  request.headers = options.headers ?? { host: "127.0.0.1:1234" };
  return request;
}

function json(response: FakeResponse): Record<string, any> {
  return JSON.parse(response.body);
}

/** Point the host half at fake paths (an empty string means "not provided"). */
function applyEnv(values: Partial<Record<string, string>>): () => void {
  const previous = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) {
    previous.set(key, process.env[key]);
    process.env[key] = values[key] ?? "";
  }

  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

const AVAILABLE = {
  [PLUGIN_MANAGER_ENV_KEYS.pnpmScript]: "C:\\app\\pnpm.cjs",
  [PLUGIN_MANAGER_ENV_KEYS.dshCli]: "C:\\app\\dsh\\bin.js",
  [PLUGIN_MANAGER_ENV_KEYS.electron]: "C:\\app\\electron.exe",
  [PLUGIN_MANAGER_ENV_KEYS.storeDir]: "C:\\home\\.pnpm-store",
  [PLUGIN_MANAGER_ENV_KEYS.shimDir]: "C:\\app\\bin",
  [PLUGIN_MANAGER_ENV_KEYS.restartExitCode]: "91"
};

interface PluginModule {
  apply(ctx: unknown): void;
  /** Exported by the host half so this line is testable without a spawn. */
  pluginArguments(action: string, specs: string[], storeDir?: string): string[];
}

interface Host {
  route: Route;
  namespaces: string[];
  profileDir: string;
  root: string;
  module: PluginModule;
}

/**
 * Mount the real host half the way the application does: the package is copied
 * into `<profile>/node_modules`, and the copy derives the profile it manages
 * from its own location.
 */
async function mountHost(
  t: { after: (fn: () => void) => void },
  options: {
    dependencies?: Record<string, string>;
    bundles?: string[];
    installed?: {
      name: string;
      version: string;
      declaresBundle: boolean;
      peerDependencies?: Record<string, string>;
    }[];
  } = {}
): Promise<Host> {
  const root = mkdtempSync(path.join(tmpdir(), "harness-desktop-host-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const profileDir = path.join(root, "profiles", "web");
  const packageDir = path.join(profileDir, "node_modules", ...PACKAGE_NAME.split("/"));
  mkdirSync(path.dirname(packageDir), { recursive: true });
  cpSync(PLUGIN_DIR, packageDir, { recursive: true });

  writeFileSync(
    path.join(profileDir, "package.json"),
    JSON.stringify(
      {
        name: "dsh-profile-web",
        private: true,
        dependencies: options.dependencies ?? {},
        dsh: {
          profile: {
            bundles: options.bundles ?? ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"],
            patchReload: "live"
          }
        }
      },
      null,
      2
    )
  );

  for (const entry of options.installed ?? []) {
    const dir = path.join(profileDir, "node_modules", ...entry.name.split("/"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({
        name: entry.name,
        version: entry.version,
        ...(entry.peerDependencies === undefined
          ? {}
          : { peerDependencies: entry.peerDependencies }),
        ...(entry.declaresBundle ? { dsh: { bundle: { patch: "./cordis.patch.yml" } } } : {})
      })
    );
  }

  const namespaces: string[] = [];
  let route: Route | undefined;

  const scopeFor = (service: string): Record<string, unknown> => {
    if (service === "settings") {
      return {
        settings: {
          register: (namespace: string) => {
            namespaces.push(namespace);
          }
        }
      };
    }
    return {
      webServer: {
        register: (registered: Route) => {
          route = registered;
          return () => {};
        }
      }
    };
  };

  const plugin = (await import(
    pathToFileURL(path.join(packageDir, "dsh", "index.js")).href
  )) as PluginModule;

  plugin.apply({
    inject: (services: string[], run: (scope: unknown) => void) => {
      // Cordis hands the scope over once every named service exists; the fake
      // provides exactly the two this plugin asks for.
      const scope: Record<string, unknown> = {};
      for (const service of services) {
        Object.assign(scope, scopeFor(service));
      }
      run(scope);
    }
  });

  if (route === undefined) {
    throw new Error("the host half must register its route");
  }
  return { route, namespaces, profileDir, root, module: plugin };
}

test("an install asks pnpm to write to the profile's workspace root", async (t) => {
  // The profile is a pnpm workspace root, and pnpm refuses a registry install
  // there without this flag (ERR_PNPM_ADDING_TO_ROOT). `dsh plugin` forwards
  // arguments verbatim, so the flag has to come from this call — and the
  // profile name it targets is derived from where the plugin itself is mounted.
  const host = await mountHost(t);

  assert.deepEqual(
    host.module.pluginArguments("add", ["@hellosz/dsh-pets"], "C:\\store"),
    [
      "plugin",
      "--profile",
      "web",
      "add",
      "--workspace-root",
      "@hellosz/dsh-pets",
      "--store-dir",
      "C:\\store"
    ]
  );

  assert.deepEqual(host.module.pluginArguments("remove", ["@hellosz/dsh-pets"]), [
    "plugin",
    "--profile",
    "web",
    "remove",
    "--workspace-root",
    "@hellosz/dsh-pets"
  ]);

  // One run may carry a registry plugin plus the local companions its peers
  // need; every spec stays its own pnpm argument.
  assert.deepEqual(
    host.module.pluginArguments("add", ["@hellosz/dsh-pets", "@deepseek-ai/dsh-tools@link:C:/tools"]),
    [
      "plugin",
      "--profile",
      "web",
      "add",
      "--workspace-root",
      "@hellosz/dsh-pets",
      "@deepseek-ai/dsh-tools@link:C:/tools"
    ]
  );
});

test("a whole install reaches the command line the way the card promises", async (t) => {
  const host = await mountHost(t);

  // Stand in for `dsh` itself: it records the arguments it was handed, so the
  // route's splitting, validation and flagging are checked end to end without
  // running pnpm (or touching a registry).
  const argvPath = path.join(host.root, "argv.json");
  const stubPath = path.join(host.root, "dsh-stub.mjs");
  writeFileSync(
    stubPath,
    [
      'import { writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)));`
    ].join("\n")
  );

  const restore = applyEnv({
    ...AVAILABLE,
    [PLUGIN_MANAGER_ENV_KEYS.electron]: process.execPath,
    [PLUGIN_MANAGER_ENV_KEYS.dshCli]: stubPath
  });
  t.after(restore);

  const response = createResponse();
  await host.route.handler(
    createRequest({
      method: "POST",
      body: {
        action: "add",
        spec: "  @hellosz/dsh-pets ,@deepseek-ai/dsh-tools@link:C:/tools "
      }
    }),
    response
  );

  assert.equal(response.statusCode, 200);
  assert.equal(json(response).ok, true);
  assert.deepEqual(JSON.parse(readFileSync(argvPath, "utf8")), [
    "plugin",
    "--profile",
    "web",
    "add",
    "--workspace-root",
    "@hellosz/dsh-pets",
    "@deepseek-ai/dsh-tools@link:C:/tools",
    "--store-dir",
    AVAILABLE[PLUGIN_MANAGER_ENV_KEYS.storeDir]
  ]);
});

test("the host half registers the route and namespace the card needs", async (t) => {
  const host = await mountHost(t);

  // The card is dispatched by this key and answers on this path; a mismatch
  // leaves a card that never renders or never loads.
  assert.deepEqual(host.namespaces, [NAMESPACE]);
  assert.equal(host.route.kind, "exact");
  assert.equal(host.route.path, ROUTE_PATH);
});

test("the list reports what the profile actually holds", async (t) => {
  const host = await mountHost(t, {
    dependencies: { "user-plugin": "1.2.3" },
    bundles: [
      "@deepseek-ai/dsh-base",
      "@deepseek-ai/dsh-web-app",
      PACKAGE_NAME,
      "user-plugin"
    ],
    installed: [
      { name: PACKAGE_NAME, version: "0.1.0", declaresBundle: true },
      { name: "user-plugin", version: "1.2.3", declaresBundle: false }
    ]
  });
  const restore = applyEnv(AVAILABLE);
  t.after(restore);

  const response = createResponse();
  await host.route.handler(createRequest({}), response);

  assert.equal(response.statusCode, 200);
  const body = json(response);
  assert.equal(body.available, true);
  assert.equal(body.profile, "web");
  assert.equal(body.profileDir, host.profileDir);

  const byName = new Map(body.packages.map((entry: any) => [entry.name, entry]));

  // The application's own plugin has no pnpm dependency entry, which is exactly
  // how the card tells a built-in from something the user installed.
  assert.deepEqual(byName.get(PACKAGE_NAME), {
    name: PACKAGE_NAME,
    version: "0.1.0",
    bundle: true,
    installed: true,
    builtIn: true,
    removable: false,
    mounted: true
  });

  // A dependency that declares no bundle is installed but never composed, and
  // the card has to say so rather than imply the plugin is active.
  const user = byName.get("user-plugin") as any;
  assert.equal(user.bundle, false);
  assert.equal(user.builtIn, false);
  assert.equal(user.removable, true);
  assert.equal(user.mounted, true);
});

test("the route refuses anything that is not a same-origin loopback caller", async (t) => {
  const host = await mountHost(t);
  const restore = applyEnv(AVAILABLE);
  t.after(restore);

  const refused: Record<string, string>[] = [
    { host: "127.0.0.1:1234", "sec-fetch-site": "cross-site" },
    { host: "dsh.example.com" },
    { host: "127.0.0.1:1234", origin: "http://evil.example" },
    { "sec-fetch-site": "same-origin" }
  ];

  for (const headers of refused) {
    const response = createResponse();
    await host.route.handler(createRequest({ headers }), response);
    assert.equal(response.statusCode, 403, `headers ${JSON.stringify(headers)}`);
  }

  // A same-origin fetch from the application's own page carries no Origin on
  // the GET, and must pass.
  const allowed = createResponse();
  await host.route.handler(
    createRequest({ headers: { host: "127.0.0.1:1234", "sec-fetch-site": "same-origin" } }),
    allowed
  );
  assert.equal(allowed.statusCode, 200);
});

test("installation is reported unavailable outside the desktop application", async (t) => {
  const host = await mountHost(t);
  const restore = applyEnv({});
  t.after(restore);

  const list = createResponse();
  await host.route.handler(createRequest({}), list);
  assert.equal(json(list).available, false);

  // A valid spec, so the request gets far enough to be refused for the right
  // reason: there is no bundled pnpm to call.
  const install = createResponse();
  await host.route.handler(
    createRequest({ method: "POST", body: { action: "add", spec: "some-plugin" } }),
    install
  );
  assert.equal(install.statusCode, 503);
  assert.match(json(install).error, /not started by Harness Desktop/);
});

test("the route refuses a spec that looks like a flag, an empty spec, and an unknown action", async (t) => {
  const host = await mountHost(t);
  // Fake but non-empty: every case below is rejected before anything is spawned.
  const restore = applyEnv(AVAILABLE);
  t.after(restore);

  const cases: { body: unknown; error: RegExp }[] = [
    { body: { action: "add", spec: "--force" }, error: /package name, version, path, or URL/ },
    { body: { action: "add", spec: "   " }, error: /package name, version, path, or URL/ },
    { body: { action: "add", spec: "a".repeat(201) }, error: /package name, version, path, or URL/ },
    { body: { action: "install", spec: "some-plugin" }, error: /unknown action/ },
    // Several specs per install are allowed, but a flag hidden behind the
    // separator is not: each item is validated on its own.
    {
      body: { action: "add", spec: "@scope/name, --force" },
      error: /is not a package name, version, path, or URL/
    },
    {
      body: { action: "remove", spec: "  " },
      error: /package name, version, path, or URL/
    }
  ];

  for (const entry of cases) {
    const response = createResponse();
    await host.route.handler(
      createRequest({ method: "POST", body: entry.body }),
      response
    );
    assert.equal(response.statusCode, 400, JSON.stringify(entry.body));
    assert.match(json(response).error, entry.error);
  }

  const malformed = createResponse();
  await host.route.handler(
    createRequest({ method: "POST", rawBody: "{ not json" }),
    malformed
  );
  assert.equal(malformed.statusCode, 400);
});

test("the restart action answers first, then leaves with the configured code", async (t) => {
  const host = await mountHost(t);
  const restore = applyEnv(AVAILABLE);
  t.after(restore);

  const originalExit = process.exit;
  let exitedWith: number | undefined;
  process.exit = ((code?: number) => {
    exitedWith = code;
    return undefined as never;
  }) as typeof process.exit;

  try {
    const response = createResponse();
    await host.route.handler(
      createRequest({ method: "POST", body: { action: "restart" } }),
      response
    );

    // The response has to reach the card before the process goes away.
    assert.equal(response.statusCode, 200);
    assert.deepEqual(json(response), { ok: true, restarting: true });

    const deadline = Date.now() + 5_000;
    while (exitedWith === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    // 91 comes from the environment, so a shell that changes the handshake code
    // and a plugin that hardcodes one cannot drift apart silently.
    assert.equal(exitedWith, 91);
  } finally {
    process.exit = originalExit;
  }
});

/**
 * Put one framework package into the scratch tree above the profile, so the
 * plugin's own module resolution reaches it.
 *
 * That copy is what the audit judges, and it is exactly the situation a profile
 * is in after an install with peer auto-install disabled: the plugin resolves
 * the running installation's line rather than the one it declared.
 */
function writeResolvablePackage(host: Host, name: string, version: string): void {
  const dir = path.join(host.root, "node_modules", ...name.split("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name, version, main: "index.js" })
  );
  writeFileSync(path.join(dir, "index.js"), "module.exports = {};\n");
}

/** A stub `dsh` that appends every argument vector it is handed. */
function writeArgvStub(host: Host): string {
  const argvPath = path.join(host.root, "argv.jsonl");
  const stubPath = path.join(host.root, "dsh-stub.mjs");
  writeFileSync(
    stubPath,
    [
      'import { appendFileSync } from "node:fs";',
      `appendFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");`
    ].join("\n")
  );
  return argvPath;
}

function readArgv(argvPath: string): string[][] {
  return readFileSync(argvPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

/**
 * A plugin the installation does not satisfy is installed cleanly and then
 * cannot be mounted: its own host half imports an API the running line no longer
 * has. Its declared range is the version range its author built against, so the
 * same request asks pnpm for that range as a plain profile dependency.
 */
test("an install restores the peer versions the plugin declares", async (t) => {
  const host = await mountHost(t, {
    dependencies: { "@hellosz/dsh-pets": "0.2.2" },
    bundles: [
      "@deepseek-ai/dsh-base",
      "@deepseek-ai/dsh-web-app",
      "@hellosz/dsh-pets"
    ],
    installed: [
      {
        name: "@hellosz/dsh-pets",
        version: "0.2.2",
        declaresBundle: true,
        peerDependencies: { "@deepseek-ai/dsh-settings": "^0.1.0-rc.6" }
      }
    ]
  });
  writeResolvablePackage(host, "@deepseek-ai/dsh-settings", "0.1.6-alpha.1");

  const argvPath = writeArgvStub(host);
  const restore = applyEnv({
    ...AVAILABLE,
    [PLUGIN_MANAGER_ENV_KEYS.electron]: process.execPath,
    [PLUGIN_MANAGER_ENV_KEYS.dshCli]: path.join(host.root, "dsh-stub.mjs")
  });
  t.after(restore);

  const response = createResponse();
  await host.route.handler(
    createRequest({ method: "POST", body: { action: "add", spec: "@hellosz/dsh-pets" } }),
    response
  );

  assert.equal(response.statusCode, 200);
  assert.equal(json(response).ok, true);
  assert.deepEqual(json(response).peerRepairs, ["@deepseek-ai/dsh-settings@^0.1.0-rc.6"]);
  assert.match(json(response).output, /compatible versions restored/);

  const argv = readArgv(argvPath);
  const storeDir = AVAILABLE[PLUGIN_MANAGER_ENV_KEYS.storeDir];
  assert.deepEqual(argv, [
    [
      "plugin",
      "--profile",
      "web",
      "add",
      "--workspace-root",
      "@hellosz/dsh-pets",
      "--store-dir",
      storeDir
    ],
    [
      "plugin",
      "--profile",
      "web",
      "add",
      "--workspace-root",
      "@deepseek-ai/dsh-settings@^0.1.0-rc.6",
      "--store-dir",
      storeDir
    ]
  ]);
});

test("a plugin whose peers already match is left alone", async (t) => {
  const host = await mountHost(t, {
    dependencies: { "@hellosz/dsh-pets": "0.2.2" },
    bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@hellosz/dsh-pets"],
    installed: [
      {
        name: "@hellosz/dsh-pets",
        version: "0.2.2",
        declaresBundle: true,
        peerDependencies: { "@deepseek-ai/dsh-settings": "^0.1.0-rc.6" }
      }
    ]
  });
  writeResolvablePackage(host, "@deepseek-ai/dsh-settings", "0.1.0-rc.8");

  const argvPath = writeArgvStub(host);
  const restore = applyEnv({
    ...AVAILABLE,
    [PLUGIN_MANAGER_ENV_KEYS.electron]: process.execPath,
    [PLUGIN_MANAGER_ENV_KEYS.dshCli]: path.join(host.root, "dsh-stub.mjs")
  });
  t.after(restore);

  const response = createResponse();
  await host.route.handler(
    createRequest({ method: "POST", body: { action: "add", spec: "@hellosz/dsh-pets" } }),
    response
  );

  assert.deepEqual(json(response).peerRepairs, []);
  // Nothing was duplicated: only the install itself ran.
  assert.equal(readArgv(argvPath).length, 1);
});

/**
 * A `*` peer is the shape that aborts an install: pnpm resolves it from the
 * registry's `latest`, which for the framework packages is a stale prerelease
 * whose own dependencies are no longer published. It is never forwarded.
 */
test("a wildcard peer never becomes a registry lookup", async (t) => {
  const host = await mountHost(t, {
    dependencies: { "@hellosz/dsh-pets": "0.2.2" },
    bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@hellosz/dsh-pets"],
    installed: [
      {
        name: "@hellosz/dsh-pets",
        version: "0.2.2",
        declaresBundle: true,
        peerDependencies: { "@deepseek-ai/dsh-client-runtime": "*" }
      }
    ]
  });

  const argvPath = writeArgvStub(host);
  const restore = applyEnv({
    ...AVAILABLE,
    [PLUGIN_MANAGER_ENV_KEYS.electron]: process.execPath,
    [PLUGIN_MANAGER_ENV_KEYS.dshCli]: path.join(host.root, "dsh-stub.mjs")
  });
  t.after(restore);

  const response = createResponse();
  await host.route.handler(
    createRequest({ method: "POST", body: { action: "add", spec: "@hellosz/dsh-pets" } }),
    response
  );

  assert.deepEqual(json(response).peerRepairs, []);
  assert.equal(readArgv(argvPath).length, 1);
});
